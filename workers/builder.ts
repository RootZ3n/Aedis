import { readFile, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

import type { RunState, CostEntry } from "../core/runstate.js";
import { recordDecision, recordFileTouch } from "../core/runstate.js";
import { invokeModel, type Provider } from "../core/model-invoker.js";
import { DiffApplier } from "../core/diff-applier.js";
import { loadModelConfig } from "../server/routes/config.js";
import type { EventBus } from "../server/websocket.js";
import {
  AbstractWorker,
  type BuildDecision,
  type BuilderOutput,
  type FileChange,
  type WorkerAssignment,
  type WorkerResult,
} from "./base.js";

// ─── Contract Types (exported for Critic) ────────────────────────────

export interface TaskContract {
  readonly file: string;
  readonly goal: string;
  readonly constraints: readonly string[];
  readonly forbiddenChanges: readonly string[];
  readonly interfaceRules: readonly string[];
}

export interface ModelInvocation {
  readonly model: string;
  readonly prompt: string;
  readonly contract: TaskContract;
  readonly assignment: WorkerAssignment;
}

export interface ModelResponse {
  readonly content: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly estimatedCostUsd?: number;
}

export interface BuilderResult extends WorkerResult {
  readonly output: BuilderOutput & {
    readonly contract: TaskContract;
    readonly prompt: string;
    readonly rawModelResponse: string;
  };
}

export interface BuilderWorkerConfig {
  readonly projectRoot: string;
  readonly eventBus?: EventBus;
  readonly runState?: RunState;
  readonly defaultModel?: string;
  readonly defaultProvider?: Provider;
  /** Max context tokens to include in prompt. Default 8000. */
  readonly maxContextTokens?: number;
}

// ─── Builder Worker ──────────────────────────────────────────────────

export class BuilderWorker extends AbstractWorker {
  readonly type = "builder" as const;
  readonly name = "Builder Worker";

  private readonly projectRoot: string;
  private readonly eventBus: EventBus | null;
  private readonly runState: RunState | null;
  private readonly defaultModel: string;
  private readonly defaultProvider: Provider;
  private readonly diffApplier: DiffApplier;
  private readonly maxContextTokens: number;

  constructor(config: BuilderWorkerConfig) {
    super();
    this.projectRoot = resolve(config.projectRoot);
    this.eventBus = config.eventBus ?? null;
    this.runState = config.runState ?? null;
    this.defaultModel = config.defaultModel ?? "qwen3.6-plus";
    this.defaultProvider = config.defaultProvider ?? "modelstudio";
    this.diffApplier = new DiffApplier();
    this.maxContextTokens = config.maxContextTokens ?? 8000;
  }

  canHandle(assignment: WorkerAssignment): boolean {
    // Deduplicate target files — multiple paths resolving to the same file count as one
    const unique = this.deduplicateTargets(assignment.task.targetFiles);
    return unique.length === 1;
  }

  async estimateCost(assignment: WorkerAssignment): Promise<CostEntry> {
    const contextChars = Math.min(
      assignment.context.layers.reduce(
        (sum, layer) => sum + layer.files.reduce((inner, file) => inner + file.content.length, 0),
        0,
      ),
      this.maxContextTokens * 4,
    );
    const inputTokens = Math.ceil((contextChars + assignment.task.description.length * 2) / 4);
    const outputTokens = Math.min(assignment.tokenBudget, 1800);
    const { model } = this.getActiveModelConfig();
    return {
      model,
      inputTokens,
      outputTokens,
      estimatedCostUsd: Number(((inputTokens * 0.00000035) + (outputTokens * 0.0000012)).toFixed(6)),
    };
  }

  async execute(assignment: WorkerAssignment): Promise<BuilderResult> {
    const startedAt = Date.now();
    const taskId = assignment.task.id;

    try {
      if (!this.canHandle(assignment)) {
        const unique = this.deduplicateTargets(assignment.task.targetFiles);
        throw new Error(`Builder requires single-file scope. Got ${unique.length} unique files: ${unique.join(", ")}`);
      }

      const { model, provider } = this.getActiveModelConfig();
      const contract = this.buildContract(assignment);
      const targetPath = this.resolveTarget(contract.file);
      const relativePath = this.toRelative(targetPath);
      const originalContent = await readFile(targetPath, "utf8");
      this.logFileTouch(taskId, relativePath, "read");

      const prompt = this.buildPrompt(contract, assignment, originalContent, model, relativePath);

      // Real model call via unified invoker
      const response = await invokeModel({
        provider: provider as Provider,
        model,
        prompt,
        systemPrompt: BUILDER_SYSTEM_PROMPT,
        maxTokens: assignment.tokenBudget,
      });

      console.log(`[Builder] Model response: ${response.tokensIn}in/${response.tokensOut}out, ${response.text.length} chars`);

      // Extract diff from response — handles markdown fences, raw diff, or full file content
      const { updatedContent, diff } = this.processModelResponse(response.text, relativePath, originalContent);
      this.enforceForbiddenChanges(contract, updatedContent);

      if (updatedContent === originalContent) {
        console.warn(`[Builder] No effective changes detected. Model response starts with: ${response.text.slice(0, 200)}`);
        throw new Error("Model returned no effective file changes");
      }

      // Apply the change
      await writeFile(targetPath, updatedContent, "utf8");
      this.logFileTouch(taskId, relativePath, "modify");
      this.noteDecision(taskId, `Applied builder patch to ${relativePath}`, `Contract goal: ${contract.goal}`);

      const changes: FileChange[] = [{
        path: relativePath,
        operation: "modify",
        diff,
        originalContent,
        content: updatedContent,
      }];

      const decisions: BuildDecision[] = [{
        description: `Applied contract-scoped update to ${relativePath}`,
        rationale: contract.goal,
        alternatives: ["Refuse patch outside scope", "Request narrower contract"],
      }];

      const cost: CostEntry = {
        model,
        inputTokens: response.tokensIn,
        outputTokens: response.tokensOut,
        estimatedCostUsd: response.costUsd,
      };

      const output: BuilderResult["output"] = {
        kind: "builder",
        changes,
        decisions,
        needsCriticReview: true,
        contract,
        prompt,
        rawModelResponse: response.text,
      };

      this.eventBus?.emit({
        type: "builder_complete",
        payload: {
          taskId,
          workerType: this.type,
          file: relativePath,
          model,
          provider,
          costUsd: cost.estimatedCostUsd,
          tokensIn: response.tokensIn,
          tokensOut: response.tokensOut,
        },
      });

      return this.success(assignment, output, {
        cost,
        confidence: 0.78,
        touchedFiles: [
          { path: relativePath, operation: "read" },
          { path: relativePath, operation: "modify" },
        ],
        assumptions: [],
        issues: [],
        durationMs: Date.now() - startedAt,
      }) as BuilderResult;
    } catch (error) {
      this.eventBus?.emit({
        type: "task_failed",
        payload: {
          taskId,
          workerType: this.type,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      const { model } = this.getActiveModelConfig();
      return this.failure(
        assignment,
        error instanceof Error ? error.message : String(error),
        { model, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
        Date.now() - startedAt,
      ) as BuilderResult;
    }
  }

  protected emptyOutput(): BuilderOutput {
    return {
      kind: "builder",
      changes: [],
      decisions: [],
      needsCriticReview: true,
    };
  }

  // ─── Model Resolution ────────────────────────────────────────────

  private getActiveModelConfig(): { model: string; provider: string } {
    try {
      const config = loadModelConfig(this.projectRoot);
      return { model: config.builder.model, provider: config.builder.provider };
    } catch {
      return { model: this.defaultModel, provider: this.defaultProvider };
    }
  }

  // ─── Target Deduplication ────────────────────────────────────────

  private deduplicateTargets(files: readonly string[]): string[] {
    const resolved = new Set<string>();
    for (const file of files) {
      try {
        resolved.add(resolve(this.projectRoot, file));
      } catch {
        resolved.add(file);
      }
    }
    return [...resolved].map((abs) => this.toRelative(abs));
  }

  // ─── Contract & Prompt ───────────────────────────────────────────

  private buildContract(assignment: WorkerAssignment): TaskContract {
    const unique = this.deduplicateTargets(assignment.task.targetFiles);
    const file = unique[0] ?? assignment.task.targetFiles[0];
    const constraints = assignment.intent.constraints.map((c) => c.description);
    const forbiddenChanges = assignment.intent.exclusions ?? [];
    const interfaceRules = [
      "Do not change public names unless the task explicitly requires it.",
      "Preserve file-local style and module shape.",
      "Do not touch files outside the exact contract file.",
    ];
    return { file, goal: assignment.task.description, constraints, forbiddenChanges, interfaceRules };
  }

  private buildPrompt(
    contract: TaskContract,
    assignment: WorkerAssignment,
    originalContent: string,
    model: string,
    relativePath: string,
  ): string {
    // Build context summary — cap at maxContextTokens
    const contextParts: string[] = [];
    let contextTokens = 0;
    const charBudget = this.maxContextTokens * 4; // ~4 chars per token

    // Prefer scout summaries over raw file contents
    const scoutResult = assignment.upstreamResults.find((r) => r.workerType === "scout" && r.success);
    if (scoutResult && scoutResult.output.kind === "scout") {
      const approach = scoutResult.output.suggestedApproach;
      if (approach) {
        contextParts.push(`Scout assessment: ${approach}`);
        contextTokens += Math.ceil(approach.length / 4);
      }
    }

    // Add context files up to budget
    for (const layer of assignment.context.layers) {
      for (const file of layer.files) {
        if (file.path === contract.file) continue; // target is already included below
        const fileTokens = Math.ceil(file.content.length / 4);
        if (contextTokens + fileTokens > this.maxContextTokens) continue;
        contextParts.push(`FILE: ${file.path}\n${file.content}`);
        contextTokens += fileTokens;
      }
    }

    const context = contextParts.length > 0
      ? `\nRelevant context (${contextParts.length} items, ~${contextTokens} tokens):\n${contextParts.join("\n\n---\n\n")}`
      : "";

    return [
      `You are the Builder worker on model ${model}.`,
      `Target file: ${relativePath}`,
      `Goal: ${contract.goal}`,
      `Constraints: ${contract.constraints.join(" | ") || "none"}`,
      `Forbidden changes: ${contract.forbiddenChanges.join(" | ") || "none"}`,
      `Interface rules: ${contract.interfaceRules.join(" | ")}`,
      "",
      "IMPORTANT: Return ONLY a unified diff. No explanation. No commentary.",
      "The diff MUST use this exact format:",
      "",
      `--- a/${relativePath}`,
      `+++ b/${relativePath}`,
      "@@ -<start>,<count> +<start>,<count> @@",
      " context line (unchanged, prefixed with space)",
      "-removed line (prefixed with minus)",
      "+added line (prefixed with plus)",
      "",
      "Example of correct output for adding a line:",
      "",
      "--- a/src/utils.ts",
      "+++ b/src/utils.ts",
      "@@ -5,3 +5,4 @@",
      " import { resolve } from 'path';",
      " ",
      "+import { readFile } from 'fs/promises';",
      " export function helper() {",
      "",
      "Rules:",
      "- Include 1-3 lines of context before and after each change",
      "- Use correct line numbers in @@ headers",
      "- Multiple hunks are allowed for non-adjacent changes",
      "- If the contract cannot be satisfied, return an empty diff (just the --- and +++ headers with no hunks)",
      "",
      `Current file content of ${relativePath}:`,
      originalContent,
      context,
    ].filter((line) => line !== undefined).join("\n");
  }

  // ─── Response Processing ─────────────────────────────────────────

  /**
   * Process model response. Handles three response formats:
   * 1. Unified diff (preferred) — apply via DiffApplier
   * 2. Full file content in markdown fences — extract and use directly
   * 3. Raw full file content — use directly
   */
  private processModelResponse(
    raw: string,
    relativePath: string,
    originalContent: string,
  ): { updatedContent: string; diff: string } {
    // Strip markdown fences if present
    const stripped = this.stripMarkdownFences(raw);

    // Check if the response looks like a unified diff
    if (this.looksLikeDiff(stripped)) {
      console.log(`[Builder] Response is a unified diff, applying via DiffApplier`);
      const updatedContent = this.applyDiffToContent(stripped, originalContent);
      return {
        updatedContent,
        diff: stripped,
      };
    }

    // Fallback: treat as full file content
    console.log(`[Builder] Response is full file content, computing diff`);
    const updatedContent = stripped.trimEnd() + "\n";
    const diff = this.buildUnifiedDiff(relativePath, originalContent, updatedContent);
    return { updatedContent, diff };
  }

  /**
   * Strip markdown code fences from model output.
   * Handles ```diff, ```typescript, ```, etc.
   */
  private stripMarkdownFences(raw: string): string {
    const trimmed = raw.trim();

    // Match opening ``` with optional language tag, then content, then closing ```
    const fenced = trimmed.match(/^```(?:diff|patch|typescript|ts|javascript|js|text)?\s*\n([\s\S]*?)\n```\s*$/);
    if (fenced) return fenced[1];

    // Multiple fenced blocks — take the first one
    const firstBlock = trimmed.match(/```(?:diff|patch|typescript|ts|javascript|js|text)?\s*\n([\s\S]*?)\n```/);
    if (firstBlock) return firstBlock[1];

    return trimmed;
  }

  /**
   * Check if text looks like a unified diff.
   */
  private looksLikeDiff(text: string): boolean {
    return (
      /^---\s+\S/m.test(text) &&
      /^\+\+\+\s+\S/m.test(text) &&
      /^@@\s+-\d+/m.test(text)
    );
  }

  /**
   * Apply a unified diff to original content, returning the updated content.
   * Simple line-by-line application.
   */
  private applyDiffToContent(diff: string, originalContent: string): string {
    const lines = originalContent.split("\n");
    const hunks = this.parseHunks(diff);

    // Apply hunks in reverse order so line numbers stay valid
    const sortedHunks = [...hunks].sort((a, b) => b.oldStart - a.oldStart);

    for (const hunk of sortedHunks) {
      const { oldStart, removals, additions, contextBefore } = hunk;

      // Find the actual position using context matching
      let pos = oldStart - 1; // 0-indexed
      if (contextBefore.length > 0) {
        const found = this.findContextPosition(lines, contextBefore, pos);
        if (found >= 0) pos = found + contextBefore.length;
      }

      // Remove old lines and insert new ones
      if (removals.length > 0) {
        // Verify the lines we're removing match
        let matchPos = pos;
        for (const removal of removals) {
          if (matchPos < lines.length && lines[matchPos] === removal) {
            matchPos++;
          }
        }
        lines.splice(pos, removals.length, ...additions);
      } else if (additions.length > 0) {
        // Pure insertion
        lines.splice(pos, 0, ...additions);
      }
    }

    return lines.join("\n").trimEnd() + "\n";
  }

  private parseHunks(diff: string): Array<{
    oldStart: number;
    removals: string[];
    additions: string[];
    contextBefore: string[];
  }> {
    const hunks: Array<{
      oldStart: number;
      removals: string[];
      additions: string[];
      contextBefore: string[];
    }> = [];

    const diffLines = diff.split("\n");
    let i = 0;

    while (i < diffLines.length) {
      const headerMatch = diffLines[i].match(/^@@\s+-(\d+)(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@/);
      if (!headerMatch) {
        i++;
        continue;
      }

      const oldStart = parseInt(headerMatch[1], 10);
      const removals: string[] = [];
      const additions: string[] = [];
      const contextBefore: string[] = [];
      let seenChange = false;
      i++;

      while (i < diffLines.length && !diffLines[i].startsWith("@@") && !diffLines[i].startsWith("--- ")) {
        const line = diffLines[i];
        if (line.startsWith("-")) {
          seenChange = true;
          removals.push(line.slice(1));
        } else if (line.startsWith("+")) {
          seenChange = true;
          additions.push(line.slice(1));
        } else if (line.startsWith(" ") || line === "") {
          if (!seenChange) {
            contextBefore.push(line.startsWith(" ") ? line.slice(1) : line);
          }
        }
        i++;
      }

      hunks.push({ oldStart, removals, additions, contextBefore });
    }

    return hunks;
  }

  private findContextPosition(lines: string[], context: string[], hint: number): number {
    // Try at hint first
    if (this.matchesAt(lines, context, hint)) return hint;

    // Search nearby
    for (let offset = 1; offset <= 10; offset++) {
      if (hint - offset >= 0 && this.matchesAt(lines, context, hint - offset)) return hint - offset;
      if (hint + offset < lines.length && this.matchesAt(lines, context, hint + offset)) return hint + offset;
    }

    return -1;
  }

  private matchesAt(lines: string[], pattern: string[], start: number): boolean {
    if (start + pattern.length > lines.length) return false;
    for (let i = 0; i < pattern.length; i++) {
      if (lines[start + i] !== pattern[i]) return false;
    }
    return true;
  }

  private enforceForbiddenChanges(contract: TaskContract, updatedContent: string): void {
    const lowered = updatedContent.toLowerCase();
    for (const forbidden of contract.forbiddenChanges) {
      if (!forbidden) continue;
      if (lowered.includes(forbidden.toLowerCase())) {
        throw new Error(`Builder output violates forbidden change rule: ${forbidden}`);
      }
    }
  }

  private buildUnifiedDiff(filePath: string, originalContent: string, updatedContent: string): string {
    const originalLines = originalContent.split(/\r?\n/);
    const updatedLines = updatedContent.split(/\r?\n/);
    const max = Math.max(originalLines.length, updatedLines.length);
    const body: string[] = [];
    for (let i = 0; i < max; i++) {
      const before = originalLines[i];
      const after = updatedLines[i];
      if (before === after) {
        if (before !== undefined) body.push(` ${before}`);
        continue;
      }
      if (before !== undefined) body.push(`-${before}`);
      if (after !== undefined) body.push(`+${after}`);
    }
    return [
      `--- a/${filePath}`,
      `+++ b/${filePath}`,
      `@@ -1,${originalLines.length} +1,${updatedLines.length} @@`,
      ...body,
    ].join("\n");
  }

  private resolveTarget(file: string): string {
    const abs = resolve(this.projectRoot, file);
    const normalizedRoot = this.projectRoot.endsWith(sep) ? this.projectRoot : `${this.projectRoot}${sep}`;
    if (abs !== this.projectRoot && !abs.startsWith(normalizedRoot)) {
      throw new Error(`Builder refused out-of-scope path: ${file}`);
    }
    return abs;
  }

  private toRelative(absPath: string): string {
    return relative(this.projectRoot, absPath).replace(/\\/g, "/");
  }

  private logFileTouch(taskId: string, path: string, operation: "read" | "create" | "modify" | "delete"): void {
    if (!this.runState) return;
    recordFileTouch(this.runState, { filePath: path, operation, taskId });
  }

  private noteDecision(taskId: string, description: string, rationale: string): void {
    if (!this.runState) return;
    recordDecision(this.runState, {
      description,
      madeBy: this.name,
      taskId,
      alternatives: [],
      rationale,
    });
  }
}

// ─── System Prompt ───────────────────────────────────────────────────

const BUILDER_SYSTEM_PROMPT = `You are the Builder worker in Zendorium, a governed AI build system.

Your job: produce a unified diff that implements exactly what the contract specifies.

OUTPUT FORMAT — You MUST return ONLY a unified diff. Nothing else. No explanation, no commentary, no markdown fences.

The diff format:
--- a/path/to/file
+++ b/path/to/file
@@ -<old_start>,<old_count> +<new_start>,<new_count> @@
 context line (space prefix = unchanged)
-removed line (minus prefix)
+added line (plus prefix)

Rules:
1. Include 1-3 lines of unchanged context before and after each change
2. Use correct line numbers in @@ hunk headers
3. Use multiple @@ hunks for non-adjacent changes
4. Every line must start with ' ', '-', or '+'
5. Do NOT wrap output in markdown code fences
6. If you cannot make the change, return only the --- and +++ headers with no hunks`;
