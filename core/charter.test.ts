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
