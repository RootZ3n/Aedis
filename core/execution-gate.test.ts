import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileChange, WorkerResult } from "../workers/base.js";
import type { VerificationReceipt } from "./verification-pipeline.js";
import { evaluateExecutionGate } from "./execution-gate.js";

test("execution gate blocks an empty task graph as no-op", () => {
  const decision = evaluateExecutionGate({
    runId: "run-1",
    projectRoot: "/tmp",
    workerResults: [],
    changes: [],
    commitSha: null,
    verificationReceipt: null,
    graphNodeCount: 0,
    cancelled: false,
    thrownError: null,
  });
  assert.equal(decision.verdict, "no_op");
  assert.equal(decision.executionVerified, false);
  assert.match(decision.reason, /zero nodes/);
  assert.equal(decision.evidence.length, 0);
});

test("execution gate blocks when workers ran but produced no changes and no commit", () => {
  const decision = evaluateExecutionGate({
    runId: "run-1",
    projectRoot: "/tmp",
    workerResults: [sampleScoutResult()],
    changes: [],
    commitSha: null,
    verificationReceipt: null,
    graphNodeCount: 2,
    cancelled: false,
    thrownError: null,
  });
  assert.equal(decision.verdict, "no_op");
  assert.equal(decision.executionVerified, false);
  assert.match(decision.reason, /No-op execution detected/);
});

test("execution gate verifies a run that created a real file on disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "aedis-gate-"));
  try {
    const rel = "capability-registry.ts";
    writeFileSync(join(dir, rel), "export const CAPABILITIES = {};\n", "utf-8");

    const change: FileChange = {
      path: rel,
      operation: "create",
      content: "export const CAPABILITIES = {};\n",
    };
    const decision = evaluateExecutionGate({
      runId: "run-1",
      projectRoot: dir,
      workerResults: [sampleBuilderResult(change)],
      changes: [change],
      commitSha: null,
      verificationReceipt: null,
      graphNodeCount: 4,
      cancelled: false,
      thrownError: null,
    });
    assert.equal(decision.verdict, "verified");
    assert.equal(decision.executionVerified, true);
    assert.equal(decision.counts.filesCreated, 1);
    assert.ok(
      decision.evidence.some((e) => e.kind === "file_created" && e.ref === rel),
      "should emit a file_created evidence item for the real file",
    );
    assert.match(decision.reason, /file\(s\) created/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("execution gate rejects a create change that did not actually land on disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "aedis-gate-"));
  try {
    const change: FileChange = {
      path: "phantom.ts",
      operation: "create",
      content: "// never written",
    };
    const decision = evaluateExecutionGate({
      runId: "run-1",
      projectRoot: dir,
      workerResults: [sampleBuilderResult(change)],
      changes: [change],
      commitSha: null,
      verificationReceipt: null,
      graphNodeCount: 4,
      cancelled: false,
      thrownError: null,
    });
    assert.equal(decision.verdict, "no_op");
    assert.equal(decision.executionVerified, false);
    assert.equal(decision.counts.filesCreated, 0);
    assert.match(decision.reason, /No-op execution detected/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("execution gate treats a real commit SHA as verification evidence", () => {
  const dir = mkdtempSync(join(tmpdir(), "aedis-gate-"));
  try {
    const rel = "core/thing.ts";
    mkdirSync(join(dir, "core"), { recursive: true });
    writeFileSync(join(dir, rel), "// modified\n", "utf-8");
    const change: FileChange = {
      path: rel,
      operation: "modify",
      diff: "@@ -1 +1 @@\n-// original\n+// modified\n",
    };
    const decision = evaluateExecutionGate({
      runId: "run-1",
      projectRoot: dir,
      workerResults: [sampleBuilderResult(change)],
      changes: [change],
      commitSha: "abcdef1234567890",
      verificationReceipt: null,
      graphNodeCount: 4,
      cancelled: false,
      thrownError: null,
    });
    assert.equal(decision.verdict, "verified");
    assert.equal(decision.executionVerified, true);
    assert.ok(decision.evidence.some((e) => e.kind === "commit_sha"));
    assert.ok(decision.evidence.some((e) => e.kind === "file_modified"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("execution gate surfaces errors explicitly on the exception path", () => {
  const decision = evaluateExecutionGate({
    runId: "run-1",
    projectRoot: "/tmp",
    workerResults: [],
    changes: [],
    commitSha: null,
    verificationReceipt: null,
    graphNodeCount: 3,
    cancelled: false,
    thrownError: new Error("kaboom inside builder"),
  });
  assert.equal(decision.verdict, "errored");
  assert.equal(decision.executionVerified, false);
  assert.equal(decision.errorMessage, "kaboom inside builder");
  assert.match(decision.reason, /Execution errored/);
});

test("execution gate accepts a read-only output when opt-in is set", () => {
  const decision = evaluateExecutionGate({
    runId: "run-1",
    projectRoot: "/tmp",
    workerResults: [sampleScoutResult()],
    changes: [],
    commitSha: null,
    verificationReceipt: null,
    graphNodeCount: 1,
    cancelled: false,
    thrownError: null,
    readOnlyOk: true,
  });
  assert.equal(decision.verdict, "verified");
  assert.equal(decision.executionVerified, true);
  assert.ok(decision.evidence.some((e) => e.kind === "read_only"));
});

test("execution gate synthesizes a per-worker receipt for every worker result", () => {
  const dir = mkdtempSync(join(tmpdir(), "aedis-gate-"));
  try {
    const rel = "created.ts";
    writeFileSync(join(dir, rel), "export {};\n", "utf-8");
    const change: FileChange = { path: rel, operation: "create", content: "export {};\n" };
    const decision = evaluateExecutionGate({
      runId: "run-1",
      projectRoot: dir,
      workerResults: [sampleScoutResult(), sampleBuilderResult(change)],
      changes: [change],
      commitSha: null,
      verificationReceipt: null,
      graphNodeCount: 2,
      cancelled: false,
      thrownError: null,
    });
    assert.equal(decision.workerReceipts.length, 2);
    const scout = decision.workerReceipts.find((r) => r.workerType === "scout");
    const builder = decision.workerReceipts.find((r) => r.workerType === "builder");
    assert.ok(scout, "scout receipt should exist");
    assert.ok(builder, "builder receipt should exist");
    assert.match(builder!.changesMade, /1 change/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("regression: 'build capability registry' with zero real changes fails visibly", () => {
  // This is the exact fake-success scenario that motivated Execution
  // Truth Enforcement v1: a "build capability registry" task runs,
  // the scout and planner fire, the builder returns "success" but
  // emits zero file changes, and nothing lands on disk. The old
  // determineVerdict would fall through to "success" because nothing
  // explicitly failed. The gate must now call this out as a no-op.
  const dir = mkdtempSync(join(tmpdir(), "aedis-capreg-"));
  try {
    // No capability-registry.ts file is ever written. The builder
    // returns "success" because its model call came back 200, but
    // the output.changes array is empty.
    const builderResult: WorkerResult = {
      workerType: "builder",
      taskId: "builder-1",
      success: true,
      output: {
        kind: "builder",
        changes: [],
        decisions: [],
        needsCriticReview: false,
      },
      issues: [],
      cost: { model: "test", inputTokens: 50, outputTokens: 50, estimatedCostUsd: 0.01 },
      confidence: 0.8,
      touchedFiles: [],
      assumptions: [],
      durationMs: 10,
    };
    const decision = evaluateExecutionGate({
      runId: "run-capreg",
      projectRoot: dir,
      workerResults: [sampleScoutResult(), builderResult],
      changes: [],
      commitSha: null,
      verificationReceipt: null,
      graphNodeCount: 4,
      cancelled: false,
      thrownError: null,
    });

    assert.equal(decision.verdict, "no_op", "zero-change builder must not pass the gate");
    assert.equal(decision.executionVerified, false, "executionVerified must be false");
    assert.match(decision.reason, /No-op execution detected/);
    assert.equal(decision.counts.filesCreated, 0);
    assert.equal(decision.counts.filesModified, 0);
    assert.equal(decision.counts.filesDeleted, 0);

    const builderReceipt = decision.workerReceipts.find((r) => r.workerType === "builder");
    assert.ok(builderReceipt, "per-worker receipt must be synthesized even for no-op runs");
    assert.match(builderReceipt!.changesMade, /zero changes/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("execution gate: content-identity modify is suppressed and run is no-op (Phase 8)", () => {
  const dir = mkdtempSync(join(tmpdir(), "aedis-gate-"));
  try {
    const rel = "src/identity.ts";
    mkdirSync(join(dir, "src"), { recursive: true });
    const body = "export function f() { return 1; }\n";
    writeFileSync(join(dir, rel), body, "utf-8");
    const change: FileChange = {
      path: rel,
      operation: "modify",
      originalContent: body,
      diff: "@@ -1 +1 @@\n fake diff\n",
    };
    const decision = evaluateExecutionGate({
      runId: "run-1",
      projectRoot: dir,
      workerResults: [sampleBuilderResult(change)],
      changes: [change],
      commitSha: null,
      verificationReceipt: null,
      graphNodeCount: 2,
      cancelled: false,
      thrownError: null,
    });
    assert.equal(decision.verdict, "no_op");
    assert.equal(decision.executionVerified, false);
    assert.equal(decision.contentIdentityFindings.length, 1);
    assert.equal(
      decision.contentIdentityFindings[0].code,
      "execution.content_identity",
    );
    assert.ok(!decision.evidence.some((e) => e.kind === "file_modified"));
    assert.match(decision.reason, /content-identical/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("execution gate: whitespace-only reformatted modify is flagged (Phase 8)", () => {
  const dir = mkdtempSync(join(tmpdir(), "aedis-gate-"));
  try {
    const rel = "src/ws.ts";
    mkdirSync(join(dir, "src"), { recursive: true });
    const original = "function f() {\n  return 1;\n}";
    const reformatted = "function f()  {\n    return 1;\n}\n";
    writeFileSync(join(dir, rel), reformatted, "utf-8");
    const change: FileChange = {
      path: rel,
      operation: "modify",
      originalContent: original,
    };
    const decision = evaluateExecutionGate({
      runId: "run-1",
      projectRoot: dir,
      workerResults: [sampleBuilderResult(change)],
      changes: [change],
      commitSha: null,
      verificationReceipt: null,
      graphNodeCount: 2,
      cancelled: false,
      thrownError: null,
    });
    assert.equal(decision.verdict, "no_op");
    assert.equal(
      decision.contentIdentityFindings[0].code,
      "execution.content_identity_whitespace",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("execution gate: verifier pass does not rescue content-identity no-op (Phase 8)", () => {
  const dir = mkdtempSync(join(tmpdir(), "aedis-gate-"));
  try {
    const rel = "src/identity-verified.ts";
    mkdirSync(join(dir, "src"), { recursive: true });
    const body = "export function stable() { return 1; }\n";
    writeFileSync(join(dir, rel), body, "utf-8");
    const change: FileChange = {
      path: rel,
      operation: "modify",
      originalContent: body,
      diff: "@@ -1 +1 @@\n fake diff\n",
    };
    const decision = evaluateExecutionGate({
      runId: "run-1",
      projectRoot: dir,
      workerResults: [sampleBuilderResult(change)],
      changes: [change],
      commitSha: null,
      verificationReceipt: {
        id: "verify-1",
        runId: "run-1",
        intentId: "intent-1",
        timestamp: new Date().toISOString(),
        verdict: "pass",
        confidenceScore: 1,
        summary: "verification passed",
        stages: [],
        judgmentReport: null,
        allIssues: [],
        blockers: [],
        requiredChecks: [],
        checks: [],
        totalDurationMs: 1,
        fileCoverage: [],
        coverageRatio: 1,
        validatedRatio: 1,
      },
      graphNodeCount: 2,
      cancelled: false,
      thrownError: null,
    });
    assert.equal(decision.verdict, "no_op");
    assert.equal(decision.executionVerified, false);
    assert.ok(!decision.evidence.some((e) => e.kind === "verifier_pass"));
    assert.equal(decision.contentIdentityFindings.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("execution gate: real modify passes (Phase 8 regression guard)", () => {
  const dir = mkdtempSync(join(tmpdir(), "aedis-gate-"));
  try {
    const rel = "src/real.ts";
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, rel), "export const VERSION = 2;\n", "utf-8");
    const change: FileChange = {
      path: rel,
      operation: "modify",
      originalContent: "export const VERSION = 1;\n",
      diff: "@@ -1 +1 @@\n-export const VERSION = 1;\n+export const VERSION = 2;\n",
    };
    const decision = evaluateExecutionGate({
      runId: "run-1",
      projectRoot: dir,
      workerResults: [sampleBuilderResult(change)],
      changes: [change],
      commitSha: null,
      verificationReceipt: null,
      graphNodeCount: 2,
      cancelled: false,
      thrownError: null,
    });
    assert.equal(decision.verdict, "verified");
    assert.equal(decision.executionVerified, true);
    assert.equal(decision.contentIdentityFindings.length, 0);
    assert.ok(decision.evidence.some((e) => e.kind === "file_modified"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("execution gate treats cancelled runs as no-op regardless of evidence", () => {
  const decision = evaluateExecutionGate({
    runId: "run-1",
    projectRoot: "/tmp",
    workerResults: [],
    changes: [],
    commitSha: null,
    verificationReceipt: null,
    graphNodeCount: 4,
    cancelled: true,
    thrownError: null,
  });
  assert.equal(decision.verdict, "no_op");
  assert.equal(decision.executionVerified, false);
  assert.match(decision.reason, /cancelled/);
});

// ─── Phase 8.5 — high-value hardening tests ─────────────────────────

test("execution gate (Phase 8.5): builder supplies WRONG originalContent — identity still fires when on-disk matches the bogus claim", () => {
  // A hostile / buggy builder could claim `originalContent: X` when
  // the real baseline was something else entirely, in an attempt to
  // trick downstream gates. The current defense compares the CLAIMED
  // originalContent to the on-disk content — so if the builder
  // claimed `originalContent="pre"` and the on-disk content is still
  // "pre" (i.e. no modification was actually applied), the identity
  // check STILL fires. The lie doesn't matter: both sides of the
  // comparison agree nothing changed on disk.
  const dir = mkdtempSync(join(tmpdir(), "aedis-gate-wrongorig-"));
  try {
    const rel = "src/wrongorig.ts";
    mkdirSync(join(dir, "src"), { recursive: true });
    const realBody = "export const VERSION = 1;\n";
    writeFileSync(join(dir, rel), realBody, "utf-8");
    // Builder claims originalContent is "lying claim" — which happens
    // to match what's on disk AFTER "modification" (because no real
    // change was applied). The gate doesn't trust the claim; it
    // compares claim-vs-disk and catches the no-op.
    const change: FileChange = {
      path: rel,
      operation: "modify",
      originalContent: realBody, // matches disk — identity triggered
      diff: "@@ fake @@",
    };
    const decision = evaluateExecutionGate({
      runId: "run-1",
      projectRoot: dir,
      workerResults: [sampleBuilderResult(change)],
      changes: [change],
      commitSha: null,
      verificationReceipt: null,
      graphNodeCount: 2,
      cancelled: false,
      thrownError: null,
    });
    assert.equal(decision.verdict, "no_op");
    assert.equal(decision.contentIdentityFindings.length, 1);
    assert.equal(
      decision.contentIdentityFindings[0].code,
      "execution.content_identity",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("execution gate (Phase 8.5): permission-denied read — skips identity check gracefully, still no_op when no other evidence", { skip: process.getuid && process.getuid() === 0 }, () => {
  // If the target file is unreadable (EACCES / root-owned file on CI),
  // safeReadFile returns null. The gate must NOT crash; it should
  // skip the identity check and fall through to the default behavior:
  // file_modified evidence based on file-exists. When that's the only
  // signal and no diff is supplied, the run still gets evidence but
  // is flagged as lacking strong verification.
  const dir = mkdtempSync(join(tmpdir(), "aedis-gate-denied-"));
  try {
    const rel = "src/locked.ts";
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, rel), "content\n", "utf-8");
    // Revoke read permission — safeReadFile will catch EACCES.
    chmodSync(join(dir, rel), 0o000);
    const change: FileChange = {
      path: rel,
      operation: "modify",
      originalContent: "content\n",
      diff: "@@ -1 +1 @@\n real diff\n",
    };
    const decision = evaluateExecutionGate({
      runId: "run-1",
      projectRoot: dir,
      workerResults: [sampleBuilderResult(change)],
      changes: [change],
      commitSha: null,
      verificationReceipt: null,
      graphNodeCount: 2,
      cancelled: false,
      thrownError: null,
    });
    // Identity check was skipped (no crash), so the file_modified
    // evidence was admitted — the run proceeds. No content-identity
    // findings because we couldn't read the file to compare.
    assert.equal(decision.contentIdentityFindings.length, 0);
    assert.equal(decision.verdict, "verified");
    chmodSync(join(dir, rel), 0o644); // restore so rmSync can clean up
  } finally {
    try { chmodSync(join(dir, "src/locked.ts"), 0o644); } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Fixtures ────────────────────────────────────────────────────────

function sampleScoutResult(): WorkerResult {
  return {
    workerType: "scout",
    taskId: "task-scout",
    success: true,
    output: {
      kind: "scout",
      dependencies: [],
      patterns: [],
      riskAssessment: { level: "low", factors: [], mitigations: [] },
      suggestedApproach: "do the thing",
    },
    issues: [],
    cost: { model: "test", inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
    confidence: 0.9,
    touchedFiles: [{ path: "core/foo.ts", operation: "read" }],
    assumptions: [],
    durationMs: 10,
  };
}

function sampleBuilderResult(change: FileChange): WorkerResult {
  return {
    workerType: "builder",
    taskId: "task-builder",
    success: true,
    output: {
      kind: "builder",
      changes: [change],
      decisions: [],
      needsCriticReview: false,
    },
    issues: [],
    cost: { model: "test", inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
    confidence: 0.9,
    touchedFiles: [{ path: change.path, operation: change.operation }],
    assumptions: [],
    durationMs: 10,
  };
}

// Unused import guard — makes TypeScript keep the VerificationReceipt
// import around for test authors extending the suite later.
const _unused: VerificationReceipt | null = null;
void _unused;
