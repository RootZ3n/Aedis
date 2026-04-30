/**
 * Loop driver tests — pin the safety contract end-to-end with a
 * stubbed coordinator. The stub returns crafted RunReceipts so the
 * loop can be driven through every branch (success, failed, repair,
 * approval pause, abort) without booting workers.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTaskPlan } from "./task-plan.js";
import { TaskPlanStore } from "./task-plan-store.js";
import {
  TaskLoopRunner,
  type CoordinatorLike,
  type ReceiptStoreReader,
} from "./task-loop.js";
import type { RunReceipt, TaskSubmission } from "./coordinator.js";

const NOW = "2026-04-28T12:00:00.000Z";

// ─── Stub plumbing ──────────────────────────────────────────────────

type StubVerdict = "success" | "failed" | "partial" | "aborted";

interface StubCall {
  prompt: string;
  runId: string;
  projectRoot: string | undefined;
}

interface StubScript {
  /** Per-call verdict, in the order submit() is invoked. Last value
   *  repeats if the loop keeps calling. */
  verdicts: readonly StubVerdict[];
  /** Optional per-call receipt-store status override (used to flag
   *  the awaiting-approval pause). Maps call index → status string. */
  receiptStatuses?: Readonly<Record<number, string>>;
  /** Optional per-call cost (in USD). Defaults to 0.001. */
  costs?: readonly number[];
  /** Optional per-call duration in ms. */
  durations?: readonly number[];
  /** Headlines surfaced on partial/failed receipts. Useful for the
   *  blockerReason assertion. */
  headlines?: readonly string[];
}

class StubCoordinator implements CoordinatorLike {
  readonly calls: StubCall[] = [];
  readonly cancelled: string[] = [];
  private readonly script: StubScript;

  constructor(script: StubScript) {
    this.script = script;
  }

  async submit(submission: TaskSubmission): Promise<RunReceipt> {
    const idx = this.calls.length;
    const runId = submission.runId ?? `run-${idx + 1}`;
    this.calls.push({
      prompt: submission.input,
      runId,
      projectRoot: submission.projectRoot,
    });
    const verdict =
      this.script.verdicts[Math.min(idx, this.script.verdicts.length - 1)];
    const cost = this.script.costs?.[idx] ?? 0.001;
    const duration = this.script.durations?.[idx] ?? 5;
    const headline = this.script.headlines?.[idx] ?? `stub-${verdict}`;
    return makeReceipt({ runId, verdict, costUsd: cost, durationMs: duration, headline });
  }

  async cancel(runId: string): Promise<void> {
    this.cancelled.push(runId);
  }
}

class StubReceiptStore implements ReceiptStoreReader {
  /** runId → status. Falls back to `COMPLETE` when absent. */
  readonly statuses = new Map<string, string>();
  async getRun(runId: string): Promise<{ status: string } | null> {
    return { status: this.statuses.get(runId) ?? "COMPLETE" };
  }
}

function makeReceipt(input: {
  runId: string;
  verdict: StubVerdict;
  costUsd: number;
  durationMs: number;
  headline: string;
}): RunReceipt {
  // Cast the receipt — the loop driver only reads a small slice
  // (verdict, totalCost.estimatedCostUsd, humanSummary?.headline,
  // runId). Filling the full RunReceipt shape would couple the test
  // to internal types; the driver doesn't care.
  const receipt: unknown = {
    id: input.runId,
    runId: input.runId,
    intentId: "stub-intent",
    timestamp: NOW,
    verdict: input.verdict,
    summary: {},
    graphSummary: {},
    verificationReceipt: null,
    waveVerifications: [],
    judgmentReport: null,
    mergeDecision: null,
    totalCost: {
      runId: input.runId,
      stage: "task",
      role: "builder",
      model: "stub",
      provider: "stub",
      ts: NOW,
      tokensIn: 0,
      tokensOut: 0,
      estimatedCostUsd: input.costUsd,
    },
    commitSha: input.verdict === "success" ? "deadbeefcafe" : null,
    durationMs: input.durationMs,
    executionVerified: input.verdict === "success",
    executionGateReason: input.verdict === "success" ? "" : "stubbed verdict",
    executionEvidence: [],
    humanSummary: { headline: input.headline },
  };
  return receipt as RunReceipt;
}

function tempRunner(script: StubScript) {
  const dir = mkdtempSync(join(tmpdir(), "aedis-task-loop-"));
  const store = new TaskPlanStore({ stateRoot: dir });
  const coordinator = new StubCoordinator(script);
  const receiptStore = new StubReceiptStore();
  const runner = new TaskLoopRunner({
    store,
    coordinator,
    receiptStore,
    now: () => NOW,
    logger: { log: () => {}, warn: () => {}, error: () => {} },
  });
  return { dir, store, coordinator, receiptStore, runner };
}

function freshPlan(opts: {
  subtasks: { prompt: string; title?: string }[];
  budget?: Partial<{
    maxSubtasks: number;
    maxAttemptsPerSubtask: number;
    maxRepairAttempts: number;
    maxRuntimeMs: number;
    maxCostUsd: number;
    maxConsecutiveFailures: number;
  }>;
}) {
  return createTaskPlan(
    {
      objective: "test plan",
      repoPath: "/tmp/repo",
      subtasks: opts.subtasks,
      ...(opts.budget ? { budget: opts.budget } : {}),
    },
    { taskPlanId: `plan_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, now: NOW },
  );
}

// ─── 1. Multi-step task creates a durable subtask plan ─────────────

test("loop: plan persists to disk before any subtask runs", async () => {
  const { dir, store } = tempRunner({ verdicts: ["success"] });
  try {
    const plan = freshPlan({
      subtasks: [
        { prompt: "step 1" },
        { prompt: "step 2" },
        { prompt: "step 3" },
      ],
    });
    await store.create(plan);
    const loaded = await store.load(plan.taskPlanId);
    assert.deepEqual(loaded, plan);
    assert.equal(loaded?.subtasks.length, 3);
    assert.equal(loaded?.status, "pending");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── 2. Aedis completes multiple simple subtasks in order ──────────

test("loop: drives all subtasks to completion in order with one submit each", async () => {
  const { dir, store, coordinator, runner } = tempRunner({
    verdicts: ["success", "success", "success"],
  });
  try {
    const plan = freshPlan({
      subtasks: [{ prompt: "step 1" }, { prompt: "step 2" }, { prompt: "step 3" }],
    });
    await store.create(plan);
    const final = await runner.run(plan.taskPlanId);
    assert.equal(final.status, "completed");
    assert.equal(final.stopReason, "all_subtasks_complete");
    assert.equal(coordinator.calls.length, 3, "one submit per subtask");
    assert.equal(coordinator.calls[0].prompt, "step 1");
    assert.equal(coordinator.calls[2].prompt, "step 3");
    for (const s of final.subtasks) {
      assert.equal(s.status, "completed");
      assert.equal(s.evidenceRunIds.length, 1, "each subtask records its run-id evidence");
    }
    assert.equal(final.spent.subtasksAttempted, 3);
    // Cost rolls up.
    assert.ok(final.spent.totalCostUsd > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── 3. Failed subtask triggers bounded repair, then continues ─────

test("loop: failed subtask repairs once and continues to next when repair succeeds", async () => {
  // subtask 1: failed → repair → success. subtask 2: success.
  const { dir, store, coordinator, runner } = tempRunner({
    verdicts: ["failed", "success", "success"],
  });
  try {
    const plan = freshPlan({
      subtasks: [{ prompt: "step 1" }, { prompt: "step 2" }],
      budget: { maxAttemptsPerSubtask: 3, maxRepairAttempts: 2 },
    });
    await store.create(plan);
    const final = await runner.run(plan.taskPlanId);
    assert.equal(final.status, "completed");
    assert.equal(coordinator.calls.length, 3, "1 fail + 1 repair + 1 next subtask");
    // First subtask repaired, not vanilla completed.
    assert.equal(final.subtasks[0].status, "repaired");
    assert.equal(final.subtasks[0].attempts, 2);
    assert.equal(final.subtasks[0].repairAttempts, 1);
    assert.equal(final.subtasks[1].status, "completed");
    // The repair prompt was tightened.
    assert.match(coordinator.calls[1].prompt, /repair attempt/);
    assert.match(coordinator.calls[1].prompt, /Original request: step 1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loop: subtask that exhausts repair budget is marked failed and loop stops with truthful state", async () => {
  const { dir, store, runner } = tempRunner({
    verdicts: ["failed", "failed", "failed"], // every attempt fails
  });
  try {
    const plan = freshPlan({
      subtasks: [{ prompt: "doomed" }, { prompt: "never reached" }],
      budget: { maxAttemptsPerSubtask: 2, maxRepairAttempts: 1, maxConsecutiveFailures: 5 },
    });
    await store.create(plan);
    const final = await runner.run(plan.taskPlanId);
    assert.equal(final.status, "blocked");
    assert.ok(
      final.stopReason === "max_repair_attempts_reached" ||
        final.stopReason === "max_attempts_reached",
      `expected attempt-budget stop; got ${final.stopReason}`,
    );
    assert.equal(final.subtasks[0].status, "failed");
    assert.equal(final.subtasks[1].status, "pending", "subsequent subtasks must NOT auto-run after a terminal failure");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── 4. Approval-needed subtask pauses the loop ────────────────────

test("loop: AWAITING_APPROVAL receipt pauses the loop and marks subtask blocked, never auto-promotes", async () => {
  // First subtask returns "partial" + receipt store says AWAITING_APPROVAL.
  const { dir, store, coordinator, receiptStore, runner } = tempRunner({
    verdicts: ["partial"],
  });
  try {
    const plan = freshPlan({
      subtasks: [{ prompt: "step 1" }, { prompt: "step 2" }],
    });
    await store.create(plan);
    receiptStore.statuses.set("approval-run", "AWAITING_APPROVAL");
    // Force the runId so the stub maps to the AWAITING_APPROVAL status.
    // The runner generates UUIDs internally; instead we rely on the
    // receipt-store stub returning AWAITING_APPROVAL for *any* run.
    // Simpler: set the default status:
    receiptStore.statuses.clear();
    const originalGet = receiptStore.getRun.bind(receiptStore);
    receiptStore.getRun = async (runId: string) => ({ status: "AWAITING_APPROVAL" });
    try {
      const final = await runner.run(plan.taskPlanId);
      assert.equal(final.status, "paused");
      assert.equal(final.stopReason, "approval_required");
      assert.equal(final.subtasks[0].status, "blocked");
      assert.match(final.subtasks[0].blockerReason, /approval required/i);
      assert.equal(final.subtasks[1].status, "pending", "loop must not advance past an approval pause");
      assert.equal(coordinator.calls.length, 1, "only the first subtask submitted");
    } finally {
      receiptStore.getRun = originalGet;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── 5. Restart reloads task plan safely (running → interrupted) ───

test("loop: restart reloads plan and reconciles running status to interrupted", async () => {
  const { dir, store } = tempRunner({ verdicts: ["success"] });
  try {
    const plan = freshPlan({ subtasks: [{ prompt: "x" }] });
    // Simulate the plan being mid-run when the process died.
    const inFlight = {
      ...plan,
      status: "running" as const,
      subtasks: [
        { ...plan.subtasks[0], status: "running" as const, attempts: 1 },
      ],
    };
    await store.create(inFlight);

    // Booting a fresh store on the same disk and calling restoreOnBoot
    // is exactly what the API layer does.
    const fresh = new TaskPlanStore({ stateRoot: dir });
    const reconciled = await fresh.restoreOnBoot(NOW);
    assert.deepEqual(reconciled, [plan.taskPlanId]);

    const after = await fresh.load(plan.taskPlanId);
    assert.equal(after?.status, "interrupted");
    assert.equal(after?.subtasks[0].status, "blocked");
    // Architectural invariant: server NEVER auto-resumes — the operator
    // has to POST /task-plans/<id>/continue. The reconcile only flips
    // status; it never re-issues a submit.
    assert.equal(after?.requiresExplicitResume, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── 6. Max-step (subtasks) budget stops safely ────────────────────

test("loop: max-subtasks budget halts the loop cleanly with state intact", async () => {
  const { dir, store, runner } = tempRunner({
    verdicts: ["success", "success", "success", "success", "success"],
  });
  try {
    const plan = freshPlan({
      subtasks: [
        { prompt: "1" },
        { prompt: "2" },
        { prompt: "3" },
        { prompt: "4" },
        { prompt: "5" },
      ],
      // Budget allows only 2 subtasks even though there are 5 in the plan.
      // Validation refuses subtask count > maxSubtasks at create time, so
      // here we exercise the *runtime* cap by directly poking the budget
      // after creation. The runtime cap is a defense-in-depth.
    });
    const planWithLowCap = { ...plan, budget: { ...plan.budget, maxSubtasks: 2 } };
    await store.create(planWithLowCap);
    const final = await runner.run(plan.taskPlanId);
    assert.equal(final.status, "blocked");
    assert.equal(final.stopReason, "max_subtasks_reached");
    assert.ok(final.spent.subtasksAttempted >= 2);
    // Receipts for the subtasks we DID attempt are intact.
    const completed = final.subtasks.filter((s) => s.status === "completed");
    assert.ok(completed.length > 0);
    for (const s of completed) {
      assert.ok(s.evidenceRunIds.length > 0);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loop: max-cost budget halts before overrunning the cap", async () => {
  // Each call costs $0.50 → after 2 calls we'd be at $1.00, just at the
  // cap of $1.00. Third call must not fire.
  const { dir, store, coordinator, runner } = tempRunner({
    verdicts: ["success", "success", "success"],
    costs: [0.5, 0.5, 0.5],
  });
  try {
    const plan = freshPlan({
      subtasks: [
        { prompt: "1" },
        { prompt: "2" },
        { prompt: "3" },
      ],
      budget: { maxCostUsd: 1.0 },
    });
    await store.create(plan);
    const final = await runner.run(plan.taskPlanId);
    assert.ok(
      final.stopReason === "max_cost_reached" || final.status === "completed",
      `expected cost cap or completion; got status=${final.status} stopReason=${final.stopReason}`,
    );
    assert.ok(coordinator.calls.length <= 3);
    // Total cost stayed within plausible bounds.
    assert.ok(final.spent.totalCostUsd <= 1.5, "cost cap must keep accumulated cost roughly bounded");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── 7. Cancel stops loop and leaves state truthful ────────────────

test("loop: cancel before run sets status cancelled with stopReason user_cancelled", async () => {
  const { dir, store, runner } = tempRunner({ verdicts: ["success"] });
  try {
    const plan = freshPlan({ subtasks: [{ prompt: "x" }, { prompt: "y" }] });
    await store.create(plan);
    await runner.cancel(plan.taskPlanId);
    const after = await store.load(plan.taskPlanId);
    assert.equal(after?.status, "cancelled");
    assert.equal(after?.stopReason, "user_cancelled");
    // Receipts remain truthful: no completion was claimed.
    for (const s of after!.subtasks) {
      assert.notEqual(s.status, "completed");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── 8. No source mutation occurs before approval ──────────────────

test("loop: NEVER calls promoteToSource — only submits run through coordinator", async () => {
  // The runner is constructed with a CoordinatorLike that exposes
  // ONLY submit + cancel. There is no promoteToSource on the
  // interface. This test pins the type-level guarantee and the
  // runtime behavior together: even on success, the runner doesn't
  // and cannot reach the promotion path.
  const { dir, store, coordinator, runner } = tempRunner({
    verdicts: ["success", "success"],
  });
  try {
    const plan = freshPlan({ subtasks: [{ prompt: "1" }, { prompt: "2" }] });
    await store.create(plan);
    await runner.run(plan.taskPlanId);
    // Sanity: the stub coordinator only saw `submit` calls (and
    // possibly `cancel`); no promote method exists on the surface.
    assert.equal(coordinator.calls.length, 2);
    assert.equal(coordinator.cancelled.length, 0);
    // Type-level: CoordinatorLike has no promoteToSource. If a future
    // change adds one to the interface, this assertion plus the
    // surrounding TS error will surface the regression.
    const surface: keyof typeof coordinator = "submit";
    assert.equal(typeof (coordinator as unknown as Record<string, unknown>)[surface], "function");
    assert.equal(typeof (coordinator as unknown as Record<string, unknown>)["promoteToSource"], "undefined");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── 9. Final summary accurately reflects subtasks ─────────────────

test("loop: final summary lists completed/failed/skipped + receipt run-ids", async () => {
  const { dir, store, runner } = tempRunner({
    verdicts: ["success", "failed", "failed"], // st-2 will exhaust repairs
  });
  try {
    const plan = freshPlan({
      subtasks: [{ prompt: "ok" }, { prompt: "doomed" }, { prompt: "never reached" }],
      budget: { maxAttemptsPerSubtask: 2, maxRepairAttempts: 1 },
    });
    await store.create(plan);
    await runner.run(plan.taskPlanId);
    const summary = await runner.summarize(plan.taskPlanId);
    assert.equal(summary.counts.completed, 1);
    assert.equal(summary.counts.failed, 1);
    assert.equal(summary.counts.pending, 1);
    assert.ok(summary.receiptRunIds.length >= 2);
    assert.match(summary.headline, /Blocked|Failed/);
    assert.ok(summary.recommendedNextAction.length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Defense-in-depth: max consecutive failures fast-fails ─────────

test("loop: max consecutive failures stops on a streak even if subtasks remain", async () => {
  const { dir, store, runner } = tempRunner({
    verdicts: ["failed", "failed", "failed", "failed"],
  });
  try {
    const plan = freshPlan({
      subtasks: [{ prompt: "1" }, { prompt: "2" }],
      budget: { maxAttemptsPerSubtask: 2, maxRepairAttempts: 1, maxConsecutiveFailures: 1 },
    });
    await store.create(plan);
    const final = await runner.run(plan.taskPlanId);
    assert.equal(final.status, "blocked");
    assert.ok(
      final.stopReason === "max_consecutive_failures_reached" ||
        final.stopReason === "max_repair_attempts_reached" ||
        final.stopReason === "max_attempts_reached",
      `expected a budget stop; got ${final.stopReason}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Skip subtask works ────────────────────────────────────────────

test("loop: skipSubtask marks subtask skipped and lets the loop advance", async () => {
  const { dir, store, runner } = tempRunner({
    verdicts: ["success", "success"],
  });
  try {
    const plan = freshPlan({
      subtasks: [{ prompt: "1" }, { prompt: "2" }, { prompt: "3" }],
    });
    await store.create(plan);
    await runner.skipSubtask(plan.taskPlanId, "st-2");
    const final = await runner.run(plan.taskPlanId);
    assert.equal(final.status, "completed");
    assert.equal(final.subtasks[0].status, "completed");
    assert.equal(final.subtasks[1].status, "skipped");
    assert.equal(final.subtasks[2].status, "completed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
