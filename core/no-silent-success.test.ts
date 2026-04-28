/**
 * No-Silent-Success regression suite.
 *
 * Five paths where Aedis used to be able to report success without
 * actually completing or verifying the work. Each test pins one
 * invariant of the classification taxonomy:
 *
 *   1. No effective diff cannot become success — the existing
 *      gate-no-op rule was already enforcing this; pin it so the
 *      regression doesn't sneak back in.
 *   2. Missing required deliverable cannot become success —
 *      previously computed only in the explanation lines, now a
 *      hard FAILED with reasonCode "missing-deliverable".
 *   3. Merge blocked cannot become PARTIAL_SUCCESS — verdict-failed
 *      + merge action=block must classify as FAILED merge-blocked.
 *   4. Verifier did not run cannot become VERIFIED_SUCCESS — when
 *      `verificationNoSignal` is true, classification is FAILED with
 *      reasonCode "verification-not-run".
 *   5. Shadow selected but no source commit cannot be reported as
 *      success — shadow workspaces never promote, so the receipt
 *      cannot honestly call this a verified result.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { classifyExecution } from "./execution-classification.js";
import type { RunReceipt } from "./coordinator.js";
import type { VerificationReceipt } from "./verification-pipeline.js";
import type { MergeDecision } from "./merge-gate.js";

// ─── Receipt factory ────────────────────────────────────────────────

interface ReceiptShape {
  verdict?: RunReceipt["verdict"];
  executionVerified?: boolean;
  executionGateReason?: string;
  commitSha?: string | null;
  verification?: { verdict: VerificationReceipt["verdict"] };
  merge?: { action: MergeDecision["action"]; primaryBlockReason?: string };
  selectedCandidateWorkspaceId?: string | null;
  candidates?: RunReceipt["candidates"];
  graphTotalNodes?: number;
}

function r(o: ReceiptShape): RunReceipt {
  const verdict = o.verdict ?? "success";
  const verification: VerificationReceipt | null = o.verification
    ? {
        id: "v-1",
        runId: "run-1",
        intentId: "intent-1",
        timestamp: "2026-04-28T00:00:00.000Z",
        verdict: o.verification.verdict,
        confidenceScore: 0.9,
        stages: [],
        judgmentReport: null,
        allIssues: [],
        blockers: [],
        requiredChecks: [],
        checks: [],
        summary: `verification ${o.verification.verdict}`,
        totalDurationMs: 10,
        fileCoverage: null,
        coverageRatio: null,
        validatedRatio: null,
      }
    : null;
  const merge: MergeDecision | null = o.merge
    ? {
        action: o.merge.action,
        findings: [],
        critical: [],
        advisory: [],
        primaryBlockReason: o.merge.primaryBlockReason ?? "",
        summary: o.merge.action,
      }
    : null;
  const graphTotalNodes = o.graphTotalNodes ?? 5;
  return {
    id: "receipt-1",
    runId: "run-1",
    intentId: "intent-1",
    timestamp: "2026-04-28T00:00:00.000Z",
    verdict,
    summary: {
      runId: "run-1",
      intentId: "intent-1",
      phase: verdict === "failed" ? "failed" : "complete",
      taskCounts: { total: 3, pending: 0, active: 0, completed: 2, failed: verdict === "failed" ? 1 : 0, skipped: 0 },
      totalCost: { model: "test", inputTokens: 10, outputTokens: 20, estimatedCostUsd: 0.01 },
      filesModified: 1,
      assumptions: 0,
      decisions: 0,
      issues: { info: 0, warning: 0, error: 0, critical: 0 },
      duration: 100,
    },
    graphSummary: {
      totalNodes: graphTotalNodes, planned: 0, ready: 0, dispatched: 0,
      completed: graphTotalNodes, failed: 0, skipped: 0, blocked: 0,
      edgeCount: 0, mergeGroupCount: 0, checkpointCount: 0, escalationCount: 0,
    },
    verificationReceipt: verification,
    waveVerifications: [],
    judgmentReport: null,
    mergeDecision: merge,
    totalCost: { model: "test", inputTokens: 10, outputTokens: 20, estimatedCostUsd: 0.01 },
    commitSha: o.commitSha ?? null,
    durationMs: 100,
    executionVerified: o.executionVerified ?? true,
    executionGateReason: o.executionGateReason ?? "",
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
    ...(o.selectedCandidateWorkspaceId !== undefined
      ? { selectedCandidateWorkspaceId: o.selectedCandidateWorkspaceId }
      : {}),
    ...(o.candidates !== undefined ? { candidates: o.candidates } : {}),
  };
}

// ─── 1. No effective diff cannot become success ─────────────────────

test("no-silent-success: gate-no-op (no effective diff) classifies as NO_OP, never success", () => {
  const receipt = r({
    verdict: "success",
    executionVerified: false,
    executionGateReason: "No-op execution detected: builder produced no diff",
    commitSha: null,
  });
  const result = classifyExecution(receipt);
  assert.equal(result.classification, "NO_OP");
  assert.equal(result.reasonCode, "gate-no-op");
  // The 'success' verdict from upstream MUST be downgraded.
  assert.notEqual(result.classification, "VERIFIED_SUCCESS");
  assert.notEqual(result.classification, "PARTIAL_SUCCESS");
});

// ─── 2. Missing required deliverable cannot become success ──────────

test("no-silent-success: missing required deliverable cannot become VERIFIED_SUCCESS", () => {
  // Verdict is success, every gate passed, but the planner declared
  // a required test file and the builder didn't produce it. This was
  // the "missing test cannot become approval" path the user asked to
  // pin. Classification must be FAILED with reasonCode missing-deliverable.
  const receipt = r({
    verdict: "success",
    executionVerified: true,
    verification: { verdict: "pass" },
    merge: { action: "apply" },
    commitSha: "abcd1234",
  });
  const result = classifyExecution(receipt, {
    missingRequiredDeliverables: ["test/normalizer.test.ts"],
  });
  assert.equal(result.classification, "FAILED");
  assert.equal(result.reasonCode, "missing-deliverable");
  assert.match(result.reason, /test\/normalizer\.test\.ts/);
});

test("no-silent-success: missing required deliverable downgrades partial too", () => {
  const receipt = r({
    verdict: "partial",
    executionVerified: true,
    verification: { verdict: "pass-with-warnings" },
  });
  const result = classifyExecution(receipt, {
    missingRequiredDeliverables: ["src/foo.ts", "test/foo.test.ts", "docs/foo.md"],
  });
  assert.equal(result.classification, "FAILED");
  assert.equal(result.reasonCode, "missing-deliverable");
  // Lists up to 3, then "+N more" would kick in past that.
  assert.match(result.reason, /src\/foo\.ts/);
  assert.match(result.reason, /test\/foo\.test\.ts/);
});

test("no-silent-success: empty missing-deliverable list does not downgrade", () => {
  // Negative case — when nothing is missing, the rule must not fire.
  const receipt = r({
    verdict: "success",
    executionVerified: true,
    verification: { verdict: "pass" },
    merge: { action: "apply" },
  });
  const result = classifyExecution(receipt, { missingRequiredDeliverables: [] });
  assert.equal(result.classification, "VERIFIED_SUCCESS");
});

// ─── 3. Merge blocked cannot become PARTIAL_SUCCESS ─────────────────

test("no-silent-success: merge-blocked verdict=failed classifies as FAILED merge-blocked", () => {
  const receipt = r({
    verdict: "failed",
    executionVerified: true,
    merge: { action: "block", primaryBlockReason: "1 critical typecheck failure" },
  });
  const result = classifyExecution(receipt);
  assert.equal(result.classification, "FAILED");
  assert.equal(result.reasonCode, "merge-blocked");
  // Cannot be a partial — the merge gate is hard.
  assert.notEqual(result.classification, "PARTIAL_SUCCESS");
});

// ─── 4. Verifier did not run cannot become VERIFIED_SUCCESS ─────────

test("no-silent-success: verification-not-run downgrades success to FAILED", () => {
  // The runtime ran, files were written, execution gate verified them
  // — but no verification check produced any signal (no required
  // checks AND no file actively validated). Cannot honestly be a
  // verified success.
  const receipt = r({
    verdict: "success",
    executionVerified: true,
    commitSha: "deadbeef",
  });
  const result = classifyExecution(receipt, { verificationNoSignal: true });
  assert.equal(result.classification, "FAILED");
  assert.equal(result.reasonCode, "verification-not-run");
});

test("no-silent-success: verification-not-run also downgrades PARTIAL_SUCCESS", () => {
  const receipt = r({ verdict: "partial", executionVerified: true });
  const result = classifyExecution(receipt, { verificationNoSignal: true });
  assert.equal(result.classification, "FAILED");
  assert.equal(result.reasonCode, "verification-not-run");
});

// ─── 5. Shadow selected but no source commit cannot become success ─

test("no-silent-success: shadow candidate selected with no source commit → FAILED", () => {
  // Selection picked a shadow candidate, but commitSha is null →
  // shadow workspaces cannot promote, so the operator's source repo
  // saw no change. Reporting this as success would lie.
  const receipt = r({
    verdict: "success",
    executionVerified: true,
    verification: { verdict: "pass" },
    commitSha: null,
    selectedCandidateWorkspaceId: "shadow-1",
    candidates: [
      {
        workspaceId: "primary",
        role: "primary",
        status: "failed",
        disqualification: "status=failed",
        costUsd: 0,
        latencyMs: 1,
        verifierVerdict: "fail",
        reason: "primary failed",
      },
      {
        workspaceId: "shadow-1",
        role: "shadow",
        status: "passed",
        disqualification: null,
        costUsd: 0.01,
        latencyMs: 200,
        verifierVerdict: "pass",
        reason: "shadow ok",
      },
    ],
  });
  const result = classifyExecution(receipt);
  assert.equal(result.classification, "FAILED");
  assert.equal(result.reasonCode, "shadow-selected-not-applied");
  assert.match(result.reason, /shadow-1/);
});

test("no-silent-success: primary candidate selected with commitSha is unaffected", () => {
  // Negative case — primary selected with a real commitSha should
  // pass through to VERIFIED_SUCCESS as before.
  const receipt = r({
    verdict: "success",
    executionVerified: true,
    verification: { verdict: "pass" },
    commitSha: "abc12345",
    selectedCandidateWorkspaceId: "primary",
    candidates: [
      {
        workspaceId: "primary",
        role: "primary",
        status: "passed",
        disqualification: null,
        costUsd: 0,
        latencyMs: 1,
        verifierVerdict: "pass",
        reason: "primary ok",
      },
    ],
  });
  const result = classifyExecution(receipt);
  assert.equal(result.classification, "VERIFIED_SUCCESS");
});

test("no-silent-success: shadow selected WITH commitSha is unaffected (defensive only on missing commit)", () => {
  // Shadow can never actually promote in current code, but the rule
  // only fires when commitSha is null. If somehow commitSha is set
  // (legacy receipt, future selection-swap pathway), don't flip.
  const receipt = r({
    verdict: "success",
    executionVerified: true,
    verification: { verdict: "pass" },
    commitSha: "abc12345",
    selectedCandidateWorkspaceId: "shadow-1",
    candidates: [
      {
        workspaceId: "shadow-1",
        role: "shadow",
        status: "passed",
        disqualification: null,
        costUsd: 0.01,
        latencyMs: 200,
        verifierVerdict: "pass",
        reason: "shadow ok",
      },
    ],
  });
  const result = classifyExecution(receipt);
  // Not VERIFIED_SUCCESS necessarily, but specifically NOT
  // shadow-selected-not-applied. The rule is conservative.
  assert.notEqual(result.reasonCode, "shadow-selected-not-applied");
});

// ─── Defense-in-depth: rule ordering ────────────────────────────────

test("no-silent-success: missing-deliverable rule fires AFTER unverified-verdict rule", () => {
  // If a run is BOTH unverified AND missing deliverables, the
  // unverified rule wins (more fundamental — no evidence at all).
  const receipt = r({
    verdict: "success",
    executionVerified: false, // unverified
    commitSha: null,
  });
  const result = classifyExecution(receipt, {
    missingRequiredDeliverables: ["foo.ts"],
  });
  assert.equal(result.classification, "NO_OP");
  assert.equal(result.reasonCode, "unverified-verdict");
});

test("no-silent-success: scope-violation rule fires BEFORE merge-blocked", () => {
  // When the merge gate blocks for a scope violation, the scope
  // rule wins so the operator sees the actual cause.
  const receipt = r({
    verdict: "failed",
    merge: { action: "block", primaryBlockReason: "scope" },
  });
  // Inject a scope-violation finding via type-cast — the production
  // path uses MergeDecision.critical[].code which the test factory
  // doesn't expose directly.
  const withScope = {
    ...receipt,
    mergeDecision: {
      ...receipt.mergeDecision!,
      critical: [
        {
          code: "judge:scope-boundary",
          message: "Touched out-of-scope file core/forbidden.ts",
          severity: "critical" as const,
          source: "integration-judge" as const,
        },
      ],
    },
  } as RunReceipt;
  const result = classifyExecution(withScope);
  assert.equal(result.classification, "FAILED");
  assert.equal(result.reasonCode, "scope-violation");
});
