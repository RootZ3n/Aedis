/**
 * POST /task-plans/:id/subtasks/:subtaskId/attach-target — pin the
 * route contract that the UI's "Repair Plan" CTA depends on.
 *
 * Required behaviors:
 *   - 200 OK when target attached to a needs_clarification subtask
 *   - 409 Conflict when subtask is in any other state
 *   - 404 when plan or subtask does not exist
 *   - 400 when target is missing/empty
 *   - On success, plan moves out of needs_replan into paused so the
 *     follow-up /continue can resume the loop
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { taskPlanRoutes, __resetTaskPlanSingletonsForTests } from "./task-plans.js";
import { TaskPlanStore } from "../../core/task-plan-store.js";
import { createTaskPlan } from "../../core/task-plan.js";
import {
  NeedsClarificationError,
  type RunReceipt,
  type TaskSubmission,
} from "../../core/coordinator.js";

async function buildApp() {
  __resetTaskPlanSingletonsForTests();
  const fastify = (await import("fastify")).default;
  const stateRoot = mkdtempSync(join(tmpdir(), "aedis-attach-target-"));
  const app = fastify();
  // Minimal coordinator: first submit throws NeedsClarificationError
  // so we can exercise the route path that flips a subtask into
  // needs_clarification on disk; subsequent submits succeed.
  let calls = 0;
  const coordinator = {
    async submit(_s: TaskSubmission): Promise<RunReceipt> {
      calls += 1;
      if (calls === 1) {
        throw new NeedsClarificationError({
          message: "no targets",
          recommendedTargets: ["src/foo.ts"],
          scoutReportIds: ["scout-1"],
          scoutSpawned: true,
          recommendedAction: "attach a target",
        });
      }
      return makeSuccess();
    },
    async cancel() { /* no-op */ },
  };
  (app as unknown as { decorate: (k: string, v: unknown) => void }).decorate("ctx", {
    coordinator,
    eventBus: { emit: () => {} },
    receiptStore: { getRun: async () => ({ status: "COMPLETE" }) },
    workerRegistry: {},
    config: { stateRoot, projectRoot: stateRoot },
    startedAt: new Date().toISOString(),
    build: {},
    pid: process.pid,
    getRuntimePolicy: () => ({}),
  });
  await app.register(taskPlanRoutes);
  return { app, stateRoot, store: new TaskPlanStore({ stateRoot }) };
}

function makeSuccess(): RunReceipt {
  return {
    runId: "r1",
    verdict: "success",
    totalCost: { estimatedCostUsd: 0 },
    humanSummary: { headline: "ok" },
  } as unknown as RunReceipt;
}

test("returns 400 when target is missing", async () => {
  const { app, stateRoot, store } = await buildApp();
  try {
    const plan = createTaskPlan(
      {
        objective: "x",
        repoPath: stateRoot,
        subtasks: [{ title: "y", prompt: "z" }],
      },
      { taskPlanId: "plan_at_001", now: new Date().toISOString() },
    );
    await store.create(plan);
    const res = await app.inject({
      method: "POST",
      url: "/plan_at_001/subtasks/st-1/attach-target",
      payload: { target: "" },
    });
    assert.equal(res.statusCode, 400);
  } finally {
    await app.close();
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("returns 404 when plan does not exist", async () => {
  const { app, stateRoot } = await buildApp();
  try {
    const res = await app.inject({
      method: "POST",
      url: "/missing/subtasks/st-1/attach-target",
      payload: { target: "src/foo.ts" },
    });
    assert.equal(res.statusCode, 404);
  } finally {
    await app.close();
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("returns 409 when subtask is not needs_clarification", async () => {
  const { app, stateRoot, store } = await buildApp();
  try {
    const plan = createTaskPlan(
      {
        objective: "x",
        repoPath: stateRoot,
        subtasks: [{ title: "y", prompt: "z" }],
      },
      { taskPlanId: "plan_at_002", now: new Date().toISOString() },
    );
    await store.create(plan); // pending — not needs_clarification
    const res = await app.inject({
      method: "POST",
      url: "/plan_at_002/subtasks/st-1/attach-target",
      payload: { target: "src/foo.ts" },
    });
    assert.equal(res.statusCode, 409);
  } finally {
    await app.close();
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("attaches target on a needs_clarification subtask and returns 200 with paused plan", async () => {
  const { app, stateRoot, store } = await buildApp();
  try {
    const plan = createTaskPlan(
      {
        objective: "x",
        repoPath: stateRoot,
        subtasks: [{ title: "y", prompt: "z" }],
      },
      { taskPlanId: "plan_at_003", now: new Date().toISOString() },
    );
    await store.create(plan);
    // Drive the plan through the loop so the first subtask hits the
    // pre-dispatch guard and becomes needs_clarification.
    const startRes = await app.inject({ method: "POST", url: "/plan_at_003/start" });
    assert.equal(startRes.statusCode, 202);
    // Wait for the loop iteration to settle.
    await new Promise((r) => setTimeout(r, 50));
    let after = await store.load("plan_at_003");
    // The loop schedules async; poll briefly.
    for (let i = 0; i < 20 && (!after || after.status !== "needs_replan"); i += 1) {
      await new Promise((r) => setTimeout(r, 25));
      after = await store.load("plan_at_003");
    }
    assert.ok(after, "plan must persist");
    assert.equal(after!.status, "needs_replan");

    const res = await app.inject({
      method: "POST",
      url: "/plan_at_003/subtasks/st-1/attach-target",
      payload: { target: "src/foo.ts" },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.subtask_id, "st-1");
    assert.equal(body.plan.status, "paused");
    const sub = body.plan.subtasks[0];
    assert.equal(sub.status, "pending");
    assert.match(sub.prompt, /Target file:\s*src\/foo\.ts/);
  } finally {
    await app.close();
    rmSync(stateRoot, { recursive: true, force: true });
  }
});
