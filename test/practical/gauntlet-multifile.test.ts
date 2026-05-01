/**
 * Gauntlet Category 3: Multi-file tasks
 *
 * - Add helper function plus test
 * - Update README plus source export
 * - Add small feature touching 2-3 files
 *
 * All must route to standard_review or strict_review (never fast_review),
 * all changed files must be visible, and approval is required.
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

test("gauntlet/multifile: helper + test reaches approval, not fast_review", async () => {
  const fixture = makeFixtureRepo();
  try {
    const utilBefore = readFileSync(join(fixture.path, "src/util.ts"), "utf-8");
    const testBefore = readFileSync(join(fixture.path, "src/util.test.ts"), "utf-8");
    const builder = new FixtureBuilderWorker([
      {
        path: "src/util.ts",
        content: utilBefore + "\nexport function negate(n: number): number {\n  return -n;\n}\n",
      },
      {
        path: "src/util.test.ts",
        content: testBefore +
          "\nimport test from 'node:test';\n" +
          "import assert from 'node:assert/strict';\n" +
          "import { negate } from './util.js';\n" +
          "test('negate returns negative', () => {\n" +
          "  assert.equal(negate(5), -5);\n" +
          "});\n",
      },
    ]);
    const { coordinator, events } = buildGauntletCoordinator(fixture.path, builder);
    const r = await coordinator.submit({
      input: "Add a negate(n) function to src/util.ts and a test for it in src/util.test.ts",
      projectRoot: fixture.path,
    });
    assertReadinessContract(r, events, { expectDiff: true });
    assertNoGarbage(r);
    assert.notEqual(r.executionMode, "fast_review",
      "multi-file tasks must not use fast_review");
    assertSourceUnchanged(fixture.path, "src/util.ts", utilBefore);
    assertSourceUnchanged(fixture.path, "src/util.test.ts", testBefore);
  } finally {
    fixture.cleanup();
  }
});

test("gauntlet/multifile: README + source export reaches approval", async () => {
  const fixture = makeFixtureRepo();
  try {
    const readmeBefore = readFileSync(join(fixture.path, "README.md"), "utf-8");
    const indexBefore = readFileSync(join(fixture.path, "src/index.ts"), "utf-8");
    const builder = new FixtureBuilderWorker([
      {
        path: "README.md",
        content: readmeBefore + "\n## API\n\n- `square(n)` — returns n squared.\n",
      },
      {
        path: "src/index.ts",
        content: indexBefore + "export function square(n: number): number { return n * n; }\n",
      },
    ]);
    const { coordinator, events } = buildGauntletCoordinator(fixture.path, builder);
    const r = await coordinator.submit({
      input: "Add a square(n) function to src/index.ts and document it in README.md",
      projectRoot: fixture.path,
    });
    assertReadinessContract(r, events, { expectDiff: true });
    assertNoGarbage(r);
    assert.notEqual(r.executionMode, "fast_review");
    assertSourceUnchanged(fixture.path, "README.md", readmeBefore);
    assertSourceUnchanged(fixture.path, "src/index.ts", indexBefore);
  } finally {
    fixture.cleanup();
  }
});

test("gauntlet/multifile: 3-file feature touches all files", async () => {
  const fixture = makeFixtureRepo();
  try {
    const utilBefore = readFileSync(join(fixture.path, "src/util.ts"), "utf-8");
    const indexBefore = readFileSync(join(fixture.path, "src/index.ts"), "utf-8");
    const readmeBefore = readFileSync(join(fixture.path, "README.md"), "utf-8");
    const builder = new FixtureBuilderWorker([
      {
        path: "src/util.ts",
        content: utilBefore + "\nexport function isEven(n: number): boolean {\n  return n % 2 === 0;\n}\n",
      },
      {
        path: "src/index.ts",
        content: indexBefore.replace(
          "export { VERSION, add } from './util.js';",
          "export { VERSION, add, isEven } from './util.js';",
        ),
      },
      {
        path: "README.md",
        content: readmeBefore + "\n## Utilities\n\n- `isEven(n)` — returns whether n is even.\n",
      },
    ]);
    const { coordinator, events } = buildGauntletCoordinator(fixture.path, builder);
    const r = await coordinator.submit({
      input: "Add isEven(n) to src/util.ts, re-export from src/index.ts, document in README.md",
      projectRoot: fixture.path,
    });
    assertReadinessContract(r, events, { expectDiff: true });
    assertNoGarbage(r);
    assert.notEqual(r.executionMode, "fast_review");
    assertSourceUnchanged(fixture.path, "src/util.ts", utilBefore);
    assertSourceUnchanged(fixture.path, "src/index.ts", indexBefore);
    assertSourceUnchanged(fixture.path, "README.md", readmeBefore);
  } finally {
    fixture.cleanup();
  }
});
