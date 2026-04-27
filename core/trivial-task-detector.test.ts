import test from "node:test";
import assert from "node:assert/strict";

import { isTrivialTask } from "./trivial-task-detector.js";

// ─── Trivial tasks: should qualify for fast path ────────────────────

test("trivial-task-detector: single-file comment edit is trivial", () => {
  const result = isTrivialTask({
    targets: ["src/index.ts"],
    prompt: "add a comment explaining the retry logic",
    scopeEstimate: "trivial",
    riskSignals: [],
  });
  assert.equal(result.isTrivial, true);
  assert.match(result.reason, /single-file trivial/);
});

test("trivial-task-detector: whitespace cleanup is trivial", () => {
  const result = isTrivialTask({
    targets: ["src/handler.ts"],
    prompt: "fix trailing whitespace in handler",
    scopeEstimate: "small",
    riskSignals: [],
  });
  assert.equal(result.isTrivial, true);
});

test("trivial-task-detector: typo fix is trivial", () => {
  const result = isTrivialTask({
    targets: ["src/utils.ts"],
    prompt: "fix typo in function name",
    scopeEstimate: "trivial",
    riskSignals: [],
  });
  assert.equal(result.isTrivial, true);
});

test("trivial-task-detector: jsdoc update is trivial", () => {
  const result = isTrivialTask({
    targets: ["src/api.ts"],
    prompt: "update the jsdoc for the fetch function",
    scopeEstimate: "small",
    riskSignals: [],
  });
  assert.equal(result.isTrivial, true);
});

test("trivial-task-detector: formatting fix is trivial", () => {
  const result = isTrivialTask({
    targets: ["src/config.ts"],
    prompt: "run prettier formatting on config",
    scopeEstimate: "trivial",
    riskSignals: [],
  });
  assert.equal(result.isTrivial, true);
});

// ─── Non-trivial tasks: should NOT qualify ──────────────────────────

test("trivial-task-detector: multi-file task is not trivial", () => {
  const result = isTrivialTask({
    targets: ["src/a.ts", "src/b.ts"],
    prompt: "add a comment to both files",
    scopeEstimate: "small",
    riskSignals: [],
  });
  assert.equal(result.isTrivial, false);
  assert.match(result.reason, /2 target file/);
});

test("trivial-task-detector: zero-file task is not trivial", () => {
  const result = isTrivialTask({
    targets: [],
    prompt: "add a comment",
    scopeEstimate: "small",
    riskSignals: [],
  });
  assert.equal(result.isTrivial, false);
  assert.match(result.reason, /0 target file/);
});

test("trivial-task-detector: feature implementation is not trivial", () => {
  const result = isTrivialTask({
    targets: ["src/handler.ts"],
    prompt: "add retry logic with exponential backoff",
    scopeEstimate: "small",
    riskSignals: [],
  });
  assert.equal(result.isTrivial, false);
  assert.match(result.reason, /trivial edit patterns/);
});

test("trivial-task-detector: risk signals disqualify", () => {
  const result = isTrivialTask({
    targets: ["src/auth.ts"],
    prompt: "add a comment explaining the auth flow",
    scopeEstimate: "trivial",
    riskSignals: ["security-sensitive"],
  });
  assert.equal(result.isTrivial, false);
  assert.match(result.reason, /risk signals/);
});

test("trivial-task-detector: medium scope disqualifies", () => {
  const result = isTrivialTask({
    targets: ["src/index.ts"],
    prompt: "update comment about retry",
    scopeEstimate: "medium",
    riskSignals: [],
  });
  assert.equal(result.isTrivial, false);
  assert.match(result.reason, /scope too large/);
});

test("trivial-task-detector: test requirement disqualifies", () => {
  const result = isTrivialTask({
    targets: ["src/utils.ts"],
    prompt: "add a comment and write a unit test",
    scopeEstimate: "trivial",
    riskSignals: [],
  });
  assert.equal(result.isTrivial, false);
  assert.match(result.reason, /test requirement/);
});

test("trivial-task-detector: large scope disqualifies", () => {
  const result = isTrivialTask({
    targets: ["src/a.ts"],
    prompt: "fix comment typo",
    scopeEstimate: "large",
    riskSignals: [],
  });
  assert.equal(result.isTrivial, false);
  assert.match(result.reason, /scope too large/);
});

// ─── burn-in-01 prompt is classified as trivial ─────────────────────

test("trivial-task-detector: burn-in-01 comment-swap prompt is classified fastPath=true", () => {
  const prompt =
    "In core/run-summary.ts, find the existing top-of-file comment block. " +
    "At the very end of that block, add a single new comment line that reads exactly: " +
    "'// burn-in: comment-swap probe test-tag.' Do not modify anything else.";
  const result = isTrivialTask({
    targets: ["core/run-summary.ts"],
    prompt,
    scopeEstimate: "small",
    riskSignals: [],
  });
  assert.equal(result.isTrivial, true, `expected trivial, got: ${result.reason}`);
});

// ─── Scope lock enforcement: fast path does NOT bypass scope lock ───

test("trivial-task-detector: scope lock is orthogonal — trivial detection does not override it", () => {
  // Scope lock is enforced by charter + integration judge, not by the
  // trivial detector. A trivial task with scope lock still gets
  // heuristic critic checks that catch scope drift.
  const result = isTrivialTask({
    targets: ["src/index.ts"],
    prompt: "add a comment to index.ts, do not modify anything else",
    scopeEstimate: "trivial",
    riskSignals: [],
  });
  assert.equal(result.isTrivial, true, "scope lock is orthogonal to trivial detection");
});
