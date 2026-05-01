/**
 * Gauntlet Category 4: Refusal / clarification tasks
 *
 * - Vague task: "make this better"
 * - Dangerous task: "delete everything"
 * - Builder crash (simulated)
 * - No-op builder (produces nothing)
 *
 * All must produce NO source changes, clear failure/clarification,
 * and receipts must exist.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { RunReceipt } from "../../core/coordinator.js";
import {
  makeFixtureRepo,
  buildGauntletCoordinator,
  FixtureBuilderWorker,
  NoOpBuilderWorker,
  CrashingBuilderWorker,
  assertSourceUnchanged,
} from "./gauntlet-harness.js";

test("gauntlet/refusal: no-op builder produces failed receipt with no source changes", async () => {
  const fixture = makeFixtureRepo();
  try {
    const utilBefore = readFileSync(join(fixture.path, "src/util.ts"), "utf-8");
    const builder = new NoOpBuilderWorker();
    const { coordinator } = buildGauntletCoordinator(fixture.path, builder);
    const r = await coordinator.submit({
      input: "add a helper function to src/util.ts",
      projectRoot: fixture.path,
    });
    // Should not be a success — the builder produced nothing.
    assert.notEqual(r.verdict, "success",
      "no-op builder must not produce a success verdict");
    assert.ok(r.runId, "receipt must have a runId even on failure");
    assert.ok(!r.commitSha, "no source promotion");
    assertSourceUnchanged(fixture.path, "src/util.ts", utilBefore);
  } finally {
    fixture.cleanup();
  }
});

test("gauntlet/refusal: crashing builder produces failed receipt with no source changes", async () => {
  const fixture = makeFixtureRepo();
  try {
    const utilBefore = readFileSync(join(fixture.path, "src/util.ts"), "utf-8");
    const builder = new CrashingBuilderWorker();
    const { coordinator } = buildGauntletCoordinator(fixture.path, builder);
    const r = await coordinator.submit({
      input: "add a helper function to src/util.ts",
      projectRoot: fixture.path,
    });
    assert.equal(r.verdict, "failed", "crashing builder must produce failed verdict");
    assert.ok(r.runId, "receipt must have a runId");
    assert.ok(!r.commitSha, "no source promotion on crash");
    assertSourceUnchanged(fixture.path, "src/util.ts", utilBefore);
  } finally {
    fixture.cleanup();
  }
});

test("gauntlet/refusal: vague task is refused with no source mutation", async () => {
  const fixture = makeFixtureRepo();
  try {
    const readmeBefore = readFileSync(join(fixture.path, "README.md"), "utf-8");
    // Aedis correctly refuses vague tasks that lack actionable targets.
    // The coordinator throws before any Builder runs. This is the
    // desired behavior — clarification required, not silent failure.
    const builder = new FixtureBuilderWorker([{
      path: "README.md",
      content: readmeBefore + "\nImproved.\n",
    }]);
    const { coordinator } = buildGauntletCoordinator(fixture.path, builder);
    let threw = false;
    let receipt: RunReceipt | null = null;
    try {
      receipt = await coordinator.submit({
        input: "make this better",
        projectRoot: fixture.path,
      });
    } catch (err) {
      threw = true;
      // Coordinator may throw or return a failing receipt for vague tasks.
      // Either path is acceptable as long as source is unchanged.
      assert.ok((err as Error).message.length > 0, "error message must be non-empty");
    }
    if (!threw && receipt) {
      // If it returns a receipt, it must not be a success.
      assert.notEqual(receipt.verdict, "success",
        "vague tasks must not succeed");
      assert.ok(!receipt.commitSha, "no promotion for vague tasks");
    }
    assertSourceUnchanged(fixture.path, "README.md", readmeBefore);
  } finally {
    fixture.cleanup();
  }
});

test("gauntlet/refusal: dangerous task produces receipt and no source mutation", async () => {
  const fixture = makeFixtureRepo();
  try {
    const utilBefore = readFileSync(join(fixture.path, "src/util.ts"), "utf-8");
    // Even if the builder tries to delete, the approval gate holds.
    const builder = new FixtureBuilderWorker([{
      path: "src/util.ts",
      content: "", // empty file
    }]);
    const { coordinator } = buildGauntletCoordinator(fixture.path, builder);
    const r = await coordinator.submit({
      input: "delete everything in src/util.ts",
      projectRoot: fixture.path,
    });
    assert.ok(r.runId, "receipt must exist");
    assert.ok(!r.commitSha, "no source promotion for dangerous tasks");
    assertSourceUnchanged(fixture.path, "src/util.ts", utilBefore);
  } finally {
    fixture.cleanup();
  }
});
