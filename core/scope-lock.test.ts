/**
 * Scope-lock pipeline tests — pinning the contract that catches the
 * burn-in 1-file → 9-files incident.
 *
 * Touches three layers:
 *   - prompt-sanitizer.ts: detects "do not modify anything else"
 *   - charter.ts: builds a Charter with scopeLock and skips test
 *     auto-injection when lockScope is set
 *   - integration-judge.ts: enforces the allowlist as a hard blocker
 *     regardless of the strictScope toggle
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sanitizePromptForFileExtraction } from "./prompt-sanitizer.js";
import { CharterGenerator } from "./charter.js";
import { createIntent } from "./intent.js";
import { createRunState } from "./runstate.js";
import { IntegrationJudge } from "./integration-judge.js";
import { Coordinator, type RunReceipt } from "./coordinator.js";
import { classifyExecution } from "./execution-classification.js";
import type { FileChange, WorkerResult } from "../workers/base.js";

// ─── Helpers ─────────────────────────────────────────────────────────

function makeChange(path: string): FileChange {
  return {
    path,
    operation: "modify",
    diff: "@@ -1 +1 @@\n-old\n+new\n",
    content: "new",
    originalContent: "old",
  };
}

const noWorkers: WorkerResult[] = [];

// ─── prompt-sanitizer: lockScope detection ───────────────────────────

test("sanitizer: 'do not modify anything else' sets lockScope=true (the burn-in-01 phrasing)", () => {
  const r = sanitizePromptForFileExtraction(
    "In core/run-summary.ts, add a comment '// burn-in: comment-swap probe.' Do not modify anything else.",
  );
  assert.equal(r.lockScope, true);
});

test("sanitizer: 'do not touch any other file' sets lockScope=true", () => {
  const r = sanitizePromptForFileExtraction(
    "In core/charter.ts, add a comment. Do not touch any other file.",
  );
  assert.equal(r.lockScope, true);
});

test("sanitizer: 'no other files should be modified' sets lockScope=true", () => {
  const r = sanitizePromptForFileExtraction(
    "Add a one-line comment to src/foo.ts. No other files should be modified.",
  );
  assert.equal(r.lockScope, true);
});

test("sanitizer: 'only modify core/x.ts' sets lockScope=true", () => {
  const r = sanitizePromptForFileExtraction("Only modify core/x.ts and append a comment.");
  assert.equal(r.lockScope, true);
});

test("sanitizer: lockScope is false when there is no catch-all phrase", () => {
  const r = sanitizePromptForFileExtraction("In core/x.ts, fix the bug.");
  assert.equal(r.lockScope, false);
});

test("sanitizer: literal 'do not modify anything else' inside quotes does NOT trip lockScope", () => {
  const r = sanitizePromptForFileExtraction(
    'Add a comment that says "do not modify anything else" to core/x.ts.',
  );
  assert.equal(r.lockScope, false, "quoted literals must not trigger the lock");
});

// ─── charter: lockScope plumbed through, no test auto-inject ─────────

test("charter: comment-only single-file prompt with lockScope does NOT auto-inject a test deliverable", () => {
  const gen = new CharterGenerator({ autoTestDeliverables: true });
  const analysis = gen.analyzeRequest(
    "In core/run-summary.ts, add a comment '// burn-in: comment-swap probe.' Do not modify anything else.",
  );
  assert.equal(analysis.lockScope, true);
  const charter = gen.generateCharter(analysis);
  // Should be exactly one deliverable for run-summary.ts — no .test.ts pair.
  for (const d of charter.deliverables) {
    for (const t of d.targetFiles) {
      assert.doesNotMatch(t, /\.test\.ts$/, `unexpected test deliverable: ${t}`);
    }
  }
  assert.equal(charter.deliverables.length, 1);
});

test("charter: 'Do not modify anything else' creates an allowedFiles allowlist on the Charter", () => {
  const gen = new CharterGenerator({ autoTestDeliverables: true });
  const analysis = gen.analyzeRequest(
    "In core/run-summary.ts, add a one-line comment. Do not modify anything else.",
  );
  const charter = gen.generateCharter(analysis);
  assert.ok(charter.scopeLock, "scopeLock must be present");
  assert.deepEqual([...charter.scopeLock.allowedFiles], ["core/run-summary.ts"]);
  assert.match(charter.scopeLock.reason, /do not modify anything else/i);
});

test("charter: prompt without a lock has scopeLock=null", () => {
  const gen = new CharterGenerator({ autoTestDeliverables: true });
  const analysis = gen.analyzeRequest(
    "In core/run-summary.ts, fix the bug in formatVerdict.",
  );
  const charter = gen.generateCharter(analysis);
  assert.equal(charter.scopeLock, null);
});

test("charter: autoTest STILL fires for an unlocked code change (regression guard)", () => {
  const gen = new CharterGenerator({ autoTestDeliverables: true });
  const analysis = gen.analyzeRequest("In core/run-summary.ts, add a new exported helper.");
  const charter = gen.generateCharter(analysis);
  const hasTestDeliverable = charter.deliverables.some((d) =>
    d.targetFiles.some((t) => t.endsWith(".test.ts")),
  );
  assert.equal(hasTestDeliverable, true, "lock-off path must still produce a test deliverable");
});

// ─── integration-judge: scopeLock allowlist enforcement ──────────────

test("integration-judge: extra file outside scopeLock allowlist → scope_violation blocker", () => {
  const gen = new CharterGenerator();
  const analysis = gen.analyzeRequest(
    "In core/run-summary.ts, add a one-line comment. Do not modify anything else.",
  );
  const charter = gen.generateCharter(analysis);
  const intent = createIntent({
    runId: "scope-lock-test",
    userRequest: analysis.raw,
    charter,
    constraints: [],
  });
  const runState = createRunState(intent.id, intent.runId);

  // Builder touched the allowed file AND eight others.
  const changes: FileChange[] = [
    makeChange("core/run-summary.ts"),
    makeChange("core/run-summary.test.ts"),
    makeChange("core/charter.ts"),
    makeChange("core/coordinator.ts"),
    makeChange("core/intent.ts"),
    makeChange("core/change-set.ts"),
    makeChange("core/builder-tier-routing.ts"),
    makeChange("core/types.ts"),
    makeChange("core/multi-file-planner.ts"),
  ];

  const judge = new IntegrationJudge({ projectRoot: "/tmp/fake" });
  const report = judge.judge(intent, runState, changes, noWorkers, "pre-apply");

  const scopeCheck = report.checks.find((c) => c.category === "scope-boundary");
  assert.ok(scopeCheck);
  assert.equal(scopeCheck.passed, false, "scope-boundary must fail");
  assert.match(scopeCheck.details, /scope_violation/);
  assert.match(scopeCheck.details, /outside the locked scope/);

  const blocker = report.blockers.find((b) => b.category === "scope-boundary");
  assert.ok(blocker, "scope-boundary failure must produce a blocker");
  assert.equal(report.passed, false, "judgment must fail overall");
  // Eight files outside scope.
  assert.equal(scopeCheck.affectedFiles.length, 8);
});

test("integration-judge: scopeLock enforcement is independent of strictScope=false", () => {
  // Even with permissive strictScope, the scope-lock allowlist must
  // block. The user explicitly said "no other files".
  const gen = new CharterGenerator();
  const analysis = gen.analyzeRequest(
    "In core/run-summary.ts, add a one-line comment. Do not modify anything else.",
  );
  const charter = gen.generateCharter(analysis);
  const intent = createIntent({
    runId: "scope-lock-strict-off",
    userRequest: analysis.raw,
    charter,
    constraints: [],
  });
  const runState = createRunState(intent.id, intent.runId);
  const changes: FileChange[] = [
    makeChange("core/run-summary.ts"),
    makeChange("core/charter.ts"),
  ];
  const judge = new IntegrationJudge({ projectRoot: "/tmp/fake", strictScope: false });
  const report = judge.judge(intent, runState, changes, noWorkers, "pre-apply");
  const scopeCheck = report.checks.find((c) => c.category === "scope-boundary");
  assert.ok(scopeCheck);
  assert.equal(scopeCheck.passed, false, "lock must override strictScope=false");
});

test("integration-judge: when all changes are within the lock, scope-boundary passes", () => {
  const gen = new CharterGenerator();
  const analysis = gen.analyzeRequest(
    "In core/run-summary.ts, add a one-line comment. Do not modify anything else.",
  );
  const charter = gen.generateCharter(analysis);
  const intent = createIntent({
    runId: "scope-lock-clean",
    userRequest: analysis.raw,
    charter,
    constraints: [],
  });
  const runState = createRunState(intent.id, intent.runId);
  const changes: FileChange[] = [makeChange("core/run-summary.ts")];
  const judge = new IntegrationJudge({ projectRoot: "/tmp/fake" });
  const report = judge.judge(intent, runState, changes, noWorkers, "pre-apply");
  const scopeCheck = report.checks.find((c) => c.category === "scope-boundary");
  assert.ok(scopeCheck);
  assert.equal(scopeCheck.passed, true, "single in-scope change must pass");
});

// ─── filesModified count consistency ─────────────────────────────────

test("scope-lock: judge.scopeCheck.affectedFiles count equals the number of out-of-scope changes", () => {
  // Pins the count consistency the user asked for: extra files
  // surfaced by the judge match the actual changes outside scope.
  const gen = new CharterGenerator();
  const analysis = gen.analyzeRequest(
    "In src/a.ts, append one line. Do not touch any other file.",
  );
  const charter = gen.generateCharter(analysis);
  const intent = createIntent({
    runId: "scope-lock-count",
    userRequest: analysis.raw,
    charter,
    constraints: [],
  });
  const runState = createRunState(intent.id, intent.runId);
  const changes: FileChange[] = [
    makeChange("src/a.ts"),
    makeChange("src/b.ts"),
    makeChange("src/c.ts"),
  ];
  const judge = new IntegrationJudge({ projectRoot: "/tmp/fake" });
  const report = judge.judge(intent, runState, changes, noWorkers, "pre-apply");
  const scopeCheck = report.checks.find((c) => c.category === "scope-boundary");
  assert.ok(scopeCheck);
  assert.equal(
    scopeCheck.affectedFiles.length,
    changes.length - 1,
    "affectedFiles count = total changes - allowlist size",
  );
  // Files reported must match the actual extra changes.
  assert.deepEqual(new Set(scopeCheck.affectedFiles), new Set(["src/b.ts", "src/c.ts"]));
});

// ─── Coordinator: prepareDeliverablesForGraph + collectChanges ───────

function setupRunSummaryFixture(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "aedis-scope-lock-"));
  mkdirSync(join(dir, "core"), { recursive: true });
  // Both files exist on disk so the test-pair-injection path's
  // findMissingTestFiles would consider injecting the .test.ts.
  writeFileSync(join(dir, "core/run-summary.ts"), "// stub source\n", "utf-8");
  writeFileSync(join(dir, "core/run-summary.test.ts"), "// stub test\n", "utf-8");
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function buildActiveWithCharter(opts: {
  projectRoot: string;
  prompt: string;
}) {
  const gen = new CharterGenerator({ autoTestDeliverables: false });
  const analysis = gen.analyzeRequest(opts.prompt);
  const charter = gen.generateCharter(analysis);
  const intent = createIntent({
    runId: "scope-lock-test",
    userRequest: opts.prompt,
    charter,
    constraints: [],
  });
  const changeSet = {
    intent,
    filesInScope: [],
    dependencyRelationships: {},
    invariants: [],
    sharedInvariants: [],
    acceptanceCriteria: [],
    coherenceVerdict: { coherent: true, reason: "test fixture" },
  };
  return {
    intent,
    run: createRunState(intent.id, "scope-lock-test"),
    projectRoot: opts.projectRoot,
    sourceRepo: opts.projectRoot,
    normalizedInput: opts.prompt,
    rejectedCandidates: [],
    userNamedStrippedTargets: [],
    analysis,
    waveVerifications: [],
    changes: [] as FileChange[],
    workerResults: [] as WorkerResult[],
    cancelled: false,
    cancelledGenerations: new Set<string>(),
    pendingDispatches: new Map(),
    runAbortController: new AbortController(),
    weakOutputRetries: 0,
    memorySuggestions: [],
    workspace: null,
    projectMemory: { recentTaskSummaries: [], substrate: null },
    gatedContext: { relevantFiles: [], recentTaskSummaries: [], language: null, memoryNotes: [], suggestedNextSteps: [] },
    changeSet,
    plan: undefined,
    scopeClassification: null,
    blastRadius: null,
  };
}

test("coordinator.prepareDeliverablesForGraph: scopeLock blocks Phase 4 test-pair injection", () => {
  const { dir, cleanup } = setupRunSummaryFixture();
  try {
    const coord = new (Coordinator as any)({ projectRoot: dir });
    const active = buildActiveWithCharter({
      projectRoot: dir,
      prompt:
        "In core/run-summary.ts, find the existing top-of-file comment block. " +
        "At the very end of that block, add a single new comment line that reads exactly: " +
        "'// burn-in: comment-swap probe.' Do not modify anything else.",
    });
    // Sanity: charter scopeLock is set.
    assert.ok(active.intent.charter.scopeLock, "charter.scopeLock must be set");
    const deliverables = coord.prepareDeliverablesForGraph(active, active.analysis);
    const allTargets = deliverables.flatMap((d: any) => d.targetFiles);
    assert.deepEqual(
      allTargets,
      ["core/run-summary.ts"],
      `expected only the source file in dispatch; got [${allTargets.join(", ")}]`,
    );
    for (const t of allTargets) {
      assert.doesNotMatch(t, /\.test\.ts$/, `unexpected test deliverable: ${t}`);
    }
  } finally {
    cleanup();
  }
});

test("coordinator.prepareDeliverablesForGraph: scopeLock strips an out-of-scope deliverable that snuck in", () => {
  const { dir, cleanup } = setupRunSummaryFixture();
  try {
    const coord = new (Coordinator as any)({ projectRoot: dir });
    const active = buildActiveWithCharter({
      projectRoot: dir,
      prompt:
        "In core/run-summary.ts, add a one-line comment. Do not modify anything else.",
    });
    // Simulate a future expansion path that injected a stray
    // deliverable into the (still-frozen original) intent's
    // dispatch path. We do this by directly handing the method an
    // analysis whose targets carry the extra file.
    const analysisExt = {
      ...active.analysis,
      targets: ["core/run-summary.ts", "core/run-summary.test.ts"],
    };
    // The intent.charter.deliverables remain locked to the source —
    // we're testing the coordinator-level allowlist intersection.
    const deliverables = coord.prepareDeliverablesForGraph(active, analysisExt);
    const allTargets = deliverables.flatMap((d: any) => d.targetFiles);
    assert.ok(
      !allTargets.some((t: string) => t.endsWith(".test.ts")),
      `scope lock must strip the test target; got [${allTargets.join(", ")}]`,
    );
  } finally {
    cleanup();
  }
});

test("coordinator.collectChanges: scopeLock filters out out-of-scope FileChanges from a builder result", () => {
  const { dir, cleanup } = setupRunSummaryFixture();
  try {
    const coord = new (Coordinator as any)({ projectRoot: dir });
    const active = buildActiveWithCharter({
      projectRoot: dir,
      prompt:
        "In core/run-summary.ts, add a one-line comment. Do not modify anything else.",
    });
    assert.ok(active.intent.charter.scopeLock);
    const sourceChange: FileChange = {
      path: "core/run-summary.ts",
      operation: "modify",
      diff: "@@ -1 +1 @@\n-old\n+new\n",
      content: "new",
      originalContent: "old",
    };
    const testChange: FileChange = {
      path: "core/run-summary.test.ts",
      operation: "modify",
      diff: "@@ -1 +1 @@\n-x\n+y\n",
      content: "y",
      originalContent: "x",
    };
    const builderResult: WorkerResult = {
      workerType: "builder",
      taskId: "t1",
      success: true,
      output: { kind: "builder", changes: [sourceChange, testChange] } as any,
      issues: [],
      cost: { model: "test", inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
      confidence: 0.9,
      touchedFiles: [],
      assumptions: [],
      durationMs: 1,
    };
    coord.collectChanges(active, builderResult);
    assert.equal(active.changes.length, 1);
    assert.equal(active.changes[0].path, "core/run-summary.ts");
  } finally {
    cleanup();
  }
});

// ─── execution-classification: scope-violation rule wins over no-op ──

function makeReceiptStub(over: Partial<RunReceipt>): RunReceipt {
  return {
    runId: "r",
    intentId: "i",
    verdict: "failed",
    executionVerified: false,
    executionGateReason: "",
    verificationReceipt: null,
    judgmentReport: null,
    mergeDecision: null,
    graphSummary: { totalNodes: 1, completed: 0, failed: 1 },
    ...over,
  } as unknown as RunReceipt;
}

test("classifyExecution: scope-boundary judge blocker wins over the gate-no-op text", () => {
  const receipt = makeReceiptStub({
    executionGateReason:
      "No-op execution detected: 2 change(s) were content-identical — no real modification applied",
    mergeDecision: {
      action: "block",
      findings: [],
      critical: [
        {
          source: "integration-judge",
          severity: "critical",
          code: "judge:scope-boundary",
          message: "scope_violation: \"core/run-summary.test.ts\" is outside the locked scope",
        },
      ],
      advisory: [],
      primaryBlockReason: "scope_violation: \"core/run-summary.test.ts\" is outside the locked scope",
      summary: "MERGE BLOCKED",
    } as any,
  });
  const result = classifyExecution(receipt);
  assert.equal(result.classification, "FAILED");
  assert.equal(result.reasonCode, "scope-violation");
  assert.match(result.reason, /Scope violation/);
  assert.match(result.reason, /run-summary\.test\.ts/);
});

test("classifyExecution: git-diff:unexpected-reference-change is also classified as scope-violation", () => {
  const receipt = makeReceiptStub({
    executionGateReason: "No-op execution detected: 2 change(s) were content-identical",
    mergeDecision: {
      action: "block",
      findings: [],
      critical: [
        {
          source: "change-set-gate",
          severity: "critical",
          code: "git-diff:unexpected-reference-change",
          message: "1 reference/context file(s) changed unexpectedly: core/run-summary.test.ts",
        },
      ],
      advisory: [],
      primaryBlockReason: "1 reference/context file(s) changed unexpectedly: core/run-summary.test.ts",
      summary: "MERGE BLOCKED",
    } as any,
  });
  const result = classifyExecution(receipt);
  assert.equal(result.classification, "FAILED");
  assert.equal(result.reasonCode, "scope-violation");
});

test("classifyExecution: legitimate no-op without scope-violation still classifies as NO_OP", () => {
  // Regression guard — ensure the new rule doesn't swallow the
  // existing gate-no-op classification when there's no scope finding.
  const receipt = makeReceiptStub({
    verdict: "success",
    executionGateReason:
      "No-op execution detected: no files were created, modified, or deleted",
    mergeDecision: {
      action: "block",
      findings: [],
      critical: [],
      advisory: [],
      primaryBlockReason: "",
      summary: "",
    } as any,
  });
  const result = classifyExecution(receipt);
  assert.equal(result.classification, "NO_OP");
  assert.equal(result.reasonCode, "gate-no-op");
});

// ─── burn-in-01 end-to-end shape ─────────────────────────────────────

test("scope-lock: burn-in-01 prompt produces a single-file deliverable + scopeLock (no decomposition)", () => {
  const burnIn01 =
    "In core/run-summary.ts, find the existing top-of-file comment block. " +
    "At the very end of that block, add a single new comment line that reads exactly: " +
    "'// burn-in: comment-swap probe.' Do not modify anything else.";
  const gen = new CharterGenerator({ autoTestDeliverables: true });
  const analysis = gen.analyzeRequest(burnIn01);
  assert.equal(analysis.lockScope, true);
  const charter = gen.generateCharter(analysis);
  // Exactly one deliverable, exactly one target — the file the user named.
  assert.equal(charter.deliverables.length, 1);
  assert.deepEqual([...charter.deliverables[0].targetFiles], ["core/run-summary.ts"]);
  assert.ok(charter.scopeLock);
  assert.deepEqual([...charter.scopeLock.allowedFiles], ["core/run-summary.ts"]);
});
