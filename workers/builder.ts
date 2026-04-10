import { readFile, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

import type { RunState, CostEntry } from "../core/runstate.js";
import { recordDecision, recordFileTouch } from "../core/runstate.js";
import {
  invokeModelWithFallback,
  createRunInvocationContext,
  type InvokeConfig,
  type Provider,
  type RunInvocationContext,
} from "../core/model-invoker.js";
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
  /**
   * Fallback model for when the primary provider times out or errors.
   * Defaults to claude-sonnet-4-6 on Anthropic. Set to null to disable
   * the fallback.
   */
  readonly fallbackModel?: { provider: Provider; model: string } | null;
}

// Default fallback chain target — Anthropic Claude Sonnet 4.6 as the
// quality backstop when ModelStudio (the Builder primary) is unreachable
// or rate-limited. Sonnet is also the Critic's primary model.
const DEFAULT_FALLBACK: { provider: Provider; model: string } = {
  provider: "anthropic",
  model: "claude-sonnet-4-6",
};

// Maximum number of run contexts to keep in memory. Each entry is tiny
// (a Set of provider strings), but we cap it to avoid unbounded growth
// across very long-lived processes.
const MAX_RUN_CONTEXTS = 50;

// ─── Prompt Size Caps ────────────────────────────────────────────────
//
// The Builder enforces a hard ceiling on prompt size to keep model calls
// fast and predictable. The cap is expressed in tokens, but enforced in
// chars (~4 chars per token is the standard rough estimate — actual
// tokenization varies by model, but this approximation is intentionally
// conservative so we never exceed the real limit).
//
//   PROMPT_TOKEN_CAP   — hard ceiling on the entire prompt
//   PROMPT_CHAR_CAP    — same, in chars (TOKEN_CAP * 4)
//   CONTEXT_TOKEN_CAP  — soft ceiling on the joined context layers block
//   CONTEXT_CHAR_CAP   — same, in chars
//
// The context block is truncated when it would exceed CONTEXT_CHAR_CAP
// OR when it would push the total prompt over PROMPT_CHAR_CAP, whichever
// is tighter. The originalContent and instructions are NEVER truncated —
// truncating the file being modified would corrupt the patch.
const PROMPT_TOKEN_CAP = 8_000;
const PROMPT_CHAR_CAP = PROMPT_TOKEN_CAP * 4;     // 32_000
const CONTEXT_TOKEN_CAP = 6_000;
const CONTEXT_CHAR_CAP = CONTEXT_TOKEN_CAP * 4;   // 24_000

// Reserved overhead for separators and the "Relevant context:" header
// when computing the available context budget.
const CONTEXT_OVERHEAD_CHARS = 64;

// ─── Internal types for prompt assembly ──────────────────────────────

interface BuiltPrompt {
  readonly prompt: string;
  readonly chars: number;
  readonly estimatedTokens: number;
  readonly fixedChars: number;
  readonly contextChars: number;
  readonly contextBudget: number;
  readonly truncated: ReadonlyArray<TruncatedFile>;
  readonly layersIncluded: number;
  readonly layersTotal: number;
  readonly originalContentChars: number;
}

interface TruncatedFile {
  readonly path: string;
  readonly chars: number;
  readonly layerIndex: number;
  readonly reason: string;
}

// Structural type for assignment.context.layers — kept loose so we don't
// depend on the exact AssembledContext shape from elsewhere.
type ContextLayers = ReadonlyArray<{
  readonly files: ReadonlyArray<{ readonly path: string; readonly content: string }>;
}>;

// ─── Builder Worker ──────────────────────────────────────────────────

export class BuilderWorker extends AbstractWorker {
  readonly type = "builder" as const;
  readonly name = "Builder Worker";

  private readonly projectRoot: string;
  private readonly eventBus: EventBus | null;
  private readonly runState: RunState | null;
  private readonly defaultModel: string;
  private readonly defaultProvider: Provider;
  private readonly fallbackModel: { provider: Provider; model: string } | null;
  private readonly diffApplier: DiffApplier;

  /**
   * Per-run fallback contexts. Keyed by intent.runId so the timeout
   * blacklist persists across multiple Builder.execute() calls within
   * a single Coordinator run, but does NOT leak across runs.
   *
   * The map is bounded by MAX_RUN_CONTEXTS — when full, the oldest
   * entry is evicted (insertion order, FIFO).
   */
  private readonly runContexts = new Map<string, RunInvocationContext>();

  constructor(config: BuilderWorkerConfig) {
    super();
    this.projectRoot = resolve(config.projectRoot);
    this.eventBus = config.eventBus ?? null;
    this.runState = config.runState ?? null;
    // CURRENT DEFAULTS: ModelStudio qwen3.6-plus as primary.
    // ModelStudio is slow (often near the 5-minute timeout cap) but reliable
    // and cheap on a per-token basis. The Anthropic Sonnet fallback is the
    // quality backstop for when ModelStudio is unreachable or rate-limited.
    // See DOCTRINE.md "Model Assignments" for the rationale.
    this.defaultModel = config.defaultModel ?? "qwen3.6-plus";
    this.defaultProvider = config.defaultProvider ?? "modelstudio";
    this.fallbackModel = config.fallbackModel === null
      ? null
      : (config.fallbackModel ?? DEFAULT_FALLBACK);
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

      const { model: primaryModel, provider: primaryProvider } = this.getActiveModelConfig();
      const contract = this.buildContract(assignment);
      const targetPath = this.resolveTarget(contract.file);
      const relativePath = this.toRelative(targetPath);
      const originalContent = await readFile(targetPath, "utf8");
      this.logFileTouch(taskId, relativePath, "read");

      // Build prompt using the *primary* model name. The fallback model sees
      // the same prompt — it's not aware of the model identity in the prompt
      // text, so this is purely a label inside the system message.
      const built = this.buildPrompt(contract, assignment, originalContent, primaryModel);
      const prompt = built.prompt;

      // Truncation log — emit BEFORE the prompt-size log so the operator
      // sees what was dropped first, then the resulting size.
      if (built.truncated.length > 0) {
        const dropped = built.truncated
          .map((t) => `${t.path} (${t.chars} chars, layer ${t.layerIndex}: ${t.reason})`)
          .join("; ");
        console.warn(
          `[builder] context truncated: ${built.truncated.length} file(s) dropped to fit ` +
          `${built.contextBudget}-char context budget (cap=${CONTEXT_CHAR_CAP}, ` +
          `kept ${built.layersIncluded}/${built.layersTotal} layer(s)) — ${dropped}`
        );
      }

      // Hard-ceiling check — if the originalContent + fixed sections alone
      // exceed PROMPT_CHAR_CAP, we cannot truncate further without corrupting
      // the patch. Log loudly so the operator knows the model may refuse.
      if (built.chars > PROMPT_CHAR_CAP) {
        console.warn(
          `[builder] WARN: prompt is ${built.chars} chars (~${built.estimatedTokens} tokens), ` +
          `over the ${PROMPT_CHAR_CAP}-char cap. originalContent alone is ${built.originalContentChars} chars. ` +
          `The Builder will proceed but the model may truncate or refuse.`
        );
      }

      // Required log line — emit immediately before the model call.
      console.log(
        `[builder] prompt size: ~${built.estimatedTokens} tokens (${built.chars} chars)`
      );

      // Build fallback chain: primary first, Anthropic Sonnet second.
      // If the primary IS already anthropic, don't append a duplicate fallback.
      const chain = this.buildInvocationChain(
        primaryProvider as Provider,
        primaryModel,
        prompt,
        assignment.tokenBudget,
      );

      // Look up (or create) the per-run fallback context. The runId comes
      // from the intent so the blacklist scope = the Coordinator run.
      const runId = this.extractRunId(assignment);
      const runCtx = this.getOrCreateRunContext(runId);

      console.log(
        `[builder] dispatching with fallback chain (${chain.length} entries) for run ${runId.slice(0, 8)}: ${chain.map(c => `${c.provider}/${c.model}`).join(" → ")}`
      );

      // Real model call via fallback-aware invoker
      const response = await invokeModelWithFallback(chain, runCtx);

      if (response.usedProvider !== primaryProvider) {
        console.warn(
          `[builder] PRIMARY FAILED — used fallback ${response.usedProvider}/${response.usedModel} ` +
          `instead of ${primaryProvider}/${primaryModel} (attempted: ${response.attemptedProviders.join(", ")})`
        );
        this.noteDecision(
          taskId,
          `Builder fell back from ${primaryProvider}/${primaryModel} to ${response.usedProvider}/${response.usedModel}`,
          `Primary provider failed mid-run; fallback chain promoted next entry`,
        );
      }

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

      // Cost entry reflects the provider that ACTUALLY succeeded, not the
      // primary. If the fallback path was taken, the model name in the
      // receipt should match what was actually called.
      const cost: CostEntry = {
        model: response.usedModel,
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
          model: response.usedModel,
          provider: response.usedProvider,
          costUsd: cost.estimatedCostUsd,
          tokensIn: response.tokensIn,
          tokensOut: response.tokensOut,
          fellBack: response.usedProvider !== primaryProvider,
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

  // ─── Fallback Chain Construction ────────────────────────────────

  /**
   * Build the InvokeConfig chain for a single Builder.execute() call.
   *
   * Chain order:
   *   1. Primary (active config — usually modelstudio/qwen3.6-plus)
   *   2. Quality fallback (anthropic/claude-sonnet-4-6) — UNLESS the
   *      primary already IS anthropic, in which case the fallback is
   *      skipped to avoid pointlessly retrying the same provider.
   *
   * The fallback can be disabled by passing `fallbackModel: null` in
   * the BuilderWorkerConfig at construction time.
   */
  private buildInvocationChain(
    primaryProvider: Provider,
    primaryModel: string,
    prompt: string,
    tokenBudget: number,
  ): InvokeConfig[] {
    const systemPrompt =
      "You are the Builder worker in Zendorium. Obey the contract exactly. Return ONLY the full final file content. No markdown fences. No explanations.";

    const chain: InvokeConfig[] = [{
      provider: primaryProvider,
      model: primaryModel,
      prompt,
      systemPrompt,
      maxTokens: tokenBudget,
    }];

    if (this.fallbackModel && this.fallbackModel.provider !== primaryProvider) {
      chain.push({
        provider: this.fallbackModel.provider,
        model: this.fallbackModel.model,
        prompt,
        systemPrompt,
        maxTokens: tokenBudget,
      });
    }

    return chain;
  }

  // ─── Run Context Management ─────────────────────────────────────

  /**
   * Pull the runId off the assignment so we can scope the timeout
   * blacklist correctly. Falls back to the task ID if the intent has no
   * runId field — this still gives us per-task isolation, just without
   * cross-task blacklist sharing.
   */
  private extractRunId(assignment: WorkerAssignment): string {
    const intentAny = assignment.intent as { runId?: unknown; id?: unknown };
    if (typeof intentAny.runId === "string" && intentAny.runId) return intentAny.runId;
    if (typeof intentAny.id === "string" && intentAny.id) return intentAny.id;
    return assignment.task.id;
  }

  private getOrCreateRunContext(runId: string): RunInvocationContext {
    let ctx = this.runContexts.get(runId);
    if (!ctx) {
      ctx = createRunInvocationContext();
      this.runContexts.set(runId, ctx);
      // Bounded LRU: when over the cap, drop the oldest entry (insertion order).
      while (this.runContexts.size > MAX_RUN_CONTEXTS) {
        const firstKey = this.runContexts.keys().next().value;
        if (firstKey === undefined) break;
        this.runContexts.delete(firstKey);
      }
    }
    return ctx;
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

  /**
   * Build the full Builder prompt with hard size enforcement.
   *
   * Returns a BuiltPrompt object containing the assembled prompt text plus
   * size accounting (chars, estimated tokens, what was truncated, how
   * many context layers survived). The caller is responsible for emitting
   * the truncation warning and the prompt-size log line.
   *
   * Budget hierarchy:
   *   1. Fixed sections (instructions + originalContent) — never truncated.
   *      If these alone exceed PROMPT_CHAR_CAP, the prompt goes over and
   *      the operator gets a loud warning at the call site.
   *   2. Context block — capped at min(remaining_budget, CONTEXT_CHAR_CAP).
   *      Truncated by dropping later layers and later files within a layer
   *      first. Layer order in the assembled context is the priority order
   *      from the ContextAssembler (target files → dependencies → patterns
   *      → tests → similar implementations), so dropping from the tail
   *      preserves the most relevant material.
   */
  private buildPrompt(
    contract: TaskContract,
    assignment: WorkerAssignment,
    originalContent: string,
    model: string,
  ): BuiltPrompt {
    // Build the fixed (non-context) parts first so we can compute the
    // remaining budget for the context block.
    const fixedParts = [
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
    ];
    const fixedJoined = fixedParts.join("\n\n");
    const fixedChars = fixedJoined.length;

    // Compute the context budget. The TOTAL prompt cannot exceed
    // PROMPT_CHAR_CAP. The CONTEXT block additionally cannot exceed
    // CONTEXT_CHAR_CAP. Whichever is tighter wins. If the fixed sections
    // alone are already over the cap, the context budget is 0 and
    // EVERYTHING gets logged as truncated.
    const remainingForContext = PROMPT_CHAR_CAP - fixedChars - CONTEXT_OVERHEAD_CHARS;
    const contextBudget = Math.min(Math.max(remainingForContext, 0), CONTEXT_CHAR_CAP);

    const layers = assignment.context.layers as ContextLayers;
    const layersTotal = layers.length;
    let contextBlock = "";
    let contextChars = 0;
    let layersIncluded = 0;
    const truncated: TruncatedFile[] = [];

    if (contextBudget > 0 && layersTotal > 0) {
      const built = this.assembleContextWithBudget(layers, contextBudget);
      contextBlock = built.context;
      contextChars = built.context.length;
      truncated.push(...built.truncated);
      layersIncluded = built.layersIncluded;
    } else if (layersTotal > 0) {
      // Zero budget — log every file as truncated so the operator can see
      // the prompt was over budget before context even got a chance.
      const reason = contextBudget <= 0
        ? "fixed sections (instructions + originalContent) consumed entire prompt budget"
        : "no context layers requested";
      for (let i = 0; i < layers.length; i++) {
        for (const file of layers[i].files) {
          truncated.push({
            path: file.path,
            chars: file.content.length,
            layerIndex: i,
            reason,
          });
        }
      }
    }

    const promptParts = [...fixedParts];
    if (contextBlock) {
      promptParts.push(`\nRelevant context:\n${contextBlock}`);
    }
    const prompt = promptParts.join("\n\n");
    const chars = prompt.length;
    const estimatedTokens = Math.ceil(chars / 4);

    return {
      prompt,
      chars,
      estimatedTokens,
      fixedChars,
      contextChars,
      contextBudget,
      truncated,
      layersIncluded,
      layersTotal,
      originalContentChars: originalContent.length,
    };
  }

  /**
   * Assemble the context block under a hard char budget.
   *
   * Walks layers in priority order. For each file, computes its serialized
   * cost (`FILE: path\ncontent` plus separator overhead). If adding the
   * file would exceed the budget, the file is recorded as truncated and
   * skipped. Files within a layer are walked in order, so earlier files
   * win when budget is tight.
   *
   * Returns the joined context string (separators included), the list of
   * truncated files, and the count of layers that contributed at least
   * one file.
   */
  private assembleContextWithBudget(
    layers: ContextLayers,
    charBudget: number,
  ): {
    readonly context: string;
    readonly truncated: TruncatedFile[];
    readonly layersIncluded: number;
  } {
    const SEP = "\n\n---\n\n";
    const truncated: TruncatedFile[] = [];
    const parts: string[] = [];
    let used = 0;
    let layersIncluded = 0;

    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i];
      let anyFromThisLayer = false;
      for (const file of layer.files) {
        const entry = `FILE: ${file.path}\n${file.content}`;
        const cost = entry.length + (parts.length > 0 ? SEP.length : 0);
        if (used + cost > charBudget) {
          truncated.push({
            path: file.path,
            chars: file.content.length,
            layerIndex: i,
            reason: `would exceed ${charBudget}-char context budget (used=${used}, needed=${cost})`,
          });
          continue;
        }
        parts.push(entry);
        used += cost;
        anyFromThisLayer = true;
      }
      if (anyFromThisLayer) layersIncluded++;
    }

    return { context: parts.join(SEP), truncated, layersIncluded };
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
