/**
 * Run Summary — Human-Readable Execution + Trust Layer v1.
 *
 * Composes a single structured summary of a completed run that
 * the UI can render instead of asking the user to read logs.
 *
 *   classification   — one of VERIFIED_SUCCESS / PARTIAL_SUCCESS /
 *                       NO_OP / FAILED, computed by execution-
 *                       classification.ts.
 *   headline         — one short plain-English sentence.
 *   narrative        — a longer paragraph in the same tone as the
 *                       product brief ("Aedis updated 3 files to
 *                       implement a capability registry...").
 *   whatWasAttempted — the user's original request.
 *   whatChanged      — a concrete list of file ops.
 *   blastRadius      — the planning-time estimate (for after-run
 *                       comparison).
 *   confidence       — the full confidence breakdown.
 *   cost             — a rounded dollar number and token counts.
 *   failureExplanation — populated only when classification !=
 *                       VERIFIED_SUCCESS.
 *
 * The summary is a pure function of the RunReceipt and the
 * conversational inputs (prompt, blast radius). It is attached
 * to the RunReceipt as `summary` so receipts remain the single
 * source of truth.
 */

import type { RunReceipt } from "./coordinator.js";
import type { ScopeClassification } from "./scope-classifier.js";
import type { ExecutionReceipt, ExecutionEvidence } from "./execution-gate.js";
import {
  classifyExecution,
  type ExecutionClassification,
  type ExecutionClassificationResult,
} from "./execution-classification.js";
import {
  estimateBlastRadius,
  type BlastRadiusEstimate,
} from "./blast-radius.js";
import {
  scoreRunConfidence,
  type ConfidenceBreakdown,
} from "./confidence-scoring.js";
import { explainFailure, type FailureExplanation } from "./failure-explainer.js";

// ─── Types ───────────────────────────────────────────────────────────

export interface FileChangeSummary {
  readonly path: string;
  readonly operation: "create" | "modify" | "delete";
}

export interface RunCostSummary {
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCostUsd: number;
  /** Rounded-to-2-decimal dollars for display. */
  readonly displayUsd: string;
}

export interface RunSummary {
  readonly classification: ExecutionClassification;
  readonly classificationReason: string;
  readonly classificationReasonCode: string;
  readonly headline: string;
  readonly narrative: string;
  readonly whatWasAttempted: string;
  readonly whatChanged: readonly FileChangeSummary[];
  readonly filesTouchedCount: number;
  readonly verification: "pass" | "fail" | "pass-with-warnings" | "not-run";
  readonly verificationChecks: readonly {
    kind: string;
    name: string;
    executed: boolean;
    passed: boolean;
    required: boolean;
  }[];
  readonly blastRadius: BlastRadiusEstimate;
  readonly confidence: ConfidenceBreakdown;
  readonly cost: RunCostSummary;
  readonly failureExplanation: FailureExplanation | null;
  /**
   * Raw classification factors — same as
   * ExecutionClassificationResult.factors — exposed so the UI
   * can render them as audit tooltips without repeating the rule.
   */
  readonly factors: readonly string[];
}

export interface RunSummaryInput {
  readonly receipt: RunReceipt;
  /** The original user prompt, used for "what was attempted" + blast radius. */
  readonly userPrompt: string;
  /**
   * Best-effort scope classification from the coordinator at
   * planning time. When absent the summary degrades gracefully
   * to "unknown" blast radius.
   */
  readonly scopeClassification?: ScopeClassification | null;
  /**
   * File changes pulled from the active run (not always present
   * on the RunReceipt itself). When absent we fall back to the
   * executionEvidence on the receipt — both paths converge to
   * the same thing in practice.
   */
  readonly changes?: readonly { path: string; operation: "create" | "modify" | "delete" }[];
  /**
   * Average worker confidence from active.workerResults. The
   * coordinator passes it in so confidence scoring can boost/
   * penalize based on worker self-reports.
   */
  readonly averageWorkerConfidence?: number;
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Build a human-readable summary for a completed run. Pure
 * function — every input comes from the receipt or the
 * coordinator's immediate context.
 */
export function generateRunSummary(input: RunSummaryInput): RunSummary {
  const { receipt, userPrompt } = input;

  const classificationResult = classifyExecution(receipt);
  const confidence = scoreRunConfidence({
    receipt,
    scopeClassification: input.scopeClassification ?? null,
    averageWorkerConfidence: input.averageWorkerConfidence,
  });
  const blastRadius = estimateBlastRadius({
    scopeClassification: input.scopeClassification ?? null,
    charterFileCount: input.changes?.length ?? receipt.executionEvidence?.filter((e) => isFileEvidence(e.kind)).length ?? 0,
    prompt: userPrompt,
  });

  const whatChanged = resolveChangesList(input);
  const cost = resolveCost(receipt);
  const verification = receipt.verificationReceipt?.verdict ?? "not-run";

  const needsExplanation = classificationResult.classification !== "VERIFIED_SUCCESS";
  const failureExplanation = needsExplanation ? explainFailure(receipt) : null;

  const headline = buildHeadline({
    classification: classificationResult.classification,
    whatChanged,
    confidence,
    receipt,
  });

  const narrative = buildNarrative({
    classificationResult,
    whatChanged,
    confidence,
    verification,
    verificationChecks: receipt.verificationReceipt?.checks ?? [],
    blastRadius,
    cost,
    failureExplanation,
    receipt,
  });

  return {
    classification: classificationResult.classification,
    classificationReason: classificationResult.reason,
    classificationReasonCode: classificationResult.reasonCode,
    headline,
    narrative,
    whatWasAttempted: userPrompt.trim() || "(no prompt recorded)",
    whatChanged,
    filesTouchedCount: whatChanged.length,
    verification,
    verificationChecks: receipt.verificationReceipt?.checks ?? [],
    blastRadius,
    confidence,
    cost,
    failureExplanation,
    factors: classificationResult.factors,
  };
}

// ─── Narrative assembly ─────────────────────────────────────────────

function buildHeadline(input: {
  classification: ExecutionClassification;
  whatChanged: readonly FileChangeSummary[];
  confidence: ConfidenceBreakdown;
  receipt: RunReceipt;
}): string {
  const { classification, whatChanged, confidence } = input;
  const fileCount = whatChanged.length;
  const percent = Math.round(confidence.overall * 100);
  const sha = input.receipt.commitSha ? ` (${input.receipt.commitSha.slice(0, 8)})` : "";

  switch (classification) {
    case "VERIFIED_SUCCESS":
      return `Aedis updated ${fileCount} file${plural(fileCount)} and all changes passed verification. Confidence: ${percent}%${sha}.`;
    case "PARTIAL_SUCCESS":
      return `Aedis updated ${fileCount} file${plural(fileCount)} but some checks raised warnings. Confidence: ${percent}%${sha}.`;
    case "NO_OP":
      return `Aedis did not change any files. Confidence: ${percent}%.`;
    case "FAILED":
      return `Aedis failed to complete the task. Confidence: ${percent}%.`;
  }
}

function buildNarrative(input: {
  classificationResult: ExecutionClassificationResult;
  whatChanged: readonly FileChangeSummary[];
  confidence: ConfidenceBreakdown;
  verification: "pass" | "fail" | "pass-with-warnings" | "not-run";
  verificationChecks: readonly {
    kind: string;
    executed: boolean;
    passed: boolean;
  }[];
  blastRadius: BlastRadiusEstimate;
  cost: RunCostSummary;
  failureExplanation: FailureExplanation | null;
  receipt: RunReceipt;
}): string {
  const {
    classificationResult,
    whatChanged,
    confidence,
    verification,
    verificationChecks,
    blastRadius,
    cost,
    failureExplanation,
  } = input;

  const percent = Math.round(confidence.overall * 100);
  const lines: string[] = [];

  switch (classificationResult.classification) {
    case "VERIFIED_SUCCESS": {
      const created = whatChanged.filter((c) => c.operation === "create");
      const modified = whatChanged.filter((c) => c.operation === "modify");
      const deleted = whatChanged.filter((c) => c.operation === "delete");
      const parts: string[] = [];
      if (created.length > 0) parts.push(`created ${listFiles(created, 3)}`);
      if (modified.length > 0) parts.push(`modified ${listFiles(modified, 3)}`);
      if (deleted.length > 0) parts.push(`deleted ${listFiles(deleted, 3)}`);
      const changeSentence = parts.length > 0
        ? `Aedis ${parts.join(", ")}.`
        : `Aedis produced ${whatChanged.length} change(s).`;
      lines.push(changeSentence);
      if (verification === "pass") {
        lines.push("All changes passed verification.");
      } else if (verification === "pass-with-warnings") {
        lines.push("Verification passed with advisory warnings.");
      }
      if (verificationChecks.length > 0) {
        lines.push(`Checks run: ${verificationChecks.map((check) => `${check.kind}=${check.executed ? (check.passed ? "pass" : "fail") : "missing"}`).join(", ")}.`);
      }
      lines.push(`Blast radius was ${blastRadius.level} (${blastRadius.rationale}).`);
      lines.push(`Cost: ${cost.displayUsd} across ${cost.inputTokens + cost.outputTokens} tokens.`);
      lines.push(`Confidence: ${percent}%.`);
      break;
    }

    case "PARTIAL_SUCCESS": {
      lines.push(`Aedis applied ${whatChanged.length} change${plural(whatChanged.length)} but not every gate was clean.`);
      lines.push(classificationResult.reason + ".");
      if (failureExplanation) {
        lines.push(`Most likely cause: ${failureExplanation.rootCause}`);
        lines.push(`Suggested next step: ${failureExplanation.suggestedFix}`);
      }
      if (verificationChecks.length > 0) {
        lines.push(`Checks run: ${verificationChecks.map((check) => `${check.kind}=${check.executed ? (check.passed ? "pass" : "fail") : "missing"}`).join(", ")}.`);
      }
      lines.push(`Blast radius was ${blastRadius.level}. Cost: ${cost.displayUsd}. Confidence: ${percent}%.`);
      break;
    }

    case "NO_OP": {
      lines.push("Aedis finished without producing any real changes.");
      lines.push(classificationResult.reason + ".");
      if (failureExplanation) {
        lines.push(`Most likely cause: ${failureExplanation.rootCause}`);
        lines.push(`Suggested next step: ${failureExplanation.suggestedFix}`);
      }
      if (verificationChecks.length > 0) {
        lines.push(`Checks run: ${verificationChecks.map((check) => `${check.kind}=${check.executed ? (check.passed ? "pass" : "fail") : "missing"}`).join(", ")}.`);
      }
      lines.push(`Blast radius was projected as ${blastRadius.level}. Cost: ${cost.displayUsd}. Confidence: ${percent}%.`);
      break;
    }

    case "FAILED": {
      lines.push(`Aedis failed the task. ${classificationResult.reason}.`);
      if (failureExplanation) {
        lines.push(`Root cause (${failureExplanation.stage} stage): ${failureExplanation.rootCause}`);
        lines.push(`Suggested next step: ${failureExplanation.suggestedFix}`);
      }
      if (verificationChecks.length > 0) {
        lines.push(`Checks run: ${verificationChecks.map((check) => `${check.kind}=${check.executed ? (check.passed ? "pass" : "fail") : "missing"}`).join(", ")}.`);
      }
      lines.push(`Projected blast radius was ${blastRadius.level}. Cost: ${cost.displayUsd}. Confidence: ${percent}%.`);
      break;
    }
  }

  return lines.join(" ");
}

// ─── Helpers ─────────────────────────────────────────────────────────

function resolveChangesList(input: RunSummaryInput): FileChangeSummary[] {
  if (input.changes && input.changes.length > 0) {
    return input.changes.map((c) => ({ path: c.path, operation: c.operation }));
  }
  // Fall back to executionEvidence — each file_* evidence item has
  // a ref=path. We reconstruct the operation from the evidence kind.
  const fromEvidence: FileChangeSummary[] = [];
  const seen = new Set<string>();
  for (const e of input.receipt.executionEvidence ?? []) {
    if (!isFileEvidence(e.kind)) continue;
    const op: FileChangeSummary["operation"] =
      e.kind === "file_created"
        ? "create"
        : e.kind === "file_deleted"
          ? "delete"
          : "modify";
    const key = `${op}:${e.ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    fromEvidence.push({ path: e.ref, operation: op });
  }
  // Also fall back to executionReceipts if evidence is sparse
  if (fromEvidence.length === 0) {
    for (const r of input.receipt.executionReceipts ?? []) {
      for (const tf of r.filesTouched) {
        if (tf.operation === "read") continue;
        const key = `${tf.operation}:${tf.path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        fromEvidence.push({ path: tf.path, operation: tf.operation });
      }
    }
  }
  return fromEvidence;
}

function resolveCost(receipt: RunReceipt): RunCostSummary {
  const c = receipt.totalCost ?? { model: "", inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 };
  const estimatedCostUsd = Number(c.estimatedCostUsd || 0);
  const displayUsd = `$${estimatedCostUsd.toFixed(estimatedCostUsd < 0.01 ? 4 : 2)}`;
  return {
    model: String(c.model || "unknown"),
    inputTokens: Number(c.inputTokens || 0),
    outputTokens: Number(c.outputTokens || 0),
    estimatedCostUsd,
    displayUsd,
  };
}

function isFileEvidence(kind: ExecutionEvidence["kind"]): boolean {
  return kind === "file_created" || kind === "file_modified" || kind === "file_deleted";
}

function listFiles(items: readonly FileChangeSummary[], max: number): string {
  const slice = items.slice(0, max).map((i) => i.path);
  if (items.length > max) slice.push(`+${items.length - max} more`);
  return slice.join(", ");
}

function plural(n: number): string {
  return n === 1 ? "" : "s";
}

// Re-export so coordinator only imports this module.
export type { ExecutionClassification, ExecutionReceipt, FailureExplanation, BlastRadiusEstimate, ConfidenceBreakdown };
