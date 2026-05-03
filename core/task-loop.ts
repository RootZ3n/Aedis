/**
 * Task-loop runner — sequential, single-step execution driver for
 * a TaskPlan.
 *
 * Operating model:
 *   - Iterates the plan's subtasks in order.
 *   - For each pending subtask, calls the injected coordinator's
 *     `submit()` once. The full Aedis pipeline runs inside that
 *     submit (Velum, target discovery, workspace, verification,
 *     approval gate). The loop adds NO bypass.
 *   - Awaits the receipt. Classifies the outcome:
 *
 *       success                    → mark completed, advance
 *       partial + AWAITING_APPROVAL → mark blocked(approval), pause loop
 *       partial / failed (other)    → bounded repair (re-submit with
 *                                     a tightened prompt) up to the
 *                                     plan's maxRepairAttempts
 *       aborted                    → mark cancelled (the cancel API
 *                                     drove this); pause loop
 *
 *   - After every state change the plan is persisted via TaskPlanStore.
 *
 * Invariants the driver enforces (and tests pin):
 *   - Never calls `coordinator.promoteToSource`. Promotion stays a
 *     separate, explicit operator action. The loop only orchestrates
 *     submits and respects the existing approval gate.
 *   - Stops the moment any budget is breached (max subtasks, max
 *     attempts per subtask, max repair attempts, max runtime, max
 *     cost, max consecutive failures). The plan is left in a truthful
 *     state with `stopReason` set so the operator can see why.
 *   - Cancellation is honored mid-iteration: a `cancel()` call sets
 *     `cancelled` on the runner, the in-flight submit gets aborted
 *     via the coordinator's normal cancel path, and the loop exits
 *     after the current submit resolves.
 *   - One subtask runs at a time — there is no parallel dispatch.
 *     This is deliberate: it keeps the audit trail linear and
 *     keeps shared resources (workspaces, ports, repo locks)
 *     uncontended.
 *
 * NON-GOALS:
 *   - Auto-promotion. Source mutation still requires `promoteToSource`
 *     with the existing primary-only role guard.
 *   - Branching. A failed subtask never auto-routes to an alternate
 *     subtask. The operator chooses skip / cancel / continue / new
 *     plan.
 *   - LLM-driven repair. Repair re-submits a *tightened* version of
 *     the same prompt; the actual repair-quality work happens inside
 *     coordinator.submit() (which has its own retry / weak-output
 *     logic).
 */

import { randomUUID } from "node:crypto";

import {
  buildFinalSummary,
  countSubtasks,
  findNextSubtask,
  type StopReason,
  type Subtask,
  type SubtaskStatus,
  type TaskPlan,
  type TaskPlanFinalSummary,
} from "./task-plan.js";
import { TaskPlanStore } from "./task-plan-store.js";
import { NeedsClarificationError, type RunReceipt, type TaskSubmission } from "./coordinator.js";
import { diagnoseFailure, type RepairDiagnosis } from "./repair-diagnosis.js";
import {
  decideNextDispatch,
  recordTimeout,
  type ChainEntry,
  type TimedOutModelEntry,
  type TimeoutRetryPolicy,
} from "./timeout-policy.js";

// ─── Injected dependencies ──────────────────────────────────────────

/**
 * Minimum surface the driver needs from the Coordinator. The
 * full Coordinator class is much larger; this interface lets tests
 * stub the parts that matter without booting workers.
 */
export interface CoordinatorLike {
  submit(submission: TaskSubmission): Promise<RunReceipt>;
  cancel(runId: string): Promise<void> | void;
}

/**
 * Minimum surface the driver needs from the receipt store: enough
 * to detect the "awaiting approval" pause state, and (optionally)
 * the providerAttempts log used to detect cross-run timeouts so the
 * timeout retry policy can persist them on the subtask.
 *
 * Returns null when the run hasn't been persisted yet (e.g. test stubs).
 */
export interface ReceiptStoreReader {
  getRun(runId: string): Promise<({
    status: string;
    providerAttempts?: ReadonlyArray<{
      taskId?: string;
      provider: string;
      model: string;
      outcome: string;
      durationMs?: number;
      errorMsg?: string;
    }>;
    workerEvents?: ReadonlyArray<{ workerType: string; taskId: string }>;
    checkpoints?: ReadonlyArray<{
      details?: Record<string, unknown>;
      summary?: string;
    }>;
  }) | null>;
}

/** Logger interface so tests can capture and assert. Defaults to console. */
export interface LoopLogger {
  log(line: string): void;
  warn(line: string): void;
  error(line: string): void;
}

const consoleLogger: LoopLogger = {
  log: (l) => console.log(l),
  warn: (l) => console.warn(l),
  error: (l) => console.error(l),
};

/**
 * Discriminator on every task_plan_event payload. The UI keys off
 * `kind` to render a short human line ("subtask 2 started", "plan
 * paused for approval") without re-deriving it from status changes.
 */
export type TaskPlanEventKind =
  | "plan_started"
  | "plan_paused"
  | "plan_blocked"
  | "plan_completed"
  | "plan_failed"
  | "plan_cancelled"
  | "plan_interrupted"
  | "plan_needs_replan"
  | "subtask_started"
  | "subtask_completed"
  | "subtask_repaired"
  | "subtask_failed"
  | "subtask_blocked"
  | "subtask_skipped"
  | "subtask_needs_clarification";

/**
 * Single payload shape every emit shares. Keeps the WS subscriber
 * code branch-free — the discriminator is `kind`, every other field
 * is always present (possibly empty).
 */
export interface TaskPlanEventPayload {
  readonly kind: TaskPlanEventKind;
  readonly taskPlanId: string;
  readonly status: string;
  readonly currentSubtaskId: string | null;
  readonly progress: { readonly completed: number; readonly total: number };
  readonly stopReason: string;
  readonly message: string;
  readonly updatedAt: string;
  /**
   * Scout-derived candidate target files. Populated for
   * `plan_needs_replan` and `subtask_needs_clarification` so the UI
   * can render a "Suggested target" chip without fetching scout
   * evidence separately.
   */
  readonly recommendedTargets?: readonly string[];
  /**
   * Scout report ids that produced the recommendation. Lets the UI
   * deep-link into the existing scout-evidence panel.
   */
  readonly scoutReportIds?: readonly string[];
  /**
   * Two-CTA contract for the UI when a mission needs a replan. Keys
   * are stable so the renderer maps each one to a button.
   */
  readonly ctas?: ReadonlyArray<{
    readonly key: "repair_plan" | "show_scout_evidence";
    readonly label: string;
    readonly endpoint: string;
    readonly method: "GET" | "POST";
    readonly description: string;
  }>;
}

/**
 * Bus emitter. Matches the shape the server EventBus expects without
 * importing the server module — keeps core/ free of server deps.
 * The route layer adapts ctx.eventBus.emit into this signature.
 */
export type TaskPlanEventEmitter = (payload: TaskPlanEventPayload) => void;

// ─── Runner ─────────────────────────────────────────────────────────

export interface TaskLoopRunnerOptions {
  readonly store: TaskPlanStore;
  readonly coordinator: CoordinatorLike;
  readonly receiptStore: ReceiptStoreReader;
  readonly logger?: LoopLogger;
  /** Returns the current ISO timestamp. Override in tests. */
  readonly now?: () => string;
  /**
   * Optional event emitter. The route layer wires this to
   * ctx.eventBus.emit so every loop transition becomes a
   * `task_plan_event` WebSocket message. Tests can pass a
   * capturing function to assert the emit sequence.
   *
   * The runner tolerates a missing emitter (no events emitted)
   * so unit tests that don't care about WS plumbing can stay
   * minimal.
   */
  readonly emit?: TaskPlanEventEmitter;
}

export interface AdvanceResult {
  readonly plan: TaskPlan;
  /** Why we stopped iterating, or null when the plan is terminal. */
  readonly stopReason: StopReason | "" | null;
  /** True when a subtask actually executed during this advance. */
  readonly executed: boolean;
}

export class TaskLoopRunner {
  private readonly store: TaskPlanStore;
  private readonly coordinator: CoordinatorLike;
  private readonly receiptStore: ReceiptStoreReader;
  private readonly logger: LoopLogger;
  private readonly now: () => string;
  private readonly emit: TaskPlanEventEmitter | null;

  /** plan id → in-flight runId so cancel() can abort the underlying submit. */
  private readonly inFlight = new Map<string, string>();
  /** plan ids the operator has cancelled. Honored at the top of each loop iter. */
  private readonly cancelled = new Set<string>();
  /** Last repair diagnosis, used by buildEffectivePrompt for smarter repair hints. */
  private lastDiagnosis: RepairDiagnosis | null = null;

  constructor(options: TaskLoopRunnerOptions) {
    this.store = options.store;
    this.coordinator = options.coordinator;
    this.receiptStore = options.receiptStore;
    this.logger = options.logger ?? consoleLogger;
    this.now = options.now ?? (() => new Date().toISOString());
    this.emit = options.emit ?? null;
  }

  /**
   * Emit a task_plan_event with a stable payload shape. Swallows
   * emitter errors — the loop driver MUST NOT fail because a
   * downstream listener threw. Truthful state on disk is the
   * canonical source; events are observability.
   */
  private emitEvent(
    plan: TaskPlan,
    kind: TaskPlanEventKind,
    message: string,
    currentSubtaskId: string | null,
    extras?: {
      recommendedTargets?: readonly string[];
      scoutReportIds?: readonly string[];
      ctas?: TaskPlanEventPayload["ctas"];
    },
  ): void {
    if (!this.emit) return;
    let completed = 0;
    let total = 0;
    for (const s of plan.subtasks) {
      total += 1;
      if (s.status === "completed" || s.status === "repaired" || s.status === "skipped") completed += 1;
    }
    try {
      this.emit({
        kind,
        taskPlanId: plan.taskPlanId,
        status: plan.status,
        currentSubtaskId,
        progress: { completed, total },
        stopReason: plan.stopReason,
        message,
        updatedAt: plan.updatedAt,
        ...(extras?.recommendedTargets ? { recommendedTargets: extras.recommendedTargets } : {}),
        ...(extras?.scoutReportIds ? { scoutReportIds: extras.scoutReportIds } : {}),
        ...(extras?.ctas ? { ctas: extras.ctas } : {}),
      });
    } catch (err) {
      this.logger.warn(
        `[task-loop] emit threw for plan=${plan.taskPlanId} kind=${kind}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Inspect the persisted run record for stage-level timeouts and
   * fold them into the subtask's `timedOutModels` history. Pure
   * helper apart from the persistRollback-style merge — the actual
   * write happens in the caller via mergeSubtask.
   *
   * Returns the new `timedOutModels` list AND the set of
   * (stage, provider, model) tuples that hit a timeout in THIS
   * receipt (for emit / decision logic). The "stage" is derived
   * from the workerEvents log when available, falling back to
   * checkpoint classification, then to "unknown" — the test stubs
   * may not produce all three.
   */
  private extractTimeoutsFromReceipt(
    subtask: Subtask,
    persisted: Awaited<ReturnType<ReceiptStoreReader["getRun"]>>,
  ): {
    nextTimedOutModels: readonly TimedOutModelEntry[];
    newTimeouts: ReadonlyArray<{ stage: string; provider: string; model: string }>;
  } {
    if (!persisted) {
      return { nextTimedOutModels: subtask.timedOutModels ?? [], newTimeouts: [] };
    }
    const attempts = persisted.providerAttempts ?? [];
    const events = persisted.workerEvents ?? [];
    const checkpoints = persisted.checkpoints ?? [];
    const newTimeouts: Array<{ stage: string; provider: string; model: string }> = [];
    let next: readonly TimedOutModelEntry[] = subtask.timedOutModels ?? [];
    for (const a of attempts) {
      if (a.outcome !== "timeout") continue;
      // Best-effort stage inference. providerAttempts entries carry a
      // taskId; workerEvents map taskId → workerType. When the taskId
      // is missing (older shapes) fall back to scanning checkpoints
      // for a "<stage>_timeout" classification.
      let stage: string | null = null;
      if (a.taskId) {
        const ev = events.find((e) => e.taskId === a.taskId);
        if (ev) stage = ev.workerType;
      }
      if (!stage) {
        const cp = checkpoints.find((c) => {
          const cls = (c.details && (c.details as Record<string, unknown>).classification) as string | undefined;
          return cls?.endsWith?.("_timeout");
        });
        if (cp) {
          const cls = (cp.details as Record<string, unknown>).classification as string;
          stage = cls.replace(/_timeout$/, "");
        }
      }
      if (!stage) stage = "unknown";
      next = recordTimeout(next, {
        stage,
        provider: a.provider,
        model: a.model,
        at: this.now(),
        stageTimeoutMs: a.durationMs ?? 0,
      });
      newTimeouts.push({ stage, provider: a.provider, model: a.model });
    }
    return { nextTimedOutModels: next, newTimeouts };
  }

  /**
   * Build the standard "timeout recovery" CTA set the UI renders on
   * the timeout-recovery card. Stable keys so the renderer maps each
   * one to a button. Mirrors buildNeedsReplanCtas but for the
   * cost-control retry pause.
   */
  private buildTimeoutRecoveryCtas(planId: string, subtaskId: string): TaskPlanEventPayload["ctas"] {
    return [
      {
        key: "retry_with_fallback" as unknown as "repair_plan",
        label: "Retry with Fallback",
        endpoint: `/task-plans/${planId}/subtasks/${subtaskId}/timeout-recovery`,
        method: "POST",
        description: "Re-dispatch the stage skipping the timed-out model; uses the next configured chain entry.",
      },
      {
        key: "retry_same_model" as unknown as "show_scout_evidence",
        label: "Retry Same Model",
        endpoint: `/task-plans/${planId}/subtasks/${subtaskId}/timeout-recovery`,
        method: "POST",
        description: "Force a retry on the timed-out model. NOT recommended for expensive cloud models.",
      },
    ];
  }

  /**
   * Build the standard "needs replan" CTA pair so every event that
   * surfaces this state agrees on shape and labels.
   */
  private buildNeedsReplanCtas(planId: string, subtaskId: string): TaskPlanEventPayload["ctas"] {
    return [
      {
        key: "repair_plan",
        label: "Repair Plan",
        endpoint: `/task-plans/${planId}/subtasks/${subtaskId}/attach-target`,
        method: "POST",
        description: "Attach the top scout-recommended target to this subtask and resume the loop.",
      },
      {
        key: "show_scout_evidence",
        label: "Show Scout Evidence",
        endpoint: `/scouts/evidence/${planId}`,
        method: "GET",
        description: "Open the scout-evidence panel for this run.",
      },
    ];
  }

  /**
   * Drive the loop until it pauses or terminates. Each call iterates
   * the next pending subtask. Returns when:
   *   - all subtasks are complete or skipped (status: completed)
   *   - a budget cap is hit (status: blocked or failed)
   *   - approval pause fires (status: paused)
   *   - the plan was cancelled (status: cancelled)
   *
   * Idempotent: calling on a terminal plan is a no-op.
   */
  async run(planId: string): Promise<TaskPlan> {
    let plan = await this.requirePlan(planId);
    if (isTerminalStatus(plan.status)) {
      this.logger.log(`[task-loop] plan ${planId} already terminal (${plan.status}); no-op`);
      return plan;
    }
    // Move the plan into running on the first iteration. The loop
    // body persists every state change, so a crash mid-iteration
    // leaves the plan in a truthful state.
    const wasPaused =
      plan.status === "paused" ||
      plan.status === "blocked" ||
      plan.status === "interrupted" ||
      plan.status === "needs_replan";
    plan = await this.persist({ ...plan, status: "running", stopReason: "", updatedAt: this.now() });
    this.emitEvent(plan, "plan_started", wasPaused ? "Loop resumed" : "Loop started", null);

    while (true) {
      // Honor cancellation BEFORE each iteration. Even if a cancel
      // arrived while a submit() was in flight, the inner await
      // returned before we started another submit.
      if (this.cancelled.has(planId)) {
        this.cancelled.delete(planId);
        plan = await this.persist({
          ...plan,
          status: "cancelled",
          stopReason: "user_cancelled",
          updatedAt: this.now(),
        });
        this.logger.log(`[task-loop] plan ${planId} cancelled by operator`);
        this.emitEvent(plan, "plan_cancelled", "Plan cancelled by operator", null);
        return plan;
      }

      const result = await this.advanceOnce(plan);
      plan = result.plan;
      if (result.stopReason !== null) {
        // stopReason === "" means "fall through to terminal status"; either
        // way the loop is done.
        return plan;
      }
      // result.executed === false should not happen if stopReason is
      // null, but be defensive: avoid infinite loops on a bug.
      if (!result.executed) {
        this.logger.warn(`[task-loop] plan ${planId} advanceOnce returned no execution and no stop; halting defensively`);
        plan = await this.persist({
          ...plan,
          status: "blocked",
          stopReason: "subtask_terminal_failure",
          updatedAt: this.now(),
        });
        return plan;
      }
    }
  }

  /**
   * Advance the loop by exactly one subtask iteration. Exposed for
   * tests + diagnostics. Returns the updated plan plus a stopReason
   * (null when the loop should keep going).
   */
  async advanceOnce(plan: TaskPlan): Promise<AdvanceResult> {
    // ── Budget caps ───────────────────────────────────────────────
    const budgetStop = this.checkAggregateBudget(plan);
    if (budgetStop) {
      const updated = await this.persist({
        ...plan,
        status: "blocked",
        stopReason: budgetStop,
        updatedAt: this.now(),
      });
      this.logger.log(`[task-loop] plan ${plan.taskPlanId} budget hit: ${budgetStop}`);
      this.emitEvent(updated, "plan_blocked", `Budget cap reached: ${budgetStop}`, null);
      return { plan: updated, stopReason: budgetStop, executed: false };
    }

    const subtask = findNextSubtask(plan);
    if (!subtask) {
      // Every subtask is in a terminal state. Decide success vs partial.
      const counts = countSubtasks(plan);
      const allDone = counts.failed === 0 && counts.blocked === 0 && counts.pending === 0 && counts.needsClarification === 0;
      // Needs-clarification trumps a generic blocked/failed status —
      // the operator has a clear repair path (attach a target), so
      // surface it explicitly instead of merging it into a vague
      // FAILED state.
      const status = allDone
        ? "completed"
        : counts.needsClarification > 0
          ? "needs_replan"
          : counts.failed > 0
            ? "failed"
            : "blocked";
      const stop: StopReason = allDone
        ? "all_subtasks_complete"
        : counts.needsClarification > 0
          ? "needs_clarification"
          : counts.failed > 0
            ? "subtask_terminal_failure"
            : "subtask_terminal_failure";
      const updated = await this.persist({
        ...plan,
        status,
        stopReason: stop,
        updatedAt: this.now(),
      });
      const eventKind: TaskPlanEventKind = allDone
        ? "plan_completed"
        : counts.needsClarification > 0
          ? "plan_needs_replan"
          : counts.failed > 0
            ? "plan_failed"
            : "plan_blocked";
      this.emitEvent(
        updated,
        eventKind,
        allDone
          ? `All ${counts.total} subtasks complete`
          : counts.needsClarification > 0
            ? `Mission needs replan: ${counts.needsClarification} subtask(s) need a target file.`
            : `Plan stopped: ${counts.failed} failed, ${counts.blocked} blocked, ${counts.pending} pending`,
        null,
      );
      return { plan: updated, stopReason: stop, executed: false };
    }

    // ── Per-subtask attempt budget ────────────────────────────────
    if (subtask.attempts >= plan.budget.maxAttemptsPerSubtask) {
      const failed = mergeSubtask(plan, subtask.id, {
        status: "failed",
        blockerReason: `max attempts (${plan.budget.maxAttemptsPerSubtask}) reached`,
        nextRecommendedAction: "rewrite the prompt or skip this subtask, then continue",
        completedAt: this.now(),
      });
      const updated = await this.persist({
        ...failed,
        status: "blocked",
        stopReason: "max_attempts_reached",
        spent: {
          ...failed.spent,
          consecutiveFailures: failed.spent.consecutiveFailures + 1,
        },
        updatedAt: this.now(),
      });
      this.emitEvent(updated, "subtask_blocked", `Subtask ${subtask.id} hit attempt cap`, subtask.id);
      this.emitEvent(updated, "plan_blocked", "Plan blocked: max attempts reached", subtask.id);
      return { plan: updated, stopReason: "max_attempts_reached", executed: false };
    }

    // ── Mark running, persist, then submit ─────────────────────────
    const isRepair = subtask.attempts > 0;
    const startedAt = subtask.startedAt ?? this.now();
    const subtaskRunId = randomUUID();
    let working: TaskPlan = mergeSubtask(plan, subtask.id, {
      status: "running",
      attempts: subtask.attempts + 1,
      repairAttempts: isRepair ? subtask.repairAttempts + 1 : subtask.repairAttempts,
      lastRunId: subtaskRunId,
      startedAt,
    });
    working = await this.persist(working);
    this.emitEvent(
      working,
      "subtask_started",
      isRepair
        ? `Subtask ${subtask.id} repair attempt ${subtask.repairAttempts + 1}`
        : `Subtask ${subtask.id} started`,
      subtask.id,
    );
    this.inFlight.set(plan.taskPlanId, subtaskRunId);

    const t0 = Date.now();
    // Compute the persisted exclusion list for this subtask BEFORE
    // dispatch. The default timeout-retry policy refuses to retry a
    // model that has already timed out — so any (stage, provider,
    // model) tuple in `subtask.timedOutModels` is excluded from this
    // attempt's chain. The coordinator passes the list through to
    // workers so chain-build can skip these entries.
    const excludedModels = (subtask.timedOutModels ?? []).map((t) => ({
      stage: t.stage, provider: t.provider, model: t.model,
    }));

    let receipt: RunReceipt;
    try {
      receipt = await this.coordinator.submit({
        input: this.buildEffectivePrompt(subtask, isRepair),
        runId: subtaskRunId,
        projectRoot: plan.repoPath,
        ...(excludedModels.length > 0 ? { excludedModels } : {}),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.inFlight.delete(plan.taskPlanId);
      const dt = Date.now() - t0;
      // Stage-timeout detection: even on a thrown error the run may
      // have produced provider attempts (e.g., the workers tried, all
      // chain entries timed out, then the coordinator threw). We pull
      // the persisted record here so the timeout history gets folded
      // into the subtask BEFORE we build the failure receipt.
      const persistedAtFail = await this.receiptStore.getRun(subtaskRunId).catch(() => null);
      const timeoutInfo = this.extractTimeoutsFromReceipt(subtask, persistedAtFail);

      // Pre-dispatch guard: the coordinator could not identify a
      // target file even after scouts ran. Convert to NEEDS_REPLAN
      // (not subtask_terminal_failure) so the operator gets scout
      // evidence + actionable CTAs instead of a dead-end FAILED
      // banner. Plan stays paused — `/continue` can resume after the
      // operator attaches a target.
      if (err instanceof NeedsClarificationError) {
        this.logger.log(
          `[task-loop] subtask ${subtask.id} needs clarification: ${message} ` +
          `(scoutSpawned=${err.scoutSpawned} recs=[${err.recommendedTargets.slice(0, 3).join(",")}])`,
        );
        const cleared = mergeSubtask(working, subtask.id, {
          status: "needs_clarification",
          lastVerdict: null,
          evidenceRunIds: [...subtask.evidenceRunIds, subtaskRunId],
          // Roll back the attempt counter — this attempt never reached
          // the Builder, so it shouldn't count against the per-subtask
          // budget. Otherwise three consecutive guard hits would burn
          // the whole budget and force the operator to re-create the
          // plan.
          attempts: subtask.attempts,
          repairAttempts: subtask.repairAttempts,
          blockerReason: message,
          nextRecommendedAction: err.recommendedAction,
          recommendedTargets: err.recommendedTargets,
          scoutReportIds: err.scoutReportIds,
          // Do NOT set completedAt — the subtask is recoverable.
        });
        const updated = await this.persist({
          ...cleared,
          status: "needs_replan",
          stopReason: "needs_clarification",
          spent: bumpSpent(cleared.spent, { runtimeMs: dt }),
          updatedAt: this.now(),
        });
        const recList = err.recommendedTargets.length > 0
          ? `Scout found: [${err.recommendedTargets.slice(0, 3).join(", ")}]. Suggest attaching ${err.recommendedTargets[0]} to ${subtask.id} and retrying.`
          : "Scout found no target files for this subtask. Please clarify which file to modify.";
        const ctas = this.buildNeedsReplanCtas(plan.taskPlanId, subtask.id);
        this.emitEvent(
          updated,
          "subtask_needs_clarification",
          `Subtask ${subtask.id} needs a target file. ${err.recommendedAction}`,
          subtask.id,
          { recommendedTargets: err.recommendedTargets, scoutReportIds: err.scoutReportIds, ctas },
        );
        this.emitEvent(
          updated,
          "plan_needs_replan",
          `Mission needs replan — subtask ${subtask.id} has no actionable target. ${recList}`,
          subtask.id,
          { recommendedTargets: err.recommendedTargets, scoutReportIds: err.scoutReportIds, ctas },
        );
        return { plan: updated, stopReason: "needs_clarification", executed: true };
      }

      // STAGE TIMEOUT RECOVERY (cost-control branch). When the
      // failure was caused by a stage-level timeout AND the chain
      // would otherwise re-dispatch the same model on the next repair
      // attempt, we transition to NEEDS_REPLAN with `stopReason
      // = "needs_clarification"` so the operator's recovery card
      // dominates instead of burning another 180s + tokens. The exact
      // bug from 2026-05-03: Aedis retried claude-opus-4-7 after a
      // first 180s timeout. The persisted timedOutModels list now
      // gates this — once a model is in there, the coordinator's
      // chain skip + this guard ensure no auto-retry.
      if (timeoutInfo.newTimeouts.length > 0) {
        this.logger.warn(
          `[task-loop] stage timeout(s) detected for subtask ${subtask.id}: ` +
          timeoutInfo.newTimeouts.map((t) => `${t.stage}=${t.provider}/${t.model}`).join(", "),
        );
        const cleared = mergeSubtask(working, subtask.id, {
          status: "needs_clarification",
          lastVerdict: null,
          evidenceRunIds: [...subtask.evidenceRunIds, subtaskRunId],
          attempts: subtask.attempts,
          repairAttempts: subtask.repairAttempts,
          blockerReason:
            `Stage timeout: ${timeoutInfo.newTimeouts.map((t) => `${t.stage}/${t.provider}/${t.model}`).join(", ")} timed out. ${message}`,
          nextRecommendedAction:
            `Choose a recovery action — Retry with Fallback (preferred), Retry Same Model (NOT recommended for expensive cloud models), Skip stage, or Cancel run.`,
          timedOutModels: timeoutInfo.nextTimedOutModels,
        });
        const updated = await this.persist({
          ...cleared,
          status: "needs_replan",
          stopReason: "needs_clarification",
          spent: bumpSpent(cleared.spent, { runtimeMs: dt }),
          updatedAt: this.now(),
        });
        const ctas = this.buildTimeoutRecoveryCtas(plan.taskPlanId, subtask.id);
        this.emitEvent(
          updated,
          "subtask_needs_clarification",
          `Subtask ${subtask.id} hit a stage timeout — recovery decision needed.`,
          subtask.id,
          { ctas },
        );
        this.emitEvent(
          updated,
          "plan_needs_replan",
          `Mission needs replan — stage timeout on ${timeoutInfo.newTimeouts.map((t) => `${t.stage}/${t.provider}/${t.model}`).join(", ")}.`,
          subtask.id,
          { ctas },
        );
        return { plan: updated, stopReason: "needs_clarification", executed: true };
      }

      this.logger.error(`[task-loop] submit threw for plan=${plan.taskPlanId} subtask=${subtask.id}: ${message}`);
      const failed = mergeSubtask(working, subtask.id, {
        status: "failed",
        lastVerdict: "failed",
        evidenceRunIds: [...subtask.evidenceRunIds, subtaskRunId],
        blockerReason: `submit() threw: ${message}`,
        nextRecommendedAction: "inspect server logs; the run did not produce a receipt",
        completedAt: this.now(),
        timedOutModels: timeoutInfo.nextTimedOutModels,
      });
      const updated = await this.persist({
        ...failed,
        status: "failed",
        stopReason: "subtask_terminal_failure",
        spent: bumpSpent(failed.spent, { runtimeMs: dt, consecutiveFailures: 1 }),
        updatedAt: this.now(),
      });
      this.emitEvent(updated, "subtask_failed", `Subtask ${subtask.id} threw: ${message}`, subtask.id);
      this.emitEvent(updated, "plan_failed", "Plan failed: submit threw", subtask.id);
      return { plan: updated, stopReason: "subtask_terminal_failure", executed: true };
    }
    const dt = Date.now() - t0;
    this.inFlight.delete(plan.taskPlanId);

    const cost = Number(receipt.totalCost?.estimatedCostUsd ?? 0) || 0;
    const evidenceRunIds = [...subtask.evidenceRunIds, subtaskRunId];

    // ── Detect approval pause via the receipt store ────────────────
    const post = await this.receiptStore.getRun(receipt.runId).catch(() => null);
    const awaitingApproval =
      post?.status === "AWAITING_APPROVAL" || receipt.verdict === "partial" && post?.status === "AWAITING_APPROVAL";

    // Stage-timeout extraction (post-receipt). Runs on every receipt,
    // not just failures, so a partial-success run that nevertheless
    // had a worker time out has its history persisted on the subtask.
    const postTimeoutInfo = this.extractTimeoutsFromReceipt(subtask, post);

    if (awaitingApproval) {
      const blocked = mergeSubtask(working, subtask.id, {
        status: "blocked",
        lastVerdict: receipt.verdict,
        evidenceRunIds,
        blockerReason: "approval required: a workspace commit is awaiting human approval",
        nextRecommendedAction:
          `approve or reject run ${receipt.runId} via /tasks/.../approve, then POST /task-plans/${plan.taskPlanId}/continue`,
        costUsd: subtask.costUsd + cost,
      });
      const updated = await this.persist({
        ...blocked,
        status: "paused",
        stopReason: "approval_required",
        spent: bumpSpent(blocked.spent, { runtimeMs: dt, costUsd: cost, attempted: 1 }),
        updatedAt: this.now(),
      });
      this.logger.log(`[task-loop] plan ${plan.taskPlanId} paused for approval at ${subtask.id} (run ${receipt.runId})`);
      this.emitEvent(updated, "subtask_blocked", `Subtask ${subtask.id} awaiting approval`, subtask.id);
      this.emitEvent(updated, "plan_paused", `Plan paused: approval required for run ${receipt.runId}`, subtask.id);
      return { plan: updated, stopReason: "approval_required", executed: true };
    }

    if (receipt.verdict === "aborted") {
      const cancelled = mergeSubtask(working, subtask.id, {
        status: "skipped",
        lastVerdict: "aborted",
        evidenceRunIds,
        blockerReason: "subtask aborted (likely cancellation)",
        completedAt: this.now(),
        costUsd: subtask.costUsd + cost,
      });
      const updated = await this.persist({
        ...cancelled,
        status: "cancelled",
        stopReason: "user_cancelled",
        spent: bumpSpent(cancelled.spent, { runtimeMs: dt, costUsd: cost, attempted: 1 }),
        updatedAt: this.now(),
      });
      this.emitEvent(updated, "subtask_skipped", `Subtask ${subtask.id} aborted`, subtask.id);
      this.emitEvent(updated, "plan_cancelled", "Plan cancelled (subtask aborted)", subtask.id);
      return { plan: updated, stopReason: "user_cancelled", executed: true };
    }

    if (receipt.verdict === "success") {
      const completedStatus: SubtaskStatus = isRepair ? "repaired" : "completed";
      const completed = mergeSubtask(working, subtask.id, {
        status: completedStatus,
        lastVerdict: "success",
        evidenceRunIds,
        completedAt: this.now(),
        costUsd: subtask.costUsd + cost,
      });
      const next: TaskPlan = {
        ...completed,
        spent: bumpSpent(completed.spent, {
          runtimeMs: dt,
          costUsd: cost,
          // success resets the consecutive failures streak
          consecutiveFailuresReset: true,
          attempted: 1,
        }),
        updatedAt: this.now(),
      };
      const persisted = await this.persist(next);
      this.logger.log(
        `[task-loop] plan ${plan.taskPlanId} subtask ${subtask.id} ${completedStatus} ` +
        `(run ${receipt.runId} cost=$${cost.toFixed(4)})`,
      );
      this.emitEvent(
        persisted,
        completedStatus === "repaired" ? "subtask_repaired" : "subtask_completed",
        `Subtask ${subtask.id} ${completedStatus}`,
        subtask.id,
      );
      return { plan: persisted, stopReason: null, executed: true };
    }

    // ── partial / failed → diagnose + bounded repair or terminal ──
    //
    // Adaptive Repair Intelligence: analyze the failure to produce a
    // structured diagnosis with root cause, suggested action, confidence,
    // and a sharpened repair hint. The diagnosis improves the repair
    // prompt quality and gives the operator clear visibility into what
    // went wrong and what will be tried next.
    const repairsLeft = plan.budget.maxRepairAttempts - subtask.repairAttempts;
    const moreAttemptsLeft = subtask.attempts + 1 < plan.budget.maxAttemptsPerSubtask;

    const diagnosis = diagnoseFailure({
      receipt,
      originalPrompt: subtask.prompt,
      attemptNumber: subtask.attempts + 1,
      maxAttempts: plan.budget.maxAttemptsPerSubtask,
    });
    this.logger.log(
      `[task-loop] repair diagnosis for ${subtask.id}: category=${diagnosis.category} ` +
      `confidence=${diagnosis.confidence.toFixed(2)} retriable=${diagnosis.retriable} ` +
      `files=[${diagnosis.likelyFiles.slice(0, 3).join(", ")}]`,
    );

    // Store the diagnosis for receipt/UI transparency. We keep the last
    // diagnosis — each repair attempt overwrites the previous one so
    // the operator sees the most recent analysis.
    this.lastDiagnosis = diagnosis;

    // STAGE TIMEOUT GATE — runs BEFORE the repair branch.
    //
    // If any new timeouts were detected on this attempt, persist them
    // on the subtask AND check whether the next dispatch would just
    // re-pick a timed-out model. When it would (no fallback left, OR
    // expensive-model hardBlock fires) the loop transitions to
    // NEEDS_REPLAN with the timeout-recovery card so the operator
    // can pick: Retry with Fallback / Retry Same Model / Skip / Cancel.
    if (postTimeoutInfo.newTimeouts.length > 0) {
      this.logger.warn(
        `[task-loop] stage timeout(s) detected on success path for subtask ${subtask.id}: ` +
        postTimeoutInfo.newTimeouts.map((t) => `${t.stage}=${t.provider}/${t.model}`).join(", "),
      );
      // We don't have the live chain here (workers own it), but the
      // policy fires on the persisted history alone — if the same
      // (stage, provider, model) tuple already appears in the
      // subtask's timedOutModels with consecutiveTimeouts >= 1 AND
      // a non-retriable verdict came back, we pause for operator.
      // The pragmatic guard: ALWAYS pause on a stage timeout when
      // the receipt's verdict is failed/partial — a single timeout
      // on a 180s stage is enough to warrant the operator's
      // attention. Successful receipts (verdict === "success") do
      // not pause; they just record the history.
      if (receipt.verdict === "failed" || receipt.verdict === "partial") {
        const cleared = mergeSubtask(working, subtask.id, {
          status: "needs_clarification",
          lastVerdict: receipt.verdict,
          evidenceRunIds,
          attempts: subtask.attempts,
          repairAttempts: subtask.repairAttempts,
          costUsd: subtask.costUsd + cost,
          blockerReason:
            `Stage timeout: ${postTimeoutInfo.newTimeouts.map((t) => `${t.stage}/${t.provider}/${t.model}`).join(", ")} timed out at the stage limit. Aedis will NOT retry the same expensive model automatically.`,
          nextRecommendedAction:
            `Choose recovery — Retry with Fallback (preferred), Retry Same Model (NOT recommended), Skip stage, or Cancel run.`,
          timedOutModels: postTimeoutInfo.nextTimedOutModels,
        });
        const updated = await this.persist({
          ...cleared,
          status: "needs_replan",
          stopReason: "needs_clarification",
          spent: bumpSpent(cleared.spent, { runtimeMs: dt, costUsd: cost, attempted: 1 }),
          updatedAt: this.now(),
        });
        const ctas = this.buildTimeoutRecoveryCtas(plan.taskPlanId, subtask.id);
        this.emitEvent(
          updated,
          "subtask_needs_clarification",
          `Subtask ${subtask.id} hit a stage timeout — recovery decision needed.`,
          subtask.id,
          { ctas },
        );
        this.emitEvent(
          updated,
          "plan_needs_replan",
          `Mission needs replan — stage timeout on ${postTimeoutInfo.newTimeouts.map((t) => `${t.stage}/${t.provider}/${t.model}`).join(", ")}.`,
          subtask.id,
          { ctas },
        );
        return { plan: updated, stopReason: "needs_clarification", executed: true };
      }
      // Success-with-recorded-timeout path: persist the history but
      // continue the normal completed/repair flow. (This branch is
      // unreachable here because verdict === "success" was already
      // handled above; the assertion documents intent.)
    }

    if (repairsLeft > 0 && moreAttemptsLeft && diagnosis.retriable) {
      // Queue repair with the diagnosis-sharpened prompt hint.
      const queued = mergeSubtask(working, subtask.id, {
        status: "pending",
        lastVerdict: receipt.verdict,
        evidenceRunIds,
        blockerReason: `${diagnosis.category}: ${diagnosis.rootCause}`,
        nextRecommendedAction: diagnosis.suggestedAction,
        costUsd: subtask.costUsd + cost,
        timedOutModels: postTimeoutInfo.nextTimedOutModels,
      });
      const next: TaskPlan = {
        ...queued,
        spent: bumpSpent(queued.spent, { runtimeMs: dt, costUsd: cost, attempted: 1 }),
        updatedAt: this.now(),
      };
      const persisted = await this.persist(next);
      this.logger.log(
        `[task-loop] plan ${plan.taskPlanId} subtask ${subtask.id} → repair queued ` +
        `(attempts=${queued.subtasks.find((s) => s.id === subtask.id)?.attempts}, ` +
        `repair=${queued.subtasks.find((s) => s.id === subtask.id)?.repairAttempts}, ` +
        `diagnosedAs=${diagnosis.category})`,
      );
      this.emitEvent(
        persisted,
        "subtask_failed",
        `Subtask ${subtask.id} attempt ${subtask.attempts + 1} failed (${diagnosis.category}); queuing repair — ${diagnosis.suggestedAction}`,
        subtask.id,
      );
      return { plan: persisted, stopReason: null, executed: true };
    }

    // No repairs left OR failure is not retriable. Terminal failure.
    const terminalReason = !diagnosis.retriable
      ? `non-retriable failure (${diagnosis.category}): ${diagnosis.rootCause}`
      : `${receipt.verdict}: ${diagnosis.rootCause}`;
    const failed = mergeSubtask(working, subtask.id, {
      status: "failed",
      lastVerdict: receipt.verdict,
      evidenceRunIds,
      blockerReason: terminalReason,
      nextRecommendedAction: diagnosis.suggestedAction || "rewrite the prompt or skip this subtask, then continue",
      completedAt: this.now(),
      costUsd: subtask.costUsd + cost,
    });
    const next: TaskPlan = {
      ...failed,
      status: "blocked",
      stopReason: repairsLeft === 0 ? "max_repair_attempts_reached" : "max_attempts_reached",
      spent: bumpSpent(failed.spent, {
        runtimeMs: dt,
        costUsd: cost,
        attempted: 1,
        consecutiveFailures: 1,
      }),
      updatedAt: this.now(),
    };
    const persisted = await this.persist(next);
    this.emitEvent(persisted, "subtask_failed", `Subtask ${subtask.id} exhausted repairs`, subtask.id);
    this.emitEvent(persisted, "plan_blocked", `Plan blocked: ${next.stopReason}`, subtask.id);
    return { plan: persisted, stopReason: next.stopReason as StopReason, executed: true };
  }

  /**
   * Mark a plan as cancelled. If a submit is in flight for the plan,
   * the underlying coordinator run is also cancelled so the run
   * doesn't keep eating budget while the loop unwinds. Idempotent.
   */
  async cancel(planId: string): Promise<void> {
    this.cancelled.add(planId);
    const inFlight = this.inFlight.get(planId);
    if (inFlight) {
      try {
        await this.coordinator.cancel(inFlight);
      } catch (err) {
        this.logger.warn(
          `[task-loop] cancel: coordinator.cancel(${inFlight}) threw: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    const plan = await this.store.load(planId);
    if (plan && !isTerminalStatus(plan.status)) {
      const next = await this.persist({
        ...plan,
        status: "cancelled",
        stopReason: "user_cancelled",
        updatedAt: this.now(),
      });
      this.emitEvent(next, "plan_cancelled", "Plan cancelled by operator", null);
    }
  }

  /**
   * Apply an operator's timeout-recovery decision. Called by the UI
   * recovery card and the corresponding HTTP route. Inputs:
   *
   *   - `retry_with_fallback` — clear the subtask state for re-dispatch
   *     while preserving timedOutModels, so the next chain entry is
   *     used. The operator's preferred path.
   *   - `retry_same_model`   — explicit override; clears the most-recent
   *     timed-out model from the history so the policy permits one
   *     re-dispatch on the same entry. Cost-class warning is the UI's job.
   *   - `skip_stage`         — mark the subtask `skipped` so the loop
   *     advances. Useful when the timed-out stage is non-essential
   *     (e.g. an LLM critic on a deterministic-builder run).
   *   - `cancel_run`         — cancel the entire plan (delegates to
   *     the existing cancel() flow).
   */
  async applyTimeoutDecision(
    planId: string,
    subtaskId: string,
    decision: "retry_with_fallback" | "retry_same_model" | "skip_stage" | "cancel_run",
  ): Promise<TaskPlan> {
    const plan = await this.requirePlan(planId);
    const sub = plan.subtasks.find((s) => s.id === subtaskId);
    if (!sub) throw new TaskLoopError(`subtask ${subtaskId} not found in plan ${planId}`);
    if (sub.status !== "needs_clarification") {
      throw new TaskLoopError(
        `subtask ${subtaskId} is in state ${sub.status}; applyTimeoutDecision is only valid for needs_clarification`,
      );
    }
    if (decision === "cancel_run") {
      await this.cancel(planId);
      return await this.requirePlan(planId);
    }
    if (decision === "skip_stage") {
      const skipped = mergeSubtask(plan, subtaskId, {
        status: "skipped",
        completedAt: this.now(),
        blockerReason: "operator chose 'Skip Stage' on the timeout-recovery card",
        nextRecommendedAction: "the next pending subtask will run on /continue",
      });
      const next = await this.persist({ ...skipped, status: "paused", stopReason: "", updatedAt: this.now() });
      this.emitEvent(next, "subtask_skipped", `Subtask ${subtaskId} skipped (timeout recovery)`, subtaskId);
      return next;
    }

    // For both retry decisions: the subtask flips back to pending so
    // the loop's next iteration dispatches it again. The difference
    // is whether the most-recent timed-out model stays excluded.
    let nextTimedOutModels = sub.timedOutModels ?? [];
    if (decision === "retry_same_model" && nextTimedOutModels.length > 0) {
      // Drop the most-recent entry so decideNextDispatch will allow it.
      // We pop the LAST entry (most recently added) — the recordTimeout
      // helper appends in order so this maps to "release the most recent
      // timeout" semantics. Earlier entries (older models) stay excluded.
      nextTimedOutModels = nextTimedOutModels.slice(0, -1);
    }
    const queued = mergeSubtask(plan, subtaskId, {
      status: "pending",
      blockerReason: "",
      nextRecommendedAction: "",
      timedOutModels: nextTimedOutModels,
    });
    const next = await this.persist({
      ...queued,
      status: "paused",
      stopReason: "",
      updatedAt: this.now(),
    });
    this.emitEvent(
      next,
      "subtask_started",
      `Subtask ${subtaskId} requeued — timeout decision: ${decision}`,
      subtaskId,
    );
    return next;
  }

  /**
   * Mark a subtask as skipped (operator decision). The next call to
   * `run()` resumes from the next pending subtask. Idempotent on
   * already-terminal subtasks.
   */
  async skipSubtask(planId: string, subtaskId: string): Promise<TaskPlan> {
    const plan = await this.requirePlan(planId);
    const sub = plan.subtasks.find((s) => s.id === subtaskId);
    if (!sub) throw new TaskLoopError(`subtask ${subtaskId} not found in plan ${planId}`);
    if (sub.status === "completed" || sub.status === "skipped" || sub.status === "repaired") {
      return plan;
    }
    const next = mergeSubtask(plan, subtaskId, {
      status: "skipped",
      blockerReason: sub.blockerReason || "skipped by operator",
      nextRecommendedAction: "continue to next subtask",
      completedAt: this.now(),
    });
    return this.persist({ ...next, updatedAt: this.now() });
  }

  /**
   * Attach a target file to a `needs_clarification` subtask so the
   * loop can re-dispatch it. The supplied target is prepended to the
   * subtask's prompt as an explicit hint — the same form the
   * coordinator's prepareTargetsForPrompt produces — and the subtask
   * is flipped back to `pending` with cleared blocker. Plan status
   * goes back to `paused` so `/continue` will resume it.
   *
   * Validation:
   *   - Subtask must exist and be in `needs_clarification`.
   *   - `target` must be a non-empty string. Path existence is NOT
   *     required at this layer — a "create" task points at a path
   *     that doesn't exist yet. The coordinator's downstream guards
   *     are the authority on path validity.
   */
  async attachTargetToSubtask(
    planId: string,
    subtaskId: string,
    target: string,
  ): Promise<TaskPlan> {
    const plan = await this.requirePlan(planId);
    const sub = plan.subtasks.find((s) => s.id === subtaskId);
    if (!sub) throw new TaskLoopError(`subtask ${subtaskId} not found in plan ${planId}`);
    if (sub.status !== "needs_clarification") {
      throw new TaskLoopError(
        `subtask ${subtaskId} is in state ${sub.status}; attachTarget is only valid for needs_clarification`,
      );
    }
    const trimmed = String(target ?? "").trim();
    if (!trimmed) {
      throw new TaskLoopError("attachTarget requires a non-empty target file path");
    }
    const augmentedPrompt = sub.prompt.includes(trimmed)
      ? sub.prompt
      : `Target file: ${trimmed}\n\n${sub.prompt}`;
    const next = mergeSubtask(plan, subtaskId, {
      status: "pending",
      prompt: augmentedPrompt,
      blockerReason: "",
      nextRecommendedAction: "",
      lastVerdict: null,
      // Preserve scout evidence on the subtask so the audit trail
      // reflects what got attached and why.
      recommendedTargets: sub.recommendedTargets,
      scoutReportIds: sub.scoutReportIds,
    });
    const planNext: TaskPlan = {
      ...next,
      status: "paused",
      stopReason: "approval_required" === next.stopReason ? "approval_required" : "",
      updatedAt: this.now(),
    };
    const persisted = await this.persist(planNext);
    this.emitEvent(
      persisted,
      "subtask_started",
      `Subtask ${subtaskId} target attached: ${trimmed}. Ready to resume.`,
      subtaskId,
    );
    return persisted;
  }

  /** Fetch the final summary for a terminal or pause plan. */
  async summarize(planId: string): Promise<TaskPlanFinalSummary> {
    const plan = await this.requirePlan(planId);
    return buildFinalSummary(plan);
  }

  // ─── Internals ─────────────────────────────────────────────────

  private async requirePlan(planId: string): Promise<TaskPlan> {
    const plan = await this.store.load(planId);
    if (!plan) throw new TaskLoopError(`task plan ${planId} not found`);
    return plan;
  }

  private async persist(plan: TaskPlan): Promise<TaskPlan> {
    await this.store.save(plan);
    return plan;
  }

  /**
   * Build the prompt the coordinator actually sees. On a repair
   * attempt we prepend a short tightening instruction so the
   * Builder/Critic know this is a retry, not a fresh request. The
   * tightening is intentionally generic — domain-specific repair
   * happens inside coordinator.submit (its existing weak-output
   * retry + critic loop).
   */
  private buildEffectivePrompt(subtask: Subtask, isRepair: boolean): string {
    if (!isRepair) return subtask.prompt;

    // Use the diagnosis repair hint if available — it carries a
    // structured, category-specific sharpening of the prompt that
    // the classifier produced from the actual failure evidence.
    if (this.lastDiagnosis?.repairHint) {
      return (
        `[repair attempt ${subtask.repairAttempts + 1}/${this.lastDiagnosis.maxAttempts}] ` +
        this.lastDiagnosis.repairHint
      );
    }

    // Fallback: use the blocker reason from the subtask itself
    const lastBlocker = subtask.blockerReason || "previous attempt did not pass verification";
    return (
      `[repair attempt ${subtask.repairAttempts + 1}] ` +
      `Reason for retry: ${lastBlocker}. ` +
      `Original request: ${subtask.prompt}`
    );
  }

  private checkAggregateBudget(plan: TaskPlan): StopReason | null {
    if (plan.spent.subtasksAttempted >= plan.budget.maxSubtasks) {
      return "max_subtasks_reached";
    }
    if (plan.spent.totalRuntimeMs >= plan.budget.maxRuntimeMs) {
      return "max_runtime_reached";
    }
    if (plan.spent.totalCostUsd >= plan.budget.maxCostUsd) {
      return "max_cost_reached";
    }
    if (plan.spent.consecutiveFailures >= plan.budget.maxConsecutiveFailures) {
      return "max_consecutive_failures_reached";
    }
    return null;
  }
}

export class TaskLoopError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskLoopError";
  }
}

// ─── Pure helpers ───────────────────────────────────────────────────

function isTerminalStatus(status: TaskPlan["status"]): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled"
  );
}

function mergeSubtask(plan: TaskPlan, id: string, patch: Partial<Subtask>): TaskPlan {
  return {
    ...plan,
    subtasks: plan.subtasks.map((s) => (s.id === id ? { ...s, ...patch } : s)),
  };
}

function bumpSpent(
  spent: TaskPlan["spent"],
  delta: {
    runtimeMs?: number;
    costUsd?: number;
    attempted?: number;
    consecutiveFailures?: number;
    consecutiveFailuresReset?: boolean;
  },
): TaskPlan["spent"] {
  return {
    totalCostUsd: spent.totalCostUsd + (delta.costUsd ?? 0),
    totalRuntimeMs: spent.totalRuntimeMs + (delta.runtimeMs ?? 0),
    consecutiveFailures: delta.consecutiveFailuresReset
      ? 0
      : spent.consecutiveFailures + (delta.consecutiveFailures ?? 0),
    subtasksAttempted: spent.subtasksAttempted + (delta.attempted ?? 0),
  };
}
