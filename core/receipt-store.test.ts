import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ReceiptStore } from "./receipt-store.js";

test("ReceiptStore writes per-run receipts incrementally and updates the index", async () => {
  const root = mkdtempSync(join(tmpdir(), "aedis-receipts-"));
  try {
    const store = new ReceiptStore(root);
    await store.beginRun({
      runId: "run-1",
      intentId: "intent-1",
      prompt: "implement persistent receipts",
      taskSummary: "implement persistent receipts",
      startedAt: "2026-04-11T10:00:00.000Z",
      phase: "charter",
    });

    await store.patchRun("run-1", {
      phase: "building",
      appendWorkerEvents: [
        {
          at: "2026-04-11T10:00:01.000Z",
          workerType: "builder",
          taskId: "task-1",
          status: "completed",
          summary: "builder completed",
          confidence: 0.82,
          costUsd: 0.01,
          filesTouched: ["core/coordinator.ts"],
          issues: [],
        },
      ],
      appendCheckpoints: [
        {
          at: "2026-04-11T10:00:01.000Z",
          type: "worker_step",
          status: "RUNNING",
          phase: "building",
          summary: "builder completed",
        },
      ],
      filesTouched: [
        {
          path: "core/coordinator.ts",
          operation: "modify",
          taskId: "task-1",
          timestamp: "2026-04-11T10:00:01.000Z",
        },
      ],
      changesSummary: [{ path: "core/coordinator.ts", operation: "modify" }],
    });

    await store.patchRun("run-1", {
      status: "COMPLETE",
      completedAt: "2026-04-11T10:00:02.000Z",
      finalClassification: "VERIFIED_SUCCESS",
      totalCost: { model: "test", inputTokens: 10, outputTokens: 20, estimatedCostUsd: 0.01 },
      confidence: { overall: 0.91, planning: 0.88, execution: 0.94, verification: 0.9 },
      humanSummary: { headline: "Aedis updated 1 file and all changes passed verification." },
      appendCheckpoints: [
        {
          at: "2026-04-11T10:00:02.000Z",
          type: "run_completed",
          status: "COMPLETE",
          phase: "complete",
          summary: "run completed",
        },
      ],
    });

    const receipt = await store.getRun("run-1");
    assert.ok(receipt);
    assert.equal(receipt.status, "COMPLETE");
    assert.equal(receipt.finalClassification, "VERIFIED_SUCCESS");
    assert.equal(receipt.workerEvents.length, 1);
    assert.equal(receipt.filesTouched.length, 1);

    const index = JSON.parse(readFileSync(join(root, "state", "receipts", "index.json"), "utf-8"));
    assert.equal(index.runs.length, 1);
    assert.equal(index.runs[0].runId, "run-1");
    assert.equal(index.runs[0].status, "COMPLETE");
    assert.equal(index.runs[0].prompt, "implement persistent receipts");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ReceiptStore marks unfinished runs as crashed on startup", async () => {
  const root = mkdtempSync(join(tmpdir(), "aedis-receipts-"));
  try {
    const store = new ReceiptStore(root);
    await store.beginRun({
      runId: "run-crash",
      intentId: "intent-crash",
      prompt: "mid-run crash",
      taskSummary: "mid-run crash",
      startedAt: "2026-04-11T11:00:00.000Z",
      phase: "building",
    });

    const recovery = await store.markIncompleteRunsCrashed("server restarted before completion");
    assert.equal(recovery.runsRecovered, 1);
    assert.equal(recovery.orphanWorkspaces.length, 0);

    const receipt = await store.getRun("run-crash");
    assert.ok(receipt);
    assert.equal(receipt.status, "INTERRUPTED");
    assert.ok(receipt.completedAt);
    assert.ok(receipt.errors.includes("server restarted before completion"));
    assert.equal(receipt.checkpoints.at(-1)?.type, "startup_recovery");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ReceiptStore persists task-to-run identity for restart recovery", async () => {
  const root = mkdtempSync(join(tmpdir(), "aedis-receipts-"));
  try {
    const store = new ReceiptStore(root);
    await store.registerTask({
      taskId: "task-42",
      runId: "run-42",
      prompt: "recover me after restart",
      submittedAt: "2026-04-11T12:00:00.000Z",
    });
    await store.updateTask("task-42", {
      status: "running",
    });

    const byTask = await store.getTask("task-42");
    const byRun = await store.getTaskByRunId("run-42");
    assert.ok(byTask);
    assert.ok(byRun);
    assert.equal(byTask.runId, "run-42");
    assert.equal(byTask.status, "running");
    assert.equal(byRun.taskId, "task-42");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
