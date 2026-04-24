import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findImplForTest } from "./import-graph.js";

// ─── findImplForTest ────────────────────────────────────────────────

test("findImplForTest: same-directory suffix strip — foo.test.ts → foo.ts", () => {
  const dir = mkdtempSync(join(tmpdir(), "aedis-impl-"));
  try {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src/foo.ts"), "export const x = 1;");
    writeFileSync(join(dir, "src/foo.test.ts"), "test('x', () => {});");

    assert.equal(findImplForTest("src/foo.test.ts", dir), "src/foo.ts");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findImplForTest: same-directory .spec suffix — foo.spec.ts → foo.ts", () => {
  const dir = mkdtempSync(join(tmpdir(), "aedis-impl-"));
  try {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src/foo.ts"), "export const x = 1;");
    writeFileSync(join(dir, "src/foo.spec.ts"), "test('x', () => {});");

    assert.equal(findImplForTest("src/foo.spec.ts", dir), "src/foo.ts");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findImplForTest: co-located __tests__ → parent — a/__tests__/foo.test.ts → a/foo.ts", () => {
  const dir = mkdtempSync(join(tmpdir(), "aedis-impl-"));
  try {
    mkdirSync(join(dir, "src/__tests__"), { recursive: true });
    writeFileSync(join(dir, "src/foo.ts"), "export const x = 1;");
    writeFileSync(join(dir, "src/__tests__/foo.test.ts"), "test('x', () => {});");

    assert.equal(findImplForTest("src/__tests__/foo.test.ts", dir), "src/foo.ts");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findImplForTest: sibling test/ dir — test/utils.test.ts → src/utils.ts (stress-suite case)", () => {
  // Mirrors /tmp/aedis-stress-fixture layout: top-level test/ paired
  // with a top-level src/. This is the exact "test-only deliverable"
  // scenario the Phase 12 fix targets.
  const dir = mkdtempSync(join(tmpdir(), "aedis-impl-"));
  try {
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "test"), { recursive: true });
    writeFileSync(join(dir, "src/utils.ts"), "export function x() {}");
    writeFileSync(join(dir, "test/utils.test.ts"), "test('x', () => {});");

    assert.equal(findImplForTest("test/utils.test.ts", dir), "src/utils.ts");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findImplForTest: returns null when implementation file does not exist", () => {
  const dir = mkdtempSync(join(tmpdir(), "aedis-impl-"));
  try {
    mkdirSync(join(dir, "test"), { recursive: true });
    writeFileSync(join(dir, "test/orphan.test.ts"), "test('x', () => {});");

    assert.equal(findImplForTest("test/orphan.test.ts", dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findImplForTest: returns null when given a non-test path", () => {
  const dir = mkdtempSync(join(tmpdir(), "aedis-impl-"));
  try {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src/foo.ts"), "x");
    // src/foo.ts is not a test file; the helper should refuse to
    // resolve it and return null.
    assert.equal(findImplForTest("src/foo.ts", dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findImplForTest: extension-less paths are handled without crashing", () => {
  const dir = mkdtempSync(join(tmpdir(), "aedis-impl-"));
  try {
    assert.equal(findImplForTest("README", dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findImplForTest: prefers strip-suffix over sibling-dir hop when both would match", () => {
  // foo.test.ts in src/ — strip suffix gives src/foo.ts (exists).
  // The sibling-dir search would also target src/foo.ts. Same result,
  // but the priority order ensures the stable cheapest match wins.
  const dir = mkdtempSync(join(tmpdir(), "aedis-impl-"));
  try {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src/foo.ts"), "export const x = 1;");
    writeFileSync(join(dir, "src/foo.test.ts"), "test('x', () => {});");

    assert.equal(findImplForTest("src/foo.test.ts", dir), "src/foo.ts");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
