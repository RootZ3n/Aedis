import test from "node:test";
import assert from "node:assert/strict";

import {
  buildFinalSummary,
  countSubtasks,
  createTaskPlan,
  DEFAULT_TASK_PLAN_BUDGET,
  findNextSubtask,
  validateCreateTaskPlanInput,
} from "./task-plan.js";

const NOW = "2026-04-28T12:00:00.000Z";

function makeInput(overrides: Partial<Parameters<typeof createTaskPlan>[0]> = {}) {
  return {
    objective: "Add Instructor Mode to Magister",
    repoPath: "/tmp/repo",
    subtasks: [
      { prompt: "design the data structures" },
      { prompt: "implement the core helper functions" },
      { prompt: "wire the UI surface" },
      { prompt: "add tests" },
    ],
    ...overrides,
  };
}

test("validateCreateTaskPlanInput: rejects empty objective + empty subtasks", () => {
  const r = validateCreateTaskPlanInput({ objective: "", repoPath: "", subtasks: [] });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /objective/.test(e)));
  assert.ok(r.errors.some((e) => /repoPath/.test(e)));
  assert.ok(r.errors.some((e) => /subtasks\[\]/.test(e)));
});

test("validateCreateTaskPlanInput: rejects subtasks with empty prompt", () => {
  const r = validateCreateTaskPlanInput(
    makeInput({ subtasks: [{ prompt: "do something" }, { prompt: "" }] }),
  );
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /subtasks\[1\]/.test(e)));
});

test("validateCreateTaskPlanInput: refuses subtasks count > maxSubtasks budget", () => {
  const subtasks = Array.from({ length: 30 }, (_, i) => ({ prompt: `step ${i}` }));
  const r = validateCreateTaskPlanInput(
    makeInput({ subtasks, budget: { maxSubtasks: 10 } }),
  );
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /maxSubtasks/.test(e)));
});

test("validateCreateTaskPlanInput: rejects non-positive budget overrides", () => {
  const r = validateCreateTaskPlanInput(makeInput({ budget: { maxRuntimeMs: 0 } }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /maxRuntimeMs/.test(e)));
});

test("createTaskPlan: produces ordered subtasks with stable ids", () => {
  const plan = createTaskPlan(makeInput(), { taskPlanId: "plan_abc", now: NOW });
  assert.equal(plan.taskPlanId, "plan_abc");
  assert.equal(plan.status, "pending");
  assert.equal(plan.subtasks.length, 4);
  assert.equal(plan.subtasks[0].id, "st-1");
  assert.equal(plan.subtasks[0].ordinal, 1);
  assert.equal(plan.subtasks[3].id, "st-4");
  assert.equal(plan.subtasks[3].ordinal, 4);
  // Every subtask starts pending with zero attempts and an empty
  // evidence list — the audit trail begins clean.
  for (const s of plan.subtasks) {
    assert.equal(s.status, "pending");
    assert.equal(s.attempts, 0);
    assert.equal(s.repairAttempts, 0);
    assert.equal(s.evidenceRunIds.length, 0);
  }
});

test("createTaskPlan: defaults budget to safe caps when omitted", () => {
  const plan = createTaskPlan(makeInput(), { taskPlanId: "plan_def", now: NOW });
  assert.equal(plan.budget.maxSubtasks, DEFAULT_TASK_PLAN_BUDGET.maxSubtasks);
  assert.equal(plan.budget.maxRuntimeMs, DEFAULT_TASK_PLAN_BUDGET.maxRuntimeMs);
  assert.equal(plan.budget.maxCostUsd, DEFAULT_TASK_PLAN_BUDGET.maxCostUsd);
  // Sanity: defaults are not "infinite" — every cap is a finite
  // positive number. This is the safety contract the schema pins.
  for (const k of Object.keys(plan.budget) as Array<keyof typeof plan.budget>) {
    assert.ok(
      Number.isFinite(plan.budget[k]) && plan.budget[k] > 0,
      `default budget.${k} must be finite + positive; got ${plan.budget[k]}`,
    );
  }
});

test("findNextSubtask: returns the first pending subtask, ignores terminal ones", () => {
  const plan = createTaskPlan(makeInput(), { taskPlanId: "plan_n", now: NOW });
  const updated = {
    ...plan,
    subtasks: plan.subtasks.map((s, i) =>
      i < 2 ? { ...s, status: "completed" as const } : s,
    ),
  };
  const next = findNextSubtask(updated);
  assert.ok(next);
  assert.equal(next!.id, "st-3");
});

test("countSubtasks: aggregates correctly across statuses", () => {
  const plan = createTaskPlan(makeInput(), { taskPlanId: "plan_c", now: NOW });
  const updated = {
    ...plan,
    subtasks: [
      { ...plan.subtasks[0], status: "completed" as const },
      { ...plan.subtasks[1], status: "repaired" as const },
      { ...plan.subtasks[2], status: "failed" as const },
      { ...plan.subtasks[3], status: "pending" as const },
    ],
  };
  const c = countSubtasks(updated);
  assert.equal(c.completed, 2);
  assert.equal(c.failed, 1);
  assert.equal(c.pending, 1);
});

test("buildFinalSummary: includes evidence run-ids from every subtask", () => {
  const plan = createTaskPlan(makeInput(), { taskPlanId: "plan_s", now: NOW });
  const updated = {
    ...plan,
    status: "completed" as const,
    stopReason: "all_subtasks_complete" as const,
    subtasks: plan.subtasks.map((s, i) => ({
      ...s,
      status: "completed" as const,
      evidenceRunIds: [`run-${i + 1}`],
    })),
  };
  const summary = buildFinalSummary(updated);
  assert.deepEqual(summary.receiptRunIds, ["run-1", "run-2", "run-3", "run-4"]);
  assert.match(summary.headline, /4\/4/);
  assert.equal(summary.counts.completed, 4);
});
