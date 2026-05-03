/**
 * Task-loop integration tests for the stage-timeout retry policy.
 *
 * The cost-control bug (2026-05-03): a Critic on `claude-opus-4-7`
 * timed out at the 180s stage limit. The task-loop's repair attempt
 * blindly re-dispatched the SAME model. This test pins the post-fix
 * contracts:
 *
 *   1. After a stage timeout, the next attempt does NOT re-dispatch
 *      the same (stage, provider, model) tuple — the subtask is
 *      flipped to `needs_clarification` and the plan to `needs_replan`
 *      with `stopReason: "needs_clarification"` so the operator's
 *      timeout-recovery card dominates instead of looping.
 *
 *   2. Receipts preserve the timeout evidence: `providerAttempts`
 *      with `outcome: "timeout"` are folded into
 *      `subtask.timedOutModels`.
 *
 *   3. The two recovery decisions exposed via
 *      `applyTimeoutDecision`:
 *        — `retry_with_fallback` keeps the timed-out model in the
 *          history (so the chain skips it on the next dispatch).
 *        — `retry_same_model` releases the most-recent timed-out
 *          entry (operator-explicit override).
 *
 *   4. The plan's WS event stream emits `subtask_needs_clarification`
 *      and `plan_needs_replan` with the timeout-recovery CTAs.
 *
 *   5. `applyTimeoutDecision("cancel_run")` cancels the plan via the
 *      existing cancel() flow.
 *
 *   6. `applyTimeoutDecision("skip_stage")` flips the subtask to
 *      `skipped` so the loop advances past it.
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
  type TaskPlanEventPayload,
} from "./task-loop.js";
import type { RunReceipt, TaskSubmission } from "./coordinator.js";

const NOW = "2026-05-03T12:00:00.000Z";

function makeFailedReceipt(runId: string): RunReceipt {
  // Minimum shape — task-loop only reads verdict, runId, totalCost.
  return {
    runId,
    verdict: "failed",
    totalCost: { estimatedCostUsd: 0 },
    humanSummary: { headline: "stage timeout" },
  } as unknown as RunReceipt;
}

/**
 * Coordinator stub that throws InvokerError-style timeout errors and
 * records what excludedModels each submit was called with so the
 * test can assert exclusions are passed through.
 */
class TimeoutStubCoordinator implements CoordinatorLike {
  readonly submissions: Array<{ runId: string | null; excludedModels: TaskSubmission["excludedModels"] }> = [];
  shouldThrow = true;
  async submit(s: TaskSubmission): Promise<RunReceipt> {
    this.submissions.push({
      runId: s.runId ?? null,
      excludedModels: s.excludedModels ? [...s.excludedModels] : undefined,
    });
    if (this.shouldThrow) {
      const err = new Error("[critic_timeout] stage timeout (180s) exceeded");
      throw err;
    }
    return makeFailedReceipt(s.runId ?? "x");
  }
  async cancel() { /* no-op */ }
}

/**
 * Receipt store stub that returns a synthetic `providerAttempts`
 * entry with `outcome: "timeout"` for the most-recent submission so
 * `extractTimeoutsFromReceipt` actually has something to fold in.
 * Each test configures the timeouts it wants.
 */
class TimeoutStubReceiptStore implements ReceiptStoreReader {
  records = new Map<string, {
    status: string;
    providerAttempts: Array<{ provider: string; model: string; outcome: string; durationMs: number; taskId?: string }>;
    workerEvents: Array<{ workerType: string; taskId: string }>;
    checkpoints: Array<{ details?: Record<string, unknown>; summary?: string }>;
  }>();
  async getRun(runId: string) {
    return this.records.get(runId) ?? null;
  }
}

test("stage timeout transitions plan to needs_replan with timeout-recovery CTAs", async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), "aedis-timeout-loop-"));
  try {
    const events: TaskPlanEventPayload[] = [];
    const store = new TaskPlanStore({ stateRoot });
    const coordinator = new TimeoutStubCoordinator();
    const receiptStore = new TimeoutStubReceiptStore();
    const runner = new TaskLoopRunner({
      store,
      coordinator,
      receiptStore,
      logger: { log: () => {}, warn: () => {}, error: () => {} },
      emit: (p) => events.push(p),
      now: () => NOW,
    });

    // Pre-seed the receipt store: when the loop calls submit, it'll
    // throw, then call receiptStore.getRun(runId) — but that runId
    // is generated inside the loop. We can't predict it, so instead
    // we patch the records map after dispatch via a coordinator hook.
    const origSubmit = coordinator.submit.bind(coordinator);
    coordinator.submit = async (s) => {
      const runId = s.runId ?? "?";
      receiptStore.records.set(runId, {
        status: "EXECUTION_ERROR",
        providerAttempts: [
          { provider: "anthropic", model: "claude-opus-4-7", outcome: "timeout", durationMs: 180_000, taskId: "t1" },
        ],
        workerEvents: [{ workerType: "critic", taskId: "t1" }],
        checkpoints: [{ details: { classification: "critic_timeout" }, summary: "[critic_timeout] stage" }],
      });
      return origSubmit(s);
    };

    const plan = createTaskPlan(
      {
        objective: "x",
        repoPath: stateRoot,
        subtasks: [{ title: "wire", prompt: "do thing" }],
      },
      { taskPlanId: "plan_to_001", now: NOW },
    );
    await store.create(plan);
    const out = await runner.run(plan.taskPlanId);

    // CONTRACT: plan must NOT be `failed` — must be `needs_replan`
    // with stopReason "needs_clarification" so the operator gets
    // the recovery card instead of a dead-end FAILED.
    assert.equal(out.status, "needs_replan");
    assert.equal(out.stopReason, "needs_clarification");

    const sub = out.subtasks[0];
    assert.equal(sub.status, "needs_clarification");
    assert.match(sub.blockerReason, /Stage timeout|critic\/anthropic\/claude-opus-4-7/);
    // The history must record the timed-out tuple.
    assert.ok(sub.timedOutModels && sub.timedOutModels.length === 1);
    assert.equal(sub.timedOutModels![0].provider, "anthropic");
    assert.equal(sub.timedOutModels![0].model, "claude-opus-4-7");
    assert.equal(sub.timedOutModels![0].stage, "critic");
    assert.equal(sub.timedOutModels![0].consecutiveTimeouts, 1);

    // Events: plan_needs_replan must be emitted with timeout-recovery CTAs.
    const replan = events.find((e) => e.kind === "plan_needs_replan");
    assert.ok(replan, "plan_needs_replan must be emitted");
    assert.ok(replan!.ctas && replan!.ctas.length === 2, "two timeout-recovery CTAs");
    const labels = (replan!.ctas ?? []).map((c) => c.label);
    assert.ok(labels.includes("Retry with Fallback"));
    assert.ok(labels.includes("Retry Same Model"));

    // Subtask ran exactly ONCE — no blind retry.
    assert.equal(coordinator.submissions.length, 1);
  } finally {
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("retry_with_fallback re-queues with the timed-out model still excluded", async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), "aedis-timeout-fallback-"));
  try {
    const store = new TaskPlanStore({ stateRoot });
    const coordinator = new TimeoutStubCoordinator();
    const receiptStore = new TimeoutStubReceiptStore();
    const runner = new TaskLoopRunner({
      store, coordinator, receiptStore,
      logger: { log: () => {}, warn: () => {}, error: () => {} },
      emit: () => {}, now: () => NOW,
    });
    const origSubmit = coordinator.submit.bind(coordinator);
    coordinator.submit = async (s) => {
      const runId = s.runId ?? "?";
      receiptStore.records.set(runId, {
        status: "EXECUTION_ERROR",
        providerAttempts: [
          { provider: "anthropic", model: "claude-opus-4-7", outcome: "timeout", durationMs: 180_000, taskId: "t1" },
        ],
        workerEvents: [{ workerType: "critic", taskId: "t1" }],
        checkpoints: [],
      });
      return origSubmit(s);
    };
    const plan = createTaskPlan({
      objective: "x", repoPath: stateRoot,
      subtasks: [{ title: "wire", prompt: "do thing" }],
    }, { taskPlanId: "plan_to_002", now: NOW });
    await store.create(plan);
    const first = await runner.run(plan.taskPlanId);
    assert.equal(first.status, "needs_replan");
    const sub = first.subtasks[0];
    assert.equal(sub.timedOutModels?.length, 1);

    // Operator clicks "Retry with Fallback" — chain should skip the
    // timed-out model on the next dispatch. We can't observe the
    // chain (worker-internal), but we can observe that the subtask
    // is requeued AND the persisted timedOutModels is unchanged
    // (so the next coordinator.submit gets the same exclusions
    // through `excludedModels`).
    const after = await runner.applyTimeoutDecision(plan.taskPlanId, sub.id, "retry_with_fallback");
    const subAfter = after.subtasks[0];
    assert.equal(subAfter.status, "pending");
    assert.equal(subAfter.timedOutModels?.length, 1, "fallback retry must keep timed-out history");
    assert.equal(after.status, "paused");

    // Run again — the loop should call coordinator.submit with
    // excludedModels populated.
    coordinator.shouldThrow = false; // let the second submit return a failed receipt cleanly
    receiptStore.records.clear();
    await runner.run(plan.taskPlanId);
    // Latest submission must have excludedModels populated with the
    // timed-out tuple.
    const latest = coordinator.submissions[coordinator.submissions.length - 1];
    assert.ok(latest.excludedModels && latest.excludedModels.length === 1);
    assert.equal(latest.excludedModels![0].model, "claude-opus-4-7");
    assert.equal(latest.excludedModels![0].provider, "anthropic");
    assert.equal(latest.excludedModels![0].stage, "critic");
  } finally {
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("retry_same_model releases the most-recent timed-out entry (operator override)", async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), "aedis-timeout-same-"));
  try {
    const store = new TaskPlanStore({ stateRoot });
    const coordinator = new TimeoutStubCoordinator();
    const receiptStore = new TimeoutStubReceiptStore();
    const runner = new TaskLoopRunner({
      store, coordinator, receiptStore,
      logger: { log: () => {}, warn: () => {}, error: () => {} },
      emit: () => {}, now: () => NOW,
    });
    const origSubmit = coordinator.submit.bind(coordinator);
    coordinator.submit = async (s) => {
      const runId = s.runId ?? "?";
      receiptStore.records.set(runId, {
        status: "EXECUTION_ERROR",
        providerAttempts: [
          { provider: "anthropic", model: "claude-opus-4-7", outcome: "timeout", durationMs: 180_000, taskId: "t1" },
        ],
        workerEvents: [{ workerType: "critic", taskId: "t1" }],
        checkpoints: [],
      });
      return origSubmit(s);
    };
    const plan = createTaskPlan({
      objective: "x", repoPath: stateRoot,
      subtasks: [{ title: "wire", prompt: "do thing" }],
    }, { taskPlanId: "plan_to_003", now: NOW });
    await store.create(plan);
    const first = await runner.run(plan.taskPlanId);
    assert.equal(first.status, "needs_replan");
    const sub = first.subtasks[0];
    assert.equal(sub.timedOutModels?.length, 1);

    // Operator explicitly clicks "Retry Same Model" — releases the
    // most-recent timed-out entry.
    const after = await runner.applyTimeoutDecision(plan.taskPlanId, sub.id, "retry_same_model");
    const subAfter = after.subtasks[0];
    assert.equal(subAfter.status, "pending");
    assert.equal(subAfter.timedOutModels?.length, 0, "same-model retry must release the entry");
  } finally {
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("skip_stage flips the subtask to skipped so the plan can advance", async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), "aedis-timeout-skip-"));
  try {
    const store = new TaskPlanStore({ stateRoot });
    const coordinator = new TimeoutStubCoordinator();
    const receiptStore = new TimeoutStubReceiptStore();
    const runner = new TaskLoopRunner({
      store, coordinator, receiptStore,
      logger: { log: () => {}, warn: () => {}, error: () => {} },
      emit: () => {}, now: () => NOW,
    });
    const origSubmit = coordinator.submit.bind(coordinator);
    coordinator.submit = async (s) => {
      const runId = s.runId ?? "?";
      receiptStore.records.set(runId, {
        status: "EXECUTION_ERROR",
        providerAttempts: [
          { provider: "anthropic", model: "claude-opus-4-7", outcome: "timeout", durationMs: 180_000, taskId: "t1" },
        ],
        workerEvents: [{ workerType: "critic", taskId: "t1" }],
        checkpoints: [],
      });
      return origSubmit(s);
    };
    const plan = createTaskPlan({
      objective: "x", repoPath: stateRoot,
      subtasks: [{ title: "wire", prompt: "do thing" }],
    }, { taskPlanId: "plan_to_004", now: NOW });
    await store.create(plan);
    const first = await runner.run(plan.taskPlanId);
    const sub = first.subtasks[0];
    assert.equal(sub.status, "needs_clarification");

    const after = await runner.applyTimeoutDecision(plan.taskPlanId, sub.id, "skip_stage");
    const subAfter = after.subtasks[0];
    assert.equal(subAfter.status, "skipped");
  } finally {
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("cancel_run cancels the entire plan", async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), "aedis-timeout-cancel-"));
  try {
    const store = new TaskPlanStore({ stateRoot });
    const coordinator = new TimeoutStubCoordinator();
    const receiptStore = new TimeoutStubReceiptStore();
    const runner = new TaskLoopRunner({
      store, coordinator, receiptStore,
      logger: { log: () => {}, warn: () => {}, error: () => {} },
      emit: () => {}, now: () => NOW,
    });
    const origSubmit = coordinator.submit.bind(coordinator);
    coordinator.submit = async (s) => {
      const runId = s.runId ?? "?";
      receiptStore.records.set(runId, {
        status: "EXECUTION_ERROR",
        providerAttempts: [
          { provider: "anthropic", model: "claude-opus-4-7", outcome: "timeout", durationMs: 180_000, taskId: "t1" },
        ],
        workerEvents: [{ workerType: "critic", taskId: "t1" }],
        checkpoints: [],
      });
      return origSubmit(s);
    };
    const plan = createTaskPlan({
      objective: "x", repoPath: stateRoot,
      subtasks: [{ title: "wire", prompt: "do thing" }],
    }, { taskPlanId: "plan_to_005", now: NOW });
    await store.create(plan);
    const first = await runner.run(plan.taskPlanId);
    const sub = first.subtasks[0];

    const after = await runner.applyTimeoutDecision(plan.taskPlanId, sub.id, "cancel_run");
    assert.equal(after.status, "cancelled");
  } finally {
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("non-timeout errors take the existing subtask_terminal_failure path (no false positive)", async () => {
  // Defensive: a generic submit() throw without any timeout
  // attempts must NOT trigger the timeout-recovery card. Only
  // genuine `outcome: "timeout"` entries should.
  const stateRoot = mkdtempSync(join(tmpdir(), "aedis-timeout-negative-"));
  try {
    const store = new TaskPlanStore({ stateRoot });
    const coordinator: CoordinatorLike = {
      async submit() { throw new Error("workspace creation exploded"); },
      async cancel() {},
    };
    const receiptStore: ReceiptStoreReader = {
      async getRun() {
        return {
          status: "EXECUTION_ERROR",
          providerAttempts: [],
          workerEvents: [],
          checkpoints: [],
        };
      },
    };
    const runner = new TaskLoopRunner({
      store, coordinator, receiptStore,
      logger: { log: () => {}, warn: () => {}, error: () => {} },
      emit: () => {}, now: () => NOW,
    });
    const plan = createTaskPlan({
      objective: "x", repoPath: stateRoot,
      subtasks: [{ title: "wire", prompt: "do thing" }],
    }, { taskPlanId: "plan_to_006", now: NOW });
    await store.create(plan);
    const out = await runner.run(plan.taskPlanId);
    assert.equal(out.status, "failed");
    assert.equal(out.stopReason, "subtask_terminal_failure");
  } finally {
    rmSync(stateRoot, { recursive: true, force: true });
  }
});
