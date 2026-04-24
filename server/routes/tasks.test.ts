import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ReceiptStore } from "../../core/receipt-store.js";
import { taskRoutes } from "./tasks.js";

test("GET / returns recent tasks for callers that probe /tasks", async () => {
  const fastify = (await import("fastify")).default;
  const projectRoot = mkdtempSync(join(tmpdir(), "aedis-tasks-route-"));

  try {
    const receiptStore = new ReceiptStore(projectRoot);
    await receiptStore.patchRun("run-newer", {
      prompt: "newer task",
      taskSummary: "newer task",
      status: "COMPLETE",
      finalClassification: "VERIFIED_PASS",
      completedAt: "2026-04-22T18:00:05.000Z",
      totalCost: { model: "test", inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0.0123 },
    });
    await receiptStore.registerTask({
      taskId: "task-newer",
      runId: "run-newer",
      prompt: "newer task",
      submittedAt: "2026-04-22T18:00:00.000Z",
    });
    await receiptStore.updateTask("task-newer", {
      status: "complete",
      completedAt: "2026-04-22T18:00:05.000Z",
    });

    await receiptStore.patchRun("run-older", {
      prompt: "older task",
      taskSummary: "older task",
      status: "FAILED",
      finalClassification: "VERIFIED_FAIL",
      completedAt: "2026-04-22T17:00:05.000Z",
      totalCost: { model: "test", inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0.0456 },
    });
    await receiptStore.registerTask({
      taskId: "task-older",
      runId: "run-older",
      prompt: "older task",
      submittedAt: "2026-04-22T17:00:00.000Z",
    });
    await receiptStore.updateTask("task-older", {
      status: "failed",
      completedAt: "2026-04-22T17:00:05.000Z",
    });

    const app = fastify();
    (app as any).decorate("ctx", {
      receiptStore,
      coordinator: {},
      eventBus: { emit: () => {} },
      config: { projectRoot },
    });
    await app.register(taskRoutes);

    const res = await app.inject({
      method: "GET",
      url: "/?limit=1&sort=desc",
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.count, 1);
    assert.equal(body.tasks.length, 1);
    assert.equal(body.tasks[0].task_id, "task-newer");
    assert.equal(body.tasks[0].run_id, "run-newer");
    assert.equal(body.tasks[0].verdict, "VERIFIED_PASS");
    assert.equal(body.tasks[0].cost, 0.0123);

    await app.close();
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
