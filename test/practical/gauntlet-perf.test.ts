/**
 * Gauntlet Category 7: Performance measurement
 *
 * Measures elapsed time for different execution modes and reports
 * stage timings, total duration, which workers ran, and skipped stages.
 *
 * These tests PASS/FAIL on correctness, not on absolute time limits
 * (stub workers are near-instant). The timing data is captured for
 * the gauntlet report.
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
  getNarrative,
} from "./gauntlet-harness.js";

test("gauntlet/perf: fast_review docs task timing captured", async () => {
  const fixture = makeFixtureRepo();
  try {
    const original = readFileSync(join(fixture.path, "README.md"), "utf-8");
    const builder = new FixtureBuilderWorker([{
      path: "README.md",
      content: original + "\nPerformance test sentence.\n",
    }]);
    const { coordinator, events } = buildGauntletCoordinator(fixture.path, builder);
    const start = Date.now();
    const r = await coordinator.submit({
      input: "add a sentence to README.md about performance",
      projectRoot: fixture.path,
    });
    const elapsed = Date.now() - start;
    assertReadinessContract(r, events, { expectDiff: true, expectMode: "fast_review" });
    assert.ok(r.durationMs > 0, "durationMs must be positive");
    // Report workers that ran via narrative.
    const narrativeKinds = getNarrative(events).map(e => e.kind);
    assert.ok(narrativeKinds.includes("mode_selected"), "mode_selected must appear");
    // Log timing for report consumption.
    console.log(`[gauntlet/perf] fast_review elapsed: ${elapsed}ms, receipt.durationMs: ${r.durationMs}ms`);
    console.log(`[gauntlet/perf] skippedStages: ${r.executionModeDetail?.skippedStages?.join(",") ?? "none"}`);
  } finally {
    fixture.cleanup();
  }
});

test("gauntlet/perf: standard_review code task timing captured", async () => {
  const fixture = makeFixtureRepo();
  try {
    const before = readFileSync(join(fixture.path, "src/util.ts"), "utf-8");
    const builder = new FixtureBuilderWorker([{
      path: "src/util.ts",
      content: before + "\nexport function perfTest(): void {}\n",
    }]);
    const { coordinator, events } = buildGauntletCoordinator(fixture.path, builder);
    const start = Date.now();
    const r = await coordinator.submit({
      input: "Add a perfTest function to src/util.ts",
      projectRoot: fixture.path,
    });
    const elapsed = Date.now() - start;
    assertReadinessContract(r, events, { expectDiff: true });
    assert.ok(r.durationMs > 0);
    console.log(`[gauntlet/perf] standard_review elapsed: ${elapsed}ms, receipt.durationMs: ${r.durationMs}ms`);
    console.log(`[gauntlet/perf] mode: ${r.executionMode}`);
  } finally {
    fixture.cleanup();
  }
});

test("gauntlet/perf: strict_review multi-file task timing captured", async () => {
  const fixture = makeFixtureRepo();
  try {
    const utilBefore = readFileSync(join(fixture.path, "src/util.ts"), "utf-8");
    const testBefore = readFileSync(join(fixture.path, "src/util.test.ts"), "utf-8");
    const builder = new FixtureBuilderWorker([
      {
        path: "src/util.ts",
        content: utilBefore + "\nexport function perfMulti(): void {}\n",
      },
      {
        path: "src/util.test.ts",
        content: testBefore + "\n// perf test marker\n",
      },
    ]);
    const { coordinator, events } = buildGauntletCoordinator(fixture.path, builder);
    const start = Date.now();
    const r = await coordinator.submit({
      input: "Add perfMulti() to src/util.ts and add a test in src/util.test.ts",
      projectRoot: fixture.path,
    });
    const elapsed = Date.now() - start;
    assertReadinessContract(r, events, { expectDiff: true });
    assert.ok(r.durationMs > 0);
    assert.notEqual(r.executionMode, "fast_review");
    console.log(`[gauntlet/perf] strict_review elapsed: ${elapsed}ms, receipt.durationMs: ${r.durationMs}ms`);
    console.log(`[gauntlet/perf] mode: ${r.executionMode}`);
  } finally {
    fixture.cleanup();
  }
});
