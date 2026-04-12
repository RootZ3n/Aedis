import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
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
