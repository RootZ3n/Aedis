import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTaskPlan } from "./task-plan.js";
import { TaskPlanStore } from "./task-plan-store.js";

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), "aedis-task-plan-store-"));
  return { dir, store: new TaskPlanStore({ stateRoot: dir }) };
}

const NOW = "2026-04-28T12:00:00.000Z";

function freshPlan(id = "plan_test") {
  return createTaskPlan(
    {
      objective: "x",
      repoPath: "/tmp/repo",
      subtasks: [
        { prompt: "step 1" },
        { prompt: "step 2" },
      ],
    },
    { taskPlanId: id, now: NOW },
  );
}

test("TaskPlanStore: create + load round-trip preserves the plan", async () => {
  const { dir, store } = tempStore();
  try {
    const plan = freshPlan();
    await store.create(plan);
    const loaded = await store.load(plan.taskPlanId);
    assert.deepEqual(loaded, plan);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TaskPlanStore: create refuses to overwrite an existing plan", async () => {
  const { dir, store } = tempStore();
  try {
    const plan = freshPlan();
    await store.create(plan);
    await assert.rejects(() => store.create(plan), /already exists/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TaskPlanStore: save overwrites and atomic-write doesn't leak temp files on success", async () => {
  const { dir, store } = tempStore();
  try {
    const plan = freshPlan();
    await store.create(plan);
    const updated = { ...plan, status: "running" as const, updatedAt: NOW };
    await store.save(updated);
    const loaded = await store.load(plan.taskPlanId);
    assert.equal(loaded?.status, "running");
    // No tmp file left over.
    const planPath = store.getPlanPath(plan.taskPlanId);
    const planDir = join(dir, "state", "task-plans");
    const fs = await import("node:fs/promises");
    const entries = await fs.readdir(planDir);
    assert.equal(entries.length, 1, `expected only the plan file; got ${entries.join(",")}`);
    assert.ok(existsSync(planPath));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TaskPlanStore: list returns plans newest-first", async () => {
  const { dir, store } = tempStore();
  try {
    const a = createTaskPlan({ objective: "a", repoPath: "/tmp/repo", subtasks: [{ prompt: "x" }] }, { taskPlanId: "plan_a", now: "2026-04-28T10:00:00.000Z" });
    const b = createTaskPlan({ objective: "b", repoPath: "/tmp/repo", subtasks: [{ prompt: "y" }] }, { taskPlanId: "plan_b", now: "2026-04-28T11:00:00.000Z" });
    await store.create(a);
    await store.create(b);
    const list = await store.list();
    assert.equal(list.length, 2);
    assert.equal(list[0].taskPlanId, "plan_b", "newer plan must come first");
    assert.equal(list[1].taskPlanId, "plan_a");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TaskPlanStore: load returns null for malformed JSON without throwing", async () => {
  const { dir, store } = tempStore();
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(join(dir, "state", "task-plans"), { recursive: true });
    await fs.writeFile(join(dir, "state", "task-plans", "plan_garbled.json"), "not json", "utf-8");
    const loaded = await store.load("plan_garbled");
    assert.equal(loaded, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TaskPlanStore: restoreOnBoot reconciles running → interrupted, never auto-resume", async () => {
  const { dir, store } = tempStore();
  try {
    const plan = freshPlan();
    // Simulate a server crash while subtask 1 was running.
    const inFlight = {
      ...plan,
      status: "running" as const,
      subtasks: [
        { ...plan.subtasks[0], status: "running" as const, attempts: 1, lastRunId: "run-abc" },
        plan.subtasks[1],
      ],
    };
    await store.create(inFlight);

    const reconciled = await store.restoreOnBoot("2026-04-28T12:30:00.000Z");
    assert.deepEqual(reconciled, [plan.taskPlanId]);

    const after = await store.load(plan.taskPlanId);
    assert.equal(after?.status, "interrupted", "running plan must be marked interrupted on boot");
    assert.equal(after?.stopReason, "server_interrupted");
    assert.equal(after?.subtasks[0].status, "blocked", "in-flight subtask must be marked blocked");
    assert.match(String(after?.subtasks[0].blockerReason ?? ""), /interrupted/);
    // No subtask was silently flipped to completed.
    for (const s of after!.subtasks) {
      assert.notEqual(s.status, "completed");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TaskPlanStore: restoreOnBoot is idempotent — running once with no running plans is a no-op", async () => {
  const { dir, store } = tempStore();
  try {
    const plan = freshPlan(); // status pending
    await store.create(plan);
    const reconciled = await store.restoreOnBoot(NOW);
    assert.equal(reconciled.length, 0);
    const after = await store.load(plan.taskPlanId);
    assert.equal(after?.status, "pending", "non-running plans must not be touched");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TaskPlanStore: persisted JSON is human-readable (tracking debug)", async () => {
  const { dir, store } = tempStore();
  try {
    const plan = freshPlan();
    await store.create(plan);
    const raw = readFileSync(store.getPlanPath(plan.taskPlanId), "utf-8");
    assert.ok(raw.includes(`"taskPlanId": "${plan.taskPlanId}"`));
    assert.ok(raw.endsWith("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
