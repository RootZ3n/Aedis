/**
 * Confidence Scoring — Human-Readable Execution + Trust Layer v1.
 *
 * Produces a structured confidence breakdown for a run. Three
 * sub-scores (planning, execution, verification) plus one overall
 * score, each in [0, 1]. The overall is a weighted combination of
 * the sub-scores, tuned so that a failed verification tanks
 * confidence even if the other stages scored well — verification
 * is the gate that matters most to trust.
 *
 * All inputs come from receipt fields the Coordinator already
 * populates. No new signals, no worker changes. The module is a
 * pure function of the RunReceipt + a few optional hints from the
 * scope classifier.
 *
 * Every score carries a `basis` array listing the specific signals
 * that contributed, so the UI can show a tooltip like:
 *   "86% — planning clean (single-file, no decompose),
 *    execution verified (3 file_modified), verification passed
 *    (confidence 0.9)."
 */

import type { RunReceipt } from "./coordinator.js";
import type { ScopeClassification } from "./scope-classifier.js";

// ─── Types ───────────────────────────────────────────────────────────

export interface ConfidenceBreakdown {
  /** Overall confidence in [0, 1]. */
  readonly overall: number;
  /** Planning-stage confidence — scope classification + charter. */
  readonly planning: number;
  /** Execution-stage confidence — gate evidence + worker results. */
  readonly execution: number;
  /** Verification-stage confidence — verification pipeline signal. */
  readonly verification: number;
  /**
   * Signals that contributed to the scores, one string per
   * contribution, for UI display.
   */
  readonly basis: readonly string[];
}

export interface ConfidenceInput {
  readonly receipt: RunReceipt;
  readonly scopeClassification?: ScopeClassification | null;
  /**
   * Average worker confidence from the run, if available. The
   * coordinator has this from active.workerResults but we do not
   * require it — when absent we infer from the gate/verification.
   */
  readonly averageWorkerConfidence?: number;
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Score confidence in a completed run from its RunReceipt.
 * Returns a breakdown with overall + three sub-scores + a basis
 * list. Pure function.
 */
export function scoreRunConfidence(input: ConfidenceInput): ConfidenceBreakdown {
  const basis: string[] = [];
  const planning = scorePlanning(input, basis);
  const execution = scoreExecution(input, basis);
  const verification = scoreVerification(input, basis);

  // Weighted overall: verification carries the most weight because
  // it is the gate that actually tests whether the changes work.
  // Execution is next — evidence of real work beats a clean plan.
  // Planning is the smallest weight; a clean plan that produced
  // no output is worth less than a messy plan that landed real
  // changes.
  const overall = clamp01(
    planning * 0.2 + execution * 0.35 + verification * 0.45,
  );

  basis.push(
    `overall = 0.2·plan(${planning.toFixed(2)}) + 0.35·exec(${execution.toFixed(2)}) + 0.45·verify(${verification.toFixed(2)})`,
  );

  return {
    overall,
    planning,
    execution,
    verification,
    basis,
  };
}

// ─── Internals ───────────────────────────────────────────────────────

function scorePlanning(input: ConfidenceInput, basis: string[]): number {
  const scope = input.scopeClassification ?? null;
  let score = 0.5; // neutral baseline

  if (!scope) {
    basis.push("planning:no-scope-classification → 0.50 baseline");
    return score;
  }

  switch (scope.type) {
    case "single-file":
      score = 0.9;
      basis.push("planning:single-file → +0.40 (bounded scope)");
      break;
    case "multi-file":
      score = 0.7;
      basis.push("planning:multi-file → +0.20 (coordinated scope)");
      break;
    case "architectural":
      score = 0.4;
      basis.push("planning:architectural → -0.10 (wide surface)");
      break;
    case "migration":
      score = 0.35;
      basis.push("planning:migration → -0.15 (migration scope)");
      break;
  }

  if (scope.recommendDecompose) {
    score = Math.max(0, score - 0.1);
    basis.push("planning:decompose-recommended → -0.10");
  }

  return clamp01(score);
}

function scoreExecution(input: ConfidenceInput, basis: string[]): number {
  const receipt = input.receipt;
  let score = 0;

  if (receipt.executionVerified) {
    score = 0.75;
    basis.push("execution:gate verified → 0.75");
  } else {
    basis.push("execution:gate not verified → 0.00");
    return 0;
  }

  // Bonus for tangible artifacts
  const evidenceCount = receipt.executionEvidence?.length ?? 0;
  if (evidenceCount >= 3) {
    score += 0.1;
    basis.push(`execution:${evidenceCount} evidence items → +0.10`);
  }

  if (receipt.commitSha) {
    score += 0.1;
    basis.push(`execution:commit ${receipt.commitSha.slice(0, 8)} → +0.10`);
  }

  // Worker confidence, when we have it
  if (typeof input.averageWorkerConfidence === "number" && input.averageWorkerConfidence > 0) {
    const workerBoost = (input.averageWorkerConfidence - 0.5) * 0.1;
    score += workerBoost;
    basis.push(
      `execution:avg worker conf ${input.averageWorkerConfidence.toFixed(2)} → ${workerBoost >= 0 ? "+" : ""}${workerBoost.toFixed(2)}`,
    );
  }

  // Penalty for failed graph nodes
  const failed = receipt.graphSummary?.failed ?? 0;
  if (failed > 0) {
    score -= 0.15 * Math.min(failed, 3);
    basis.push(`execution:${failed} failed node(s) → -${(0.15 * Math.min(failed, 3)).toFixed(2)}`);
  }

  return clamp01(score);
}

function scoreVerification(input: ConfidenceInput, basis: string[]): number {
  const v = input.receipt.verificationReceipt;
  if (!v) {
    basis.push("verification:not run → 0.25 (no positive signal)");
    return 0.25;
  }
  switch (v.verdict) {
    case "pass": {
      const score = 0.6 + v.confidenceScore * 0.4;
      basis.push(`verification:pass (pipeline conf ${v.confidenceScore.toFixed(2)}) → ${score.toFixed(2)}`);
      return clamp01(score);
    }
    case "pass-with-warnings": {
      const score = 0.5 + v.confidenceScore * 0.25;
      basis.push(`verification:pass-with-warnings (pipeline conf ${v.confidenceScore.toFixed(2)}) → ${score.toFixed(2)}`);
      return clamp01(score);
    }
    case "fail": {
      basis.push("verification:fail → 0.05");
      return 0.05;
    }
    default:
      basis.push(`verification:unknown(${v.verdict}) → 0.25`);
      return 0.25;
  }
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
