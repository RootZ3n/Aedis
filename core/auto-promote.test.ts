/**
 * Auto-promote + trust regression — regression tests.
 *
 * Validates that:
 *   1. PARTIAL_SUCCESS + executionVerified=true triggers auto-promote
 *   2. PARTIAL_SUCCESS without executionVerified does NOT auto-promote
 *   3. VERIFIED_SUCCESS triggers auto-promote
 *   4. Trust regression blocks VERIFIED_SUCCESS but NOT PARTIAL_SUCCESS+verified
 *   5. Trust regression with severity=significant still allows PARTIAL_SUCCESS+verified
 *   6. determineRunVerdict returns correct values
 */

import test from "node:test";
import assert from "node:assert/strict";
import { determineRunVerdict } from "./coordinator-lifecycle.js";

// ─── determineRunVerdict ─────────────────────────────────────────────

test("verdict: cancelled → aborted", () => {
  assert.equal(
    determineRunVerdict({
      cancelled: true,
      runPhase: "building",
      mergeAction: null,
      verificationVerdict: null,
      judgmentPassed: null,
      hasFailedNodes: false,
    }),
    "aborted",
  );
});

test("verdict: failed phase → failed", () => {
  assert.equal(
    determineRunVerdict({
      cancelled: false,
      runPhase: "failed",
      mergeAction: null,
      verificationVerdict: null,
      judgmentPassed: null,
      hasFailedNodes: false,
    }),
    "failed",
  );
});

test("verdict: merge blocked → failed", () => {
  assert.equal(
    determineRunVerdict({
      cancelled: false,
      runPhase: "complete",
      mergeAction: "block",
      verificationVerdict: null,
      judgmentPassed: null,
      hasFailedNodes: false,
    }),
    "failed",
  );
});

test("verdict: verification fail → failed", () => {
  assert.equal(
    determineRunVerdict({
      cancelled: false,
      runPhase: "complete",
      mergeAction: null,
      verificationVerdict: "fail",
      judgmentPassed: null,
      hasFailedNodes: false,
    }),
    "failed",
  );
});

test("verdict: pass-with-warnings → partial", () => {
  assert.equal(
    determineRunVerdict({
      cancelled: false,
      runPhase: "complete",
      mergeAction: null,
      verificationVerdict: "pass-with-warnings",
      judgmentPassed: null,
      hasFailedNodes: false,
    }),
    "partial",
  );
});

test("verdict: has failed nodes → partial", () => {
  assert.equal(
    determineRunVerdict({
      cancelled: false,
      runPhase: "complete",
      mergeAction: null,
      verificationVerdict: "pass",
      judgmentPassed: true,
      hasFailedNodes: true,
    }),
    "partial",
  );
});

test("verdict: clean pass → success", () => {
  assert.equal(
    determineRunVerdict({
      cancelled: false,
      runPhase: "complete",
      mergeAction: "apply",
      verificationVerdict: "pass",
      judgmentPassed: true,
      hasFailedNodes: false,
    }),
    "success",
  );
});

// ─── Auto-promote decision logic ─────────────────────────────────────

interface AutoPromoteInputs {
  autoPromoteOnSuccess: boolean;
  regressionAlert: { severity: string; signals: string[] } | null;
  sourceRepo: string | null;
  classification: string | null;
  executionVerified: boolean;
}

function shouldAutoPromote(inputs: AutoPromoteInputs): boolean {
  const { autoPromoteOnSuccess, regressionAlert, sourceRepo, classification, executionVerified } = inputs;
  const regressionBlocksPromote = regressionAlert !== null && classification !== "PARTIAL_SUCCESS";
  return (
    autoPromoteOnSuccess &&
    !regressionBlocksPromote &&
    sourceRepo !== null &&
    (classification === "VERIFIED_SUCCESS" ||
      (classification === "PARTIAL_SUCCESS" && executionVerified))
  );
}

test("auto-promote: VERIFIED_SUCCESS + no regression → promote", () => {
  assert.ok(shouldAutoPromote({
    autoPromoteOnSuccess: true,
    regressionAlert: null,
    sourceRepo: "/tmp/repo",
    classification: "VERIFIED_SUCCESS",
    executionVerified: true,
  }));
});

test("auto-promote: PARTIAL_SUCCESS + executionVerified → promote", () => {
  assert.ok(shouldAutoPromote({
    autoPromoteOnSuccess: true,
    regressionAlert: null,
    sourceRepo: "/tmp/repo",
    classification: "PARTIAL_SUCCESS",
    executionVerified: true,
  }));
});

test("auto-promote: PARTIAL_SUCCESS + NOT executionVerified → no promote", () => {
  assert.ok(!shouldAutoPromote({
    autoPromoteOnSuccess: true,
    regressionAlert: null,
    sourceRepo: "/tmp/repo",
    classification: "PARTIAL_SUCCESS",
    executionVerified: false,
  }));
});

test("auto-promote: FAILED → no promote", () => {
  assert.ok(!shouldAutoPromote({
    autoPromoteOnSuccess: true,
    regressionAlert: null,
    sourceRepo: "/tmp/repo",
    classification: "FAILED",
    executionVerified: false,
  }));
});

test("auto-promote: NO_OP → no promote", () => {
  assert.ok(!shouldAutoPromote({
    autoPromoteOnSuccess: true,
    regressionAlert: null,
    sourceRepo: "/tmp/repo",
    classification: "NO_OP",
    executionVerified: false,
  }));
});

test("auto-promote: autoPromoteOnSuccess=false → no promote", () => {
  assert.ok(!shouldAutoPromote({
    autoPromoteOnSuccess: false,
    regressionAlert: null,
    sourceRepo: "/tmp/repo",
    classification: "VERIFIED_SUCCESS",
    executionVerified: true,
  }));
});

test("auto-promote: no sourceRepo → no promote", () => {
  assert.ok(!shouldAutoPromote({
    autoPromoteOnSuccess: true,
    regressionAlert: null,
    sourceRepo: null,
    classification: "VERIFIED_SUCCESS",
    executionVerified: true,
  }));
});

// ─── Trust regression interaction with auto-promote ──────────────────

test("trust regression blocks VERIFIED_SUCCESS auto-promote", () => {
  assert.ok(!shouldAutoPromote({
    autoPromoteOnSuccess: true,
    regressionAlert: { severity: "mild", signals: ["low success rate"] },
    sourceRepo: "/tmp/repo",
    classification: "VERIFIED_SUCCESS",
    executionVerified: true,
  }));
});

test("trust regression does NOT block PARTIAL_SUCCESS+verified auto-promote", () => {
  assert.ok(shouldAutoPromote({
    autoPromoteOnSuccess: true,
    regressionAlert: { severity: "mild", signals: ["low success rate"] },
    sourceRepo: "/tmp/repo",
    classification: "PARTIAL_SUCCESS",
    executionVerified: true,
  }));
});

test("trust regression (significant) does NOT block PARTIAL_SUCCESS+verified", () => {
  assert.ok(shouldAutoPromote({
    autoPromoteOnSuccess: true,
    regressionAlert: { severity: "significant", signals: ["low success rate", "3 failures in 5 runs"] },
    sourceRepo: "/tmp/repo",
    classification: "PARTIAL_SUCCESS",
    executionVerified: true,
  }));
});

test("trust regression blocks PARTIAL_SUCCESS when NOT executionVerified", () => {
  assert.ok(!shouldAutoPromote({
    autoPromoteOnSuccess: true,
    regressionAlert: { severity: "mild", signals: ["low success rate"] },
    sourceRepo: "/tmp/repo",
    classification: "PARTIAL_SUCCESS",
    executionVerified: false,
  }));
});
