/**
 * Gauntlet Category 2: Simple code tasks
 *
 * - Add one exported helper function
 * - Add a small pure utility
 * - Add a test placeholder
 * - Fix a simple bug in a function
 *
 * All must produce visible diffs, not be fast_review, reach approval,
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

test("gauntlet/code: add exported helper function reaches approval", async () => {
  const fixture = makeFixtureRepo();
  try {
    const before = readFileSync(join(fixture.path, "src/util.ts"), "utf-8");
    const builder = new FixtureBuilderWorker([{
      path: "src/util.ts",
      content: before + "\nexport function multiply(a: number, b: number): number {\n  return a * b;\n}\n",
    }]);
    const { coordinator, events } = buildGauntletCoordinator(fixture.path, builder);
    const r = await coordinator.submit({
      input: "Add an exported helper function `multiply(a, b)` to src/util.ts",
      projectRoot: fixture.path,
    });
    assertReadinessContract(r, events, { expectDiff: true });
    assertNoGarbage(r);
    assertSourceUnchanged(fixture.path, "src/util.ts", before);
    // Code tasks should NOT be fast_review.
    assert.notEqual(r.executionMode, "fast_review",
      "code tasks must not use fast_review");
  } finally {
    fixture.cleanup();
  }
});

test("gauntlet/code: add small pure utility reaches approval", async () => {
  const fixture = makeFixtureRepo();
  try {
    const before = readFileSync(join(fixture.path, "src/util.ts"), "utf-8");
    const builder = new FixtureBuilderWorker([{
      path: "src/util.ts",
      content: before + "\nexport function clamp(value: number, min: number, max: number): number {\n  return Math.min(Math.max(value, min), max);\n}\n",
    }]);
    const { coordinator, events } = buildGauntletCoordinator(fixture.path, builder);
    const r = await coordinator.submit({
      input: "Add a clamp(value, min, max) utility to src/util.ts",
      projectRoot: fixture.path,
    });
    assertReadinessContract(r, events, { expectDiff: true });
    assertNoGarbage(r);
    assertSourceUnchanged(fixture.path, "src/util.ts", before);
  } finally {
    fixture.cleanup();
  }
});

test("gauntlet/code: add test placeholder reaches approval (single placeholder allowed)", async () => {
  const fixture = makeFixtureRepo();
  try {
    const beforeTest = readFileSync(join(fixture.path, "src/util.test.ts"), "utf-8");
    const beforeUtil = readFileSync(join(fixture.path, "src/util.ts"), "utf-8");
    // The charter targets src/util.ts (from "util" in the prompt) and the
    // test-inject heuristic adds src/util.test.ts, so TWO builder nodes
    // are created. The fixture must supply content for both files so
    // neither builder node triggers missing_required_deliverable.
    const builder = new FixtureBuilderWorker([
      {
        path: "src/util.test.ts",
        content: beforeTest +
          "\nimport test from 'node:test';\n" +
          "import assert from 'node:assert/strict';\n" +
          "test.skip('handles zero inputs', () => {\n" +
          "  // pin zero-input behavior once add() edge cases are defined\n" +
          "  assert.ok(true);\n" +
          "});\n",
      },
      {
        // Document the function under test — a real non-identical change
        // that satisfies the builder node targeting the implementation file.
        path: "src/util.ts",
        content: "export const VERSION = 1;\n\n/** Add two numbers. */\nexport function add(a: number, b: number): number {\n  return a + b;\n}\n",
      },
    ]);
    const { coordinator, events } = buildGauntletCoordinator(fixture.path, builder);
    const r = await coordinator.submit({
      input: "add a skipped test placeholder for zero input in src/util.test.ts",
      projectRoot: fixture.path,
    });
    assertReadinessContract(r, events, { expectDiff: true });
    assertNoGarbage(r);
    assertSourceUnchanged(fixture.path, "src/util.test.ts", beforeTest);
    assertSourceUnchanged(fixture.path, "src/util.ts", beforeUtil);
  } finally {
    fixture.cleanup();
  }
});

test("gauntlet/code: fix simple bug reaches approval with visible diff", async () => {
  const fixture = makeFixtureRepo({
    extraFiles: {
      "src/math.ts": "export function subtract(a: number, b: number): number {\n  return a + b; // BUG: should be a - b\n}\n",
    },
  });
  try {
    const before = readFileSync(join(fixture.path, "src/math.ts"), "utf-8");
    const builder = new FixtureBuilderWorker([{
      path: "src/math.ts",
      content: "export function subtract(a: number, b: number): number {\n  return a - b;\n}\n",
    }]);
    const { coordinator, events } = buildGauntletCoordinator(fixture.path, builder);
    const r = await coordinator.submit({
      input: "Fix the bug in src/math.ts: subtract should return a - b, not a + b",
      projectRoot: fixture.path,
    });
    assertReadinessContract(r, events, { expectDiff: true });
    assertNoGarbage(r);
    assertSourceUnchanged(fixture.path, "src/math.ts", before);
  } finally {
    fixture.cleanup();
  }
});
