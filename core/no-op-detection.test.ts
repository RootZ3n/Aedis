import test from "node:test";
import assert from "node:assert/strict";

import { detectNoOpUpdate } from "./no-op-detection.js";

test("detectNoOpUpdate: byte-identical updates trip with byte-identical reason", () => {
  const before = "export const x = 1;\n";
  const after = "export const x = 1;\n";
  const r = detectNoOpUpdate(before, after);
  assert.equal(r.noOp, true);
  assert.match(r.reason, /byte-identical/);
});

test("detectNoOpUpdate: trailing-whitespace-only churn trips (whitespace-normalized identical)", () => {
  const before = "export const x = 1;\n";
  const after = "export const x = 1;   \n";
  const r = detectNoOpUpdate(before, after);
  assert.equal(r.noOp, true);
  assert.match(r.reason, /whitespace-normalized identical/);
});

test("detectNoOpUpdate: CRLF vs LF line ending churn trips", () => {
  // The d3524769 trailing-comment scenario could land here when a
  // model uses CRLF in its output but the source repo uses LF: the
  // diff is non-empty but the post-apply content is identical after
  // normalization.
  const before = "line a\nline b\nline c\n";
  const after = "line a\r\nline b\r\nline c\r\n";
  const r = detectNoOpUpdate(before, after);
  assert.equal(r.noOp, true);
});

test("detectNoOpUpdate: blank-line collapsing churn trips", () => {
  const before = "import x from 'x';\n\n\nexport const y = 1;\n";
  const after = "import x from 'x';\n\nexport const y = 1;\n";
  const r = detectNoOpUpdate(before, after);
  assert.equal(r.noOp, true);
});

test("detectNoOpUpdate: real one-character source change does NOT trip", () => {
  const before = "export const x = 1;\n";
  const after = "export const x = 2;\n";
  const r = detectNoOpUpdate(before, after);
  assert.equal(r.noOp, false);
});

test("detectNoOpUpdate: real prepended JSDoc line does NOT trip", () => {
  // The "Add a JSDoc above the function" pattern that a healthy
  // Builder run produces — must not be falsely flagged as no-op.
  const before = "export function foo() { return 1; }\n";
  const after = "/** foo: returns one */\nexport function foo() { return 1; }\n";
  const r = detectNoOpUpdate(before, after);
  assert.equal(r.noOp, false);
});

test("detectNoOpUpdate: empty file → empty file is a no-op", () => {
  const r = detectNoOpUpdate("", "");
  assert.equal(r.noOp, true);
});

test("detectNoOpUpdate: empty file → real content is NOT a no-op", () => {
  const r = detectNoOpUpdate("", "export const x = 1;\n");
  assert.equal(r.noOp, false);
});

test("detectNoOpUpdate: reason is non-empty for both no-op and real cases", () => {
  // The reason field must always be human-readable so receipt error
  // messages and log lines stay informative regardless of branch.
  const noop = detectNoOpUpdate("a\n", "a\n");
  assert.ok(noop.reason.length > 0);
  const real = detectNoOpUpdate("a\n", "b\n");
  assert.ok(real.reason.length > 0);
});
