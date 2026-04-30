/**
 * Loqui Orientation route — helper unit tests.
 *
 * The pure orientation builder is covered by core/loqui-orientation.test.ts.
 * These tests pin the route-side helpers — active-run detection from
 * the receipt store, plan highlighting precedence — so we know the
 * snapshot the route hands to `buildOrientation` is shaped correctly.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  ACTIVE_RECEIPT_STATUSES,
  detectActiveTask,
  pickHighlightedPlan,
  type ReceiptListingReader,
} from "./loqui-orientation.js";
import type { TaskPlan } from "../../core/task-plan.js";

// ─── detectActiveTask ──────────────────────────────────────────────

function fakeReceiptStore(
  runsByStatus: Readonly<Record<string, number>>,
): ReceiptListingReader {
  return {
    listRuns: async (_limit, status) => {
      if (!status) return [];
      const count = runsByStatus[status] ?? 0;
      return Array.from({ length: count }, (_, i) => ({ id: `${status}-${i}` }));
    },
  };
}

test("detectActiveTask: returns true when any active status has runs", async () => {
  for (const status of ACTIVE_RECEIPT_STATUSES) {
    const store = fakeReceiptStore({ [status]: 1 });
    assert.equal(await detectActiveTask(store), true, `status=${status}`);
  }
});

test("detectActiveTask: returns false when every active-status query is empty", async () => {
  const store = fakeReceiptStore({});
  assert.equal(await detectActiveTask(store), false);
});

test("detectActiveTask: terminal-status runs do NOT trip the detector", async () => {
  // COMPLETE / FAILED / REJECTED / ABORTED are terminal — even if the
  // receipt store has entries for them, we report no active task.
  const store = fakeReceiptStore({
    COMPLETE: 5,
    FAILED: 3,
    REJECTED: 2,
    ABORTED: 1,
  });
  assert.equal(await detectActiveTask(store), false);
});

// ─── pickHighlightedPlan ───────────────────────────────────────────

function plan(
  taskPlanId: string,
  status: TaskPlan["status"],
  updatedAt: string = "2026-04-28T00:00:00Z",
): TaskPlan {
  return {
    schemaVersion: 1,
    taskPlanId,
    objective: `obj-${taskPlanId}`,
    repoPath: "/tmp/repo",
    subtasks: [],
    status,
    stopReason: "",
    budget: {
      maxSubtasks: 25,
      maxAttemptsPerSubtask: 3,
      maxRepairAttempts: 2,
      maxRuntimeMs: 1_800_000,
      maxCostUsd: 5,
      maxConsecutiveFailures: 2,
    },
    spent: { totalCostUsd: 0, totalRuntimeMs: 0, consecutiveFailures: 0, subtasksAttempted: 0 },
    createdAt: updatedAt,
    updatedAt,
    requiresExplicitResume: true,
  };
}

test("pickHighlightedPlan: paused beats running", () => {
  const picked = pickHighlightedPlan([plan("a", "running"), plan("b", "paused")]);
  assert.equal(picked?.taskPlanId, "b");
});

test("pickHighlightedPlan: running beats pending", () => {
  const picked = pickHighlightedPlan([plan("a", "pending"), plan("b", "running")]);
  assert.equal(picked?.taskPlanId, "b");
});

test("pickHighlightedPlan: pending beats nothing", () => {
  const picked = pickHighlightedPlan([plan("a", "pending")]);
  assert.equal(picked?.taskPlanId, "a");
});

test("pickHighlightedPlan: ignores terminal plans", () => {
  const picked = pickHighlightedPlan([
    plan("done", "completed"),
    plan("died", "failed"),
    plan("killed", "cancelled"),
  ]);
  assert.equal(picked, null);
});

test("pickHighlightedPlan: interrupted beats blocked beats pending", () => {
  const picked = pickHighlightedPlan([
    plan("c", "pending"),
    plan("b", "blocked"),
    plan("a", "interrupted"),
  ]);
  assert.equal(picked?.taskPlanId, "a");
});

test("pickHighlightedPlan: empty list → null", () => {
  assert.equal(pickHighlightedPlan([]), null);
});
