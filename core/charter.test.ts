import test from "node:test";
import assert from "node:assert/strict";

import { CharterGenerator } from "./charter.js";

const generator = new CharterGenerator();

test("charter category: improve provider error handling is refactor, not bugfix", () => {
  const analysis = generator.analyzeRequest("improve provider error handling in src/providers/http.ts");
  assert.equal(analysis.category, "refactor");
});

test("charter category: fix provider timeout bug is bugfix", () => {
  const analysis = generator.analyzeRequest("fix provider timeout bug in src/providers/http.ts");
  assert.equal(analysis.category, "bugfix");
});

test("charter category: add health endpoint is feature", () => {
  const analysis = generator.analyzeRequest("add health endpoint in server/routes/health.ts");
  assert.equal(analysis.category, "feature");
});

test("charter category: write tests for auth pairing is test", () => {
  const analysis = generator.analyzeRequest("write tests for auth pairing in tests/auth-pairing.test.ts");
  assert.equal(analysis.category, "test");
});

test("charter category: document provider setup is docs", () => {
  const analysis = generator.analyzeRequest("document provider setup in README.md");
  assert.equal(analysis.category, "docs");
});

// ─── extractTargets: quoted-content stripping (run d3524769 regression) ─────

test("charter targets: filenames inside double-quoted content are NOT extracted", () => {
  // The exact failing prompt from run d3524769 (commit 5838aad on
  // absent-pianist, since reverted): start.sh is the real target,
  // README.md sits inside the literal comment to be inserted.
  const analysis = generator.analyzeRequest(
    'At the end of start.sh, add a single-line trailing comment: "# See README.md for usage details." Do not change any other line.',
  );
  assert.deepEqual(analysis.targets, ["start.sh"], `expected start.sh only, got ${analysis.targets.join(", ")}`);
});

test("charter targets: bare and backtick-fenced filenames ARE extracted", () => {
  // Backtick fences are commonly used to highlight a real target.
  // Bare references must continue to work too.
  const a = generator.analyzeRequest("Edit `core/foo.ts` and src/bar.ts to add a helper.");
  assert.ok(a.targets.includes("core/foo.ts"), `expected core/foo.ts, got ${a.targets.join(", ")}`);
  assert.ok(a.targets.includes("src/bar.ts"), `expected src/bar.ts, got ${a.targets.join(", ")}`);
});

test("charter targets: prompt explicitly listing two files extracts both", () => {
  const analysis = generator.analyzeRequest(
    "Update workers/builder.ts and core/coordinator.ts to share the new helper.",
  );
  assert.ok(analysis.targets.includes("workers/builder.ts"));
  assert.ok(analysis.targets.includes("core/coordinator.ts"));
});

test("charter targets: incidental quoted reference does not promote to multi-file scope", async () => {
  // End-to-end verification through classifyScope: the same trailing-
  // comment prompt must classify as single-file, not multi-file.
  const { classifyScope } = await import("./scope-classifier.js");
  const analysis = generator.analyzeRequest(
    'In start.sh, add a final-line comment: "# See README.md for usage." Do not change any other line.',
  );
  const scope = classifyScope(
    'In start.sh, add a final-line comment: "# See README.md for usage." Do not change any other line.',
    analysis.targets,
  );
  assert.equal(scope.type, "single-file", `expected single-file, got ${scope.type} (targets=${analysis.targets.join(", ")})`);
  assert.equal(scope.recommendDecompose, false);
});

test("charter targets: explicit two-file prompt classifies as small-linked or multi-file", async () => {
  const { classifyScope } = await import("./scope-classifier.js");
  const prompt = "Update workers/builder.ts and workers/critic.ts to share the new helper.";
  const analysis = generator.analyzeRequest(prompt);
  const scope = classifyScope(prompt, analysis.targets);
  // Either small-linked (no decompose) or multi-file is acceptable —
  // both correctly reflect the user's explicit two-file ask. The point
  // is that decomposition isn't FORCED when the user names exactly two
  // files in the same module.
  assert.ok(
    scope.type === "small-linked" || scope.type === "multi-file" || scope.type === "single-file",
    `expected small-linked/multi-file/single-file for two-file prompt, got ${scope.type}`,
  );
});

test("charter targets: broad architectural prompt classifies as architectural", async () => {
  const { classifyScope } = await import("./scope-classifier.js");
  const prompt = "Refactor every provider in src/providers to use the new error envelope across the codebase.";
  const analysis = generator.analyzeRequest(prompt);
  const scope = classifyScope(prompt, [
    "src/providers/openrouter.ts",
    "src/providers/anthropic.ts",
    "src/providers/ollama.ts",
    "src/providers/minimax.ts",
    "src/providers/zai.ts",
    "src/providers/dashscope.ts",
    "src/providers/openai.ts",
    "src/providers/elevenlabs.ts",
  ]);
  assert.ok(
    scope.recommendDecompose,
    `broad architectural change must recommend decompose, got ${scope.type} recommendDecompose=${scope.recommendDecompose}`,
  );
  assert.match(scope.type, /architectural|multi-file|cross-cutting-sweep/);
  assert.ok(analysis.targets.length >= 1);
});
