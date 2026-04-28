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

test("ReceiptStore concurrent writers keep a valid complete index", async () => {
  const root = mkdtempSync(join(tmpdir(), "aedis-receipts-concurrent-"));
  try {
    const stores = Array.from({ length: 8 }, () => new ReceiptStore(root));
    await Promise.all(stores.map((store, i) =>
      store.patchRun(`run-${i}`, {
        prompt: `prompt ${i}`,
        taskSummary: `summary ${i}`,
        status: "COMPLETE",
        completedAt: `2026-04-11T10:00:0${i}.000Z`,
      }),
    ));

    const indexPath = join(root, "state", "receipts", "index.json");
    const index = JSON.parse(readFileSync(indexPath, "utf-8"));
    assert.equal(index.runs.length, 8);
    assert.deepEqual(
      new Set(index.runs.map((run: any) => run.runId)),
      new Set(Array.from({ length: 8 }, (_, i) => `run-${i}`)),
    );
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

test("ReceiptStore persists routing decisions and merges escalations on the same taskId", async () => {
  const root = mkdtempSync(join(tmpdir(), "aedis-receipts-routing-"));
  try {
    const store = new ReceiptStore(root);
    await store.beginRun({
      runId: "run-r1",
      intentId: "intent-r1",
      prompt: "test routing persistence",
      taskSummary: "test routing persistence",
      startedAt: "2026-04-25T10:00:00.000Z",
      phase: "dispatch",
    });

    // Initial routing decision (no escalations yet).
    await store.patchRun("run-r1", {
      appendRouting: [{
        at: "2026-04-25T10:00:01.000Z",
        taskId: "task-r1",
        workerType: "builder",
        tier: "fast",
        rationale: "single-file scope",
        complexityScore: 2.5,
        blastRadiusLevel: "contained",
        riskSignals: [],
        estimatedCostUsd: 0.0008,
        tokenBudget: 4000,
        criticReviewRequired: false,
        escalations: [],
      }],
    });

    // Capability-floor bump to standard.
    await store.patchRun("run-r1", {
      appendRouting: [{
        at: "2026-04-25T10:00:01.500Z",
        taskId: "task-r1",
        workerType: "builder",
        tier: "standard",
        rationale: "ignored on merge",
        complexityScore: 0,
        blastRadiusLevel: "",
        riskSignals: [],
        estimatedCostUsd: 0,
        tokenBudget: 0,
        criticReviewRequired: false,
        escalations: [{
          at: "2026-04-25T10:00:01.500Z",
          from: "fast",
          to: "standard",
          reason: "capability-floor",
          detail: "broad change verb in prompt",
        }],
      }],
    });

    // Weak-output retry to premium.
    await store.patchRun("run-r1", {
      appendRouting: [{
        at: "2026-04-25T10:00:05.000Z",
        taskId: "task-r1",
        workerType: "builder",
        tier: "premium",
        rationale: "ignored on merge",
        complexityScore: 0,
        blastRadiusLevel: "",
        riskSignals: [],
        estimatedCostUsd: 0,
        tokenBudget: 0,
        criticReviewRequired: false,
        escalations: [{
          at: "2026-04-25T10:00:05.000Z",
          from: "standard",
          to: "premium",
          reason: "weak-output-retry",
          detail: "minimax-coding -> mimo-v2.5-pro",
        }],
      }],
    });

    const persisted = await store.getRun("run-r1");
    assert.ok(persisted);
    assert.equal(persisted.routing.length, 1, "single row per taskId");
    const r = persisted.routing[0]!;
    assert.equal(r.tier, "fast", "initial tier preserved");
    assert.equal(r.rationale, "single-file scope");
    assert.equal(r.escalations.length, 2);
    assert.equal(r.escalations[0]!.reason, "capability-floor");
    assert.equal(r.escalations[1]!.reason, "weak-output-retry");
    assert.equal(r.escalations[1]!.to, "premium");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ReceiptStore persists provider attempts and circuit-breaker skips", async () => {
  const root = mkdtempSync(join(tmpdir(), "aedis-receipts-attempts-"));
  try {
    const store = new ReceiptStore(root);
    await store.beginRun({
      runId: "run-a1",
      intentId: "intent-a1",
      prompt: "test attempt persistence",
      taskSummary: "test attempt persistence",
      startedAt: "2026-04-25T11:00:00.000Z",
      phase: "dispatch",
    });

    await store.patchRun("run-a1", {
      appendProviderAttempts: [
        {
          at: "2026-04-25T11:00:01.000Z",
          taskId: "task-a1",
          attemptIndex: 0,
          provider: "openrouter",
          model: "xiaomi/mimo-v2.5",
          outcome: "empty_response",
          durationMs: 412,
          costUsd: 0,
          errorMsg: "openrouter/xiaomi/mimo-v2.5 returned empty content",
        },
        {
          at: "2026-04-25T11:00:02.000Z",
          taskId: "task-a1",
          attemptIndex: 1,
          provider: "minimax",
          model: "minimax-coding",
          outcome: "ok",
          durationMs: 833,
          costUsd: 0.0012,
          tokensIn: 850,
          tokensOut: 220,
        },
      ],
      appendCircuitBreakerSkips: [
        {
          at: "2026-04-25T11:00:00.500Z",
          taskId: "task-a1",
          provider: "openrouter",
          model: "xiaomi/mimo-v2-pro",
        },
      ],
    });

    const persisted = await store.getRun("run-a1");
    assert.ok(persisted);
    assert.equal(persisted.providerAttempts.length, 2);
    assert.equal(persisted.providerAttempts[0]!.outcome, "empty_response");
    assert.equal(persisted.providerAttempts[1]!.outcome, "ok");
    assert.equal(persisted.providerAttempts[1]!.costUsd, 0.0012);
    assert.equal(persisted.circuitBreakerSkips.length, 1);
    assert.equal(persisted.circuitBreakerSkips[0]!.provider, "openrouter");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ReceiptStore initializes new fields as empty arrays for fresh receipts", async () => {
  const root = mkdtempSync(join(tmpdir(), "aedis-receipts-empty-"));
  try {
    const store = new ReceiptStore(root);
    await store.beginRun({
      runId: "run-e1",
      intentId: "intent-e1",
      prompt: "fresh",
      taskSummary: "fresh",
      startedAt: "2026-04-25T12:00:00.000Z",
      phase: "starting",
    });
    const persisted = await store.getRun("run-e1");
    assert.ok(persisted);
    assert.deepEqual(persisted.routing, []);
    assert.deepEqual(persisted.providerAttempts, []);
    assert.deepEqual(persisted.circuitBreakerSkips, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
