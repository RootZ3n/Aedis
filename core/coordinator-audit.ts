import type { RunReceipt } from "./coordinator.js";
import type { PersistentRunStatus } from "./receipt-store.js";

export function persistentStatusForReceipt(receipt: RunReceipt): PersistentRunStatus {
  if (receipt.verdict === "aborted") return "ABORTED";
  if (receipt.verdict === "failed") return "FAILED";
  return "COMPLETE";
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
    blastRadius: summary.blastRadius,
    confidence: summary.confidence,
    cost: summary.cost,
    failureExplanation: summary.failureExplanation,
    factors: summary.factors,
  };
}
