import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { diagnoseFailure, type RepairDiagnosis, type DiagnoseFailureInput } from "./repair-diagnosis.js";

// Minimal RunReceipt stub for testing
function makeReceipt(overrides: Record<string, unknown> = {}): DiagnoseFailureInput["receipt"] {
  // Minimal stub — cast through unknown to avoid exhaustive RunReceipt matching.
  // Tests only exercise fields the diagnosis reads (verdict, humanSummary,
  // verificationReceipt, mergeDecision, executionGateReason, patchArtifact).
  return {
    id: "test-receipt",
    runId: "test-run",
    intentId: "test-intent",
    timestamp: new Date().toISOString(),
    verdict: "failed",
    summary: {},
    graphSummary: {},
    verificationReceipt: null,
    waveVerifications: [],
    judgmentReport: null,
    mergeDecision: null,
    totalCost: { model: "test", inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
    commitSha: null,
    durationMs: 1000,
    executionVerified: false,
    executionGateReason: "",
    executionEvidence: [],
    executionReceipts: [],
    humanSummary: null,
    blastRadius: null,
    evaluation: null,
    patchArtifact: null,
    workspaceCleanup: null,
    sourceRepo: null,
    sourceCommitSha: null,
    confidenceGate: null,
    ...overrides,
  } as unknown as DiagnoseFailureInput["receipt"];
}

// ─── Failure classification ──────────────────────────────────────────

describe("diagnoseFailure — classification", () => {
  it("failed verification creates repair diagnosis", () => {
    const result = diagnoseFailure({
      receipt: makeReceipt({
        verificationReceipt: { verdict: "fail", blockers: [{ message: "test suite failed: 3 assertions failed" }] },
        humanSummary: { headline: "Verification failed: test suite did not pass" },
      }),
      originalPrompt: "add input validation",
      attemptNumber: 1,
      maxAttempts: 3,
    });
    assert.equal(result.category, "verification-failure");
    assert.ok(result.rootCause.includes("Verification failed"));
    assert.ok(result.suggestedAction.length > 0);
    assert.ok(result.confidence > 0);
    assert.equal(result.retriable, true);
    assert.ok(result.repairHint.includes("[REPAIR]"));
    assert.ok(result.repairHint.includes("test"));
    assert.equal(result.attemptNumber, 1);
    assert.equal(result.maxAttempts, 3);
    assert.ok(result.diagnosedAt.length > 0);
  });

  it("empty output diagnosed as empty-output", () => {
    const result = diagnoseFailure({
      receipt: makeReceipt({
        executionGateReason: "no real output produced",
        executionVerified: false,
      }),
      originalPrompt: "add a hello endpoint",
      attemptNumber: 1,
      maxAttempts: 3,
    });
    assert.equal(result.category, "empty-output");
    assert.ok(result.rootCause.includes("no effective changes"));
    assert.equal(result.retriable, true);
    assert.ok(result.repairHint.includes("MUST make a concrete"));
  });

  it("scope drift diagnosed correctly", () => {
    const result = diagnoseFailure({
      receipt: makeReceipt({
        humanSummary: { headline: "Builder modified files out of scope" },
      }),
      originalPrompt: "fix auth.ts",
      attemptNumber: 2,
      maxAttempts: 3,
    });
    assert.equal(result.category, "scope-drift");
    assert.ok(result.suggestedAction.includes("scope"));
    assert.equal(result.retriable, true);
  });

  it("syntax error via verification diagnosed as verification-failure with syntax detail", () => {
    const result = diagnoseFailure({
      receipt: makeReceipt({
        verificationReceipt: { verdict: "fail", blockers: [{ message: "unexpected token at line 42" }] },
        humanSummary: { headline: "Syntax error in generated code" },
      }),
      originalPrompt: "add validation",
      attemptNumber: 1,
      maxAttempts: 3,
    });
    // Syntax errors caught by verification are classified under verification-failure
    assert.equal(result.category, "verification-failure");
    assert.equal(result.retriable, true);
    assert.ok(result.repairHint.includes("[REPAIR]"));
  });

  it("syntax error without verification receipt diagnosed as syntax-error", () => {
    const result = diagnoseFailure({
      receipt: makeReceipt({
        humanSummary: { headline: "Syntax error: unexpected token in output" },
      }),
      originalPrompt: "add validation",
      attemptNumber: 1,
      maxAttempts: 3,
    });
    assert.equal(result.category, "syntax-error");
    assert.ok(result.repairHint.includes("valid, parseable code"));
  });

  it("missing export diagnosed correctly", () => {
    const result = diagnoseFailure({
      receipt: makeReceipt({
        humanSummary: { headline: "Export 'authenticate' is not exported from module" },
      }),
      originalPrompt: "refactor auth module",
      attemptNumber: 1,
      maxAttempts: 3,
    });
    assert.equal(result.category, "missing-export");
    assert.ok(result.repairHint.includes("Preserve EVERY existing export"));
  });

  it("merge blocked diagnosed correctly", () => {
    const result = diagnoseFailure({
      receipt: makeReceipt({
        mergeDecision: { action: "block", primaryBlockReason: "critical finding: advisory limit exceeded" },
      }),
      originalPrompt: "update auth",
      attemptNumber: 1,
      maxAttempts: 3,
    });
    assert.equal(result.category, "merge-blocked");
    assert.ok(result.rootCause.includes("Merge gate blocked"));
  });

  it("timeout diagnosed as non-retriable", () => {
    const result = diagnoseFailure({
      receipt: makeReceipt({
        humanSummary: { headline: "Run timed out after 30 minutes" },
      }),
      originalPrompt: "refactor everything",
      attemptNumber: 1,
      maxAttempts: 3,
    });
    assert.equal(result.category, "timeout");
    assert.equal(result.retriable, false);
  });

  it("unknown failure falls back gracefully", () => {
    const result = diagnoseFailure({
      receipt: makeReceipt({}),
      originalPrompt: "do something",
      attemptNumber: 1,
      maxAttempts: 3,
    });
    assert.equal(result.category, "unknown");
    assert.ok(result.rootCause.length > 0);
    assert.ok(result.suggestedAction.length > 0);
    assert.equal(result.retriable, true);
  });
});

// ─── Bounded repair ──────────────────────────────────────────────────

describe("diagnoseFailure — bounded repair", () => {
  it("repair attempts are bounded (tracks attempt/max)", () => {
    const result = diagnoseFailure({
      receipt: makeReceipt({
        verificationReceipt: { verdict: "fail", blockers: [] },
        humanSummary: { headline: "Tests failed" },
      }),
      originalPrompt: "add validation",
      attemptNumber: 2,
      maxAttempts: 3,
    });
    assert.equal(result.attemptNumber, 2);
    assert.equal(result.maxAttempts, 3);
  });

  it("repeated failure stops safely (non-retriable timeout)", () => {
    const result = diagnoseFailure({
      receipt: makeReceipt({
        humanSummary: { headline: "Timed out" },
      }),
      originalPrompt: "large refactor",
      attemptNumber: 3,
      maxAttempts: 3,
    });
    assert.equal(result.retriable, false);
    assert.equal(result.category, "timeout");
    // Caller should check retriable before queuing another attempt
  });
});

// ─── Evidence in receipt ─────────────────────────────────────────────

describe("diagnoseFailure — repair evidence in receipt", () => {
  it("repair evidence appears in diagnosis (evidence array)", () => {
    const result = diagnoseFailure({
      receipt: makeReceipt({
        verdict: "failed",
        executionGateReason: "builder produced empty diff",
        humanSummary: { headline: "No changes produced" },
      }),
      originalPrompt: "add endpoint",
      attemptNumber: 1,
      maxAttempts: 3,
    });
    assert.ok(result.evidence.length > 0);
    assert.ok(result.evidence.some((e) => e.includes("verdict")));
  });

  it("likely files populated from patch artifact", () => {
    const result = diagnoseFailure({
      receipt: makeReceipt({
        patchArtifact: { diff: "...", changedFiles: ["src/auth.ts", "src/routes/login.ts"] },
        verificationReceipt: { verdict: "fail", blockers: [{ message: "typecheck failed" }] },
      }),
      originalPrompt: "fix auth",
      attemptNumber: 1,
      maxAttempts: 3,
    });
    assert.ok(result.likelyFiles.includes("src/auth.ts"));
    assert.ok(result.likelyFiles.includes("src/routes/login.ts"));
  });

  it("scout evidence enriches likely files", () => {
    const result = diagnoseFailure({
      receipt: makeReceipt({
        verificationReceipt: { verdict: "fail", blockers: [] },
        humanSummary: { headline: "Tests failed" },
      }),
      originalPrompt: "fix auth",
      attemptNumber: 1,
      maxAttempts: 3,
      scoutReports: [{
        scoutId: "scout-1",
        type: "target_discovery",
        modelProvider: "local",
        modelName: "local",
        localOrCloud: "deterministic",
        confidence: 0.8,
        summary: "found targets",
        findings: [],
        recommendedTargets: ["src/auth.ts", "src/middleware.ts"],
        recommendedTests: [],
        risks: [],
        costUsd: 0,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      }],
    });
    assert.ok(result.likelyFiles.includes("src/auth.ts"));
    assert.ok(result.likelyFiles.includes("src/middleware.ts"));
  });
});

// ─── Safety invariants ───────────────────────────────────────────────

describe("diagnoseFailure — safety", () => {
  it("approval still required (diagnosis has no approval/promote fields)", () => {
    const result = diagnoseFailure({
      receipt: makeReceipt({
        verificationReceipt: { verdict: "fail", blockers: [] },
      }),
      originalPrompt: "fix bug",
      attemptNumber: 1,
      maxAttempts: 3,
    });
    const keys = Object.keys(result);
    assert.ok(!keys.includes("approved"));
    assert.ok(!keys.includes("promoted"));
    assert.ok(!keys.includes("commitSha"));
    // Diagnosis is advisory — it never claims success
    assert.ok(result.category !== "success" as string);
  });

  it("repair is not treated as success without verification", () => {
    // A diagnosis that says "retriable" does NOT mean "succeeded" —
    // the caller must re-submit and get a new receipt with verdict=success
    const result = diagnoseFailure({
      receipt: makeReceipt({
        verdict: "failed",
        verificationReceipt: { verdict: "fail", blockers: [{ message: "tests still failing" }] },
      }),
      originalPrompt: "add validation",
      attemptNumber: 2,
      maxAttempts: 3,
    });
    assert.equal(result.retriable, true);
    // But retriable !== success
    assert.ok(result.category.includes("failure") || result.category.includes("error") || result.category === "unknown" || result.category === "verification-failure");
  });
});
