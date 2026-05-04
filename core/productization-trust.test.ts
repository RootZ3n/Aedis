import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { recordTask, loadMemory, findPatternWarnings } from "./project-memory.js";
import { assessRepoReadiness } from "./repo-readiness.js";
import { VerificationPipeline, createCustomHook } from "./verification-pipeline.js";
import { generateRunSummary } from "./run-summary.js";
import { scoreRunConfidence } from "./confidence-scoring.js";
import type { EvaluationAttachment } from "./post-run-evaluator.js";
import type { RunReceipt } from "./coordinator.js";

test("pattern memory warns when similar tasks usually need more files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aedis-pattern-"));
  try {
    await recordTask(dir, {
      prompt: "refactor auth flow",
      normalizedPrompt: "refactor auth flow",
      verdict: "failed",
      commitSha: null,
      cost: 0,
      timestamp: "2026-04-13T00:00:00.000Z",
      scopeType: "multi-file",
      filesTouched: ["src/auth.ts", "src/session.ts", "src/routes.ts", "src/auth.test.ts"],
      verificationCoverageRatio: 0.5,
      failureSummary: "Missed required integration file",
    });
    await recordTask(dir, {
      prompt: "refactor auth flow",
      normalizedPrompt: "refactor auth flow",
      verdict: "success",
      commitSha: null,
      cost: 0,
      timestamp: "2026-04-13T00:05:00.000Z",
      scopeType: "multi-file",
      filesTouched: ["src/auth.ts", "src/session.ts", "src/routes.ts", "src/auth.test.ts", "src/types.ts"],
      verificationCoverageRatio: 1,
    });

    const memory = await loadMemory(dir);
    const warnings = findPatternWarnings(memory, {
      prompt: "refactor auth flow",
      scopeType: "multi-file",
      plannedFilesCount: 2,
    });

    assert.ok(warnings.some((warning) => /usually touch about/i.test(warning)));
    assert.ok(warnings.some((warning) => /verification gaps|common issue/i.test(warning)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("repo readiness flags unusual layouts and missing tests", () => {
  const dir = mkdtempSync(join(tmpdir(), "aedis-readiness-"));
  try {
    mkdirSync(join(dir, "custom"), { recursive: true });
    writeFileSync(join(dir, "custom", "feature.ts"), "export const feature = 1;\n");

    const assessment = assessRepoReadiness({
      projectRoot: dir,
      changedFiles: ["custom/feature.ts"],
      verificationReceipt: null,
    });

    assert.equal(assessment.reviewRequired, true);
    assert.ok(assessment.warnings.some((warning) => /non-standard/i.test(warning)));
    assert.ok(assessment.warnings.some((warning) => /no obvious test pair/i.test(warning)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("strict mode fails when files are only structurally checked", async () => {
  const pipeline = new VerificationPipeline({
    requiredChecks: [],
    strictMode: true,
  });

  const receipt = await pipeline.verify(
    intentFixture(),
    runStateFixture(),
    [changeFixture("src/example.ts")],
    [],
  );

  assert.equal(receipt.verdict, "fail");
  assert.match(receipt.summary, /strict mode/i);
});

test("run summary explanation compresses manifest, verification, and consistency truth", () => {
  const summary = generateRunSummary({
    receipt: receiptFixture(),
    userPrompt: "update auth flow",
    changes: [
      { path: "src/types/auth.d.ts", operation: "modify" },
      { path: "src/auth.ts", operation: "modify" },
      { path: "src/routes/index.ts", operation: "modify" },
      { path: "src/auth.test.ts", operation: "modify" },
    ],
    requiredFiles: ["src/auth.ts", "src/routes/index.ts"],
    projectRoot: process.cwd(),
    gitDiffConfirmationRatio: 0.5,
    gitDiffResult: {
      actualChangedFiles: ["src/auth.ts", "src/routes/index.ts", "src/extra.ts"],
      expectedButUnchanged: ["src/auth.test.ts"],
      undeclaredChanges: ["src/extra.ts"],
      unexpectedReferenceChanges: [],
      confirmed: ["src/auth.ts", "src/routes/index.ts"],
      filesWithDiffLines: ["src/auth.ts", "src/routes/index.ts"],
      filesWithoutDiffLines: ["src/auth.test.ts"],
      changedLineCount: 4,
      passed: false,
      confirmationRatio: 0.5,
      summary: "2/4 manifest files confirmed on disk, 1 expected but unchanged, 1 undeclared changes",
      rawDiffStat: "",
    },
    patternWarnings: ["Similar multi-file:build tasks usually touch about 5 files; current plan may be too narrow."],
  });

  assert.ok(summary.explanationLines.length >= 4);
  assert.ok(summary.explanationLines.length <= 6);
  // Line 1: scope summary with role breakdown
  assert.ok(summary.explanationLines.some((line) => /Updated \d+ file/i.test(line) || /no file changes/i.test(line)));
  // Line 2: manifest result (required files + undeclared)
  assert.ok(summary.explanationLines.some((line) => /required files|undeclared/i.test(line)));
  // Line 3: verification coverage + validation
  assert.ok(summary.explanationLines.some((line) => /Verification:/i.test(line)));
  // Line 5: git diff truth
  assert.ok(summary.explanationLines.some((line) => /Git diff:/i.test(line)));
});

test("confidence calibration downgrades overconfident failed evaluations", () => {
  const evaluation: EvaluationAttachment = {
    schema: "aedis.evaluation.v1",
    attempted: true,
    completed: true,
    reason: "completed",
    startedAt: "2026-04-13T00:00:00.000Z",
    completedAt: "2026-04-13T00:00:01.000Z",
    durationMs: 1000,
    taskResults: [],
    aggregate: {
      tasksAttempted: 1,
      tasksPassed: 0,
      tasksFailed: 1,
      tasksErrored: 0,
      averageScore: 0.41,
      overallPass: false,
      summary: "evaluation failed",
    },
    disagreement: {
      aedisConfidence: 0.82,
      crucibulumScore: 0.41,
      gap: 0.41,
      severity: "significant",
      direction: "aedis-overconfident",
      summary: "Aedis was materially overconfident.",
      escalate: true,
    },
    confidenceAdjustment: {
      direction: "downgrade",
      delta: -0.1,
      reason: "evaluation failure",
    },
  };

  const confidence = scoreRunConfidence({
    receipt: {
      ...receiptFixture(),
      evaluation,
    },
    filesTouched: 4,
    verificationCoverageRatio: 0.5,
    validationDepthRatio: 0.5,
    gitDiffConfirmationRatio: 0.5,
    undeclaredChangesCount: 1,
    expectedButUnchangedCount: 1,
    evaluation,
  });

  assert.ok(confidence.overall < 0.5, `expected calibrated confidence < 0.5, got ${confidence.overall}`);
  assert.ok(confidence.basis.some((line) => /evaluation:/i.test(line)));
});

function intentFixture(): any {
  return {
    id: "intent-1",
    exclusions: [],
    charter: {
      objective: "update example",
      successCriteria: ["works"],
      deliverables: [
        {
          description: "update src/example.ts",
          targetFiles: ["src/example.ts"],
        },
      ],
    },
  };
}

function runStateFixture(): any {
  return {
    id: "run-1",
    assumptions: [],
  };
}

function changeFixture(path: string): any {
  return {
    path,
    operation: "modify",
    diff: "-export const oldValue = 1;\n+export const newValue = 2;\n",
    content: "export const newValue = 2;\n",
    originalContent: "export const oldValue = 1;\n",
  };
}

function receiptFixture(): RunReceipt {
  return {
    id: "receipt-1",
    runId: "run-1",
    intentId: "intent-1",
    timestamp: "2026-04-13T00:00:00.000Z",
    verdict: "failed",
    summary: {
      runId: "run-1",
      intentId: "intent-1",
      phase: "verifying",
      taskCounts: { total: 4, pending: 0, active: 0, completed: 3, failed: 1, skipped: 0 },
      totalCost: { model: "test", inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
      filesModified: 4,
      assumptions: 0,
      decisions: 1,
      issues: { info: 0, warning: 0, error: 1, critical: 0 },
      duration: 100,
    },
    graphSummary: {
      totalNodes: 4,
      planned: 0,
      ready: 0,
      dispatched: 0,
      completed: 4,
      failed: 0,
      skipped: 0,
      blocked: 0,
      edgeCount: 0,
      mergeGroupCount: 0,
      checkpointCount: 0,
      escalationCount: 0,
    },
    verificationReceipt: {
      id: "verify-1",
      runId: "run-1",
      intentId: "intent-1",
      timestamp: "2026-04-13T00:00:00.000Z",
      verdict: "fail",
      confidenceScore: 0.35,
      stages: [],
      judgmentReport: null,
      allIssues: [
        {
          stage: "typecheck",
          severity: "error",
          message: "Cannot find name 'AuthToken'",
          file: "src/auth.ts",
        },
      ],
      blockers: [],
      requiredChecks: ["lint", "typecheck", "tests"],
      checks: [
        { kind: "lint", name: "Lint", required: true, executed: true, passed: true, details: "Lint passed" },
        { kind: "typecheck", name: "Typecheck", required: true, executed: true, passed: false, details: "Typecheck failed" },
        { kind: "tests", name: "Tests", required: true, executed: true, passed: true, details: "Tests passed" },
      ],
      summary: "FAIL",
      totalDurationMs: 10,
      fileCoverage: [
        { path: "src/types/auth.d.ts", verifiedByStages: ["diff-check"], verified: true, depth: "checked", hasActiveErrors: false },
        { path: "src/auth.ts", verifiedByStages: ["typecheck"], verified: true, depth: "validated", hasActiveErrors: true },
        { path: "src/routes/index.ts", verifiedByStages: ["diff-check"], verified: true, depth: "checked", hasActiveErrors: false },
        { path: "src/auth.test.ts", verifiedByStages: [], verified: false, depth: "none", hasActiveErrors: false },
      ],
      coverageRatio: 0.75,
      validatedRatio: 0.25,
    },
    waveVerifications: [
      {
        id: "wave-1",
        runId: "run-1",
        intentId: "intent-1",
        timestamp: "2026-04-13T00:00:00.000Z",
        verdict: "pass",
        confidenceScore: 0.9,
        stages: [],
        judgmentReport: null,
        allIssues: [],
        blockers: [],
        requiredChecks: [],
        checks: [],
        summary: "PASS",
        totalDurationMs: 0,
        fileCoverage: [],
        coverageRatio: 1,
        validatedRatio: 1,
      },
      {
        id: "wave-2",
        runId: "run-1",
        intentId: "intent-1",
        timestamp: "2026-04-13T00:00:00.000Z",
        verdict: "fail",
        confidenceScore: 0.4,
        stages: [],
        judgmentReport: null,
        allIssues: [],
        blockers: [],
        requiredChecks: [],
        checks: [],
        summary: "FAIL",
        totalDurationMs: 0,
        fileCoverage: [],
        coverageRatio: 0.5,
        validatedRatio: 0.5,
      },
    ],
    judgmentReport: null,
    mergeDecision: {
      action: "block",
      findings: [],
      critical: [],
      advisory: [],
      primaryBlockReason: "Typecheck failed",
      summary: "merge blocked",
    },
    totalCost: {
      model: "test",
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
    },
    commitSha: null,
    durationMs: 100,
    executionVerified: true,
    executionGateReason: "Execution verified: 4 file(s) modified",
    executionEvidence: [],
    executionReceipts: [],
    humanSummary: null,
    blastRadius: null,
    evaluation: null,
    confidenceGate: null,
    patchArtifact: null,
    workspaceCleanup: null,
    sourceRepo: null,
    sourceCommitSha: null,
  };
}
