import test from "node:test";
import assert from "node:assert/strict";

import {
  checkGarbageOutput,
  summarizeGarbageResult,
  type GarbageCheckChange,
} from "./garbage-output-detector.js";

function makeChange(over: Partial<GarbageCheckChange>): GarbageCheckChange {
  return {
    path: "src/foo.ts",
    operation: "modify",
    content: "export const foo = 1;\n",
    originalContent: "",
    diff: null,
    ...over,
  };
}

// ─── Healthy diffs ───────────────────────────────────────────────────

test("simple README sentence add passes the garbage detector", () => {
  const r = checkGarbageOutput([makeChange({
    path: "README.md",
    originalContent: "# Project\n",
    content: "# Project\n\nNew sentence.\n",
  })], "Add a sentence to the README about the new --quiet flag");
  assert.equal(r.ok, true);
  assert.equal(r.findings.length, 0);
});

test("small helper function add passes the garbage detector", () => {
  const r = checkGarbageOutput([makeChange({
    path: "src/util.ts",
    originalContent: "export const x = 1;\n",
    content:
      "export const x = 1;\n" +
      "export function double(n: number): number {\n" +
      "  return n * 2;\n" +
      "}\n",
  })], "Add a one-line exported function `double` to src/util.ts that returns n*2");
  assert.equal(r.ok, true);
});

// ─── Repeated identical lines ────────────────────────────────────────

test("repeated identical added lines is flagged", () => {
  const r = checkGarbageOutput([makeChange({
    path: "src/foo.ts",
    originalContent: "",
    content: "console.log('x');\n".repeat(20),
  })], "fix bug");
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => f.kind === "repeated_identical_lines"));
});

test("whitespace-only repeats are not counted as garbage", () => {
  const r = checkGarbageOutput([makeChange({
    path: "src/foo.ts",
    originalContent: "a\n",
    content: "a\n\n\n\n\n\nb\n",
  })], "fix bug");
  // Whitespace lines are excluded from repeat detection.
  assert.ok(!r.findings.some((f) => f.kind === "repeated_identical_lines"));
});

// ─── Duplicate exports ───────────────────────────────────────────────

test("duplicate export declarations are flagged", () => {
  const r = checkGarbageOutput([makeChange({
    path: "src/foo.ts",
    originalContent: "",
    content:
      "export function foo() { return 1; }\n" +
      "export function foo() { return 2; }\n" +
      "export function bar() { return 3; }\n",
  })], "add helpers");
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => f.kind === "duplicate_exports"));
});

// ─── Suspicious bulk addition ────────────────────────────────────────

test("tiny prompt + huge added diff is flagged", () => {
  const huge = Array.from({ length: 200 }, (_, i) => `const x${i} = ${i};`).join("\n");
  const r = checkGarbageOutput([makeChange({
    path: "src/foo.ts",
    originalContent: "",
    content: huge,
  })], "fix typo");
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => f.kind === "suspicious_bulk_addition"));
});

test("longer prompt + large diff is NOT flagged as bulk addition", () => {
  const big = Array.from({ length: 200 }, (_, i) => `const x${i} = ${i};`).join("\n");
  const longPrompt =
    "Add a complete CRUD layer in src/foo.ts including TypeScript interfaces, " +
    "an in-memory store, a constructor, list/get/create/update/delete operations, " +
    "and a final default export wiring everything together.";
  const r = checkGarbageOutput([makeChange({
    path: "src/foo.ts",
    originalContent: "",
    content: big,
  })], longPrompt);
  assert.ok(!r.findings.some((f) => f.kind === "suspicious_bulk_addition"));
});

// ─── Placeholder-only ────────────────────────────────────────────────

test("placeholder-only output is flagged when implementation was requested", () => {
  const r = checkGarbageOutput([makeChange({
    path: "src/foo.ts",
    originalContent: "",
    content:
      "// TODO: implement\n" +
      "// FIXME: implement this\n" +
      "function notImplementedYet() {\n" +
      "  throw new Error('not implemented');\n" +
      "}\n",
  })], "implement the user serializer");
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => f.kind === "placeholder_only"));
});

test("a single TODO comment in real code is NOT flagged", () => {
  const r = checkGarbageOutput([makeChange({
    path: "src/foo.ts",
    originalContent: "export const x = 1;\n",
    content:
      "export const x = 1;\n" +
      "// TODO: handle the edge case where input is empty\n" +
      "export function double(n: number): number {\n" +
      "  return n * 2;\n" +
      "}\n",
  })], "implement double()");
  assert.ok(!r.findings.some((f) => f.kind === "placeholder_only"));
});

// ─── Byte-for-byte duplicate / no-op ─────────────────────────────────

test("byte-for-byte duplicate modify is flagged", () => {
  const r = checkGarbageOutput([makeChange({
    path: "src/foo.ts",
    operation: "modify",
    originalContent: "export const x = 1;\n",
    content: "export const x = 1;\n",
  })], "fix bug in foo");
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => f.kind === "byte_for_byte_duplicate"));
});

test("zero-line diff is flagged as no-op", () => {
  const r = checkGarbageOutput([makeChange({
    path: "src/foo.ts",
    originalContent: "x\n",
    content: "x\n",
  })], "do something");
  assert.equal(r.ok, false);
  // Either byte-for-byte duplicate or noop_diff fires; both are
  // legitimate signals here. The contract is "ok=false."
  assert.ok(
    r.findings.some((f) => f.kind === "byte_for_byte_duplicate" || f.kind === "noop_diff"),
  );
});

// ─── Summary helper ──────────────────────────────────────────────────

test("summarizeGarbageResult returns empty string for clean diffs", () => {
  const r = checkGarbageOutput([makeChange({
    path: "README.md",
    originalContent: "a\n",
    content: "a\nb\n",
  })], "add line");
  assert.equal(summarizeGarbageResult(r), "");
});

test("summarizeGarbageResult lists distinct finding kinds", () => {
  const r = checkGarbageOutput([makeChange({
    path: "src/foo.ts",
    originalContent: "",
    content: "export function foo() {}\nexport function foo() {}\n".repeat(10),
  })], "implement foo");
  const summary = summarizeGarbageResult(r);
  assert.ok(summary.length > 0);
  assert.match(summary, /Garbage output detected/);
});

// ─── Per-file detail ─────────────────────────────────────────────────

test("perFile carries per-file findings + line counts", () => {
  const r = checkGarbageOutput([makeChange({
    path: "src/foo.ts",
    originalContent: "x\n",
    content: "x\nconsole.log('x');\nconsole.log('x');\nconsole.log('x');\nconsole.log('x');\nconsole.log('x');\n",
  })], "fix bug");
  assert.equal(r.perFile.length, 1);
  assert.equal(r.perFile[0]!.path, "src/foo.ts");
  assert.equal(r.perFile[0]!.ok, false);
  assert.ok(r.perFile[0]!.addedLines >= 5);
});

// ─── Configurable thresholds ─────────────────────────────────────────

test("threshold tuning lets a stricter caller catch fewer-repeat output", () => {
  const change = makeChange({
    originalContent: "",
    content: "x\nx\n",
  });
  const lax = checkGarbageOutput([change], "fix", { maxRepeatedLines: 5 });
  assert.equal(lax.ok, true);
  const strict = checkGarbageOutput([change], "fix", { maxRepeatedLines: 1 });
  assert.equal(strict.ok, false);
});

// ─── Receipt persistence shape ───────────────────────────────────────

test("GarbageCheckResult is JSON-serializable for receipt persistence", () => {
  const r = checkGarbageOutput([makeChange({
    path: "src/foo.ts",
    originalContent: "",
    content: "console.log('x');\n".repeat(20),
  })], "fix bug");
  // Must survive JSON round-trip without data loss.
  const json = JSON.stringify(r);
  const restored = JSON.parse(json) as typeof r;
  assert.equal(restored.ok, false);
  assert.equal(restored.findings.length, r.findings.length);
  assert.equal(restored.findings[0]?.kind, "repeated_identical_lines");
  assert.equal(restored.findings[0]?.path, "src/foo.ts");
  assert.ok(restored.findings[0]?.reason.length > 0, "reason must be non-empty");
  assert.equal(restored.perFile.length, 1);
  assert.equal(restored.perFile[0]?.path, "src/foo.ts");
  assert.ok(restored.perFile[0]?.addedLines > 0);
});

test("finding kind, path, severity, and explanation are all present", () => {
  const r = checkGarbageOutput([makeChange({
    path: "src/a.ts",
    originalContent: "",
    content:
      "// TODO: implement\n" +
      "// FIXME: implement this\n" +
      "function notImplementedYet() {\n" +
      "  throw new Error('not implemented');\n" +
      "}\n",
  })], "implement serializer");
  assert.equal(r.ok, false);
  const finding = r.findings.find((f) => f.kind === "placeholder_only");
  assert.ok(finding, "placeholder_only finding must exist");
  assert.equal(finding!.path, "src/a.ts");
  assert.ok(finding!.reason.includes("placeholder") || finding!.reason.includes("TODO"),
    "reason must explain the placeholder issue");
});
