import test from "node:test";
import assert from "node:assert/strict";
import type { RunReceipt } from "./coordinator.js";
import type { VerificationReceipt } from "./verification-pipeline.js";
import type { MergeDecision } from "./merge-gate.js";
import {
  computeMetrics,
  projectRunList,
  projectRunDetail,
  type TrackedRunLike,
} from "./metrics.js";
import { generateRunSummary } from "./run-summary.js";

// ─── Metrics snapshot ───────────────────────────────────────────────

test("computeMetrics: empty registry → zeroed snapshot", () => {
  const m = computeMetrics([]);
  assert.equal(m.totalRuns, 0);
  assert.equal(m.successfulRuns, 0);
  assert.equal(m.failedRuns, 0);
  assert.equal(m.successRate, 0);
  assert.equal(m.totalCostUsd, 0);
  assert.equal(m.lastRunSummary, null);
});

test("computeMetrics: single verified success → successRate = 1", () => {
  const runs: TrackedRunLike[] = [
    trackedRun({
      taskId: "task_A",
      prompt: "in core/foo.ts, add a helper",
      receipt: verifiedSuccessReceipt({ files: 1, costUsd: 0.02 }),
    }),
  ];
  const m = computeMetrics(runs);
  assert.equal(m.totalRuns, 1);
  assert.equal(m.successfulRuns, 1);
  assert.equal(m.failedRuns, 0);
  assert.equal(m.successRate, 1);
  assert.equal(m.totalCostUsd, 0.02);
  assert.equal(m.avgCostPerRunUsd, 0.02);
  assert.equal(m.avgFilesTouched, 1);
  assert.ok(m.avgConfidence > 0);
  assert.ok(m.lastRunSummary);
  assert.equal(m.lastRunSummary!.classification, "VERIFIED_SUCCESS");
});

test("computeMetrics: mix of verified + failed + in-flight → correct averages", () => {
  const runs: TrackedRunLike[] = [
    trackedRun({
      taskId: "task_A",
      prompt: "fix foo",
      receipt: verifiedSuccessReceipt({ files: 2, costUsd: 0.10 }),
    }),
    trackedRun({
      taskId: "task_B",
      prompt: "fix bar",
      receipt: verifiedSuccessReceipt({ files: 4, costUsd: 0.20 }),
    }),
    trackedRun({
      taskId: "task_C",
      prompt: "break baz",
      receipt: failedReceipt({ costUsd: 0.05 }),
    }),
    trackedRun({
      taskId: "task_D",
      prompt: "queued fix",
      status: "queued",
      receipt: null,
    }),
  ];
  const m = computeMetrics(runs);
  assert.equal(m.totalRuns, 4);
  assert.equal(m.successfulRuns, 2);
  assert.equal(m.failedRuns, 1);
  assert.equal(m.inFlightRuns, 1);
  // successRate denominator excludes in-flight
  assert.equal(m.successRate, Math.round((2 / 3) * 10_000) / 10_000);
  // Cost totals and averages exclude in-flight. The snapshot
  // rounds to 6 decimals for stable JSON output, so we compare
  // against the rounded expected values.
  assert.equal(m.totalCostUsd, 0.35);
  assert.equal(m.avgCostPerRunUsd, Math.round((0.35 / 3) * 1_000_000) / 1_000_000);
  // Files average counts runs with a summary — 2 successes contribute.
  // Rounded to 2 decimals for stable JSON output.
  assert.equal(m.avgFilesTouched, Math.round(((2 + 4) / 3) * 100) / 100);
});

test("computeMetrics: no-op and partial are NOT counted as successful", () => {
  const runs: TrackedRunLike[] = [
    trackedRun({ taskId: "task_A", prompt: "p1", receipt: noOpReceipt() }),
    trackedRun({ taskId: "task_B", prompt: "p2", receipt: partialReceipt() }),
  ];
  const m = computeMetrics(runs);
  assert.equal(m.successfulRuns, 0);
  assert.equal(m.noOpRuns, 1);
  assert.equal(m.partialRuns, 1);
  assert.equal(m.successRate, 0);
});

test("computeMetrics: crashed persisted runs are not counted as in-flight", () => {
  const runs: TrackedRunLike[] = [
    trackedRun({
      taskId: "task_crash",
      prompt: "crash mid-run",
      status: "failed",
      receipt: null,
      error: "server restarted",
      stateCategory: "crashed",
    }),
  ];
  const m = computeMetrics(runs);
  assert.equal(m.totalRuns, 1);
  assert.equal(m.crashedRuns, 1);
  assert.equal(m.inFlightRuns, 0);
  assert.equal(m.failedRuns, 0);
});

test("computeMetrics: lastRunSummary reflects the newest run", () => {
  const runs: TrackedRunLike[] = [
    trackedRun({
      taskId: "task_NEWEST",
      prompt: "newest",
      submittedAt: "2026-04-11T18:00:00.000Z",
      receipt: verifiedSuccessReceipt({ files: 1, costUsd: 0.01 }),
    }),
    trackedRun({
      taskId: "task_OLDER",
      prompt: "older",
      submittedAt: "2026-04-11T15:00:00.000Z",
      receipt: failedReceipt({ costUsd: 0.02 }),
    }),
  ];
  const m = computeMetrics(runs);
  assert.ok(m.lastRunSummary);
  assert.equal(m.lastRunSummary!.taskId, "task_NEWEST");
  assert.equal(m.lastRunSummary!.classification, "VERIFIED_SUCCESS");
});

// ─── Run list + detail ─────────────────────────────────────────────

test("projectRunList: returns lightweight list items grounded in receipts", () => {
  const runs: TrackedRunLike[] = [
    trackedRun({
      taskId: "task_A",
      prompt: "fix foo",
      receipt: verifiedSuccessReceipt({ files: 3, costUsd: 0.12 }),
    }),
  ];
  const items = projectRunList(runs, 10);
  assert.equal(items.length, 1);
  const item = items[0];
  assert.equal(item.id, "task_A");
  assert.equal(item.classification, "VERIFIED_SUCCESS");
  assert.equal(item.filesTouched, 3);
  assert.equal(item.costUsd, 0.12);
  assert.ok(item.confidence > 0);
  assert.match(item.summary, /Aedis updated/);
});

test("projectRunList: respects the limit", () => {
  const runs: TrackedRunLike[] = Array.from({ length: 30 }, (_, i) =>
    trackedRun({
      taskId: `task_${i}`,
      prompt: `p${i}`,
      receipt: verifiedSuccessReceipt({ files: 1, costUsd: 0.01 }),
    }),
  );
  assert.equal(projectRunList(runs, 10).length, 10);
  assert.equal(projectRunList(runs, 5).length, 5);
});

test("projectRunDetail: verified success run exposes receipts + files + summary + confidence", () => {
  const run = trackedRun({
    taskId: "task_A",
    prompt: "in core/foo.ts, add a helper",
    receipt: verifiedSuccessReceipt({ files: 2, costUsd: 0.08 }),
  });
  const detail = projectRunDetail(run);
  assert.ok(detail);
  assert.equal(detail!.id, "task_A");
  assert.ok(detail!.receipt);
  assert.ok(detail!.filesChanged.length > 0);
  assert.equal(detail!.summary.classification, "VERIFIED_SUCCESS");
  assert.match(detail!.summary.headline, /Aedis updated/);
  assert.ok(detail!.confidence.overall > 0);
  assert.equal(detail!.errors.length, 0);
  assert.equal(detail!.executionVerified, true);
});

test("projectRunDetail: failed run surfaces errors with suggested fix", () => {
  const run = trackedRun({
    taskId: "task_X",
    prompt: "break things",
    status: "failed",
    receipt: failedReceipt({ costUsd: 0.01 }),
  });
  const detail = projectRunDetail(run);
  assert.ok(detail);
  assert.equal(detail!.summary.classification, "FAILED");
  assert.ok(detail!.errors.length >= 1, "failed runs should carry at least one error entry");
  // The failure explainer attaches a root cause + suggested fix
  // when humanSummary.failureExplanation is populated.
  const hasSuggestion = detail!.errors.some((e) => e.suggestedFix && e.suggestedFix.length > 0);
  assert.ok(hasSuggestion, "expected a suggestedFix on at least one error entry");
});

test("projectRunDetail: in-flight run (no receipt) returns a legible skeleton", () => {
  const run = trackedRun({
    taskId: "task_Q",
    prompt: "queued",
    status: "queued",
    receipt: null,
  });
  const detail = projectRunDetail(run);
  assert.ok(detail);
  assert.equal(detail!.receipt, null);
  assert.equal(detail!.filesChanged.length, 0);
  assert.equal(detail!.summary.classification, null);
  assert.equal(detail!.confidence.overall, 0);
});

test("projectRunDetail: returns null for missing run", () => {
  assert.equal(projectRunDetail(null), null);
  assert.equal(projectRunDetail(undefined), null);
});

// ─── Fixtures ──────────────────────────────────────────────────────

function trackedRun(opts: {
  taskId: string;
  prompt: string;
  status?: TrackedRunLike["status"];
  submittedAt?: string;
  completedAt?: string | null;
  runId?: string | null;
  receipt: RunReceipt | null;
  error?: string | null;
  stateCategory?: TrackedRunLike["stateCategory"];
}): TrackedRunLike {
  return {
    taskId: opts.taskId,
    runId: opts.runId ?? `run_${opts.taskId}`,
    status: opts.status ?? (opts.receipt ? "complete" : "queued"),
    prompt: opts.prompt,
    submittedAt: opts.submittedAt ?? "2026-04-11T17:00:00.000Z",
    completedAt: opts.completedAt ?? (opts.receipt ? "2026-04-11T17:10:00.000Z" : null),
    receipt: opts.receipt,
    error: opts.error ?? null,
    stateCategory: opts.stateCategory,
  };
}

function verifiedSuccessReceipt(opts: { files: number; costUsd: number }): RunReceipt {
  const evidence = Array.from({ length: opts.files }, (_, i) => ({
    kind: "file_modified" as const,
    ref: `core/file-${i}.ts`,
    verifiedOnDisk: true,
  }));
  const base = baseReceipt({
    verdict: "success",
    executionVerified: true,
    executionGateReason: `Execution verified: ${opts.files} file(s) modified`,
    verification: { verdict: "pass", confidenceScore: 0.9 },
    totalCost: { model: "test", inputTokens: 100, outputTokens: 100, estimatedCostUsd: opts.costUsd },
    commitSha: "abc1234567890",
    evidence,
  });
  return withSummary(base, `fix ${opts.files} file(s)`);
}

function failedReceipt(opts: { costUsd: number }): RunReceipt {
  const base = baseReceipt({
    verdict: "failed",
    executionVerified: false,
    executionGateReason: "Execution errored: ENOENT: no such file or directory, open '/tmp/missing.ts'",
    totalCost: { model: "test", inputTokens: 50, outputTokens: 50, estimatedCostUsd: opts.costUsd },
  });
  return withSummary(base, "write to a missing path");
}

function noOpReceipt(): RunReceipt {
  const base = baseReceipt({
    verdict: "failed",
    executionVerified: false,
    executionGateReason: "No-op execution detected: no files were created, modified, or deleted",
    totalCost: { model: "test", inputTokens: 50, outputTokens: 50, estimatedCostUsd: 0.02 },
  });
  return withSummary(base, "build something");
}

function partialReceipt(): RunReceipt {
  const base = baseReceipt({
    verdict: "partial",
    executionVerified: true,
    executionGateReason: "Execution verified: 1 file modified",
    verification: { verdict: "pass-with-warnings", confidenceScore: 0.6 },
    totalCost: { model: "test", inputTokens: 50, outputTokens: 50, estimatedCostUsd: 0.03 },
    evidence: [{ kind: "file_modified", ref: "core/foo.ts", verifiedOnDisk: true }],
  });
  return withSummary(base, "adjust foo");
}

function withSummary(receipt: RunReceipt, prompt: string): RunReceipt {
  const summary = generateRunSummary({
    receipt,
    userPrompt: prompt,
    scopeClassification: {
      type: "single-file",
      blastRadius: 1,
      recommendDecompose: false,
      reason: "test",
      governance: { decompositionRequired: false, approvalRequired: false, escalationRecommended: false, wavesRequired: false },
    },
    changes: receipt.executionEvidence
      .filter((e) => e.kind === "file_modified" || e.kind === "file_created" || e.kind === "file_deleted")
      .map((e) => ({
        path: e.ref,
        operation:
          e.kind === "file_created"
            ? ("create" as const)
            : e.kind === "file_deleted"
              ? ("delete" as const)
              : ("modify" as const),
      })),
  });
  return { ...receipt, humanSummary: summary };
}

interface BaseReceiptOpts {
  verdict: RunReceipt["verdict"];
  executionVerified: boolean;
  executionGateReason: string;
  verification?: { verdict: VerificationReceipt["verdict"]; confidenceScore: number };
  merge?: { action: MergeDecision["action"]; primaryBlockReason?: string };
  totalCost?: { model: string; inputTokens: number; outputTokens: number; estimatedCostUsd: number };
  commitSha?: string | null;
  evidence?: { kind: "file_created" | "file_modified" | "file_deleted"; ref: string; verifiedOnDisk: boolean }[];
}

function baseReceipt(opts: BaseReceiptOpts): RunReceipt {
  const verification: VerificationReceipt | null = opts.verification
    ? {
        id: "v-1",
        runId: "run-1",
        intentId: "intent-1",
        timestamp: "2026-04-11T17:00:00.000Z",
        verdict: opts.verification.verdict,
        confidenceScore: opts.verification.confidenceScore,
        stages: [],
        judgmentReport: null,
        allIssues: [],
        blockers: [],
        requiredChecks: ["lint", "typecheck", "tests"],
        // Stub one executed required check matching the declared verdict.
        // Fixtures used to leave checks: [] which made
        // computeVerificationNoSignal report "no signal" — production
        // verdict="pass" always has at least one executed check.
        checks: [{
          kind: "typecheck",
          name: "stub-typecheck",
          executed: true,
          passed: opts.verification.verdict !== "fail",
          required: true,
          details: "",
        }],
        summary: `verification ${opts.verification.verdict}`,
        totalDurationMs: 10,
        fileCoverage: null,
        coverageRatio: null,
        validatedRatio: null,
      }
    : null;

  const merge: MergeDecision | null = opts.merge
    ? {
        action: opts.merge.action,
        findings: [],
        critical: [],
        advisory: [],
        primaryBlockReason: opts.merge.primaryBlockReason ?? "",
        summary: opts.merge.action,
      }
    : null;

  return {
    id: "receipt-1",
    runId: "run-1",
    intentId: "intent-1",
    timestamp: "2026-04-11T17:00:00.000Z",
    verdict: opts.verdict,
    summary: {
      runId: "run-1",
      intentId: "intent-1",
      phase: opts.verdict === "failed" ? "failed" : "complete",
      taskCounts: {
        total: 3,
        pending: 0,
        active: 0,
        completed: 2,
        failed: opts.verdict === "failed" ? 1 : 0,
        skipped: 0,
      },
      totalCost: opts.totalCost ?? {
        model: "test",
        inputTokens: 10,
        outputTokens: 10,
        estimatedCostUsd: 0.01,
      },
      filesModified: 1,
      assumptions: 0,
      decisions: 0,
      issues: { info: 0, warning: 0, error: 0, critical: 0 },
      duration: 100,
    },
    graphSummary: {
      totalNodes: 5,
      planned: 0,
      ready: 0,
      dispatched: 0,
      completed: 5,
      failed: 0,
      skipped: 0,
      blocked: 0,
      edgeCount: 4,
      mergeGroupCount: 0,
      checkpointCount: 0,
      escalationCount: 0,
    },
    verificationReceipt: verification,
    waveVerifications: [],
    judgmentReport: null,
    mergeDecision: merge,
    totalCost: opts.totalCost ?? {
      model: "test",
      inputTokens: 10,
      outputTokens: 10,
      estimatedCostUsd: 0.01,
    },
    commitSha: opts.commitSha ?? null,
    durationMs: 100,
    executionVerified: opts.executionVerified,
    executionGateReason: opts.executionGateReason,
    executionEvidence: opts.evidence ?? [],
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
