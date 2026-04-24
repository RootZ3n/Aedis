import test from "node:test";
import assert from "node:assert/strict";

import { isTestInjectionFile } from "./git-diff-verifier.js";

// ─── isTestInjectionFile ────────────────────────────────────────────

const TEST_INJECTION_MATCHES: readonly string[] = [
  "test/utils.test.ts",
  "tests/utils.test.ts",
  "__tests__/utils.test.ts",
  "src/test/utils.ts",
  "src/tests/utils.ts",
  "src/__tests__/utils.ts",
  "packages/api/test/routes.test.ts",
  "src/utils.test.ts",
  "src/utils.spec.ts",
  "src/utils.test.tsx",
  "src/utils.spec.tsx",
  "src/utils.test.js",
  "src/utils.test.jsx",
  "src/utils.test.mjs",
  "src/utils.test.cjs",
  "src/utils.spec.mjs",
  "./test/utils.test.ts",
];

for (const path of TEST_INJECTION_MATCHES) {
  test(`isTestInjectionFile: "${path}" is treated as a test file`, () => {
    assert.equal(isTestInjectionFile(path), true);
  });
}

const NON_TEST_FILES: readonly string[] = [
  "src/utils.ts",
  "src/utils.tsx",
  "core/coordinator.ts",
  "README.md",
  "package.json",
  "src/test-helpers.ts", // "test" in filename but not a test file
  "src/testing.ts",
  "src/contest.ts", // contains "test" substring
  "src/my-tests.ts",
  "docs/test-plan.md",
];

for (const path of NON_TEST_FILES) {
  test(`isTestInjectionFile: "${path}" is NOT treated as a test file`, () => {
    assert.equal(isTestInjectionFile(path), false);
  });
}

test("isTestInjectionFile: Windows-style backslash paths are normalized", () => {
  assert.equal(isTestInjectionFile("src\\utils.test.ts"), true);
  assert.equal(isTestInjectionFile("test\\utils.ts"), true);
});

test("isTestInjectionFile: stress-suite regression case (test/utils.test.ts)", () => {
  // This is the exact path from the observed merge_blocked events:
  // "1 file(s) changed but not declared in manifest: test/utils.test.ts"
  assert.equal(isTestInjectionFile("test/utils.test.ts"), true);
});
