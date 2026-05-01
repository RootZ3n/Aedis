/**
 * Gauntlet Category 1: Tiny docs tasks
 *
 * These prove Aedis handles the simplest real-world tasks correctly:
 * - Add one README sentence
 * - Fix a typo in README
 * - Add changelog entry
 *
 * All must produce visible diffs, no garbage, reach approval gate,
 * and never mutate source before approval.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  makeFixtureRepo,
  buildGauntletCoordinator,
  FixtureBuilderWorker,
  assertReadinessContract,
  assertSourceUnchanged,
  assertNoGarbage,
} from "./gauntlet-harness.js";

test("gauntlet/docs: add one README sentence reaches approval with visible diff", async () => {
  const fixture = makeFixtureRepo();
  try {
    const original = readFileSync(join(fixture.path, "README.md"), "utf-8");
    const builder = new FixtureBuilderWorker([{
      path: "README.md",
      content: original + "\nThis project supports the `--verbose` flag for detailed output.\n",
    }]);
    const { coordinator, events } = buildGauntletCoordinator(fixture.path, builder);
    const r = await coordinator.submit({
      input: "add a sentence to README.md about the --verbose flag",
      projectRoot: fixture.path,
    });
    assertReadinessContract(r, events, { expectDiff: true });
    assertNoGarbage(r);
    assertSourceUnchanged(fixture.path, "README.md", original);
    assert.ok(r.executionMode, "executionMode must be recorded");
    assert.ok(r.totalCost && typeof r.totalCost.model === "string", "totalCost.model must exist");
  } finally {
    fixture.cleanup();
  }
});

test("gauntlet/docs: fix a typo in README reaches approval with visible diff", async () => {
  const fixture = makeFixtureRepo();
  try {
    const original = readFileSync(join(fixture.path, "README.md"), "utf-8");
    const builder = new FixtureBuilderWorker([{
      path: "README.md",
      content: original.replace("Gauntlet Fixture", "Gauntlet Fixture (corrected)"),
    }]);
    const { coordinator, events } = buildGauntletCoordinator(fixture.path, builder);
    const r = await coordinator.submit({
      input: "fix the typo in README.md heading",
      projectRoot: fixture.path,
    });
    assertReadinessContract(r, events, { expectDiff: true });
    assertNoGarbage(r);
    assertSourceUnchanged(fixture.path, "README.md", original);
  } finally {
    fixture.cleanup();
  }
});

test("gauntlet/docs: add changelog entry reaches approval with visible diff", async () => {
  const fixture = makeFixtureRepo();
  try {
    const original = readFileSync(join(fixture.path, "CHANGELOG.md"), "utf-8");
    const builder = new FixtureBuilderWorker([{
      path: "CHANGELOG.md",
      content: original + "\n## v0.1.0\n\n- Added verbose flag support.\n",
    }]);
    const { coordinator, events } = buildGauntletCoordinator(fixture.path, builder);
    const r = await coordinator.submit({
      input: "add a changelog entry for the v0.1.0 release to CHANGELOG.md",
      projectRoot: fixture.path,
    });
    assertReadinessContract(r, events, { expectDiff: true });
    assertNoGarbage(r);
    assertSourceUnchanged(fixture.path, "CHANGELOG.md", original);
  } finally {
    fixture.cleanup();
  }
});

test("gauntlet/docs: fast_review eligible for single-file doc task", async () => {
  const fixture = makeFixtureRepo();
  try {
    const original = readFileSync(join(fixture.path, "README.md"), "utf-8");
    const builder = new FixtureBuilderWorker([{
      path: "README.md",
      content: original + "\nSee the docs/ directory for more info.\n",
    }]);
    const { coordinator, events } = buildGauntletCoordinator(fixture.path, builder);
    const r = await coordinator.submit({
      input: "add a sentence to README.md about the docs directory",
      projectRoot: fixture.path,
    });
    assertReadinessContract(r, events, { expectDiff: true, expectMode: "fast_review" });
    assertNoGarbage(r);
    // fast_review must skip certain stages.
    assert.ok(r.executionModeDetail, "executionModeDetail must be present");
    assert.ok(r.executionModeDetail!.skippedStages.length > 0,
      "fast_review should skip some stages");
  } finally {
    fixture.cleanup();
  }
});
