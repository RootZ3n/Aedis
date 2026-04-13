import type { RunReceipt } from "./coordinator.js";
import type { PersistentRunStatus } from "./receipt-store.js";

/**
 * Map a RunReceipt verdict to the canonical PersistentRunStatus.
 *
 * Truth rules:
 *   - "success" only maps to READY_FOR_PROMOTION (not "applied")
 *   - Crucibulum disagreement → DISAGREEMENT_HOLD (blocked, not pass)
 *   - "partial" → VERIFICATION_PENDING (not success)
 *   - "failed" → VERIFIED_FAIL or EXECUTION_ERROR depending on evidence
 */
export function persistentStatusForReceipt(receipt: RunReceipt): PersistentRunStatus {
  if (receipt.verdict === "aborted") return "ABORTED";

  // Crucibulum override: disagreement blocks regardless of advisory confidence
  if (
    receipt.evaluation?.disagreement &&
    (receipt.evaluation.disagreement.severity === "significant" ||
     receipt.evaluation.disagreement.severity === "critical")
  ) {
    return "DISAGREEMENT_HOLD";
  }
  if (receipt.evaluation?.aggregate && !receipt.evaluation.aggregate.overallPass) {
    return "CRUCIBULUM_FAIL";
  }

  if (receipt.verdict === "failed") {
    // Distinguish verification failure from execution error
    return receipt.executionVerified ? "VERIFIED_FAIL" : "EXECUTION_ERROR";
  }

  if (receipt.verdict === "partial") {
    return "VERIFICATION_PENDING";
  }

  // "success" — all gates passed, ready for promotion
  return "READY_FOR_PROMOTION";
}

export function buildRunSummaryPayload(runId: string, receipt: RunReceipt): Record<string, unknown> | null {
  const summary = receipt.humanSummary;
  if (!summary) return null;
  return {
    runId,
    classification: summary.classification,
    classificationReason: summary.classificationReason,
    headline: summary.headline,
    narrative: summary.narrative,
    whatWasAttempted: summary.whatWasAttempted,
    whatChanged: summary.whatChanged,
    filesTouchedCount: summary.filesTouchedCount,
    verification: summary.verification,
    verificationChecks: summary.verificationChecks,
    explanationLines: summary.explanationLines,
    explanationDetails: summary.explanationDetails,
    blastRadius: summary.blastRadius,
    confidence: summary.confidence,
    cost: summary.cost,
    failureExplanation: summary.failureExplanation,
    factors: summary.factors,
  };
}
