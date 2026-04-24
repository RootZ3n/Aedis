import test from "node:test";
import assert from "node:assert/strict";

import { isBugfixLikePrompt } from "./scope-classifier.js";
import { classifyResult } from "./reliability-harness.js";
import { normalizeReceipt } from "./reliability-runner.js";
import type { ReliabilityTask } from "./reliability-harness.js";

// ─── isBugfixLikePrompt ─────────────────────────────────────────────

const BUGFIX_PROMPTS: readonly string[] = [
  "fix the off-by-one in fibonacci",
  "fix the bug in src/utils.ts",
  "capitalize is broken on empty strings",
  "validateEmail returns the wrong result when no @",
  "divide throws when b is zero — please fix",
  "Stack.pop is failing for empty stacks",
  "this is a regression, please fix",
  "handle the exception thrown by parse()",
  "incorrect result for fibonacci(3)",
  "crash when stack is empty",
  "the test fails because the code path is wrong",
];

for (const prompt of BUGFIX_PROMPTS) {
  test(`isBugfixLikePrompt: "${prompt}" → true`, () => {
    assert.equal(isBugfixLikePrompt(prompt), true);
  });
}

const NON_BUGFIX_PROMPTS: readonly string[] = [
  "add a multiply function to src/utils.ts",
  "implement string reverse",
  "refactor utils into smaller modules",
  "extract the email validator into its own file",
  "add tests for the Stack class",
  "rename User to Person everywhere",
  "migrate from v1 to v2",
  "update the README",
  "create a new hook for authentication",
  "improve readability of the parser",
];

for (const prompt of NON_BUGFIX_PROMPTS) {
  test(`isBugfixLikePrompt: "${prompt}" → false (feature/refactor preserved)`, () => {
    assert.equal(isBugfixLikePrompt(prompt), false);
  });
}

test("isBugfixLikePrompt: whole-word matching — 'prefix' does not match 'fix'", () => {
  assert.equal(isBugfixLikePrompt("expose a prefix option"), false);
  assert.equal(isBugfixLikePrompt("add a prefix parameter"), false);
});

test("isBugfixLikePrompt: null/empty/non-string inputs return false", () => {
  assert.equal(isBugfixLikePrompt(""), false);
  assert.equal(isBugfixLikePrompt(null), false);
  assert.equal(isBugfixLikePrompt(undefined), false);
});

test("isBugfixLikePrompt: case insensitive", () => {
  assert.equal(isBugfixLikePrompt("FIX the broken utility"), true);
  assert.equal(isBugfixLikePrompt("Regression in parser"), true);
});

// ─── End-to-end: bugfix-target-not-modified → empty_diff ────────────

function task(overrides: Partial<ReliabilityTask> = {}): ReliabilityTask {
  return {
    id: "t",
    taskType: "bugfix",
    repoPath: "/tmp/fake",
    difficulty: "easy",
    prompt: "fix the bug in src/utils.ts",
    ...overrides,
  };
}

test("coordinator finding → harness: failureCode 'bugfix-target-not-modified' classifies as empty_diff", () => {
  // Simulate the RunReceipt the coordinator produces when
  // bugfixTargetFindings fires: merge decision blocked with
  // primaryBlockReason containing 'bugfix_target_not_modified', which
  // failure-explainer matches → humanSummary.failureExplanation.code
  // becomes 'bugfix-target-not-modified', which the harness maps to
  // empty_diff.
  const raw = {
    verdict: "failed",
    executionVerified: true,
    executionEvidence: [
      { kind: "file_modified", ref: "test/utils.test.ts" },
    ],
    totalCost: { usd: 0 },
    verificationReceipt: null,
    humanSummary: {
      failureExplanation: {
        code: "bugfix-target-not-modified",
      },
    },
    executionGateReason: "Execution verified: 1 file(s) modified",
  };
  const receipt = normalizeReceipt(raw);
  assert.ok(receipt);
  const r = classifyResult({
    task: task({ expectedFiles: ["src/utils.ts"] }),
    trialId: "T",
    receipt,
    error: null,
    startedAt: "x",
    finishedAt: "x",
  });
  assert.equal(r.outcome, "failure");
  assert.equal(r.errorType, "empty_diff");
  assert.ok(r.notes.some((n) => /bugfix-target-not-modified/.test(n)));
});
