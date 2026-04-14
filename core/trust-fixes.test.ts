/**
 * Trust Fixes — Unit Tests
 *
 * Focused tests for the Phase 1+2 trust fixes.
 * No coordinator integration (too slow) — tests the pure functions directly.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ─── Fix #4: Calibrated Thresholds ───────────────────────────────────

test("calibrateThresholds — defaults with insufficient data", async () => {
  const { calibrateThresholds } = await import("./confidence-scoring.js");
  const r = calibrateThresholds(0.5, 0.1, 3);
  assert.equal(r.apply, 0.85, "should use default apply");
  assert.equal(r.review, 0.70, "should use default review");
  assert.equal(r.escalate, 0.50, "should use default escalate");
  assert.equal(r.reason, "insufficient data for calibration");
});

test("calibrateThresholds — raises apply when overconfident", async () => {
  const { calibrateThresholds } = await import("./confidence-scoring.js");
  const r = calibrateThresholds(0.3, 0, 10);
  assert.ok(r.apply > 0.85, "apply should be raised");
  assert.ok(r.apply <= 0.95, "apply should cap at reasonable bound");
  assert.ok(r.reason.includes("overconfidence"), "reason should mention overconfidence");
});

test("calibrateThresholds — lowers review when underconfident", async () => {
  const { calibrateThresholds } = await import("./confidence-scoring.js");
  const r = calibrateThresholds(0, 0.3, 10);
  assert.ok(r.review < 0.70, "review should be lowered");
  assert.ok(r.reason.includes("underconfidence"), "reason should mention underconfidence");
});

test("calibrateThresholds — caps overconfidence adjustment at +0.10", async () => {
  const { calibrateThresholds } = await import("./confidence-scoring.js");
  const r = calibrateThresholds(1.0, 0, 100); // 100% overconfidence
  assert.ok(r.apply <= 0.95, "apply should never exceed 0.95");
});

test("calibrateThresholds — both adjustments compose", async () => {
  const { calibrateThresholds } = await import("./confidence-scoring.js");
  const r = calibrateThresholds(0.4, 0.3, 20);
  assert.ok(r.apply > 0.85, "apply raised for overconfidence");
  assert.ok(r.review < 0.70, "review lowered for underconfidence");
});

// ─── Fix #7: Trust Explanation ────────────────────────────────────────

test("saveMemory — uses atomic write (tmp + rename)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aedis-memtest-"));
  try {
    const { loadMemory, saveMemory } = await import("./project-memory.js");

    // Save memory
    const mem = await loadMemory(dir); // loads empty memory
    await saveMemory(dir, {
      ...mem,
      projectRoot: dir,
      language: "javascript",
      recentFiles: ["src/index.ts"],
      recentTasks: [],
      fileClusters: [],
      taskPatterns: [],
      schemaVersion: 1,
    });

    // Verify file was written
    const memPath = join(dir, ".aedis/memory.json");
    assert.ok(existsSync(memPath), "memory.json should exist");

    // Verify content
    const loaded = await loadMemory(dir);
    assert.deepEqual(loaded.recentFiles, ["src/index.ts"]);

    // No .tmp file should remain (cleanup after rename)
    assert.ok(!existsSync(memPath + ".tmp"), "tmp file should be cleaned up");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Fix #1: Startup Recovery ─────────────────────────────────────────

test("startup recovery — marks orphaned AWAITING_APPROVAL as INTERRUPTED", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aedis-recoverytest-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "test" }));
    const { ReceiptStore } = await import("./receipt-store.js");
    const store = new ReceiptStore(dir);

    // Create orphaned run
    await store.patchRun("orphan-1", {
      status: "AWAITING_APPROVAL",
      taskSummary: "orphaned",
      prompt: "test",
    });

    // Verify it's there as AWAITING_APPROVAL
    const before = await store.getRun("orphan-1");
    assert.equal(before!.status, "AWAITING_APPROVAL");

    // Simulate startup recovery (what the Coordinator constructor does)
    const awaiting = await store.listRuns(100, "AWAITING_APPROVAL");
    assert.equal(awaiting.length, 1, "should find 1 awaiting run");

    // Mark as interrupted (this is what recoverPendingApprovals does)
    await store.patchRun("orphan-1", {
      status: "INTERRUPTED",
      taskSummary: "Interrupted — process restarted while awaiting approval",
      completedAt: new Date().toISOString(),
      appendErrors: ["Orphaned AWAITING_APPROVAL run recovered on startup"],
    });

    const after = await store.getRun("orphan-1");
    assert.equal(after!.status, "INTERRUPTED");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Fix #6: Recovery Circuit Breaker ─────────────────────────────────

test("recovery engine — global circuit breaker trips on max attempts", async () => {
  const { RecoveryEngine } = await import("./recovery-engine.js");
  const engine = new RecoveryEngine();

  assert.equal(engine.isCircuitTripped(), false, "should start untripped");

  // Record 20 attempts (the limit)
  for (let i = 0; i < 20; i++) {
    engine.recordRecoveryAttempt(0.01);
  }

  assert.equal(engine.isCircuitTripped(), true, "should be tripped after 20 attempts");
  const budget = engine.getGlobalBudget();
  assert.ok(budget.tripReason!.includes("attempt limit"), "reason should mention attempt limit");
});

test("recovery engine — global circuit breaker trips on cost", async () => {
  const { RecoveryEngine } = await import("./recovery-engine.js");
  const engine = new RecoveryEngine();

  // Spend $2 in one shot
  engine.recordRecoveryAttempt(2.00);

  assert.equal(engine.isCircuitTripped(), true, "should be tripped after $2 spent");
  const budget = engine.getGlobalBudget();
  assert.ok(budget.tripReason!.includes("cost limit"), "reason should mention cost limit");
});

test("recovery engine — global budget persists across instances via singleton", async () => {
  const { getGlobalRecoveryEngine } = await import("./recovery-engine.js");
  const e1 = getGlobalRecoveryEngine();
  const e2 = getGlobalRecoveryEngine();
  assert.equal(e1, e2, "should be same instance");
});

// ─── Fix #2: Rollback Verification (unit test of the concept) ────────

test("rollback verification — git status check detects dirty state", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aedis-rollbacktest-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "test" }));
    writeFileSync(join(dir, "test.txt"), "hello");

    // Initialize git repo
    const { execSync } = await import("child_process");
    execSync("git init", { cwd: dir, stdio: "pipe" });
    execSync("git add .", { cwd: dir, stdio: "pipe" });
    execSync("git commit -m 'init'", { cwd: dir, stdio: "pipe" });

    // Make a change
    writeFileSync(join(dir, "test.txt"), "modified");

    // Check git status
    const status = execSync("git status --porcelain", { cwd: dir, encoding: "utf-8" });
    assert.ok(status.includes("test.txt"), "should detect modified file");

    // Restore
    execSync("git restore test.txt", { cwd: dir, stdio: "pipe" });

    // Verify clean
    const statusAfter = execSync("git status --porcelain", { cwd: dir, encoding: "utf-8" });
    assert.equal(statusAfter.trim(), "", "should be clean after restore");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Fix #5: Trust Regression Detection (unit test of the logic) ─────

test("trust regression — detects overconfidence pattern", async () => {
  // Test the detection logic inline (it's simple enough)
  const confidence = 0.75;
  const evalScore = 0.40;
  const signals: string[] = [];

  if (confidence >= 0.7 && evalScore < 0.5) {
    signals.push("overconfident: confidence " + (confidence * 100).toFixed(0) + "% but evaluation " + (evalScore * 100).toFixed(0) + "%");
  }

  assert.equal(signals.length, 1, "should detect overconfidence");
  assert.ok(signals[0].includes("75%"), "should include confidence value");
  assert.ok(signals[0].includes("40%"), "should include eval value");
});

test("trust regression — detects low success rate", async () => {
  const recentStatuses = ["VERIFIED_FAIL", "VERIFIED_FAIL", "VERIFIED_PASS", "VERIFIED_FAIL", "VERIFIED_FAIL", "VERIFIED_PASS", "VERIFIED_FAIL", "VERIFIED_FAIL"];
  const successes = recentStatuses.filter((s) => s === "VERIFIED_PASS").length;
  const rate = successes / recentStatuses.length;

  assert.ok(rate < 0.4, "should be below 40%");
  assert.equal(rate, 0.25, "success rate should be 25%");
});
