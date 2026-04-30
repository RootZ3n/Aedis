/**
 * Pin the WebSocket event emission contract: every loop transition
 * fires a task_plan_event with the agreed payload shape so the UI
 * can refresh in real time without polling.
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
  type TaskPlanEventKind,
  type TaskPlanEventPayload,
} from "./task-loop.js";
import type { RunReceipt, TaskSubmission } from "./coordinator.js";

const NOW = "2026-04-28T12:00:00.000Z";

// ─── Stubs (mirror task-loop.test.ts; kept minimal) ────────────────

class StubCoordinator implements CoordinatorLike {
  readonly calls: TaskSubmission[] = [];
  readonly cancelled: string[] = [];
  constructor(private readonly verdicts: readonly ("success" | "failed" | "partial" | "aborted")[]) {}
  async submit(s: TaskSubmission): Promise<RunReceipt> {
    const idx = this.calls.length;
    this.calls.push(s);
    const verdict = this.verdicts[Math.min(idx, this.verdicts.length - 1)];
    return makeReceipt(s.runId ?? `run-${idx + 1}`, verdict);
  }
  async cancel(runId: string): Promise<void> { this.cancelled.push(runId); }
}

class StubReceiptStore implements ReceiptStoreReader {
  readonly statuses = new Map<string, string>();
  async getRun(runId: string): Promise<{ status: string } | null> {
    return { status: this.statuses.get(runId) ?? "COMPLETE" };
  }
}

function makeReceipt(runId: string, verdict: "success" | "failed" | "partial" | "aborted"): RunReceipt {
  const r: unknown = {
    id: runId, runId, intentId: "stub", timestamp: NOW, verdict,
    summary: {}, graphSummary: {}, verificationReceipt: null,
    waveVerifications: [], judgmentReport: null, mergeDecision: null,
    totalCost: { runId, stage: "task", role: "builder", model: "stub", provider: "stub", ts: NOW, tokensIn: 0, tokensOut: 0, estimatedCostUsd: 0.001 },
    commitSha: verdict === "success" ? "deadbeef" : null,
    durationMs: 5,
    executionVerified: verdict === "success",
    executionGateReason: "",
    executionEvidence: [],
    humanSummary: { headline: `stub-${verdict}` },
  };
  return r as RunReceipt;
}

function tempRunner(verdicts: readonly ("success" | "failed" | "partial" | "aborted")[]) {
  const dir = mkdtempSync(join(tmpdir(), "aedis-task-loop-events-"));
  const store = new TaskPlanStore({ stateRoot: dir });
  const coordinator = new StubCoordinator(verdicts);
  const receiptStore = new StubReceiptStore();
  const events: TaskPlanEventPayload[] = [];
  const runner = new TaskLoopRunner({
    store,
    coordinator,
    receiptStore,
    now: () => NOW,
    logger: { log: () => {}, warn: () => {}, error: () => {} },
    emit: (e) => { events.push(e); },
  });
  return { dir, store, coordinator, receiptStore, runner, events };
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

// ─── Event payload shape ───────────────────────────────────────────

test("task_plan_event: every emit carries the contract fields", async () => {
  const { dir, store, runner, events } = tempRunner(["success"]);
  try {
    const plan = freshPlan({ subtasks: [{ prompt: "x" }] });
    await store.create(plan);
    await runner.run(plan.taskPlanId);
    assert.ok(events.length > 0);
    for (const ev of events) {
      // Discriminator + identity
      assert.equal(typeof ev.kind, "string");
      assert.equal(ev.taskPlanId, plan.taskPlanId);
      // Status + progress always populated
      assert.equal(typeof ev.status, "string");
      assert.equal(typeof ev.progress, "object");
      assert.equal(typeof ev.progress.completed, "number");
      assert.equal(typeof ev.progress.total, "number");
      assert.equal(ev.progress.total, 1);
      assert.equal(typeof ev.message, "string");
      assert.equal(typeof ev.updatedAt, "string");
      // stopReason is "" or a known reason string
      assert.equal(typeof ev.stopReason, "string");
      // currentSubtaskId is either null or a stable id
      assert.ok(ev.currentSubtaskId === null || typeof ev.currentSubtaskId === "string");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("task_plan_event: a successful run emits plan_started → subtask_started → subtask_completed → plan_completed", async () => {
  const { dir, store, runner, events } = tempRunner(["success", "success"]);
  try {
    const plan = freshPlan({ subtasks: [{ prompt: "1" }, { prompt: "2" }] });
    await store.create(plan);
    await runner.run(plan.taskPlanId);
    const kinds: TaskPlanEventKind[] = events.map((e) => e.kind);
    assert.equal(kinds[0], "plan_started", `first event must be plan_started; got ${kinds[0]}`);
    assert.equal(kinds[kinds.length - 1], "plan_completed", `last event must be plan_completed; got ${kinds[kinds.length - 1]}`);
    // At least one started + one completed per subtask.
    assert.ok(kinds.filter((k) => k === "subtask_started").length >= 2);
    assert.ok(kinds.filter((k) => k === "subtask_completed").length >= 2);
    // Final progress must hit completed=total.
    const last = events[events.length - 1];
    assert.equal(last.progress.completed, last.progress.total);
    assert.equal(last.status, "completed");
    assert.equal(last.stopReason, "all_subtasks_complete");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("task_plan_event: AWAITING_APPROVAL emits subtask_blocked + plan_paused, never plan_completed", async () => {
  const { dir, store, runner, events, receiptStore } = tempRunner(["partial"]);
  try {
    receiptStore.getRun = async () => ({ status: "AWAITING_APPROVAL" });
    const plan = freshPlan({ subtasks: [{ prompt: "x" }] });
    await store.create(plan);
    await runner.run(plan.taskPlanId);
    const kinds = events.map((e) => e.kind);
    assert.ok(kinds.includes("subtask_blocked"), "must emit subtask_blocked on approval pause");
    assert.ok(kinds.includes("plan_paused"), "must emit plan_paused on approval pause");
    assert.ok(!kinds.includes("plan_completed"), "must NOT emit plan_completed when paused for approval");
    const pause = events.find((e) => e.kind === "plan_paused");
    assert.ok(pause);
    assert.equal(pause!.stopReason, "approval_required");
    assert.match(pause!.message, /approval/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("task_plan_event: cancel emits plan_cancelled with stopReason=user_cancelled", async () => {
  const { dir, store, runner, events } = tempRunner(["success"]);
  try {
    const plan = freshPlan({ subtasks: [{ prompt: "x" }, { prompt: "y" }] });
    await store.create(plan);
    await runner.cancel(plan.taskPlanId);
    const cancelEvents = events.filter((e) => e.kind === "plan_cancelled");
    assert.equal(cancelEvents.length, 1);
    assert.equal(cancelEvents[0].status, "cancelled");
    assert.equal(cancelEvents[0].stopReason, "user_cancelled");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("task_plan_event: failed subtask with no repairs left emits subtask_failed + plan_blocked", async () => {
  const { dir, store, runner, events } = tempRunner(["failed", "failed"]);
  try {
    const plan = freshPlan({
      subtasks: [{ prompt: "doomed" }],
      budget: { maxAttemptsPerSubtask: 2, maxRepairAttempts: 1 },
    });
    await store.create(plan);
    await runner.run(plan.taskPlanId);
    const kinds = events.map((e) => e.kind);
    assert.ok(kinds.includes("subtask_failed"));
    assert.ok(kinds.includes("plan_blocked"));
    const last = events[events.length - 1];
    // The last event must reflect the final terminal-blocked plan
    // status, never a stale "running" snapshot.
    assert.notEqual(last.status, "running");
    assert.notEqual(last.stopReason, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("task_plan_event: missing emit option is tolerated — no crash, no events", async () => {
  // Build a runner WITHOUT an emit callback. This is the path tests
  // and external callers can use when they don't care about the bus.
  const dir = mkdtempSync(join(tmpdir(), "aedis-task-loop-events-no-emit-"));
  try {
    const store = new TaskPlanStore({ stateRoot: dir });
    const coordinator = new StubCoordinator(["success"]);
    const receiptStore = new StubReceiptStore();
    const runner = new TaskLoopRunner({
      store,
      coordinator,
      receiptStore,
      now: () => NOW,
      logger: { log: () => {}, warn: () => {}, error: () => {} },
      // emit intentionally omitted
    });
    const plan = freshPlan({ subtasks: [{ prompt: "x" }] });
    await store.create(plan);
    const final = await runner.run(plan.taskPlanId);
    assert.equal(final.status, "completed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("task_plan_event: emit callback that throws does not break the loop", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aedis-task-loop-events-throw-"));
  try {
    const store = new TaskPlanStore({ stateRoot: dir });
    const coordinator = new StubCoordinator(["success"]);
    const receiptStore = new StubReceiptStore();
    let throws = 0;
    const runner = new TaskLoopRunner({
      store,
      coordinator,
      receiptStore,
      now: () => NOW,
      logger: { log: () => {}, warn: () => {}, error: () => {} },
      emit: () => { throws += 1; throw new Error("listener boom"); },
    });
    const plan = freshPlan({ subtasks: [{ prompt: "x" }] });
    await store.create(plan);
    const final = await runner.run(plan.taskPlanId);
    // Loop completed despite emitter blowing up on every transition.
    assert.equal(final.status, "completed");
    assert.ok(throws > 0, "emitter must have been invoked");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
