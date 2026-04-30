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
import type { RunReceipt, TaskSubmission } from "./coordinator.js";
import { diagnoseFailure, type RepairDiagnosis } from "./repair-diagnosis.js";

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
 * to detect the "awaiting approval" pause state. Returns null when
 * the run hasn't been persisted yet (e.g. test stubs).
 */
export interface ReceiptStoreReader {
  getRun(runId: string): Promise<{ status: string } | null>;
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
  | "subtask_started"
  | "subtask_completed"
  | "subtask_repaired"
  | "subtask_failed"
  | "subtask_blocked"
  | "subtask_skipped";

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
  private emitEvent(plan: TaskPlan, kind: TaskPlanEventKind, message: string, currentSubtaskId: string | null): void {
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
      });
    } catch (err) {
      this.logger.warn(
        `[task-loop] emit threw for plan=${plan.taskPlanId} kind=${kind}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
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
    const wasPaused = plan.status === "paused" || plan.status === "blocked" || plan.status === "interrupted";
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
      const allDone = counts.failed === 0 && counts.blocked === 0 && counts.pending === 0;
      const status = allDone ? "completed" : counts.failed > 0 ? "failed" : "blocked";
      const stop: StopReason = allDone
        ? "all_subtasks_complete"
        : counts.failed > 0
          ? "subtask_terminal_failure"
          : "subtask_terminal_failure";
      const updated = await this.persist({
        ...plan,
        status,
        stopReason: stop,
        updatedAt: this.now(),
      });
      this.emitEvent(
        updated,
        allDone ? "plan_completed" : counts.failed > 0 ? "plan_failed" : "plan_blocked",
        allDone
          ? `All ${counts.total} subtasks complete`
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
    let receipt: RunReceipt;
    try {
      receipt = await this.coordinator.submit({
        input: this.buildEffectivePrompt(subtask, isRepair),
        runId: subtaskRunId,
        projectRoot: plan.repoPath,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`[task-loop] submit threw for plan=${plan.taskPlanId} subtask=${subtask.id}: ${message}`);
      this.inFlight.delete(plan.taskPlanId);
      const dt = Date.now() - t0;
      const failed = mergeSubtask(working, subtask.id, {
        status: "failed",
        lastVerdict: "failed",
        evidenceRunIds: [...subtask.evidenceRunIds, subtaskRunId],
        blockerReason: `submit() threw: ${message}`,
        nextRecommendedAction: "inspect server logs; the run did not produce a receipt",
        completedAt: this.now(),
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

    if (repairsLeft > 0 && moreAttemptsLeft && diagnosis.retriable) {
      // Queue repair with the diagnosis-sharpened prompt hint.
      const queued = mergeSubtask(working, subtask.id, {
        status: "pending",
        lastVerdict: receipt.verdict,
        evidenceRunIds,
        blockerReason: `${diagnosis.category}: ${diagnosis.rootCause}`,
        nextRecommendedAction: diagnosis.suggestedAction,
        costUsd: subtask.costUsd + cost,
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
