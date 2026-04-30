import type { RunState, CostEntry, Issue } from "../core/runstate.js";
import { recordDecision } from "../core/runstate.js";
import {
  invokeModelWithFallback,
  createRunInvocationContext,
  InvokerError,
  type InvokeAttempt,
  type InvokeConfig,
  type Provider,
  type RunInvocationContext,
} from "../core/model-invoker.js";
import { loadModelConfig, resolveAssignmentChain } from "../server/routes/config.js";
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

// ─── Critic Prompt Truncation ────────────────────────────────────────
//
// The Critic model gets the full set of Builder diffs in its prompt.
// Without a cap, a multi-file refactor (or a single big migration) can
// produce a prompt large enough that the upstream stage timeout (180s)
// fires while the model is still streaming. Truncating each per-file
// diff to a head + tail slice with an explicit elision marker keeps the
// review signal intact (Critic still sees what changed at the top and
// bottom of each diff) while bounding the prompt to a few KB.
//
// These caps are deliberately conservative — bigger than any single
// reasonable diff fragment, smaller than the prompt sizes that have
// surfaced as 180s timeouts in production. Exported for the unit test.

export const MAX_DIFF_CHARS_PER_FILE = 3000;
export const MAX_DIFF_CHARS_TOTAL = 12000;

/**
 * Slice an oversized diff to head + tail with an elision marker. The
 * head/tail split prefers the head (so the file/operation context near
 * the start is preserved) but always keeps a tail tail so the closing
 * lines are visible. Diffs at or under maxChars pass through unchanged.
 */
export function truncateDiffForReview(
  diff: string | undefined | null,
  maxChars: number,
): string {
  if (!diff) return "(no diff)";
  if (maxChars <= 0) return "(diff omitted — review budget exhausted)";
  if (diff.length <= maxChars) return diff;
  const headBudget = Math.max(0, Math.floor(maxChars * 0.7));
  const tailBudget = Math.max(0, Math.floor(maxChars * 0.2));
  const head = diff.slice(0, headBudget);
  const tail = tailBudget > 0 ? diff.slice(-tailBudget) : "";
  const elided = diff.length - head.length - tail.length;
  return `${head}\n... [${elided} chars truncated for critic review] ...\n${tail}`;
}

/**
 * Build the per-change diff section for the Critic prompt under a
 * total-prompt budget. Each file gets up to MAX_DIFF_CHARS_PER_FILE
 * characters, and the cumulative budget is capped at
 * MAX_DIFF_CHARS_TOTAL so a 50-file change-set can't drag the prompt
 * past the timeout cliff.
 */
export function summarizeChangesForCriticReview(
  changes: readonly { path: string; diff?: string }[],
): string {
  let totalUsed = 0;
  const parts: string[] = [];
  for (const change of changes) {
    const remaining = MAX_DIFF_CHARS_TOTAL - totalUsed;
    if (remaining <= 0) {
      parts.push(`${change.path}: diff omitted — total review budget exhausted`);
      continue;
    }
    const perFileBudget = Math.min(MAX_DIFF_CHARS_PER_FILE, remaining);
    const truncated = truncateDiffForReview(change.diff, perFileBudget);
    totalUsed += truncated.length;
    parts.push(`${change.path}:\n${truncated}`);
  }
  return parts.join("\n\n");
}

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
    // it's the API server's cwd. Per-task
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
    // Declared at execute() scope so the catch handler can also surface
    // any attempts captured before a downstream throw.
    let providerAttempts: readonly InvokeAttempt[] = [];

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
      // The model call only runs when there's a contract AND this is not
      // a fast-path trivial edit. Fast-path runs skip the model entirely
      // (heuristic-only critic) to reduce pipeline cost while still
      // enforcing scope drift, forbidden changes, and other safety checks.
      let rawModelReview: string | undefined;
      let modelTokensIn = 0;
      let modelTokensOut = 0;
      let modelCostUsd = 0;
      let usedModel = primaryModel;
      let usedProvider: Provider = primaryProvider as Provider;
      let fellBack = false;

      if (assignment.fastPath) {
        console.log(`[critic] fast-path: skipping model review, heuristic-only`);
        rawModelReview = "[critic_fast_path] heuristic-only review — trivial single-file edit";
      } else if (contract) {
        const prompt = this.buildPrompt(contract, changes, heuristicIssues, assignment, primaryModel);

        // Read the per-repo declared chain from .aedis/model-config.json.
        // When present, it REPLACES the constructor-level legacy
        // `this.fallbackModel` — see buildInvocationChain for the merge
        // rule. Run 2b2b71d9 surfaced this gap: a declared chain was
        // silently dropped because critic only used its constructor
        // default; fallback fired against the wrong target. Mirrors
        // workers/builder.ts:1532.
        const declaredChain = this.getDeclaredFallbackChain(configRoot);

        // Build fallback chain: primary first, then declared chain
        // (per-repo) OR the legacy constructor fallback (single-entry
        // configs that haven't migrated to declarative chains).
        const chain = this.buildInvocationChain(
          primaryProvider as Provider,
          primaryModel,
          prompt,
          2048,
          declaredChain,
        );

        // Look up (or create) the per-run fallback context. The runId comes
        // from the intent so the blacklist scope = the Coordinator run.
        const runId = this.extractRunId(assignment);
        const runCtx = this.getOrCreateRunContext(runId);

        console.log(
          `[critic] dispatching with fallback chain (${chain.length} entries) for run ${runId.slice(0, 8)}: ${chain.map(c => `${c.provider}/${c.model}`).join(" → ")}`
        );
        // Instrumentation: emit prompt size + chain head before invocation
        // so operators can correlate slow-critic incidents with input size
        // without needing to reconstruct the prompt later. Logged once per
        // dispatch; cheap to compute (single .length and .map).
        const invokeStartedAt = Date.now();
        console.log(
          `[critic] invoke start model=${primaryModel} provider=${primaryProvider} ` +
          `promptChars=${prompt.length} files=${changes.length} ` +
          `chainEntries=${chain.length} runId=${runId.slice(0, 8)}`,
        );

        // Capture attempts on BOTH paths. invokeModelWithFallback throws
        // an InvokerError with .attempts populated on chain-cancel /
        // chain-exhaustion; without this catch the attempts would only
        // be visible on the success path. Run 097adb9c surfaced the gap:
        // a cancelled in-flight call left providerAttempts[] empty in
        // the receipt, so operators couldn't see "we tried provider X
        // and it was aborted." The catch below preserves the attempts
        // log before re-throwing into the worker's outer error handler.
        let response: Awaited<ReturnType<typeof invokeModelWithFallback>> | null = null;
        let invocationError: Error | null = null;
        let retryUsed = false;
        try {
          response = await invokeModelWithFallback(chain, runCtx, assignment.signal);
        } catch (err) {
          if (err instanceof InvokerError && err.attempts) {
            providerAttempts = err.attempts;
          }
          // If the run was cancelled (coordinator-level abort or stage
          // timeout), bubble the error up — the coordinator owns that
          // failure path and will synthesize the [critic_timeout]-tagged
          // result. The retry-with-reduced-context path below is only
          // useful for transient provider failures (network, 5xx,
          // chain-exhaustion without abort) where the run is still
          // alive and a smaller prompt may succeed.
          if (assignment.signal?.aborted) {
            const elapsed = Date.now() - invokeStartedAt;
            console.warn(
              `[critic] FAILED elapsed=${elapsed}ms cause=signal-aborted ` +
              `reraising for coordinator-level handling`,
            );
            throw err;
          }
          // Single retry with a compact prompt — strips diff bodies and
          // keeps just the manifest, acceptance criteria, contract
          // surface, and heuristic summary. Uses a smaller token budget
          // (1024 vs 2048) since the input is smaller. providerAttempts
          // are concatenated across the primary + retry chains so the
          // receipt records both legs honestly.
          const primaryErr = err instanceof Error ? err : new Error(String(err));
          const compactPrompt = this.buildCompactPrompt(contract, changes, heuristicIssues, assignment, primaryModel);
          const compactChain = this.buildInvocationChain(
            primaryProvider as Provider,
            primaryModel,
            compactPrompt,
            1024,
            declaredChain,
          );
          retryUsed = true;
          const retryStartedAt = Date.now();
          console.log(
            `[critic] retry-with-reduced-context promptChars=${compactPrompt.length} ` +
            `(was ${prompt.length}) cause=${primaryErr.message}`,
          );
          try {
            response = await invokeModelWithFallback(compactChain, runCtx, assignment.signal);
            providerAttempts = [...providerAttempts, ...response.attempts];
            const retryElapsed = Date.now() - retryStartedAt;
            console.log(
              `[critic] retry-with-reduced-context complete elapsed=${retryElapsed}ms ` +
              `tokensIn=${response.tokensIn} tokensOut=${response.tokensOut} ` +
              `usedModel=${response.usedProvider}/${response.usedModel}`,
            );
            this.noteDecision(
              assignment.task.id,
              `Critic retried with reduced context after primary failure`,
              `Primary critic invocation failed (${primaryErr.message}); retry with compact prompt succeeded.`,
            );
          } catch (retryErr) {
            if (retryErr instanceof InvokerError && retryErr.attempts) {
              providerAttempts = [...providerAttempts, ...retryErr.attempts];
            }
            if (assignment.signal?.aborted) {
              throw retryErr;
            }
            response = null;
            invocationError = retryErr instanceof Error ? retryErr : new Error(String(retryErr));
            console.warn(
              `[critic] retry-with-reduced-context also failed: ${invocationError.message} ` +
              `— falling back to heuristic-only review`,
            );
          }
        }

        if (response) {
          const elapsed = Date.now() - invokeStartedAt;
          console.log(
            `[critic] invoke complete elapsed=${elapsed}ms ` +
            `tokensIn=${response.tokensIn} tokensOut=${response.tokensOut} ` +
            `usedModel=${response.usedProvider}/${response.usedModel} ` +
            `attempts=${response.attempts.length}`,
          );

          // When retry-with-reduced-context produced this response, the
          // primary leg's providerAttempts have already been
          // concatenated into the running providerAttempts. Overwriting
          // here would lose that history; only assign verbatim when the
          // primary call itself succeeded.
          if (!retryUsed) {
            providerAttempts = response.attempts;
          }

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
          if (retryUsed) {
            // Make the retry visible to receipts that don't surface
            // providerAttempts directly. Distinct from "fellBack to a
            // different provider" — same provider, smaller prompt.
            fellBack = true;
          }

          rawModelReview = response.text;
          modelTokensIn = response.tokensIn;
          modelTokensOut = response.tokensOut;
          modelCostUsd = response.costUsd;
          usedModel = response.usedModel;
          usedProvider = response.usedProvider;
        } else if (invocationError) {
          // Heuristic-only fallback: the model invocation failed for a
          // non-cancellation reason. Builder output is preserved (it
          // lives on Coordinator's active.changes, not on the critic's
          // result), and the heuristic review still produced
          // heuristicIssues that drive the status below. Marker text
          // makes this visible in receipts.
          const elapsed = Date.now() - invokeStartedAt;
          console.warn(
            `[critic] model invocation failed after ${elapsed}ms ` +
            `(${invocationError.message}) — falling back to heuristic-only review`,
          );
          rawModelReview =
            `[critic_heuristic_fallback] model invocation failed after ${elapsed}ms: ${invocationError.message}`;
          this.noteDecision(
            assignment.task.id,
            `Critic degraded to heuristic-only review`,
            `Model invocation failed (${invocationError.message}); preserving Builder output and continuing on heuristics.`,
          );
          fellBack = true;
        }
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
        providerAttempts,
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
        providerAttempts,
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
   *   1. Primary (from `.aedis/model-config.json`'s `critic` entry,
   *      defaulting to qwen3.5:9b on Ollama via the constructor when
   *      no config is present — not Anthropic; the doctrine bans
   *      Anthropic in the hot path)
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
    /**
     * Declared fallback entries from `.aedis/model-config.json`'s
     * `critic.chain[]`. When non-empty, these REPLACE the constructor-
     * level legacy `this.fallbackModel` — the per-repo declaration is
     * authoritative for that build. When empty/missing, the legacy
     * fallback is appended (preserves behavior for single-entry configs
     * that haven't migrated to declarative chains). Mirrors the
     * builder pattern at workers/builder.ts:864.
     */
    declaredChain?: readonly { provider: string; model: string }[],
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
    const seen = new Set<string>([`${primaryProvider}/${primaryModel}`]);

    if (declaredChain && declaredChain.length > 0) {
      // Per-repo declared chain wins over the legacy hardcoded fallback.
      // Dedup against the primary so a self-referencing declaration
      // can't cause an invocation loop.
      for (const entry of declaredChain) {
        const id = `${entry.provider}/${entry.model}`;
        if (seen.has(id)) continue;
        seen.add(id);
        chain.push({
          provider: entry.provider as Provider,
          model: entry.model,
          prompt,
          systemPrompt,
          maxTokens: tokenBudget,
        });
      }
    } else if (
      this.fallbackModel &&
      !seen.has(`${this.fallbackModel.provider}/${this.fallbackModel.model}`)
    ) {
      // No declared chain — preserve the legacy fallback so
      // single-entry model-config.json files keep getting *some*
      // fallback without requiring a config migration.
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

  /**
   * Resolve the declared fallback chain for the critic by reading
   * `.aedis/model-config.json`. Returns the chain *tail* (entries
   * after the primary) so callers can pass it into
   * buildInvocationChain. Empty array if no chain is declared or
   * the config can't be read — buildInvocationChain treats [] as
   * "fall back to the constructor-level default."
   *
   * Mirrors workers/builder.ts:getDeclaredFallbackChain. Critic has
   * no tier system (no `criticTiers` in ModelConfig), so the
   * resolution is a direct read of `config.critic` instead of
   * resolveBuilderChainForTier's tier-aware path.
   */
  private getDeclaredFallbackChain(
    configRoot: string,
  ): readonly { provider: string; model: string }[] {
    try {
      const config = loadModelConfig(configRoot);
      const resolved = resolveAssignmentChain(config.critic);
      return resolved.slice(1).map((e) => ({ provider: e.provider, model: e.model }));
    } catch {
      return [];
    }
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
        issues.push({ severity: "info", message: "Debug logging added without contract approval", file: change.path });
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
      `Diffs:\n${summarizeChangesForCriticReview(changes)}`,
      "Return a terse review summary and any blockers.",
    ].join("\n\n");
  }

  /**
   * Compact review prompt used for the retry-with-reduced-context leg.
   * Strips diff bodies entirely and keeps just the high-signal surface:
   * task description, contract anchor, manifest of changed files +
   * operations, the heuristic-issue summary, and acceptance criteria
   * pulled from the intent's charter. Sized to fit comfortably under
   * the budgets the truncated full-prompt path bumps against on large
   * change-sets, so a Critic that timed out on a giant prompt has a
   * second shot with a small one before falling back to heuristic-only.
   */
  private buildCompactPrompt(
    contract: TaskContract,
    changes: readonly FileChange[],
    issues: readonly Issue[],
    assignment: WorkerAssignment,
    model: string,
  ): string {
    const manifest = changes.length === 0
      ? "(no changes)"
      : changes.map((c) => `- ${c.path} (${c.operation})`).join("\n");
    const acceptanceCriteria = assignment.intent.charter.successCriteria.length === 0
      ? "(none declared)"
      : assignment.intent.charter.successCriteria.map((line) => `- ${line}`).join("\n");
    return [
      `You are the Critic worker on model ${model} (compact retry mode).`,
      "Review only. Do not rewrite code. Diff bodies are omitted — review against acceptance criteria, contract, and the heuristic summary below.",
      `Task: ${assignment.task.description}`,
      `Contract file: ${contract.file}`,
      `Forbidden changes: ${contract.forbiddenChanges.join(" | ") || "none"}`,
      `Heuristic issues: ${issues.map((i) => i.message).join(" | ") || "none"}`,
      `Changed files:\n${manifest}`,
      `Acceptance criteria:\n${acceptanceCriteria}`,
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
