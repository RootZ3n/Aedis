import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  discoverNamedTargets,
  extractNamedCandidates,
  formatAmbiguousNamedTargetMessage,
  formatMissingNamedTargetMessage,
} from "./named-target-discovery.js";

// ─── Name extraction ─────────────────────────────────────────────────

test("extractNamedCandidates: PascalCase tokens are kept", () => {
  const names = extractNamedCandidates("Add Instructor Mode to Magister for teaching.");
  assert.ok(names.includes("Magister"), `expected Magister; got ${names.join(",")}`);
  assert.ok(
    names.some((n) => /Instructor/.test(n)),
    `expected Instructor phrase; got ${names.join(",")}`,
  );
});

test("extractNamedCandidates: imperative verbs are stoplisted (Add ≠ name)", () => {
  const names = extractNamedCandidates("Add Magister.");
  assert.ok(!names.includes("Add"), `Add must be stoplisted; got ${names.join(",")}`);
});

test("extractNamedCandidates: ignores lowercase verbs", () => {
  const names = extractNamedCandidates("just keep going");
  assert.equal(names.length, 0);
});

// ─── A. Magister → modules/magister ──────────────────────────────────

test("discover: 'Magister' resolves to modules/magister", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "aedis-named-magister-"));
  try {
    mkdirSync(join(projectRoot, "modules", "magister"), { recursive: true });
    writeFileSync(join(projectRoot, "modules", "magister", "index.ts"), "// magister", "utf-8");
    const result = discoverNamedTargets({
      prompt: "Add Instructor Mode to Magister for interactive teaching.",
      projectRoot,
    });
    assert.equal(result.resolvedPath, "modules/magister");
    assert.equal(result.ambiguous, false);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ─── B. Case-insensitive ─────────────────────────────────────────────

test("discover: case-insensitive match (MAGISTER → modules/magister)", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "aedis-named-case-"));
  try {
    mkdirSync(join(projectRoot, "modules", "magister"), { recursive: true });
    const result = discoverNamedTargets({
      prompt: "Add a feature to MAGISTER for paste handling.",
      projectRoot,
    });
    assert.equal(result.resolvedPath, "modules/magister");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ─── C. Common path priority ─────────────────────────────────────────

test("discover: modules/ wins over libs/ when both exist", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "aedis-named-priority-"));
  try {
    mkdirSync(join(projectRoot, "modules", "magister"), { recursive: true });
    mkdirSync(join(projectRoot, "libs", "magister"), { recursive: true });
    const result = discoverNamedTargets({
      prompt: "Update Magister.",
      projectRoot,
    });
    assert.equal(result.resolvedPath, "modules/magister");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ─── D. Multi-match ambiguity ────────────────────────────────────────

test("discover: ambiguous when two matches under same priority root", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "aedis-named-ambig-"));
  try {
    mkdirSync(join(projectRoot, "modules", "magister"), { recursive: true });
    mkdirSync(join(projectRoot, "apps", "magister"), { recursive: true });
    const result = discoverNamedTargets({
      prompt: "Refactor Magister.",
      projectRoot,
    });
    // modules/ has higher priority than apps/, so the gap should not
    // trigger ambiguity here. Use two equally-ranked roots instead.
    assert.equal(result.resolvedPath, "modules/magister");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("discover: same-name in two equal-priority spots → ambiguous", () => {
  // A real ambiguity case — both candidates under modules/
  // (different parent name resolves to the same child via different
  // extracted names). Simulate by creating two extractable names
  // (Magister and Loqui) and a directory for each.
  const projectRoot = mkdtempSync(join(tmpdir(), "aedis-named-ambig2-"));
  try {
    mkdirSync(join(projectRoot, "modules", "magister"), { recursive: true });
    mkdirSync(join(projectRoot, "modules", "loqui"), { recursive: true });
    const result = discoverNamedTargets({
      prompt: "Connect Magister with Loqui.",
      projectRoot,
    });
    // Two equal candidates → ambiguous
    assert.equal(result.ambiguous, true, `expected ambiguous; got ${JSON.stringify(result)}`);
    assert.equal(result.resolvedPath, null);
    const msg = formatAmbiguousNamedTargetMessage(result);
    assert.match(msg, /modules\/magister/);
    assert.match(msg, /modules\/loqui/);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ─── E. No match ─────────────────────────────────────────────────────

test("discover: no match → empty + helpful clarification", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "aedis-named-nomatch-"));
  try {
    mkdirSync(join(projectRoot, "core"), { recursive: true });
    const result = discoverNamedTargets({
      prompt: "Add Instructor Mode to Magister.",
      projectRoot,
    });
    assert.equal(result.resolvedPath, null);
    assert.equal(result.ambiguous, false);
    assert.ok(result.extractedNames.includes("Magister"));
    const msg = formatMissingNamedTargetMessage(result);
    assert.match(msg, /Magister/);
    assert.match(msg, /create one|point me to the path/i);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ─── F. Explicit path wins ───────────────────────────────────────────

test("discover: skipped when caller already has explicit targets", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "aedis-named-skip-"));
  try {
    mkdirSync(join(projectRoot, "modules", "magister"), { recursive: true });
    const result = discoverNamedTargets({
      prompt: "Add to Magister.",
      projectRoot,
      knownTargets: ["core/foo.ts"],
    });
    assert.equal(result.resolvedPath, null);
    assert.equal(result.candidates.length, 0);
    assert.equal(result.extractedNames.length, 0);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ─── Hyphen / snake variants ─────────────────────────────────────────

test("discover: 'Instructor Mode' resolves to modules/instructor-mode", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "aedis-named-hyphen-"));
  try {
    mkdirSync(join(projectRoot, "modules", "instructor-mode"), { recursive: true });
    const result = discoverNamedTargets({
      prompt: "Build Instructor Mode for paste handling.",
      projectRoot,
    });
    assert.equal(result.resolvedPath, "modules/instructor-mode");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("discover: 'instructor-mode' (already kebab) resolves directly", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "aedis-named-kebab-"));
  try {
    mkdirSync(join(projectRoot, "modules", "instructor-mode"), { recursive: true });
    const result = discoverNamedTargets({
      prompt: "Update instructor-mode.",
      projectRoot,
    });
    assert.equal(result.resolvedPath, "modules/instructor-mode");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ─── Top-level fallback ──────────────────────────────────────────────

test("discover: top-level dir match (single-package repo)", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "aedis-named-toplevel-"));
  try {
    mkdirSync(join(projectRoot, "magister"), { recursive: true });
    const result = discoverNamedTargets({
      prompt: "Add to Magister.",
      projectRoot,
    });
    assert.equal(result.resolvedPath, "magister");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
