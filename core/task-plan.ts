/**
 * Task plan — durable schema for the multi-step "continue-until-done"
 * execution loop.
 *
 * Architectural intent:
 *   - One TaskPlan models a single objective composed of an ordered
 *     list of Subtasks. Each Subtask becomes one Coordinator.submit()
 *     call when the loop driver advances to it.
 *   - The loop is single-step: at most one Subtask is in flight at a
 *     time. There is no parallelism, no branching, and no auto-jump
 *     past a failed subtask without an explicit "skip" action.
 *   - Every state transition is persisted (see task-plan-store.ts)
 *     so a server restart never loses the plan. On restart, plans
 *     in `running` state are reconciled to `interrupted` — Aedis
 *     does NOT auto-resume; the operator must explicitly continue.
 *
 * SAFETY INVARIANTS the schema enforces (and tests pin):
 *   - `subtasks` is non-empty for any plan past `pending`.
 *   - The `status` field is the single source of truth — there is
 *     no "implicit" running state derivable from active subtasks.
 *   - Every Subtask carries a list of receipt run-ids it produced.
 *     The audit trail is intact even when a subtask is skipped or
 *     blocked. Receipts are never bypassed.
 *   - Budget fields are required (defaulted) so an empty caller
 *     config still aborts the loop within sane bounds. There is no
 *     "infinite" mode — every plan has a hard ceiling.
 *
 * NON-GOALS:
 *   - No subtask graph / DAG. Subtasks are linearly ordered.
 *   - No auto-decomposition of an objective into subtasks. The
 *     caller (CLI / API / future planner) provides the subtasks.
 *     This is deliberate: we don't want a vague broad objective
 *     to be silently expanded into broad repo edits.
 *   - No promotion logic. Promotion remains the existing
 *     coordinator.promoteToSource path with its primary-only guard.
 */

export type SubtaskStatus =
  | "pending"     // not yet started
  | "running"     // a coordinator.submit() is in flight
  | "verifying"   // submit returned, verifier evaluating
  | "repaired"    // first attempt failed, repair attempt completed successfully
  | "completed"   // success, advances to next subtask
  | "failed"      // attempts exhausted, loop may stop or skip
  | "skipped"     // user / loop chose to skip this subtask
  | "blocked"    // approval required, Velum-blocked, budget hit, etc.
  | "needs_clarification"; // coordinator could not identify a target file even after scouts ran

export type TaskPlanStatus =
  | "pending"     // created, not yet started
  | "running"     // loop driver actively iterating
  | "paused"      // waiting on approval / blocker / human action
  | "completed"   // every subtask completed or safely skipped
  | "failed"      // one or more subtasks terminally failed and loop stopped
  | "cancelled"   // user cancelled
  | "interrupted" // server restart caught the plan mid-run
  | "blocked"    // budget hit or stop signal; recoverable via continue
  | "needs_replan"; // a subtask needs a target file attached or rephrased before the loop can continue

export type StopReason =
  | "all_subtasks_complete"
  | "approval_required"
  | "blocked_by_velum"
  | "max_subtasks_reached"
  | "max_attempts_reached"
  | "max_repair_attempts_reached"
  | "max_runtime_reached"
  | "max_cost_reached"
  | "max_consecutive_failures_reached"
  | "user_cancelled"
  | "server_interrupted"
  | "subtask_terminal_failure"
  | "needs_clarification";

export interface Subtask {
  /** Stable id within the plan, e.g. "st-1". */
  readonly id: string;
  /** 1-based ordinal — same as the array index + 1; redundant for sort safety. */
  readonly ordinal: number;
  /** Short one-line title, displayed in the UI. */
  readonly title: string;
  /** The actual prompt that gets handed to coordinator.submit(). */
  readonly prompt: string;
  readonly status: SubtaskStatus;
  /** How many submit() attempts have been made (initial + repairs). */
  readonly attempts: number;
  /** How many of those attempts were repair-mode retries. */
  readonly repairAttempts: number;
  /**
   * Coordinator runIds this subtask produced. Append-only so a later
   * "audit trail" reader can reconstruct exactly what ran.
   */
  readonly evidenceRunIds: readonly string[];
  /** Most recent runId attempted (head of evidenceRunIds, or null). */
  readonly lastRunId: string | null;
  /** Most recent verdict from coordinator.submit, or null when never run. */
  readonly lastVerdict: "success" | "partial" | "failed" | "aborted" | null;
  /** Reason a subtask is `blocked` or `failed`. Empty otherwise. */
  readonly blockerReason: string;
  /** Human suggestion for what to do next if this subtask is blocked / failed. */
  readonly nextRecommendedAction: string;
  /** Structured failure reason copied from the run receipt when available. */
  readonly failureReason?: string | null;
  /** Pipeline stage that blocked the subtask when available. */
  readonly blockedStage?: string | null;
  /** Stable recovery actions the UI can render. */
  readonly nextAllowedActions?: readonly string[];
  /** Attempt signatures used to block identical automatic repairs. */
  readonly failureSignatures?: readonly string[];
  /** ISO timestamp of first run start, or null. */
  readonly startedAt: string | null;
  /** ISO timestamp of terminal transition, or null. */
  readonly completedAt: string | null;
  /** Approximate cost charged to this subtask across attempts. */
  readonly costUsd: number;
  /**
   * Scout-derived candidate target files to attach. Populated when
   * the coordinator's pre-dispatch guard rejected this subtask for
   * lack of an actionable target. Empty for any other state. Surfaced
   * to the UI as the "Suggested target" / "Show Scout Evidence" data.
   */
  readonly recommendedTargets?: readonly string[];
  /**
   * Scout report ids that produced the recommended targets. Lets the
   * UI link the operator straight at the underlying evidence rather
   * than guessing where it came from.
   */
  readonly scoutReportIds?: readonly string[];
  /**
   * Per-subtask record of (stage, provider, model) tuples that hit a
   * stage timeout during this subtask. Persisted across repair
   * attempts so the next dispatch can apply the timeout retry policy
   * (default: do NOT re-dispatch a timed-out model). Increments on
   * each timeout via `recordTimeout` from core/timeout-policy.ts.
   * The UI's timeout-recovery card reads this to render the model
   * + elapsed-time chip.
   */
  readonly timedOutModels?: readonly {
    readonly stage: string;
    readonly provider: string;
    readonly model: string;
    readonly at: string;
    readonly stageTimeoutMs: number;
    readonly consecutiveTimeouts: number;
  }[];
}

export interface TaskPlanBudget {
  readonly maxSubtasks: number;
  readonly maxAttemptsPerSubtask: number;
  readonly maxRepairAttempts: number;
  readonly maxRuntimeMs: number;
  readonly maxCostUsd: number;
  readonly maxConsecutiveFailures: number;
}

export interface TaskPlanSpent {
  readonly totalCostUsd: number;
  readonly totalRuntimeMs: number;
  readonly consecutiveFailures: number;
  readonly subtasksAttempted: number;
}

export interface TaskPlan {
  readonly schemaVersion: 1;
  readonly taskPlanId: string;
  readonly objective: string;
  readonly repoPath: string;
  readonly subtasks: readonly Subtask[];
  readonly status: TaskPlanStatus;
  /** Reason for the current pause / stop. Empty when `status === running` etc. */
  readonly stopReason: StopReason | "";
  readonly budget: TaskPlanBudget;
  readonly spent: TaskPlanSpent;
  readonly createdAt: string;
  readonly updatedAt: string;
  /**
   * If true, on restart the loop driver will refuse to auto-continue.
   * Always true in v1 — no implicit recovery, only operator-driven
   * `/continue`. Field exists so a future opt-in safer-restart mode
   * can flip it without a schema bump.
   */
  readonly requiresExplicitResume: true;
}

// ─── Defaults ───────────────────────────────────────────────────────

/**
 * Conservative budget defaults. Picked so an unconfigured plan
 * cannot run away — every cap is small enough that a worst-case
 * runaway hits a hard stop within minutes / cents / tens of steps.
 *
 * Operators who need higher caps must set them explicitly per plan.
 */
export const DEFAULT_TASK_PLAN_BUDGET: TaskPlanBudget = Object.freeze({
  maxSubtasks: 25,
  maxAttemptsPerSubtask: 3,         // initial + 2 repairs
  maxRepairAttempts: 2,
  maxRuntimeMs: 30 * 60 * 1000,     // 30 minutes wall-clock
  maxCostUsd: 5.0,                   // $5 hard ceiling
  maxConsecutiveFailures: 2,         // fail-fast on a streak
});

// ─── Validators ─────────────────────────────────────────────────────

export interface SubtaskInput {
  readonly title?: string;
  readonly prompt: string;
}

export interface CreateTaskPlanInput {
  readonly objective: string;
  readonly repoPath: string;
  readonly subtasks: readonly SubtaskInput[];
  readonly budget?: Partial<TaskPlanBudget>;
}

export interface ValidateResult {
  readonly ok: boolean;
  readonly errors: readonly string[];
}

/**
 * Validate a CreateTaskPlanInput. Pure — no I/O, never throws.
 *
 * Strict because the loop driver assumes:
 *   - subtasks length is in (0, maxSubtasks]
 *   - every prompt is non-empty (otherwise coordinator.submit
 *     would route to clarification and the loop would deadlock)
 *   - budget caps are positive (we never run with zero budget)
 */
export function validateCreateTaskPlanInput(
  input: CreateTaskPlanInput,
  defaults: TaskPlanBudget = DEFAULT_TASK_PLAN_BUDGET,
): ValidateResult {
  const errors: string[] = [];
  const objective = (input.objective ?? "").trim();
  if (!objective) errors.push("objective must be a non-empty string");
  const repoPath = (input.repoPath ?? "").trim();
  if (!repoPath) errors.push("repoPath must be a non-empty string");
  const subtasks = Array.isArray(input.subtasks) ? input.subtasks : [];
  if (subtasks.length === 0) {
    errors.push("subtasks[] must contain at least one entry");
  }
  // Budget cap on subtask count — refuse plans that would already
  // exceed the cap before they even start. Better to reject here
  // than to silently truncate and lose work.
  const effectiveMaxSubtasks = input.budget?.maxSubtasks ?? defaults.maxSubtasks;
  if (subtasks.length > effectiveMaxSubtasks) {
    errors.push(
      `subtasks[] length (${subtasks.length}) exceeds maxSubtasks (${effectiveMaxSubtasks}). ` +
      `Raise budget.maxSubtasks or split into multiple plans.`,
    );
  }
  for (let i = 0; i < subtasks.length; i++) {
    const sub = subtasks[i];
    const prompt = (sub.prompt ?? "").trim();
    if (!prompt) errors.push(`subtasks[${i}].prompt must be a non-empty string`);
  }
  // Budget overrides must be positive.
  if (input.budget) {
    for (const key of [
      "maxSubtasks",
      "maxAttemptsPerSubtask",
      "maxRepairAttempts",
      "maxRuntimeMs",
      "maxCostUsd",
      "maxConsecutiveFailures",
    ] as const) {
      const v = input.budget[key];
      if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v) || v <= 0)) {
        errors.push(`budget.${key} must be a positive finite number`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Construct a brand-new TaskPlan from a validated input. Pure — no
 * I/O, no clock ambiguity (caller passes `now`).
 *
 * Each Subtask starts in `pending` with zero attempts and an empty
 * evidence list. The plan starts in `pending` until something calls
 * `start()` on the loop driver.
 */
export function createTaskPlan(
  input: CreateTaskPlanInput,
  options: {
    taskPlanId: string;
    now: string;
    budgetDefaults?: TaskPlanBudget;
  },
): TaskPlan {
  const defaults = options.budgetDefaults ?? DEFAULT_TASK_PLAN_BUDGET;
  const budget: TaskPlanBudget = {
    maxSubtasks: input.budget?.maxSubtasks ?? defaults.maxSubtasks,
    maxAttemptsPerSubtask:
      input.budget?.maxAttemptsPerSubtask ?? defaults.maxAttemptsPerSubtask,
    maxRepairAttempts: input.budget?.maxRepairAttempts ?? defaults.maxRepairAttempts,
    maxRuntimeMs: input.budget?.maxRuntimeMs ?? defaults.maxRuntimeMs,
    maxCostUsd: input.budget?.maxCostUsd ?? defaults.maxCostUsd,
    maxConsecutiveFailures:
      input.budget?.maxConsecutiveFailures ?? defaults.maxConsecutiveFailures,
  };
  const subtasks: Subtask[] = input.subtasks.map((s, i) => ({
    id: `st-${i + 1}`,
    ordinal: i + 1,
    title: (s.title ?? truncate(s.prompt, 80)).trim() || `Subtask ${i + 1}`,
    prompt: s.prompt.trim(),
    status: "pending",
    attempts: 0,
    repairAttempts: 0,
    evidenceRunIds: [],
    lastRunId: null,
    lastVerdict: null,
    blockerReason: "",
    nextRecommendedAction: "",
    startedAt: null,
    completedAt: null,
    costUsd: 0,
  }));
  return {
    schemaVersion: 1,
    taskPlanId: options.taskPlanId,
    objective: input.objective.trim(),
    repoPath: input.repoPath.trim(),
    subtasks,
    status: "pending",
    stopReason: "",
    budget,
    spent: {
      totalCostUsd: 0,
      totalRuntimeMs: 0,
      consecutiveFailures: 0,
      subtasksAttempted: 0,
    },
    createdAt: options.now,
    updatedAt: options.now,
    requiresExplicitResume: true,
  };
}

// ─── Helpers (pure) ─────────────────────────────────────────────────

function truncate(s: string, max: number): string {
  const clean = s.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

/**
 * Find the next subtask the loop should run, or null when the plan
 * is done (or terminally blocked). Pure — operator-readable so the
 * UI can preview the next step without invoking the driver.
 */
export function findNextSubtask(plan: TaskPlan): Subtask | null {
  for (const s of plan.subtasks) {
    if (s.status === "pending" || s.status === "running" || s.status === "verifying") {
      return s;
    }
  }
  return null;
}

/**
 * Subtasks in `needs_clarification` are the ones holding up a
 * `needs_replan` plan — surfaced separately so the UI can list them
 * with their scout evidence + recommended targets.
 */
export function findNeedsClarificationSubtasks(plan: TaskPlan): readonly Subtask[] {
  return plan.subtasks.filter((s) => s.status === "needs_clarification");
}

/**
 * Aggregate counts for the UI / final summary. Pure projection.
 */
export interface SubtaskCounts {
  readonly total: number;
  readonly completed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly blocked: number;
  readonly pending: number;
  readonly needsClarification: number;
}

export function countSubtasks(plan: TaskPlan): SubtaskCounts {
  const counts = {
    total: plan.subtasks.length,
    completed: 0,
    failed: 0,
    skipped: 0,
    blocked: 0,
    pending: 0,
    needsClarification: 0,
  };
  for (const s of plan.subtasks) {
    if (s.status === "completed" || s.status === "repaired") counts.completed += 1;
    else if (s.status === "failed") counts.failed += 1;
    else if (s.status === "skipped") counts.skipped += 1;
    else if (s.status === "blocked") counts.blocked += 1;
    else if (s.status === "needs_clarification") counts.needsClarification += 1;
    else counts.pending += 1;
  }
  return counts;
}

/**
 * Build the operator-facing final summary from a terminal plan.
 * Pure — exported so the API and the UI can render the same string.
 */
export interface TaskPlanFinalSummary {
  readonly status: TaskPlanStatus;
  readonly stopReason: StopReason | "";
  readonly counts: SubtaskCounts;
  readonly objective: string;
  readonly receiptRunIds: readonly string[];
  readonly totalCostUsd: number;
  readonly totalRuntimeMs: number;
  readonly headline: string;
  readonly recommendedNextAction: string;
}

export function buildFinalSummary(plan: TaskPlan): TaskPlanFinalSummary {
  const counts = countSubtasks(plan);
  const receiptRunIds: string[] = [];
  for (const s of plan.subtasks) {
    for (const id of s.evidenceRunIds) receiptRunIds.push(id);
  }
  const headline = buildHeadline(plan, counts);
  const next = recommendedNext(plan, counts);
  return {
    status: plan.status,
    stopReason: plan.stopReason,
    counts,
    objective: plan.objective,
    receiptRunIds,
    totalCostUsd: plan.spent.totalCostUsd,
    totalRuntimeMs: plan.spent.totalRuntimeMs,
    headline,
    recommendedNextAction: next,
  };
}

function buildHeadline(plan: TaskPlan, counts: SubtaskCounts): string {
  switch (plan.status) {
    case "completed":
      return `${counts.completed}/${counts.total} subtasks complete${counts.skipped > 0 ? `, ${counts.skipped} skipped` : ""}.`;
    case "paused":
      return `Paused at ${counts.completed}/${counts.total}: ${humanReason(plan.stopReason)}.`;
    case "blocked":
      return `Blocked at ${counts.completed}/${counts.total}: ${humanReason(plan.stopReason)}.`;
    case "failed":
      return `Failed at ${counts.completed + counts.failed}/${counts.total}: ${humanReason(plan.stopReason)}.`;
    case "cancelled":
      return `Cancelled at ${counts.completed}/${counts.total}.`;
    case "interrupted":
      return `Interrupted by server restart at ${counts.completed}/${counts.total}. Use /continue to resume.`;
    case "needs_replan":
      return `Mission needs replan at ${counts.completed}/${counts.total}: ${counts.needsClarification} subtask(s) need a target file.`;
    default:
      return `${plan.status} — ${counts.completed}/${counts.total} subtasks.`;
  }
}

function humanReason(reason: StopReason | ""): string {
  switch (reason) {
    case "":
      return "no reason recorded";
    case "all_subtasks_complete":
      return "all subtasks complete";
    case "approval_required":
      return "approval required for the current change";
    case "blocked_by_velum":
      return "blocked by Velum input gate";
    case "max_subtasks_reached":
      return "max subtasks reached";
    case "max_attempts_reached":
      return "max attempts on a subtask reached";
    case "max_repair_attempts_reached":
      return "max repair attempts reached";
    case "max_runtime_reached":
      return "max runtime reached";
    case "max_cost_reached":
      return "max cost reached";
    case "max_consecutive_failures_reached":
      return "max consecutive failures reached";
    case "user_cancelled":
      return "user cancelled";
    case "server_interrupted":
      return "server interrupted mid-run";
    case "subtask_terminal_failure":
      return "subtask failed terminally after repairs";
    case "needs_clarification":
      return "subtask is missing a target file — clarification needed";
  }
}

function recommendedNext(plan: TaskPlan, counts: SubtaskCounts): string {
  if (plan.status === "completed") return "Review the receipts and promote any pending workspace commits.";
  if (plan.status === "paused" && plan.stopReason === "approval_required") {
    return "Approve or reject the pending change, then POST /task-plans/<id>/continue.";
  }
  if (plan.status === "blocked") {
    return "Review the blocker reason on the current subtask, then continue, skip, or cancel.";
  }
  if (plan.status === "failed") {
    return "Inspect the failed subtask receipt; either rewrite the prompt and create a new plan or skip and continue.";
  }
  if (plan.status === "interrupted") {
    return "Server restart caught the run mid-flight. Inspect the last subtask receipt, then POST /task-plans/<id>/continue.";
  }
  if (plan.status === "cancelled") {
    return "Cancelled. Receipts for completed subtasks are intact.";
  }
  if (plan.status === "needs_replan") {
    return "Review scout evidence, attach a target file to the affected subtask, then POST /task-plans/<id>/continue.";
  }
  if (counts.pending > 0) return "Continue to advance to the next pending subtask.";
  return "Plan terminal — no further action required.";
}
