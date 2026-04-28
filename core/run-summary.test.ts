import test from "node:test";
import assert from "node:assert/strict";
import type { RunReceipt } from "./coordinator.js";
import type { VerificationReceipt } from "./verification-pipeline.js";
import type { MergeDecision } from "./merge-gate.js";
import type { ScopeClassification } from "./scope-classifier.js";
import { classifyExecution } from "./execution-classification.js";
import { estimateBlastRadius } from "./blast-radius.js";
import { scoreRunConfidence } from "./confidence-scoring.js";
import { explainFailure } from "./failure-explainer.js";
import { generateRunSummary } from "./run-summary.js";

// ─── Execution classification ──────────────────────────────────────

test("classification: success + verified + passing verification → VERIFIED_SUCCESS", () => {
  const r = classifyExecution(receipt({
    verdict: "success",
    executionVerified: true,
    executionGateReason: "Execution verified: 2 file(s) modified",
    verification: { verdict: "pass", confidenceScore: 0.9 },
  }));
  assert.equal(r.classification, "VERIFIED_SUCCESS");
  assert.equal(r.reasonCode, "verified");
});

test("classification: partial with warnings → PARTIAL_SUCCESS", () => {
  const r = classifyExecution(receipt({
    verdict: "partial",
    executionVerified: true,
    executionGateReason: "Execution verified: 1 file modified",
    verification: { verdict: "pass-with-warnings", confidenceScore: 0.6 },
  }));
  assert.equal(r.classification, "PARTIAL_SUCCESS");
});

test("classification: gate no-op → NO_OP", () => {
  const r = classifyExecution(receipt({
    verdict: "failed",
    executionVerified: false,
    executionGateReason: "No-op execution detected: no files were created, modified, or deleted",
  }));
  assert.equal(r.classification, "NO_OP");
  assert.equal(r.reasonCode, "gate-no-op");
});

test("classification: empty graph special message", () => {
  const r = classifyExecution(receipt({
    verdict: "failed",
    executionVerified: false,
    executionGateReason: "No-op execution detected: task graph produced zero nodes",
    graphTotalNodes: 0,
  }));
  assert.equal(r.classification, "NO_OP");
  assert.match(r.reason, /zero actionable nodes/);
});

test("classification: gate errored → FAILED", () => {
  const r = classifyExecution(receipt({
    verdict: "failed",
    executionVerified: false,
    executionGateReason: "Execution errored: kaboom",
  }));
  assert.equal(r.classification, "FAILED");
  assert.equal(r.reasonCode, "gate-errored");
});

test("classification: verification fail → FAILED", () => {
  const r = classifyExecution(receipt({
    verdict: "failed",
    executionVerified: true,
    executionGateReason: "Execution verified: 1 file modified",
    verification: { verdict: "fail", confidenceScore: 0.3 },
  }));
  assert.equal(r.classification, "FAILED");
  assert.equal(r.reasonCode, "verification-fail");
});

test("classification: merge blocked → FAILED", () => {
  const r = classifyExecution(receipt({
    verdict: "failed",
    executionVerified: true,
    executionGateReason: "Execution verified",
    merge: { action: "block", primaryBlockReason: "Typecheck failed in core/coordinator.ts" },
  }));
  assert.equal(r.classification, "FAILED");
  assert.equal(r.reasonCode, "merge-blocked");
});

test("classification: aborted → FAILED", () => {
  const r = classifyExecution(receipt({
    verdict: "aborted",
    executionVerified: false,
    executionGateReason: "Execution cancelled by user before completion",
  }));
  assert.equal(r.classification, "FAILED");
  assert.equal(r.reasonCode, "aborted");
});

test("classification: regression — success without verification is treated as NO_OP", () => {
  // Defensive check: if a future refactor lets a success verdict
  // slip past the execution gate, the classifier must still refuse
  // to call it success.
  const r = classifyExecution(receipt({
    verdict: "success",
    executionVerified: false,
    executionGateReason: "",
  }));
  assert.equal(r.classification, "NO_OP");
  assert.equal(r.reasonCode, "unverified-verdict");
});

// ─── Blast radius ──────────────────────────────────────────────────

test("blast radius: single-file scope → low", () => {
  const r = estimateBlastRadius({
    scopeClassification: scope("single-file", 1),
    charterFileCount: 1,
    prompt: "fix typo in core/foo.ts",
  });
  assert.equal(r.level, "low");
  assert.equal(r.estimatedFiles, 1);
});

test("blast radius: multi-file scope → medium", () => {
  const r = estimateBlastRadius({
    scopeClassification: scope("multi-file", 5, true),
    charterFileCount: 3,
    prompt: "refactor the coordinator",
  });
  assert.equal(r.level, "medium");
});

test("blast radius: architectural scope → always high", () => {
  const r = estimateBlastRadius({
    scopeClassification: scope("architectural", 12),
    charterFileCount: 8,
    prompt: "rewrite the build pipeline",
  });
  assert.equal(r.level, "high");
});

test("blast radius: destructive + security → high even at low raw score", () => {
  const r = estimateBlastRadius({
    scopeClassification: scope("single-file", 1),
    charterFileCount: 1,
    prompt: "delete the auth token store",
  });
  assert.equal(r.level, "high");
  assert.ok(r.signals.includes("destructive-verb"));
  assert.ok(r.signals.includes("security-sensitive"));
});

test("blast radius: rationale is a plain-English string", () => {
  const r = estimateBlastRadius({
    scopeClassification: scope("multi-file", 6),
    charterFileCount: 4,
    prompt: "refactor coordinator dispatch",
  });
  assert.match(r.rationale, /file\(s\)/);
  assert.match(r.rationale, /spans multiple files/);
});

// ─── Confidence scoring ────────────────────────────────────────────

test("confidence: verified success + passing verification → high overall", () => {
  const r = scoreRunConfidence({
    receipt: receipt({
      verdict: "success",
      executionVerified: true,
      executionGateReason: "Execution verified: 2 file(s) modified",
      commitSha: "abc12345",
      verification: { verdict: "pass", confidenceScore: 0.95 },
      evidence: [
        { kind: "file_modified", ref: "a.ts", verifiedOnDisk: true },
        { kind: "file_modified", ref: "b.ts", verifiedOnDisk: true },
        { kind: "commit_sha", ref: "abc12345", verifiedOnDisk: true },
      ],
    }),
    scopeClassification: scope("single-file", 1),
  });
  assert.ok(r.overall > 0.8, `expected overall > 0.8, got ${r.overall}`);
  assert.ok(r.planning > 0.8);
  assert.ok(r.execution > 0.8);
  assert.ok(r.verification > 0.8);
  assert.ok(r.basis.length > 0);
});

test("confidence: unverified execution → execution score is zero", () => {
  const r = scoreRunConfidence({
    receipt: receipt({
      verdict: "failed",
      executionVerified: false,
      executionGateReason: "No-op execution detected",
    }),
    scopeClassification: scope("single-file", 1),
  });
  assert.equal(r.execution, 0);
  assert.ok(r.overall < 0.4);
});

test("confidence: failed verification tanks overall", () => {
  const r = scoreRunConfidence({
    receipt: receipt({
      verdict: "failed",
      executionVerified: true,
      executionGateReason: "Execution verified",
      verification: { verdict: "fail", confidenceScore: 0.2 },
    }),
    scopeClassification: scope("single-file", 1),
  });
  assert.ok(r.verification < 0.1);
  assert.ok(r.overall < 0.55);
});

test("confidence: basis always includes enough detail to audit", () => {
  const r = scoreRunConfidence({
    receipt: receipt({ verdict: "success", executionVerified: true, executionGateReason: "Execution verified" }),
    scopeClassification: scope("multi-file", 4),
  });
  assert.ok(r.basis.length >= 3);
  assert.ok(r.basis.some((line) => line.includes("planning")));
  assert.ok(r.basis.some((line) => line.includes("execution")));
  assert.ok(r.basis.some((line) => line.includes("verification")));
  assert.ok(r.basis.some((line) => line.includes("overall")));
});

// ─── Failure explainer ─────────────────────────────────────────────

test("failure: empty graph → planning stage with concrete fix", () => {
  const e = explainFailure(receipt({
    verdict: "failed",
    executionVerified: false,
    executionGateReason: "No-op execution detected: task graph produced zero nodes",
    graphTotalNodes: 0,
  }));
  assert.equal(e.code, "empty-graph");
  assert.equal(e.stage, "planning");
  assert.match(e.suggestedFix, /rephrase|dry-run/i);
});

test("failure: ENOENT error → filesystem fix", () => {
  const e = explainFailure(receipt({
    verdict: "failed",
    executionVerified: false,
    executionGateReason: "Execution errored: ENOENT: no such file or directory, open '/repo/missing.ts'",
  }));
  assert.equal(e.code, "missing-path");
  assert.match(e.rootCause, /\/repo\/missing\.ts/);
  assert.match(e.suggestedFix, /Create.*\/repo\/missing\.ts|create/i);
});

test("failure: permission denied → permissions fix", () => {
  const e = explainFailure(receipt({
    verdict: "failed",
    executionVerified: false,
    executionGateReason: "Execution errored: EACCES: permission denied, open '/root/locked.ts'",
  }));
  assert.equal(e.code, "permission-denied");
  assert.match(e.suggestedFix, /permissions/i);
});

test("failure: API key missing → auth fix", () => {
  const e = explainFailure(receipt({
    verdict: "failed",
    executionVerified: false,
    executionGateReason: "Execution errored: API key missing, 401 Unauthorized",
  }));
  assert.equal(e.code, "auth-missing");
  assert.match(e.suggestedFix, /API_KEY|environment/i);
});

test("failure: merge blocker with typecheck → suggests tsc", () => {
  const e = explainFailure(receipt({
    verdict: "failed",
    executionVerified: true,
    executionGateReason: "Execution verified",
    merge: { action: "block", primaryBlockReason: "Typecheck failed in core/coordinator.ts" },
  }));
  assert.equal(e.code, "merge-typecheck");
  assert.match(e.suggestedFix, /tsc/);
});

test("failure: gate no-op → no-op explanation with builder guidance", () => {
  const e = explainFailure(receipt({
    verdict: "failed",
    executionVerified: false,
    executionGateReason: "No-op execution detected: no files were created",
  }));
  assert.equal(e.code, "no-op");
  assert.match(e.suggestedFix, /builder|scope|narrow/i);
});

test("failure: aborted → fix is to re-submit", () => {
  const e = explainFailure(receipt({
    verdict: "aborted",
    executionVerified: false,
    executionGateReason: "Execution cancelled",
  }));
  assert.equal(e.code, "aborted");
  assert.match(e.suggestedFix, /re-submit|resubmit/i);
});

// ─── Composed summary ──────────────────────────────────────────────

test("summary: verified success produces the brief-tone headline", () => {
  const r = generateRunSummary({
    receipt: receipt({
      verdict: "success",
      executionVerified: true,
      executionGateReason: "Execution verified: 3 file(s) modified",
      commitSha: "abc1234567890",
      verification: { verdict: "pass", confidenceScore: 0.9 },
      evidence: [
        { kind: "file_created", ref: "core/capability-registry.ts", verifiedOnDisk: true },
        { kind: "file_modified", ref: "core/index.ts", verifiedOnDisk: true },
        { kind: "file_modified", ref: "core/types.ts", verifiedOnDisk: true },
        { kind: "commit_sha", ref: "abc1234567890", verifiedOnDisk: true },
      ],
      totalCost: { model: "qwen3.6-plus", inputTokens: 1200, outputTokens: 800, estimatedCostUsd: 0.0342 },
    }),
    userPrompt: "build a capability registry",
    scopeClassification: scope("single-file", 1),
  });

  assert.equal(r.classification, "VERIFIED_SUCCESS");
  assert.equal(r.filesTouchedCount, 3);
  assert.match(r.headline, /Aedis updated 3 files/);
  assert.match(r.headline, /Confidence:\s*\d+%/);
  assert.match(r.narrative, /created|modified/);
  assert.match(r.narrative, /verification/);
  assert.equal(r.failureExplanation, null);
  assert.ok(r.blastRadius);
  assert.ok(r.confidence.overall > 0.7);
});

test("summary: no-op failure produces a headline that does NOT claim success", () => {
  const r = generateRunSummary({
    receipt: receipt({
      verdict: "failed",
      executionVerified: false,
      executionGateReason: "No-op execution detected: no files were created, modified, or deleted",
      graphTotalNodes: 4,
    }),
    userPrompt: "build a capability registry",
    scopeClassification: scope("multi-file", 3),
  });

  assert.equal(r.classification, "NO_OP");
  assert.ok(!/success/i.test(r.headline), `headline must not claim success: ${r.headline}`);
  assert.match(r.headline, /did not change any files|no changes|no-op/i);
  assert.ok(r.failureExplanation);
  assert.match(r.failureExplanation!.suggestedFix, /\w/);
});

test("summary: failed run attaches a failure explanation", () => {
  const r = generateRunSummary({
    receipt: receipt({
      verdict: "failed",
      executionVerified: false,
      executionGateReason: "Execution errored: ENOENT: no such file or directory, open '/tmp/missing/capability-registry.ts'",
    }),
    userPrompt: "build a capability registry at /tmp/missing/capability-registry.ts",
    scopeClassification: scope("single-file", 1),
  });

  assert.equal(r.classification, "FAILED");
  assert.ok(r.failureExplanation);
  assert.equal(r.failureExplanation!.code, "missing-path");
  assert.match(r.narrative, /Root cause/);
  assert.match(r.narrative, /Suggested next step/);
});

test("summary: cost is rendered as a display-friendly dollar string", () => {
  const r = generateRunSummary({
    receipt: receipt({
      verdict: "success",
      executionVerified: true,
      executionGateReason: "Execution verified: 1 file modified",
      totalCost: { model: "qwen", inputTokens: 500, outputTokens: 500, estimatedCostUsd: 0.0012 },
      evidence: [{ kind: "file_modified", ref: "x.ts", verifiedOnDisk: true }],
    }),
    userPrompt: "fix typo in x.ts",
    scopeClassification: scope("single-file", 1),
  });
  assert.match(r.cost.displayUsd, /^\$\d/);
  assert.ok(r.cost.inputTokens > 0);
});

// ─── verificationChecks fallback (Aedis bugfix run 901e6da2) ───────
//
// Run 902a23c3 surfaced this in real receipts: when the verifier
// produced rich StageResult[] data on `verificationReceipt.stages`
// but no explicit lint/typecheck/tests hooks were configured (so
// `verificationReceipt.checks` was empty), the run-summary's
// "Checks run: …" line came up empty even though the verifier had
// done real work. Aedis attempted to fix this in commit f2ee019 by
// falling back to `receipt.verificationResults.final.stages`, but
// that field only exists on PersistentRunReceipt — it's undefined
// on the in-memory RunReceipt that generateRunSummary actually
// receives. The fallback compiled (tsc emits despite the TS2339)
// but was dead at runtime: verificationChecks stayed empty.
//
// These tests pin the corrected fallback (`verificationReceipt.stages`):
//   1. checks-populated → existing checks are used as-is (back-compat)
//   2. checks-empty + stages-populated → stages are mapped into the
//      verificationChecks shape and surfaced
//   3. both empty → empty result (graceful)
//   4. both populated → checks WIN (preferred source preserved)

interface FallbackReceiptOverrides {
  checks?: { kind: "lint" | "typecheck" | "tests"; name: string; required: boolean; executed: boolean; passed: boolean; details: string }[];
  stages?: { stage: "diff-check" | "contract-check" | "cross-file-check" | "lint" | "typecheck" | "custom-hook" | "confidence-scoring"; name: string; passed: boolean; score: number; issues: never[]; durationMs: number; details: string }[];
}

function receiptWithVerification(overrides: FallbackReceiptOverrides): RunReceipt {
  // Build off the standard receipt fixture but inject our verification
  // shape directly. The fixture's verification field gets nulled out
  // so we can fully control checks AND stages for the assertion.
  const base = receipt({ verdict: "success", executionVerified: true, executionGateReason: "Execution verified: 1 file modified" });
  const v: VerificationReceipt = {
    id: "v-fallback", runId: "run-fallback", intentId: "intent-fallback",
    timestamp: "2026-04-26T10:00:00.000Z",
    verdict: "pass",
    confidenceScore: 0.9,
    stages: overrides.stages ?? [],
    judgmentReport: null,
    allIssues: [], blockers: [],
    requiredChecks: ["lint", "typecheck", "tests"],
    checks: overrides.checks ?? [],
    summary: "test",
    totalDurationMs: 0,
    fileCoverage: null, coverageRatio: null, validatedRatio: null,
  };
  return { ...base, verificationReceipt: v };
}

test("summary verificationChecks: checks-populated → existing checks used as-is (back-compat)", () => {
  const r = generateRunSummary({
    receipt: receiptWithVerification({
      checks: [
        { kind: "typecheck", name: "TypeScript Check", required: true, executed: true, passed: true, details: "ok" },
        { kind: "tests", name: "npm test", required: false, executed: true, passed: false, details: "Tests failed (exit 1)" },
      ],
      // stages also non-empty — checks must still win
      stages: [
        { stage: "diff-check", name: "Diff Validation", passed: true, score: 1, issues: [], durationMs: 0, details: "ignored" },
      ],
    }),
    userPrompt: "fix typo",
    scopeClassification: scope("single-file", 1),
  });
  assert.equal(r.verificationChecks.length, 2, "explicit checks must be preserved when populated");
  assert.equal(r.verificationChecks[0]!.kind, "typecheck");
  assert.equal(r.verificationChecks[1]!.kind, "tests");
  assert.equal(r.verificationChecks[1]!.passed, false);
});

test("summary verificationChecks: checks-empty → falls back to verificationReceipt.stages (run 901e6da2 regression)", () => {
  // The exact bug Aedis tried to fix in f2ee019 but missed at the
  // wrong field. Pre-fix this assertion would fail with length=0 even
  // though stages has 3 entries — that's the operator-visible "0
  // checks" complaint that surfaced during cancellation/multi-file
  // runs. Post-fix the stages are surfaced into verificationChecks.
  const r = generateRunSummary({
    receipt: receiptWithVerification({
      checks: [],
      stages: [
        { stage: "diff-check", name: "Diff Validation", passed: true, score: 1, issues: [], durationMs: 0, details: "" },
        { stage: "typecheck", name: "TypeScript Check", passed: true, score: 1, issues: [], durationMs: 5, details: "" },
        { stage: "custom-hook", name: "Tests", passed: false, score: 0.8, issues: [], durationMs: 30, details: "Tests failed (exit 1)" },
      ],
    }),
    userPrompt: "edit a comment",
    scopeClassification: scope("single-file", 1),
  });
  assert.equal(r.verificationChecks.length, 3, "stages must surface as checks when checks is empty");
  assert.equal(r.verificationChecks[0]!.kind, "diff-check");
  assert.equal(r.verificationChecks[1]!.kind, "typecheck");
  assert.equal(r.verificationChecks[1]!.passed, true);
  assert.equal(r.verificationChecks[2]!.kind, "custom-hook");
  assert.equal(r.verificationChecks[2]!.passed, false);
  // Every stage-derived check is "executed" — the stage produced a
  // result, so by definition it ran.
  assert.ok(r.verificationChecks.every((c) => c.executed === true));
});

test("summary verificationChecks: both empty → result is empty (no fabrication)", () => {
  const r = generateRunSummary({
    receipt: receiptWithVerification({ checks: [], stages: [] }),
    userPrompt: "trivial",
    scopeClassification: scope("single-file", 1),
  });
  assert.equal(r.verificationChecks.length, 0, "no fabrication when both sources are empty");
});

test("summary verificationChecks: stages-only narrative includes the derived checks line", () => {
  // End-to-end check that the narrative consumes the fallback. The
  // operator-visible string is what they actually read; if the
  // fallback worked but the narrative ignored it, the bug would
  // still be visible to the user.
  const r = generateRunSummary({
    receipt: receiptWithVerification({
      checks: [],
      stages: [
        { stage: "typecheck", name: "TS", passed: true, score: 1, issues: [], durationMs: 1, details: "" },
      ],
    }),
    userPrompt: "tweak",
    scopeClassification: scope("single-file", 1),
  });
  assert.match(r.narrative, /Checks run:/, "narrative must mention the checks line when fallback fires");
  assert.match(r.narrative, /typecheck=pass/, "narrative must report the stage's pass/fail mapping");
});

// ─── Fixtures ──────────────────────────────────────────────────────

function scope(type: ScopeClassification["type"], radius: number, decompose = false): ScopeClassification {
  return {
    type,
    blastRadius: radius,
    recommendDecompose: decompose,
    reason: `test-${type}`,
    governance: { decompositionRequired: false, approvalRequired: false, escalationRecommended: false, wavesRequired: false },
  };
}

interface ReceiptOverrides {
  verdict?: RunReceipt["verdict"];
  executionVerified?: boolean;
  executionGateReason?: string;
  commitSha?: string | null;
  verification?: { verdict: VerificationReceipt["verdict"]; confidenceScore: number };
  merge?: { action: MergeDecision["action"]; primaryBlockReason?: string };
  evidence?: { kind: "file_created" | "file_modified" | "file_deleted" | "commit_sha" | "read_only" | "verifier_pass" | "file_diff" | "file_exists" | "worker_output"; ref: string; verifiedOnDisk: boolean }[];
  graphTotalNodes?: number;
  totalCost?: { model: string; inputTokens: number; outputTokens: number; estimatedCostUsd: number };
}

function receipt(o: ReceiptOverrides): RunReceipt {
  const verdict = o.verdict ?? "success";
  const verification: VerificationReceipt | null = o.verification
    ? {
        id: "v-1",
        runId: "run-1",
        intentId: "intent-1",
        timestamp: "2026-04-11T17:00:00.000Z",
        verdict: o.verification.verdict,
        confidenceScore: o.verification.confidenceScore,
        stages: [],
        judgmentReport: null,
        allIssues: [],
        blockers: [],
        requiredChecks: ["lint", "typecheck", "tests"],
        // Populate one executed required check matching the verdict.
        // Without it, computeVerificationNoSignal flags the receipt
        // as "no signal" — correct in production, wrong for fixtures
        // that explicitly declare a verification.verdict. Production
        // verdict="pass" always has at least one executed check.
        checks: [{
          kind: "typecheck",
          name: "stub-typecheck",
          executed: true,
          passed: o.verification.verdict !== "fail",
          required: true,
          details: "",
        }],
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
    timestamp: "2026-04-11T17:00:00.000Z",
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
      totalNodes: graphTotalNodes,
      planned: 0,
      ready: 0,
      dispatched: 0,
      completed: graphTotalNodes,
      failed: 0,
      skipped: 0,
      blocked: 0,
      edgeCount: 0,
      mergeGroupCount: 0,
      checkpointCount: 0,
      escalationCount: 0,
    },
    verificationReceipt: verification,
    waveVerifications: [],
    judgmentReport: null,
    mergeDecision: merge,
    totalCost: o.totalCost ?? { model: "test", inputTokens: 10, outputTokens: 20, estimatedCostUsd: 0.01 },
    commitSha: o.commitSha ?? null,
    durationMs: 100,
    executionVerified: o.executionVerified ?? false,
    executionGateReason: o.executionGateReason ?? "",
    executionEvidence: o.evidence ?? [],
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
