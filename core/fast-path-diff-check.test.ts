import test from "node:test";
import assert from "node:assert/strict";

import { checkFastPathDiff, type FastDiffCheckChange } from "./fast-path-diff-check.js";

function makeChange(overrides: Partial<FastDiffCheckChange>): FastDiffCheckChange {
  return {
    path: "README.md",
    operation: "modify",
    content: "Hello\nworld\n",
    originalContent: "Hello\n",
    diff: null,
    ...overrides,
  };
}

// ─── Doc files ───────────────────────────────────────────────────────

test("README sentence add passes", () => {
  const r = checkFastPathDiff([makeChange({
    path: "README.md",
    originalContent: "# Project\n\nA short description.\n",
    content: "# Project\n\nA short description.\n\nAlso supports `--quiet`.\n",
  })]);
  assert.equal(r.ok, true);
  assert.equal(r.reasons.length, 0);
  assert.equal(r.perFile.length, 1);
  assert.equal(r.perFile[0]!.ok, true);
});

test("LICENSE typo fix passes", () => {
  const r = checkFastPathDiff([makeChange({
    path: "LICENSE",
    originalContent: "Copyright (c) 2025 Examplecorp\n",
    content: "Copyright (c) 2025 ExampleCorp\n",
  })]);
  assert.equal(r.ok, true);
});

// ─── Code files: comment-only ────────────────────────────────────────

test("single-line // comment add to TS file passes", () => {
  const r = checkFastPathDiff([makeChange({
    path: "src/widget.ts",
    originalContent: "export const widget = 1;\n",
    content: "// shared widget id\nexport const widget = 1;\n",
  })]);
  assert.equal(r.ok, true);
});

test("Python `#` comment add passes", () => {
  const r = checkFastPathDiff([makeChange({
    path: "scripts/build.py",
    originalContent: "import os\n",
    content: "# bootstrap script\nimport os\n",
  })]);
  assert.equal(r.ok, true);
});

// ─── Code files: NOT comment-only → reject ───────────────────────────

test("real code change to TS file FAILS fast-path check", () => {
  const r = checkFastPathDiff([makeChange({
    path: "src/widget.ts",
    originalContent: "export const widget = 1;\n",
    content: "export const widget = 1;\nexport function setWidget(n: number) { return n; }\n",
  })]);
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((m) => /not a blank line or single-line comment/.test(m)));
});

test("block comment /* */ on a TS file FAILS (only single-line comments accepted)", () => {
  const r = checkFastPathDiff([makeChange({
    path: "src/widget.ts",
    originalContent: "export const widget = 1;\n",
    content: "/* block comment */\nexport const widget = 1;\n",
  })]);
  assert.equal(r.ok, false);
});

// ─── Multi-file ──────────────────────────────────────────────────────

test("two files in fast_review FAILS (must be exactly 1)", () => {
  const r = checkFastPathDiff([
    makeChange({ path: "README.md" }),
    makeChange({ path: "CHANGELOG.md" }),
  ]);
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((m) => /touched 2 files/.test(m)));
});

// ─── Delete operations ───────────────────────────────────────────────

test("delete operation rejected even on a doc file", () => {
  const r = checkFastPathDiff([makeChange({
    path: "OLD.md",
    operation: "delete",
    content: null,
    originalContent: "old\n",
  })]);
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((m) => /delete operation not allowed/.test(m)));
});

// ─── Size and line-count caps ────────────────────────────────────────

test("oversized doc add (> default cap) rejected", () => {
  const big = "x ".repeat(5000); // > 4096 bytes
  const r = checkFastPathDiff([makeChange({
    path: "README.md",
    originalContent: "",
    content: big,
  })]);
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((m) => /bytes \(cap/.test(m)));
});

test("explicit smaller cap can override the default", () => {
  const r = checkFastPathDiff(
    [makeChange({
      path: "README.md",
      originalContent: "",
      content: "hello world\n",
    })],
    { maxNewBytes: 5 },
  );
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((m) => /bytes \(cap 5\)/.test(m)));
});

test("changed-line cap rejects oversized doc edits", () => {
  const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
  const r = checkFastPathDiff(
    [makeChange({
      path: "README.md",
      originalContent: "",
      content: lines,
    })],
    { maxChangedLines: 10, maxNewBytes: 1_000_000 },
  );
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((m) => /changed lines \(cap 10\)/.test(m)));
});

// ─── Secret detection ────────────────────────────────────────────────

test("AWS access key in added line rejected", () => {
  const r = checkFastPathDiff([makeChange({
    path: "README.md",
    originalContent: "## Setup\n",
    content: "## Setup\n\nAKIAIOSFODNN7EXAMPLE\n",
  })]);
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((m) => /secret-shaped token/.test(m)));
});

test("OpenAI sk- prefix in added line rejected", () => {
  const r = checkFastPathDiff([makeChange({
    path: "src/widget.ts",
    originalContent: "export const widget = 1;\n",
    content: `// ${"sk-" + "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}\nexport const widget = 1;\n`,
  })]);
  // It's inside a comment but it's still a secret-shaped token.
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((m) => /secret-shaped token/.test(m)));
});

test("GitHub token ghp_ in added line rejected", () => {
  const r = checkFastPathDiff([makeChange({
    path: "README.md",
    originalContent: "## Setup\n",
    content: "## Setup\n\nghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
  })]);
  assert.equal(r.ok, false);
});

test("PEM private key block rejected", () => {
  const r = checkFastPathDiff([makeChange({
    path: "README.md",
    originalContent: "",
    content: "-----BEGIN RSA PRIVATE KEY-----\nABC\n-----END RSA PRIVATE KEY-----\n",
  })]);
  assert.equal(r.ok, false);
});

// ─── Unknown extension ───────────────────────────────────────────────

test("unknown extension fails fast-path", () => {
  const r = checkFastPathDiff([makeChange({
    path: "config.weird",
    originalContent: "x\n",
    content: "x\ny\n",
  })]);
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((m) => /not a fast-path doc or recognised code type/.test(m)));
});

// ─── No diff data path ───────────────────────────────────────────────

test("change with no diff data is rejected", () => {
  const r = checkFastPathDiff([{
    path: "README.md",
    operation: "modify",
    content: null,
    originalContent: null,
    diff: null,
  }]);
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((m) => /no diff data available/.test(m)));
});

// ─── Empty change-set ────────────────────────────────────────────────

test("empty change-set is rejected (fast_review must produce a diff)", () => {
  const r = checkFastPathDiff([]);
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((m) => /no file changes/.test(m)));
});

// ─── Per-file detail in result ───────────────────────────────────────

test("perFile detail is populated for receipts", () => {
  const r = checkFastPathDiff([makeChange({
    path: "README.md",
    originalContent: "a\n",
    content: "a\nb\nc\n",
  })]);
  assert.equal(r.perFile.length, 1);
  const entry = r.perFile[0]!;
  assert.equal(entry.path, "README.md");
  assert.equal(entry.ok, true);
  assert.equal(entry.addedLines, 2);
  assert.equal(entry.removedLines, 0);
  assert.ok(entry.bytes > 0);
});

// ─── Unified-diff fallback path ──────────────────────────────────────

test("counts work from a unified diff when content is unavailable", () => {
  const r = checkFastPathDiff([{
    path: "README.md",
    operation: "modify",
    content: null,
    originalContent: null,
    diff: "--- a/README.md\n+++ b/README.md\n@@\n-old line\n+new line one\n+new line two\n",
  }]);
  assert.equal(r.ok, true);
  assert.equal(r.perFile[0]!.addedLines, 2);
  assert.equal(r.perFile[0]!.removedLines, 1);
});
