/**
 * Gauntlet Category 5: Garbage-output detection
 *
 * Inject or simulate Builder output with:
 * - Repeated identical lines
 * - Duplicate exports/types
 * - Placeholder-only implementation
 * - Huge suspicious addition for tiny task
 * - No-op diff (byte-for-byte identical)
 *
 * All must be blocked before approval with clear reasons.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  makeFixtureRepo,
  buildGauntletCoordinator,
  FixtureBuilderWorker,
  assertGarbageBlocked,
  assertSourceUnchanged,
  getNarrativeTrail,
} from "./gauntlet-harness.js";

test("gauntlet/garbage: repeated identical lines blocked before approval", async () => {
  const fixture = makeFixtureRepo();
  try {
    const before = readFileSync(join(fixture.path, "src/util.ts"), "utf-8");
    const builder = new FixtureBuilderWorker([{
      path: "src/util.ts",
      content: before + "console.log('repeated');\n".repeat(30),
    }]);
    const { coordinator, events } = buildGauntletCoordinator(fixture.path, builder);
    const r = await coordinator.submit({
      input: "Add a helper function to src/util.ts",
      projectRoot: fixture.path,
    });
    assertGarbageBlocked(r, "repeated_identical_lines");
    assertSourceUnchanged(fixture.path, "src/util.ts", before);
    const trail = getNarrativeTrail(events);
    assert.ok(trail.includes("safety_block"),
      `expected safety_block in narrative, got: ${trail.join(",")}`);
  } finally {
    fixture.cleanup();
  }
});

test("gauntlet/garbage: duplicate exports blocked before approval", async () => {
  const fixture = makeFixtureRepo();
  try {
    const before = readFileSync(join(fixture.path, "src/util.ts"), "utf-8");
    const builder = new FixtureBuilderWorker([{
      path: "src/util.ts",
      content: before +
        "\nexport function helper(): void {}\n" +
        "export function helper(): void {}\n" +
        "export function helper(): void {}\n",
    }]);
    const { coordinator } = buildGauntletCoordinator(fixture.path, builder);
    const r = await coordinator.submit({
      input: "Add a helper function to src/util.ts",
      projectRoot: fixture.path,
    });
    assertGarbageBlocked(r, "duplicate_exports");
    assertSourceUnchanged(fixture.path, "src/util.ts", before);
  } finally {
    fixture.cleanup();
  }
});

test("gauntlet/garbage: placeholder-only implementation blocked", async () => {
  const fixture = makeFixtureRepo();
  try {
    const before = readFileSync(join(fixture.path, "src/util.ts"), "utf-8");
    const builder = new FixtureBuilderWorker([{
      path: "src/util.ts",
      content: before +
        "// TODO: implement\n" +
        "// FIXME: actually implement this\n" +
        "function notImplementedYet(): number {\n" +
        "  throw new Error('not implemented');\n" +
        "}\n",
    }]);
    const { coordinator } = buildGauntletCoordinator(fixture.path, builder);
    const r = await coordinator.submit({
      input: "implement the multiply() helper in src/util.ts",
      projectRoot: fixture.path,
    });
    assertGarbageBlocked(r, "placeholder_only");
    assertSourceUnchanged(fixture.path, "src/util.ts", before);
  } finally {
    fixture.cleanup();
  }
});

test("gauntlet/garbage: suspicious bulk addition for tiny task blocked", async () => {
  const fixture = makeFixtureRepo();
  try {
    const before = readFileSync(join(fixture.path, "src/util.ts"), "utf-8");
    // 100 lines of generated code for a 30-char prompt
    const bulk = Array.from({ length: 100 }, (_, i) =>
      `export const val${i} = ${i};`
    ).join("\n") + "\n";
    const builder = new FixtureBuilderWorker([{
      path: "src/util.ts",
      content: before + bulk,
    }]);
    const { coordinator } = buildGauntletCoordinator(fixture.path, builder);
    const r = await coordinator.submit({
      input: "add a constant to src/util.ts",
      projectRoot: fixture.path,
    });
    assertGarbageBlocked(r, "suspicious_bulk_addition");
    assertSourceUnchanged(fixture.path, "src/util.ts", before);
  } finally {
    fixture.cleanup();
  }
});

test("gauntlet/garbage: no-op diff (byte-for-byte identical) blocked", async () => {
  const fixture = makeFixtureRepo();
  try {
    const before = readFileSync(join(fixture.path, "src/util.ts"), "utf-8");
    // Builder "modifies" the file but produces identical content
    const builder = new FixtureBuilderWorker([{
      path: "src/util.ts",
      content: before, // identical
    }]);
    const { coordinator } = buildGauntletCoordinator(fixture.path, builder);
    const r = await coordinator.submit({
      input: "add a helper function to src/util.ts",
      projectRoot: fixture.path,
    });
    // Either garbage-detected as byte_for_byte_duplicate or noop_diff,
    // or the execution gate catches zero changes. Either way: not success.
    assert.notEqual(r.verdict, "success",
      "byte-for-byte identical output must not succeed");
    assertSourceUnchanged(fixture.path, "src/util.ts", before);
  } finally {
    fixture.cleanup();
  }
});
