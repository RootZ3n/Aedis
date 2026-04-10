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

  constructor(config: BuilderWorkerConfig) {
    super();
    this.projectRoot = resolve(config.projectRoot);
    this.eventBus = config.eventBus ?? null;
    this.runState = config.runState ?? null;
    this.defaultModel = config.defaultModel ?? "qwen3.6-plus";
    this.defaultProvider = config.defaultProvider ?? "modelstudio";
    this.diffApplier = new DiffApplier();
  }

  canHandle(assignment: WorkerAssignment): boolean {
    return assignment.task.targetFiles.length === 1;
  }

  async estimateCost(assignment: WorkerAssignment): Promise<CostEntry> {
    const contextChars = assignment.context.layers.reduce(
      (sum, layer) => sum + layer.files.reduce((inner, file) => inner + file.content.length, 0),
      0,
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
        throw new Error("Builder requires an exact single-file contract scope");
      }

      const { model, provider } = this.getActiveModelConfig();
      const contract = this.buildContract(assignment);
      const targetPath = this.resolveTarget(contract.file);
      const relativePath = this.toRelative(targetPath);
      const originalContent = await readFile(targetPath, "utf8");
      this.logFileTouch(taskId, relativePath, "read");

      const prompt = this.buildPrompt(contract, assignment, originalContent, model);

      // Real model call via unified invoker
      const response = await invokeModel({
        provider: provider as Provider,
        model,
        prompt,
        systemPrompt: "You are the Builder worker in Zendorium. Obey the contract exactly. Return ONLY the full final file content. No markdown fences. No explanations.",
        maxTokens: assignment.tokenBudget,
      });

      // Process model response — handles diff, fenced content, or raw content
      const { updatedContent, diff } = this.processModelResponse(response.text, relativePath, originalContent);
      this.enforceForbiddenChanges(contract, updatedContent);

      if (updatedContent === originalContent) {
        throw new Error("Model returned no effective file changes");
      }

      // Final safety gate: never write raw diff text to a source file
      if (DiffApplier.looksLikeRawDiff(updatedContent)) {
        throw new Error(`SAFETY: Refusing to write raw diff text to ${relativePath}`);
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

  // ─── Contract & Prompt ───────────────────────────────────────────

  private buildContract(assignment: WorkerAssignment): TaskContract {
    const file = assignment.task.targetFiles[0];
    const constraints = assignment.intent.constraints.map((c) => c.description);
    const forbiddenChanges = assignment.intent.exclusions ?? [];
    const interfaceRules = [
      "Do not change public names unless the task explicitly requires it.",
      "Preserve file-local style and module shape.",
      "Do not touch files outside the exact contract file.",
    ];
    return { file, goal: assignment.task.description, constraints, forbiddenChanges, interfaceRules };
  }

  private buildPrompt(contract: TaskContract, assignment: WorkerAssignment, originalContent: string, model: string): string {
    const context = assignment.context.layers
      .flatMap((layer) => layer.files.map((file) => `FILE: ${file.path}\n${file.content}`))
      .join("\n\n---\n\n");

    return [
      `You are the Builder worker on model ${model}.`,
      "You must obey the contract exactly.",
      `Target file: ${contract.file}`,
      `Goal: ${contract.goal}`,
      `Constraints: ${contract.constraints.join(" | ") || "none"}`,
      `Forbidden changes: ${contract.forbiddenChanges.join(" | ") || "none"}`,
      `Interface rules: ${contract.interfaceRules.join(" | ")}`,
      "Return ONLY the full final file content for the target file. No markdown fences. No explanations.",
      "If the contract cannot be satisfied without leaving scope, return the original file unchanged.",
      "Current file:",
      originalContent,
      context ? `\nRelevant context:\n${context}` : "",
    ].filter(Boolean).join("\n\n");
  }

  // ─── Response Processing ─────────────────────────────────────────

  /**
   * Process model response. Handles three response formats:
   * 1. Unified diff (preferred) — apply hunks to original content
   * 2. Full file content in markdown fences — extract and use directly
   * 3. Raw full file content — use directly
   *
   * CRITICAL: Never write raw diff text as file content. Always verify
   * the result looks like source code, not diff headers.
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
      console.log(`[Builder] Response is a unified diff, applying hunks to original content`);
      const updatedContent = this.diffApplier.applyToString(stripped, originalContent);

      // Safety: verify the result is source code, not diff text
      if (DiffApplier.looksLikeRawDiff(updatedContent)) {
        console.error(`[Builder] SAFETY: applyToString produced raw diff output, falling back to original`);
        throw new Error("Diff application produced raw diff text instead of patched source code");
      }

      const finalContent = updatedContent.trimEnd() + "\n";
      return { updatedContent: finalContent, diff: stripped };
    }

    // Fallback: treat as full file content — but verify it's not diff text
    if (DiffApplier.looksLikeRawDiff(stripped)) {
      // Model returned a diff but looksLikeDiff didn't catch it (malformed headers)
      // Try to apply it anyway
      console.warn(`[Builder] Response looks like malformed diff, attempting to apply`);
      try {
        const updatedContent = this.diffApplier.applyToString(stripped, originalContent);
        if (!DiffApplier.looksLikeRawDiff(updatedContent)) {
          const finalContent = updatedContent.trimEnd() + "\n";
          return { updatedContent: finalContent, diff: stripped };
        }
      } catch {
        // Fall through
      }
      throw new Error("Model returned diff-like output that could not be applied as a patch");
    }

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
