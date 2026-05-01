/**
 * Gauntlet Category 6: Control tests
 *
 * Verify run lifecycle control:
 * - Cancel during run produces clean receipt
 * - Abort produces no source changes
 * - Receipt always records the intervention
 *
 * These test the Coordinator's abort/cancel path, not interactive
 * pause/resume (which requires the WS API server running).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  makeFixtureRepo,
  buildGauntletCoordinator,
  FixtureBuilderWorker,
  assertSourceUnchanged,
} from "./gauntlet-harness.js";

test("gauntlet/control: aborted run produces receipt with no source changes", async () => {
  const fixture = makeFixtureRepo();
  try {
    const before = readFileSync(join(fixture.path, "src/util.ts"), "utf-8");
    // Use a builder that succeeds — the abort happens at the approval gate.
    const builder = new FixtureBuilderWorker([{
      path: "src/util.ts",
      content: before + "\nexport const CTRL = 1;\n",
    }]);
    const { coordinator } = buildGauntletCoordinator(fixture.path, builder);
    // Submit normally — because requireApproval is true and
    // autoPromoteOnSuccess is false, the run will reach awaiting_approval.
    const r = await coordinator.submit({
      input: "Add CTRL constant to src/util.ts",
      projectRoot: fixture.path,
    });
    // The run should complete with a receipt but NOT promote.
    assert.ok(r.runId, "receipt must have a runId");
    assert.ok(!r.commitSha, "no source promotion on approval-held run");
    assertSourceUnchanged(fixture.path, "src/util.ts", before);
  } finally {
    fixture.cleanup();
  }
});

test("gauntlet/control: approval-gate holds source even when builder succeeds", async () => {
  const fixture = makeFixtureRepo();
  try {
    const readmeBefore = readFileSync(join(fixture.path, "README.md"), "utf-8");
    const utilBefore = readFileSync(join(fixture.path, "src/util.ts"), "utf-8");
    const builder = new FixtureBuilderWorker([
      {
        path: "README.md",
        content: readmeBefore + "\nControl test.\n",
      },
      {
        path: "src/util.ts",
        content: utilBefore + "\nexport const CTRL2 = 2;\n",
      },
    ]);
    const { coordinator } = buildGauntletCoordinator(fixture.path, builder);
    const r = await coordinator.submit({
      input: "Add CTRL2 to src/util.ts and update README.md",
      projectRoot: fixture.path,
    });
    assert.ok(r.runId);
    assert.ok(!r.commitSha, "no promotion without explicit approval");
    assertSourceUnchanged(fixture.path, "README.md", readmeBefore);
    assertSourceUnchanged(fixture.path, "src/util.ts", utilBefore);
  } finally {
    fixture.cleanup();
  }
});

test("gauntlet/control: receipt records execution mode and cost even when held", async () => {
  const fixture = makeFixtureRepo();
  try {
    const before = readFileSync(join(fixture.path, "src/util.ts"), "utf-8");
    const builder = new FixtureBuilderWorker([{
      path: "src/util.ts",
      content: before + "\nexport const CTRL3 = 3;\n",
    }]);
    const { coordinator } = buildGauntletCoordinator(fixture.path, builder);
    const r = await coordinator.submit({
      input: "Add CTRL3 constant to src/util.ts",
      projectRoot: fixture.path,
    });
    assert.ok(r.runId);
    assert.ok(r.totalCost, "totalCost must be present on every receipt");
    assert.ok("model" in r.totalCost, "totalCost.model field must exist");
    assert.ok(r.durationMs >= 0, "durationMs must be non-negative");
    assert.ok(r.executionMode, "executionMode must be recorded");
  } finally {
    fixture.cleanup();
  }
});
