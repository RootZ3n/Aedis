// MIMOV25_TEST
// MIMOTESTV3
/**
 * BaseWorker — Contract schema and interface for all Aedis workers.
 *
 * Workers are the execution units of Aedis. Each worker type has a
 * specific role in the build pipeline, but they all share the same
 * contract: receive an assignment, produce a result, report cost.
 *
 * Worker Types:
 *   Scout      — Gathers context, identifies patterns, maps dependencies
 *   Builder    — Produces code changes based on intent and context
 *   Critic     — Reviews builder output for correctness, style, risk
 *   Verifier   — Runs tests, type checks, linting against changes
 *   Integrator — Merges results, resolves conflicts, produces final diff
 *
 * Key principle: Workers see the full IntentObject, not just their file task.
 * This lets them make coherent decisions aligned with the build's purpose.
 */

import type { IntentObject } from "../core/intent.js";
import type { AssembledContext } from "../core/context-assembler.js";
import type { GatedContext } from "../core/context-gate.js";
import type { ExecutionReceipt } from "../core/execution-gate.js";
import type { CostEntry, Issue, RunTask, RunState } from "../core/runstate.js";
import type { ImplementationBrief } from "../core/implementation-brief.js";
import type { InvokeAttempt } from "../core/model-invoker.js";

// ─── Worker Types ────────────────────────────────────────────────────

export type WorkerType = "scout" | "builder" | "critic" | "verifier" | "integrator";

export type WorkerTier = "fast" | "standard" | "premium";

// ─── Worker Contract ─────────────────────────────────────────────────

export interface WorkerAssignment {
  /** The task from RunState this worker is executing */
  readonly task: RunTask;
  /** The full intent — workers see purpose, not just mechanics */
  readonly intent: IntentObject;
  /** Assembled context relevant to this task */
  readonly context: AssembledContext;
  /** Results from upstream workers (e.g., Scout results for Builder) */
  readonly upstreamResults: readonly WorkerResult[];
  /** Which model tier to use for this assignment */
  readonly tier: WorkerTier;
  /** Maximum tokens this worker may consume */
  readonly tokenBudget: number;

  /**
   * Active RunState for the current Coordinator run, attached by
   * Coordinator.dispatchNode after building the base assignment.
   *
   * Optional because:
   *   - Workers are constructed once at boot via WorkerRegistry, BEFORE
   *     any run exists, so they cannot get RunState through their
   *     constructor in production.
   *   - The Coordinator populates this field on every dispatch in
   *     production, so workers that need RunState (Verifier, Integrator)
   *     can read it directly.
   *   - Tests and stand-alone harnesses that bypass the registry may
   *     omit this field and pass RunState through the worker constructor
   *     instead. Workers fall back to their constructor-time runState
   *     when this field is undefined.
   */
  readonly runState?: RunState;

  /**
   * Snapshot of the run's accumulated file changes, attached by
   * Coordinator.dispatchNode. This is `active.changes` on the
   * Coordinator's ActiveRun — the running tally populated by
   * collectChanges() after each Builder.execute() succeeds.
   *
   * Optional because:
   *   - The Verifier needs the full FileChange[] (path + operation +
   *     diff + content) to verify against, but its only direct upstream
   *     in the task graph is Critic, not Builder, so its
   *     upstreamResults walk for `output.kind === "builder"` returns
   *     empty in production. The Coordinator populates this field so
   *     the Verifier can read it directly.
   *   - Shallow-copied at attach time so workers cannot mutate the
   *     Coordinator's running tally. The array contents themselves are
   *     readonly (deeply immutable from the consumer's perspective).
   */
  readonly changes?: readonly FileChange[];

  /**
   * Snapshot of all worker results produced so far in the current run,
   * in dispatch order. Attached by Coordinator.dispatchNode.
   *
   * Optional because:
   *   - The Integrator needs the successful Builder results (with
   *     .success and .output.changes) to verify approval and extract
   *     the merged changeset, but its only direct upstream in the task
   *     graph is Verifier (scout→builder→critic→verifier→integrator),
   *     so its upstreamResults walk for `workerType === "builder"`
   *     returns empty in production. The Coordinator populates this
   *     field so the Integrator can find the Builder results directly.
   *   - Future workers that need broader visibility into the run get
   *     the same access path through this field.
   *   - Shallow-copied at attach time so workers cannot mutate the
   *     Coordinator's running tally.
   */
  readonly workerResults?: readonly WorkerResult[];

  /**
   * Effective project root for this submission, attached by
   * Coordinator.dispatchNode. The Coordinator computes this as
   * `submission.projectRoot ?? this.config.projectRoot` so that per-task
   * `projectRoot` overrides from TaskSubmission flow through to workers.
   *
   * Optional because:
   *   - Workers are constructed once at boot via WorkerRegistry with the
   *     API server's projectRoot (typically `process.cwd()`). For builds
   *     that target a different repo via the `--repo` CLI flag or the
   *     `repoPath` field on POST /tasks, the per-task projectRoot must
   *     flow through the assignment rather than through the constructor.
   *   - Workers that need projectRoot (Builder, Scout, Critic, Integrator)
   *     resolve `assignment.projectRoot ?? this.projectRoot` (or
   *     `?? process.cwd()` for workers without a constructor field) at
   *     the start of execute() and thread the local value to all helpers.
   *   - Tests and stand-alone harnesses that bypass the registry may omit
   *     this field; workers fall back to their constructor-time projectRoot.
   */
  readonly projectRoot?: string;
  /**
   * Absolute path to the SOURCE repo (not the disposable workspace).
   * Attached by Coordinator.dispatchNode so workers can read persistent,
   * gitignored state that the workspace worktree doesn't carry — most
   * importantly `.aedis/model-config.json`. When absent, helpers fall
   * back to `projectRoot`.
   */
  readonly sourceRepo?: string;
  /** Prompt-gated recent project memory, attached for Scout context. */
  readonly recentContext?: GatedContext;
  /**
   * Engineer-grade work order built by the Coordinator from the charter,
   * scope classification, and multi-file plan. Carries the selected
   * files + rationale, rejected candidates, staged plan, non-goals,
   * verification commands, fallback plan, and (on retries) a sharpened
   * retry hint. Optional because unit-test harnesses that bypass the
   * Coordinator don't produce one; production dispatches always include it.
   */
  readonly implementationBrief?: ImplementationBrief;
  /**
   * Cancellation signal threaded from Coordinator.cancel(runId) down to
   * provider calls. When the run is cancelled, this signal aborts —
   * workers should pass it through to invokeModelWithFallback so any
   * in-flight HTTP request is dropped instead of running to completion.
   *
   * Optional because:
   *   - test harnesses don't always wire one
   *   - workers that don't make external calls (deterministic transforms,
   *     local-only Verifier) ignore it
   *
   * The Coordinator builds one AbortController per run; every dispatch
   * for that run receives the same signal, so cancelling once stops
   * every concurrent worker call.
   */
  readonly signal?: AbortSignal;
}

export interface WorkerResult {
  /** Which worker produced this result */
  readonly workerType: WorkerType;
  /** Task ID this result corresponds to */
  readonly taskId: string;
  /** Whether the worker completed successfully */
  readonly success: boolean;
  /** Primary output — meaning varies by worker type */
  readonly output: WorkerOutput;
  /** Issues found during execution */
  readonly issues: readonly Issue[];
  /** Actual cost incurred */
  readonly cost: CostEntry;
  /** Confidence score 0-1 in the quality of this result */
  readonly confidence: number;
  /** Files this worker read or modified */
  readonly touchedFiles: readonly TouchedFile[];
  /** Assumptions the worker made (need Coordinator acceptance) */
  readonly assumptions: readonly string[];
  /** Wall-clock milliseconds */
  readonly durationMs: number;
  /**
   * Optional self-reported execution receipt. Workers that know
   * exactly what they produced can populate this directly; workers
   * that leave it unset get a receipt synthesized by the Execution
   * Gate from `touchedFiles` + `output` at the end of the run. Either
   * way, every run ends with one receipt per worker in the RunReceipt.
   */
  readonly executionReceipt?: ExecutionReceipt;
  /**
   * Per-attempt log from invokeModelWithFallback for every model
   * call this worker made (initial dispatch, repair retries, etc.)
   * in dispatch order. The Coordinator transforms these to
   * ReceiptProviderAttempt entries and persists them on the run
   * receipt so trust signals (which provider failed how, how long,
   * what it cost) survive past the run. Optional because workers
   * that make no model calls (deterministic transforms, local-only
   * Verifier) don't produce one.
   */
  readonly providerAttempts?: readonly InvokeAttempt[];
}

export interface TouchedFile {
  readonly path: string;
  readonly operation: "read" | "create" | "modify" | "delete";
}

// ─── Output Types Per Worker ─────────────────────────────────────────

export type WorkerOutput =
  | ScoutOutput
  | BuilderOutput
  | CriticOutput
  | VerifierOutput
  | IntegratorOutput;

export interface ScoutOutput {
  readonly kind: "scout";
  /** Dependency graph edges relevant to the task */
  readonly dependencies: readonly DependencyEdge[];
  /** Patterns discovered in the codebase */
  readonly patterns: readonly CodePattern[];
  /** Risk assessment for the planned changes */
  readonly riskAssessment: RiskAssessment;
  /** Suggested approach based on findings */
  readonly suggestedApproach: string;
}

export interface BuilderOutput {
  readonly kind: "builder";
  /** File changes produced */
  readonly changes: readonly FileChange[];
  /** Rationale for key decisions */
  readonly decisions: readonly BuildDecision[];
  /** Whether the builder thinks more review is warranted */
  readonly needsCriticReview: boolean;
}

export interface CriticOutput {
  readonly kind: "critic";
  /** Overall verdict */
  readonly verdict: "approve" | "request-changes" | "reject";
  /** Detailed review comments */
  readonly comments: readonly ReviewComment[];
  /** Suggested changes if verdict is not approve */
  readonly suggestedChanges: readonly FileChange[];
  /** Coherence with intent assessment */
  readonly intentAlignment: number; // 0-1
}

export interface VerifierOutput {
  readonly kind: "verifier";
  /** Test results */
  readonly testResults: readonly TestResult[];
  /** Type check passed */
  readonly typeCheckPassed: boolean;
  /** Lint passed */
  readonly lintPassed: boolean;
  /** Build succeeded */
  readonly buildPassed: boolean;
  /** Overall verification verdict */
  readonly passed: boolean;
}

export interface IntegratorOutput {
  readonly kind: "integrator";
  /** Final merged changeset */
  readonly finalChanges: readonly FileChange[];
  /** Conflicts that were resolved */
  readonly conflictsResolved: readonly ConflictResolution[];
  /** Pre-commit coherence check result */
  readonly coherenceCheck: CoherenceCheckResult;
  /** Ready to apply */
  readonly readyToApply: boolean;
}

// ─── Supporting Types ────────────────────────────────────────────────

export interface DependencyEdge {
  readonly from: string;
  readonly to: string;
  readonly type: "import" | "type" | "test" | "config";
}

export interface CodePattern {
  readonly name: string;
  readonly description: string;
  readonly examples: readonly string[]; // file paths
}

export interface RiskAssessment {
  readonly level: "low" | "medium" | "high" | "critical";
  readonly factors: readonly string[];
  readonly mitigations: readonly string[];
}

export interface FileChange {
  readonly path: string;
  readonly operation: "create" | "modify" | "delete";
  readonly content?: string;        // Full content for create
  readonly diff?: string;           // Unified diff for modify
  readonly originalContent?: string; // For rollback
}

export interface BuildDecision {
  readonly description: string;
  readonly rationale: string;
  readonly alternatives: readonly string[];
}

export interface ReviewComment {
  readonly file: string;
  readonly line?: number;
  readonly severity: "nit" | "suggestion" | "concern" | "blocker";
  readonly message: string;
  readonly suggestedFix?: string;
}

export interface TestResult {
  readonly name: string;
  readonly passed: boolean;
  readonly durationMs: number;
  readonly error?: string;
}

export interface ConflictResolution {
  readonly file: string;
  readonly description: string;
  readonly strategy: "ours" | "theirs" | "manual-merge";
}

export interface CoherenceCheckResult {
  readonly passed: boolean;
  readonly checks: readonly { name: string; passed: boolean; message: string }[];
}

// ─── Base Worker Interface ───────────────────────────────────────────

export interface BaseWorker {
  /** Worker type identifier */
  readonly type: WorkerType;

  /** Human-readable name for logging */
  readonly name: string;

  /**
   * Execute the assignment and return a result.
   * Workers MUST NOT mutate the assignment, intent, or context.
   * Workers MUST report all files they touch.
   * Workers MUST track and report their cost.
   */
  execute(assignment: WorkerAssignment): Promise<WorkerResult>;

  /**
   * Estimate the cost of executing this assignment without doing the work.
   * Used by the TrustRouter to make routing decisions.
   */
  estimateCost(assignment: WorkerAssignment): Promise<CostEntry>;

  /**
   * Check if this worker can handle the given assignment.
   * Returns false if the assignment is outside this worker's capabilities.
   */
  canHandle(assignment: WorkerAssignment): boolean;
}

// ─── Abstract Base Implementation ────────────────────────────────────

export abstract class AbstractWorker implements BaseWorker {
  abstract readonly type: WorkerType;
  abstract readonly name: string;

  abstract execute(assignment: WorkerAssignment): Promise<WorkerResult>;

  abstract estimateCost(assignment: WorkerAssignment): Promise<CostEntry>;

  canHandle(_assignment: WorkerAssignment): boolean {
    return true;
  }

  /** Helper: build a successful result */
  protected success(
    assignment: WorkerAssignment,
    output: WorkerOutput,
    opts: {
      cost: CostEntry;
      confidence: number;
      touchedFiles: TouchedFile[];
      assumptions?: string[];
      issues?: Issue[];
      durationMs: number;
      providerAttempts?: readonly InvokeAttempt[];
    }
  ): WorkerResult {
    return {
      workerType: this.type,
      taskId: assignment.task.id,
      success: true,
      output,
      issues: opts.issues ?? [],
      cost: opts.cost,
      confidence: opts.confidence,
      touchedFiles: opts.touchedFiles,
      assumptions: opts.assumptions ?? [],
      durationMs: opts.durationMs,
      ...(opts.providerAttempts && opts.providerAttempts.length > 0
        ? { providerAttempts: opts.providerAttempts }
        : {}),
    };
  }

  /** Helper: build a failed result */
  protected failure(
    assignment: WorkerAssignment,
    error: string,
    cost: CostEntry,
    durationMs: number,
    providerAttempts?: readonly InvokeAttempt[],
  ): WorkerResult {
    return {
      workerType: this.type,
      taskId: assignment.task.id,
      success: false,
      output: this.emptyOutput(),
      issues: [{ severity: "error", message: error }],
      cost,
      confidence: 0,
      touchedFiles: [],
      assumptions: [],
      durationMs,
      ...(providerAttempts && providerAttempts.length > 0
        ? { providerAttempts }
        : {}),
    };
  }

  /** Subclasses return their type-specific empty output */
  protected abstract emptyOutput(): WorkerOutput;

  /** Helper: zero cost entry */
  protected zeroCost(): CostEntry {
    return { model: "", inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 };
  }
}

// ─── Worker Registry ─────────────────────────────────────────────────

export class WorkerRegistry {
  private workers = new Map<WorkerType, BaseWorker[]>();

  register(worker: BaseWorker): void {
    const existing = this.workers.get(worker.type) ?? [];
    existing.push(worker);
    this.workers.set(worker.type, existing);
  }

  getWorkers(type: WorkerType): BaseWorker[] {
    return this.workers.get(type) ?? [];
  }

  getWorker(type: WorkerType): BaseWorker | undefined {
    const workers = this.getWorkers(type);
    return workers[0];
  }

  getAllWorkers(): BaseWorker[] {
    return [...this.workers.values()].flat();
  }

  hasWorker(type: WorkerType): boolean {
    return (this.workers.get(type)?.length ?? 0) > 0;
  }
}

// ─── Assignment Validation ───────────────────────────────────────────

/**
 * Validation error with field context for debugging.
 */
export class AssignmentValidationError extends Error {
  constructor(
    message: string,
    public readonly field: string,
    public readonly value: unknown,
  ) {
    super(message);
    this.name = "AssignmentValidationError";
  }
}

/**
 * Validate a WorkerAssignment before worker.execute() is called.
 * Throws AssignmentValidationError on any malformed field —
 * workers must NOT accept bad input and continue silently.
 *
 * This is the FAIL-FAST gate: catch bad data at the boundary
 * rather than letting it propagate as a confusing TypeError deep
 * in worker logic.
 */
export function validateWorkerAssignment(assignment: unknown, workerType: WorkerType): asserts assignment is WorkerAssignment {
  if (!isObject(assignment)) {
    throw new AssignmentValidationError(
      `${workerType}: assignment must be a plain object, got ${typeof assignment}`,
      "assignment",
      assignment,
    );
  }

  const a = assignment as Record<string, unknown>;

  // task — required object with targetFiles array
  if (!isObject(a.task)) {
    throw new AssignmentValidationError(`${workerType}: assignment.task must be an object`, "task", a.task);
  }
  const task = a.task as Record<string, unknown>;
  if (!Array.isArray(task.targetFiles)) {
    throw new AssignmentValidationError(
      `${workerType}: assignment.task.targetFiles must be an array, got ${typeof task.targetFiles}`,
      "task.targetFiles",
      task.targetFiles,
    );
  }
  for (const tf of task.targetFiles) {
    if (typeof tf !== "string") {
      throw new AssignmentValidationError(
        `${workerType}: assignment.task.targetFiles must contain strings, got ${typeof tf}`,
        "task.targetFiles[]",
        tf,
      );
    }
  }
  if (typeof task.id !== "string") {
    throw new AssignmentValidationError(`${workerType}: assignment.task.id must be a string`, "task.id", task.id);
  }

  // intent — required object
  if (!isObject(a.intent)) {
    throw new AssignmentValidationError(`${workerType}: assignment.intent must be an object`, "intent", a.intent);
  }

  // context — required object
  if (!isObject(a.context)) {
    throw new AssignmentValidationError(`${workerType}: assignment.context must be an object`, "context", a.context);
  }
  const ctx = a.context as Record<string, unknown>;
  if (!Array.isArray(ctx.layers)) {
    throw new AssignmentValidationError(
      `${workerType}: assignment.context.layers must be an array`,
      "context.layers",
      ctx.layers,
    );
  }

  // upstreamResults — readonly array, each item must have success + output.kind
  if (!Array.isArray(a.upstreamResults)) {
    throw new AssignmentValidationError(
      `${workerType}: assignment.upstreamResults must be an array`,
      "upstreamResults",
      a.upstreamResults,
    );
  }
  for (const ur of a.upstreamResults as unknown[]) {
    if (!isObject(ur)) {
      throw new AssignmentValidationError(
        `${workerType}: assignment.upstreamResults must contain objects`,
        "upstreamResults[]",
        ur,
      );
    }
    const urObj = ur as Record<string, unknown>;
    if (typeof urObj.success !== "boolean") {
      throw new AssignmentValidationError(
        `${workerType}: upstreamResults[].success must be boolean`,
        "upstreamResults[].success",
        urObj.success,
      );
    }
    if (!isObject(urObj.output)) {
      throw new AssignmentValidationError(
        `${workerType}: upstreamResults[].output must be an object`,
        "upstreamResults[].output",
        urObj.output,
      );
    }
    const out = urObj.output as Record<string, unknown>;
    if (typeof out.kind !== "string") {
      throw new AssignmentValidationError(
        `${workerType}: upstreamResults[].output.kind must be string`,
        "upstreamResults[].output.kind",
        out.kind,
      );
    }
  }

  // tokenBudget — must be positive number
  if (typeof a.tokenBudget !== "number" || !Number.isFinite(a.tokenBudget) || a.tokenBudget <= 0) {
    throw new AssignmentValidationError(
      `${workerType}: assignment.tokenBudget must be a positive number`,
      "tokenBudget",
      a.tokenBudget,
    );
  }

  // tier — must be known WorkerTier
  const validTiers = ["fast", "standard", "premium"] as const;
  if (!validTiers.includes(a.tier as typeof validTiers[number])) {
    throw new AssignmentValidationError(
      `${workerType}: assignment.tier must be one of ${validTiers.join(", ")}`,
      "tier",
      a.tier,
    );
  }
}

function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

/**
 * Validate a FileChange before using it in downstream processing.
 * Throws AssignmentValidationError on malformed change objects.
 */
export function validateFileChange(change: unknown, index: number): asserts change is FileChange {
  if (!isObject(change)) {
    throw new AssignmentValidationError(`FileChange[${index}]: must be an object`, `changes[${index}]`, change);
  }
  const c = change as Record<string, unknown>;
  if (typeof c.path !== "string" || (c.path as string).length === 0) {
    throw new AssignmentValidationError(
      `FileChange[${index}]: path must be a non-empty string`,
      `changes[${index}].path`,
      c.path,
    );
  }
  const validOps = ["create", "modify", "delete"] as const;
  if (!validOps.includes(c.operation as typeof validOps[number])) {
    throw new AssignmentValidationError(
      `FileChange[${index}]: operation must be one of ${validOps.join(", ")}`,
      `changes[${index}].operation`,
      c.operation,
    );
  }
}

/**
 * Validate a FileChange array (used by Verifier and dispatch).
 * Throws on the first malformed entry.
 */
export function validateFileChangeArray(changes: unknown, fieldName = "changes"): asserts changes is readonly FileChange[] {
  if (!Array.isArray(changes)) {
    throw new AssignmentValidationError(`${fieldName}: must be an array`, fieldName, changes);
  }
  for (let i = 0; i < changes.length; i++) {
    validateFileChange(changes[i], i);
  }
}
