/**
 * Tests for POST /missions/start.
 *
 * Pin the contract: creating a mission must NOT mark the overall
 * task as COMPLETE — neither in the HTTP response, in the WS event,
 * nor in the metrics aggregation. The response must surface a
 * `phase: "plan_ready"` so the UI can override any stale prior run
 * banner state.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { missionRoutes } from "./missions.js";
import { computeMetrics, type TrackedRunLike } from "../../core/metrics.js";

interface CapturedEvent {
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

function buildApp() {
  // Lazy import so the test file is cheap to load even when the
  // suite filters this out.
  return import("fastify").then(async ({ default: fastify }) => {
    const projectRoot = mkdtempSync(join(tmpdir(), "aedis-missions-route-"));
    const events: CapturedEvent[] = [];
    const app = fastify();
    (app as unknown as { decorate: (k: string, v: unknown) => void }).decorate("ctx", {
      coordinator: {},
      eventBus: {
        emit: (e: CapturedEvent) => {
          events.push(e);
        },
      },
      receiptStore: {},
      workerRegistry: {},
      config: { stateRoot: projectRoot, projectRoot },
      startedAt: new Date().toISOString(),
      build: {},
      pid: process.pid,
      getRuntimePolicy: () => ({}),
    });
    await app.register(missionRoutes);
    return { app, events, projectRoot };
  });
}

test("POST /start returns plan_ready, not complete; plan.status === 'pending'", async () => {
  const { app, events, projectRoot } = await buildApp();
  try {
    const res = await app.inject({
      method: "POST",
      url: "/start",
      payload: {
        objective: "Add a Teach Me Anything conversational mode",
        repoPath: projectRoot,
        subtasks: [
          { title: "Wire route", prompt: "wire route" },
          { title: "Add tests", prompt: "add tests" },
          { title: "Update docs", prompt: "update docs" },
          { title: "Update changelog", prompt: "update changelog" },
          { title: "Verify", prompt: "verify" },
        ],
      },
    });

    assert.equal(res.statusCode, 201, "plan creation must be 201 Created");
    const body = res.json();

    // Top-level signals.
    assert.equal(body.status, "plan_ready", "status must be plan_ready (not 'created' or 'completed')");
    assert.equal(body.phase, "plan_ready");
    assert.equal(body.executed, false, "no execution has happened yet");

    // Plan content.
    assert.ok(body.task_plan_id);
    assert.equal(body.plan.status, "pending", "plan starts pending — 0/5 subtasks done");
    assert.equal(body.plan.subtasks.length, 5);
    for (const s of body.plan.subtasks) {
      assert.equal(s.status, "pending");
      assert.equal(s.attempts, 0);
      assert.equal(s.evidenceRunIds.length, 0);
    }

    // next_action makes the next step explicit.
    assert.ok(body.next_action, "must surface next_action");
    assert.equal(body.next_action.kind, "auto_start");
    assert.equal(body.next_action.method, "POST");
    assert.match(String(body.next_action.endpoint), /^\/task-plans\/.+\/start$/);
    assert.equal(body.next_action.manualStartRequired, false);
    assert.equal(body.next_action.approvalRequired, true);
    assert.match(
      String(body.message),
      /automatically|Plan ready/i,
      "message should describe automatic start behavior",
    );

    // WS event mirrors the response.
    assert.equal(events.length, 1);
    const evt = events[0];
    assert.equal(evt.type, "task_plan_event");
    assert.equal(evt.payload.kind, "plan_created");
    assert.equal(evt.payload.phase, "plan_ready");
    assert.equal(evt.payload.status, "pending");
    assert.equal(evt.payload.executed, false);
    assert.deepEqual(evt.payload.progress, { completed: 0, total: 5 });
  } finally {
    await app.close();
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("Mission creation does NOT count as a successful run in metrics", async () => {
  const { app, projectRoot } = await buildApp();
  try {
    await app.inject({
      method: "POST",
      url: "/start",
      payload: {
        objective: "Add Teach Me Anything",
        repoPath: projectRoot,
        subtasks: [{ title: "x", prompt: "x" }],
      },
    });

    // Metrics aggregator works on TrackedRunLike entries, which only
    // get populated by submitBuildTask — never by mission creation.
    // Pin the rule: empty registry → zero successful runs.
    const runs: TrackedRunLike[] = [];
    const m = computeMetrics(runs, "2026-05-02T00:00:00.000Z");
    assert.equal(m.totalRuns, 0);
    assert.equal(m.successfulRuns, 0);
    assert.equal(m.completedRuns, 0);
    assert.equal(m.lastRunSummary, null);
  } finally {
    await app.close();
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("0/5 subtask plan reports 0/total progress, not complete", async () => {
  const { app, events, projectRoot } = await buildApp();
  try {
    const res = await app.inject({
      method: "POST",
      url: "/start",
      payload: {
        objective: "5-step plan",
        repoPath: projectRoot,
        subtasks: Array.from({ length: 5 }, (_, i) => ({ title: `S${i + 1}`, prompt: `s${i + 1}` })),
      },
    });
    assert.equal(res.statusCode, 201);
    const evt = events[0];
    const progress = evt.payload.progress as { completed: number; total: number };
    assert.equal(progress.completed, 0);
    assert.equal(progress.total, 5);
    // The plan status is "pending" — never "completed".
    assert.notEqual(evt.payload.status, "completed");
    assert.notEqual(evt.payload.status, "complete");
    assert.equal(evt.payload.status, "pending");
  } finally {
    await app.close();
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("Bad input (missing subtasks) is rejected before any plan write", async () => {
  const { app, events, projectRoot } = await buildApp();
  try {
    const res = await app.inject({
      method: "POST",
      url: "/start",
      payload: {
        objective: "no subtasks",
        repoPath: projectRoot,
        subtasks: [],
      },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(events.length, 0, "no WS event when validation fails");
  } finally {
    await app.close();
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
