import type { RunState, CostEntry, Issue } from "../core/runstate.js";
import { recordDecision } from "../core/runstate.js";
import {
  invokeModelWithFallback,
  createRunInvocationContext,
  type InvokeConfig,
  type Provider,
  type RunInvocationContext,
} from "../core/model-invoker.js";
import { loadModelConfig } from "../server/routes/config.js";
import type { EventBus } from "../server/websocket.js";
import {
  AbstractWorker,
  validateWorkerAssignment,
  type BuilderOutput,
  type CriticOutput,
  type FileChange,
  type ReviewComment,
  type WorkerAssignment,
  type WorkerResult,
} from "./base.js";
import type { ModelInvocation, ModelResponse, TaskContract } from "./builder.js";

// ─── Types ───────────────────────────────────────────────────────────

export interface CriticResult extends WorkerResult {
  readonly output: CriticOutput & {
    readonly status: "approved" | "rejected" | "needs-revision";
    readonly issuesList: readonly Issue[];
    readonly contract: TaskContract | null;
    readonly rawModelReview?: string;
  };
}

export interface CriticWorkerConfig {
  readonly projectRoot?: string;
  readonly eventBus?: EventBus;
  readonly runState?: RunState;
  readonly defaultModel?: string;
  readonly defaultProvider?: Provider;
  /**
   * Local fallback model for when the primary provider times out or errors.
   * Defaults to qwen3.5:9b on Ollama. Set to null to disable the fallback.
   */
  readonly fallbackModel?: { provider: Provider; model: string } | null;
}

// Default fallback chain target — local Ollama, free, no API key needed.
const DEFAULT_FALLBACK: { provider: Provider; model: string } = {
  provider: "ollama",
  model: "qwen3.5:9b",
};

// Maximum number of run contexts to keep in memory. Each entry is tiny
// (a Set of provider strings), but we cap it to avoid unbounded growth
// across very long-lived processes.
const MAX_RUN_CONTEXTS = 50;

// ─── Critic Worker ───────────────────────────────────────────────────
//
// RESPONSIBILITY: Evaluates the PROPOSED DIFF for quality and correctness.
// The Critic answers: "Is this diff good?" — reviewing code quality,
// correctness, adherence to the charter, and suggesting changes.
//
// This is distinct from:
//   - Verifier: evaluates REPO STATE after apply (tests, lint, typecheck)
//   - IntegrationJudge: evaluates cross-file structural coherence
//   - Velum: evaluates security concerns (injection, secrets)
//
// The Critic does NOT run tests, lint, or typecheck. It reviews the diff.

export class CriticWorker extends AbstractWorker {
  readonly type = "critic" as const;
  readonly name = "Critic Worker";

  private readonly projectRoot: string;
  private readonly eventBus: EventBus | null;
  private readonly runState: RunState | null;
  private readonly defaultModel: string;
  private readonly defaultProvider: Provider;
  private readonly fallbackModel: { provider: Provider; model: string } | null;

  /**
   * Per-run fallback contexts. Keyed by intent.runId so the timeout
   * blacklist persists across multiple Critic.execute() calls within
   * a single Coordinator run, but does NOT leak across runs.
   *
   * The map is bounded by MAX_RUN_CONTEXTS — when full, the oldest
   * entry is evicted (insertion order, FIFO).
   */
  private readonly runContexts = new Map<string, RunInvocationContext>();

  constructor(config: CriticWorkerConfig = {}) {
    super();
    // NOTE: this.projectRoot is the constructor-time default. In production
    // it's the API server's cwd (typically /mnt/ai/Zendorium). Per-task
    // submissions can override via assignment.projectRoot, which is what
    // execute() reads first; this field is the fallback for tests and
    // stand-alone harnesses that bypass the assignment-based wiring.
    this.projectRoot = config.projectRoot ?? process.cwd();
    this.eventBus = config.eventBus ?? null;
    this.runState = config.runState ?? null;
    // NEW DEFAULTS: Anthropic Claude Sonnet 4.6 as primary review model.
    // Critic gates the entire pipeline — using a stronger model here pays
    // for itself by catching issues before they reach Verify or Apply.
    // The local Ollama fallback exists so a transient Anthropic outage
    // cannot stall the entire pipeline. See DOCTRINE.md "Model Assignments".
    // Defaults to local ollama — Aedis is meant to be cheap; any need for
    // Anthropic must come through explicit per-repo config, not a silent
    // backstop that blows up the cost budget.
    this.defaultModel = config.defaultModel ?? "qwen3.5:9b";
    this.defaultProvider = config.defaultProvider ?? "ollama";
    this.fallbackModel = config.fallbackModel === null
      ? null
      : (config.fallbackModel ?? DEFAULT_FALLBACK);
  }

  async estimateCost(assignment: WorkerAssignment): Promise<CostEntry> {
    // Resolve effective projectRoot from the assignment first; the
    // constructor-time field is the fallback for tests/standalone use.
    const projectRoot = assignment.projectRoot ?? this.projectRoot;
    const configRoot = assignment.sourceRepo ?? projectRoot;
    const { model } = this.getActiveModelConfig(configRoot);
    return {
      model,
      inputTokens: Math.ceil((assignment.task.description.length + JSON.stringify(assignment.upstreamResults).length) / 4),
      outputTokens: 600,
      estimatedCostUsd: 0.0006,
    };
  }

  async execute(assignment: WorkerAssignment): Promise<CriticResult> {
    // FAIL-FAST: reject malformed assignments at the worker boundary.
    // eslint-disable-next-line @typescript-eslint/no-use-before-define
    validateWorkerAssignment(assignment, this.type);


    const startedAt = Date.now();
    const builderResult = assignment.upstreamResults.find((r) => r.workerType === "builder" && r.success);

    // Resolve the effective projectRoot for this submission. Coordinator.dispatchNode
    // populates assignment.projectRoot for every production dispatch. Falls
    // back to this.projectRoot (constructor-time, the API server's cwd) when
    // no override is provided — the test/standalone-harness path.
    const projectRoot = assignment.projectRoot ?? this.projectRoot;
    // Model assignments live at the SOURCE repo's .aedis/model-config.json,
    // which is gitignored and therefore absent from the workspace worktree.
    // Prefer sourceRepo when the Coordinator supplied it.
    const configRoot = assignment.sourceRepo ?? projectRoot;

    try {
      if (!builderResult || builderResult.output.kind !== "builder") {
        throw new Error("Critic requires a successful BuilderResult upstream");
      }

      const { model: primaryModel, provider: primaryProvider } = this.getActiveModelConfig(configRoot);
      const builderOutput = builderResult.output as BuilderOutput & { contract?: TaskContract };
      const changes = builderOutput.changes;
      const contract = builderOutput.contract ?? null;
      const heuristicIssues = this.runHeuristicChecks(changes, contract, assignment);
      const heuristicComments = this.toComments(heuristicIssues, changes[0]?.path ?? assignment.task.targetFiles[0] ?? "unknown");

      // Model review via fallback-aware invoker.
      // The model call only runs when there's a contract — heuristic-only
      // reviews skip the model entirely (and report zero model cost).
      let rawModelReview: string | undefined;
      let modelTokensIn = 0;
      let modelTokensOut = 0;
      let modelCostUsd = 0;
      let usedModel = primaryModel;
      let usedProvider: Provider = primaryProvider as Provider;
      let fellBack = false;

      if (contract) {
        const prompt = this.buildPrompt(contract, changes, heuristicIssues, assignment, primaryModel);

        // Build fallback chain: primary first, local Ollama second.
        // If the primary IS already ollama, the fallback is skipped.
        const chain = this.buildInvocationChain(
          primaryProvider as Provider,
          primaryModel,
          prompt,
          2048,
        );

        // Look up (or create) the per-run fallback context. The runId comes
        // from the intent so the blacklist scope = the Coordinator run.
        const runId = this.extractRunId(assignment);
        const runCtx = this.getOrCreateRunContext(runId);

        console.log(
          `[critic] dispatching with fallback chain (${chain.length} entries) for run ${runId.slice(0, 8)}: ${chain.map(c => `${c.provider}/${c.model}`).join(" → ")}`
        );

        const response = await invokeModelWithFallback(chain, runCtx);

        if (response.usedProvider !== primaryProvider) {
          console.warn(
            `[critic] PRIMARY FAILED — used fallback ${response.usedProvider}/${response.usedModel} ` +
            `instead of ${primaryProvider}/${primaryModel} (attempted: ${response.attemptedProviders.join(", ")})`
          );
          this.noteDecision(
            assignment.task.id,
            `Critic fell back from ${primaryProvider}/${primaryModel} to ${response.usedProvider}/${response.usedModel}`,
            `Primary provider failed mid-run; fallback chain promoted next entry`,
          );
          fellBack = true;
        }

        rawModelReview = response.text;
        modelTokensIn = response.tokensIn;
        modelTokensOut = response.tokensOut;
        modelCostUsd = response.costUsd;
        usedModel = response.usedModel;
        usedProvider = response.usedProvider;
      }

      const status: CriticResult["output"]["status"] = heuristicIssues.some((i) => i.severity === "critical")
        ? "rejected"
        : heuristicIssues.some((i) => i.severity === "error" || i.severity === "warning")
          ? "needs-revision"
          : "approved";

      const output: CriticResult["output"] = {
        kind: "critic",
        verdict: status === "approved" ? "approve" : status === "needs-revision" ? "request-changes" : "reject",
        comments: heuristicComments,
        suggestedChanges: [],
        intentAlignment: status === "approved" ? 0.92 : status === "needs-revision" ? 0.68 : 0.3,
        status,
        issuesList: heuristicIssues,
        contract,
        rawModelReview,
      };

      if (status !== "approved") {
        this.noteDecision(assignment.task.id, `Critic flagged ${status}`, heuristicIssues.map((i) => i.message).join(" | "));
      }

      // Calibrated critic confidence — higher when the review approved,
      // lower when changes were requested. Computed once so the live
      // event emit and the WorkerResult report the same number.
      const criticConfidence = status === "approved" ? 0.84 : 0.71;

      this.eventBus?.emit({
        type: "critic_review",
        payload: {
          runId: this.extractRunId(assignment),
          taskId: assignment.task.id,
          workerType: this.type,
          // Reflect the provider that ACTUALLY succeeded, not the primary,
          // so the receipt stream and UI show the real cost source.
          model: usedModel,
          provider: usedProvider,
          status,
          issues: heuristicIssues.length,
          costUsd: modelCostUsd,
          fellBack,
          confidence: criticConfidence,
        },
      });

      return this.success(assignment, output, {
        // Cost entry reflects the provider that ACTUALLY succeeded, not the
        // primary. If the fallback path was taken, the model name in the
        // receipt should match what was actually called.
        cost: {
          model: usedModel,
          inputTokens: modelTokensIn,
          outputTokens: modelTokensOut,
          estimatedCostUsd: modelCostUsd,
        },
        confidence: criticConfidence,
        touchedFiles: [],
        issues: heuristicIssues,
        durationMs: Date.now() - startedAt,
      }) as CriticResult;
    } catch (error) {
      this.eventBus?.emit({
        type: "task_failed",
        payload: {
          taskId: assignment.task.id,
          workerType: this.type,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      const { model } = this.getActiveModelConfig(configRoot);
      return this.failure(
        assignment,
        error instanceof Error ? error.message : String(error),
        { model, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
        Date.now() - startedAt,
      ) as CriticResult;
    }
  }

  protected emptyOutput(): CriticOutput {
    return {
      kind: "critic",
      verdict: "request-changes",
      comments: [],
      suggestedChanges: [],
      intentAlignment: 0,
    };
  }

  // ─── Model Resolution ────────────────────────────────────────────

  /**
   * Resolve the active model configuration for a given projectRoot.
   * Each call reads .aedis/model-config.json from the supplied root
   * (with .zendorium/model-config.json as a legacy fallback), so
   * per-task projectRoot overrides honor per-repo model configurations
   * if the user has them.
   */
  private getActiveModelConfig(projectRoot: string): { model: string; provider: string } {
    try {
      const config = loadModelConfig(projectRoot);
      return { model: config.critic.model, provider: config.critic.provider };
    } catch {
      return { model: this.defaultModel, provider: this.defaultProvider };
    }
  }

  // ─── Fallback Chain Construction ────────────────────────────────

  /**
   * Build the InvokeConfig chain for a single Critic.execute() call.
   *
   * Chain order:
   *   1. Primary (active config — usually anthropic/claude-sonnet-4-6)
   *   2. Local fallback (qwen3.5:9b on Ollama) — UNLESS the primary
   *      already IS ollama, in which case the fallback is skipped to
   *      avoid pointlessly retrying the same provider.
   *
   * The fallback can be disabled by passing `fallbackModel: null` in
   * the CriticWorkerConfig at construction time.
   *
   * Mirrors workers/builder.ts buildInvocationChain exactly.
   */
  private buildInvocationChain(
    primaryProvider: Provider,
    primaryModel: string,
    prompt: string,
    tokenBudget: number,
  ): InvokeConfig[] {
    const systemPrompt =
      "You are the Critic worker in Aedis. Review code changes for correctness, style, and contract compliance. Be terse. Report blockers clearly.";

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
   *
   * Mirrors workers/builder.ts extractRunId exactly so both workers
   * key into the same logical run.
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

  // ─── Heuristic Checks ───────────────────────────────────────────

  private runHeuristicChecks(changes: readonly FileChange[], contract: TaskContract | null, assignment: WorkerAssignment): Issue[] {
    const issues: Issue[] = [];
    // Normalize both sides of the scope check so mixed absolute/relative
    // shapes don't fire a false "Scope drift". The Coordinator canonicalizes
    // upstream but a defensive normalization here stops any future regression
    // from reaching a user-visible block.
    const stripSource = (p: string): string => {
      const src = assignment.sourceRepo;
      if (src && p.startsWith(src)) return p.slice(src.length).replace(/^[\\/]+/, "");
      return p;
    };
    const allowedFiles = new Set(assignment.task.targetFiles.map(stripSource));

    for (const change of changes) {
      const normalized = stripSource(change.path);
      if (!allowedFiles.has(normalized) && !allowedFiles.has(change.path)) {
        issues.push({ severity: "critical", message: `Scope drift: ${change.path} is outside contract scope`, file: change.path });
      }
      if (change.diff?.includes("TODO") || change.content?.includes("TODO")) {
        issues.push({ severity: "warning", message: "Builder left TODO markers in output", file: change.path });
      }
      if (change.diff?.match(/^\+\s*console\.log/m) || change.content?.match(/console\.log\(/)) {
        issues.push({ severity: "warning", message: "Debug logging added without contract approval", file: change.path });
      }
      if (!change.diff || change.diff.trim().length < 24) {
        issues.push({ severity: "error", message: "Builder change lacks a meaningful diff", file: change.path });
      }
    }

    if (contract) {
      for (const forbidden of contract.forbiddenChanges) {
        for (const change of changes) {
          if (change.content?.toLowerCase().includes(forbidden.toLowerCase())) {
            issues.push({ severity: "critical", message: `Forbidden edit detected: ${forbidden}`, file: change.path });
          }
        }
      }
    }

    if (assignment.task.description.toLowerCase().includes("read only") && changes.length > 0) {
      issues.push({ severity: "critical", message: "Contract violation: builder changed files for a read-only task" });
    }

    return issues;
  }

  private toComments(issues: readonly Issue[], file: string): ReviewComment[] {
    return issues.map((issue) => ({
      file: issue.file ?? file,
      line: issue.line,
      severity: issue.severity === "critical" ? "blocker" : issue.severity === "error" ? "concern" : issue.severity === "warning" ? "suggestion" : "nit",
      message: issue.message,
    }));
  }

  private buildPrompt(contract: TaskContract, changes: readonly FileChange[], issues: readonly Issue[], assignment: WorkerAssignment, model: string): string {
    return [
      `You are the Critic worker on model ${model}.`,
      "Review only. Do not rewrite code.",
      `Task: ${assignment.task.description}`,
      `Contract file: ${contract.file}`,
      `Forbidden changes: ${contract.forbiddenChanges.join(" | ") || "none"}`,
      `Interface rules: ${contract.interfaceRules.join(" | ")}`,
      `Heuristic issues: ${issues.map((i) => i.message).join(" | ") || "none"}`,
      `Diffs: ${changes.map((c) => c.diff ?? `${c.path} changed`).join("\n\n")}`,
      "Return a terse review summary and any blockers.",
    ].join("\n\n");
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
