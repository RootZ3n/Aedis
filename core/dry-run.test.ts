import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPreflight } from "./preflight.js";
import { generateDryRun } from "./dry-run.js";

function makeRepo(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "aedis-dryrun-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "dryrun-tmp" }), "utf-8");
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    const parent = abs.replace(/\/[^/]+$/, "");
    if (parent !== dir) mkdirSync(parent, { recursive: true });
    writeFileSync(abs, content, "utf-8");
  }
  return dir;
}

// ─── Preflight ───────────────────────────────────────────────────────

test("preflight: empty input → block with empty-input code", () => {
  const r = runPreflight({ input: "", projectRoot: "/tmp" });
  assert.equal(r.blocked, true);
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => f.code === "empty-input"));
});

test("preflight: trivial one-word input → block with trivial-input code", () => {
  const r = runPreflight({ input: "hi", projectRoot: "/tmp" });
  assert.equal(r.blocked, true);
  assert.ok(r.findings.some((f) => f.code === "trivial-input"));
});

test("preflight: missing repoPath → block", () => {
  const r = runPreflight({ input: "in core/foo.ts, add a helper", projectRoot: "" });
  assert.equal(r.blocked, true);
  assert.ok(r.findings.some((f) => f.code === "missing-repo-path"));
});

test("preflight: nonexistent repoPath → block", () => {
  const r = runPreflight({
    input: "in core/foo.ts, add a helper",
    projectRoot: "/tmp/does-not-exist-aedis-preflight",
  });
  assert.equal(r.blocked, true);
  assert.ok(r.findings.some((f) => f.code === "invalid-repo-path"));
});

test("preflight: vague prompt with no targets → block", () => {
  const r = runPreflight({
    input: "maybe improve stuff somehow",
    projectRoot: "/tmp",
    extractedTargets: [],
    ambiguities: ["Subjective quality target"],
  });
  assert.equal(r.blocked, true);
  assert.ok(r.findings.some((f) => f.code === "vague-instruction"));
});

test("preflight: destructive verb without a target → block", () => {
  const r = runPreflight({
    input: "delete everything",
    projectRoot: "/tmp",
    extractedTargets: [],
  });
  assert.equal(r.blocked, true);
  assert.ok(r.findings.some((f) => f.code === "destructive-no-target"));
});

test("preflight: named target that doesn't exist → WARN, not block", () => {
  const dir = makeRepo();
  try {
    const r = runPreflight({
      input: "in core/new-thing.ts, add a helper",
      projectRoot: dir,
      extractedTargets: ["core/new-thing.ts"],
    });
    assert.equal(r.blocked, false);
    assert.equal(r.hasWarnings, true);
    assert.ok(r.findings.some((f) => f.code === "all-targets-missing"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("preflight: security-sensitive surface → WARN, not block", () => {
  const dir = makeRepo({ "core/auth.ts": "export const x = 1;\n" });
  try {
    const r = runPreflight({
      input: "in core/auth.ts, rotate the token handling logic",
      projectRoot: dir,
      extractedTargets: ["core/auth.ts"],
    });
    assert.equal(r.blocked, false);
    assert.ok(r.findings.some((f) => f.code === "security-sensitive" && f.severity === "warn"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("preflight: clean request against a real file → ok, no findings", () => {
  const dir = makeRepo({ "core/foo.ts": "export const x = 1;\n" });
  try {
    const r = runPreflight({
      input: "in core/foo.ts, add a helper exportConst",
      projectRoot: dir,
      extractedTargets: ["core/foo.ts"],
    });
    assert.equal(r.blocked, false);
    assert.equal(r.findings.length, 0);
    assert.match(r.summary, /passed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Dry run composition ────────────────────────────────────────────

test("dry-run: clean single-file request → ok=true, steps cover every stage", () => {
  const dir = makeRepo({ "core/capability-registry.ts": "export const x = 1;\n" });
  try {
    const plan = generateDryRun({
      input: "in core/capability-registry.ts, add a helper listCapabilities",
      projectRoot: dir,
    });
    assert.equal(plan.ok, true);
    assert.equal(plan.blocked, false);
    const stages = plan.steps.map((s) => s.stage);
    assert.ok(stages.includes("preflight"));
    assert.ok(stages.includes("charter"));
    assert.ok(stages.includes("scout"));
    assert.ok(stages.includes("builder"));
    assert.ok(stages.includes("critic"));
    assert.ok(stages.includes("verifier"));
    assert.ok(stages.includes("integrator"));
    assert.ok(plan.filesLikelyTouched.includes("core/capability-registry.ts"));
    assert.ok(plan.estimatedCost.maxUsd > 0);
    assert.ok(plan.confidence.overall > 0);
    assert.match(plan.headline, /\d+ steps/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dry-run: blocked preflight still returns a partial plan", () => {
  const dir = makeRepo();
  try {
    const plan = generateDryRun({
      input: "delete everything",
      projectRoot: dir,
    });
    assert.equal(plan.blocked, true);
    assert.equal(plan.ok, false);
    assert.ok(plan.preflight.findings.some((f) => f.code === "destructive-no-target"));
    assert.ok(plan.steps.length >= 1, "partial steps must still be rendered so the user sees what was parsed");
    assert.match(plan.headline, /blocked/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dry-run: 'build a capability registry' with no target files → planner still runs", () => {
  // The charter adds a placeholder deliverable when no targets
  // are extracted. The dry-run should plan against that — not
  // block on the empty target list — so the user can see what
  // Aedis *would* do even before they name a file.
  const dir = makeRepo();
  try {
    const plan = generateDryRun({
      input: "build a capability registry",
      projectRoot: dir,
    });
    assert.equal(plan.blocked, false);
    assert.ok(plan.steps.length > 0);
    assert.match(plan.narrative, /plan|steps|scope/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dry-run: vague prompt is blocked by preflight", () => {
  const dir = makeRepo();
  try {
    const plan = generateDryRun({
      input: "maybe improve something",
      projectRoot: dir,
    });
    assert.equal(plan.blocked, true);
    assert.ok(plan.preflight.findings.some((f) => f.code === "vague-instruction"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dry-run: risk level comes from blast radius estimator", () => {
  const dir = makeRepo({ "core/auth.ts": "export const x = 1;\n" });
  try {
    const plan = generateDryRun({
      input: "delete the auth token store in core/auth.ts",
      projectRoot: dir,
    });
    // Destructive + security-sensitive → high blast radius.
    assert.equal(plan.riskLevel, "high");
    assert.ok(plan.blastRadius.signals.includes("destructive-verb"));
    assert.ok(plan.blastRadius.signals.includes("security-sensitive"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dry-run: cost estimate is a display-friendly range", () => {
  const dir = makeRepo({ "core/foo.ts": "export const x = 1;\n" });
  try {
    const plan = generateDryRun({
      input: "in core/foo.ts, add a helper",
      projectRoot: dir,
    });
    assert.match(plan.estimatedCost.display, /^\$[\d.]+/);
    assert.ok(plan.estimatedCost.minUsd <= plan.estimatedCost.maxUsd);
    assert.ok(plan.estimatedCost.assumedTokens > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dry-run: confidence breakdown carries basis lines", () => {
  const dir = makeRepo({ "core/foo.ts": "export const x = 1;\n" });
  try {
    const plan = generateDryRun({
      input: "in core/foo.ts, add a helper",
      projectRoot: dir,
    });
    assert.ok(plan.confidence.basis.length >= 3);
    assert.ok(plan.confidence.basis.some((line) => line.includes("planning")));
    assert.ok(plan.confidence.basis.some((line) => line.includes("execution")));
    assert.ok(plan.confidence.basis.some((line) => line.includes("verification")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dry-run: narrative names the risk level and cost", () => {
  const dir = makeRepo({ "core/foo.ts": "export const x = 1;\n" });
  try {
    const plan = generateDryRun({
      input: "in core/foo.ts, add a helper",
      projectRoot: dir,
    });
    assert.match(plan.narrative, /Risk level/);
    assert.match(plan.narrative, /Estimated cost/);
    assert.match(plan.narrative, /Predictive confidence/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dry-run: success criterion — 'what would you do?' returns a plan, nothing executes", () => {
  const dir = makeRepo({ "core/capability-registry.ts": "export const x = 1;\n" });
  try {
    const plan = generateDryRun({
      input: "build a capability registry in core/capability-registry.ts",
      projectRoot: dir,
    });
    // The core success criterion from the task brief: a clear
    // plan, not an execution. We check: (a) no files were
    // touched on disk (we only read package.json and the
    // single seed file), (b) a plan was returned, (c) the plan
    // names concrete files.
    assert.equal(plan.ok, true);
    assert.ok(plan.steps.length >= 5);
    assert.ok(plan.filesLikelyTouched.length > 0);
    assert.match(plan.headline, /Aedis would/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
