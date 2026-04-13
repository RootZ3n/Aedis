/**
 * Confidence Scoring — Evidence-Based Trust Layer v2.
 *
 * Produces a structured confidence breakdown for every run.
 * No fixed constants — every score is computed from actual
 * pipeline evidence.
 *
 * Five sub-scores (plan, execution, critic, verification, risk)
 * weighted and penalty-adjusted to produce an overall confidence
 * and a decision recommendation.
 *
 * Decision thresholds:
 *   0.85+ → apply (high confidence)
 *   0.70–0.84 → review required
 *   0.50–0.69 → escalate
 *   below 0.50 → reject
 */

import type { RunReceipt } from "./coordinator.js";
import type { ScopeClassification } from "./scope-classifier.js";

// ─── Types ───────────────────────────────────────────────────────────

export type ConfidenceDecision = "apply" | "review" | "escalate" | "reject";

export interface ConfidenceBreakdown {
  /** Overall confidence in [0, 1]. */
  readonly overall: number;
  /** Planning-stage confidence — scope classification + charter. */
  readonly planning: number;
  /** Execution-stage confidence — gate evidence + worker results. */
  readonly execution: number;
  /** Critic review confidence — critic score + findings. */
  readonly critic: number;
  /** Verification-stage confidence — verification pipeline signal. */
  readonly verification: number;
  /** Risk modifier — penalties for risky conditions. */
  readonly risk: number;
  /** Penalties applied — human-readable reasons. */
  readonly penalties: readonly string[];
  /** Decision recommendation based on overall confidence. */
  readonly decision: ConfidenceDecision;
  /** Human-readable reason for the decision. */
  readonly reason: string;
  /**
   * Signals that contributed to the scores, one string per
   * contribution, for UI display.
   */
  readonly basis: readonly string[];
}

export interface ConfidenceInput {
  readonly receipt: RunReceipt;
  readonly scopeClassification?: ScopeClassification | null;
  /** Average worker confidence from the run, if available. */
  readonly averageWorkerConfidence?: number;
  /** Critic confidence from the critic worker (0-1). */
  readonly criticConfidence?: number;
  /** Number of critic findings (issues found). */
  readonly criticFindings?: number;
  /** Whether the critic approved, needs-revision, or rejected. */
  readonly criticVerdict?: "approved" | "needs-revision" | "rejected";
  /** Number of rehearsal retries (Builder↔Critic cycles). */
  readonly rehearsalRetries?: number;
  /** Whether a fallback provider was used. */
  readonly usedFallback?: boolean;
  /** Whether an escalation was triggered. */
  readonly escalationTriggered?: boolean;
  /** Number of files touched. */
  readonly filesTouched?: number;
  /** Whether section-edit mode was used (large file). */
  readonly sectionEditUsed?: boolean;
  /** Whether the run was a partial success. */
  readonly partialSuccess?: boolean;
  /** Sensitive files touched (configs, security, auth). */
  readonly sensitiveFilesTouched?: number;
}

// ─── Weights ─────────────────────────────────────────────────────────

const W_PLAN = 0.15;
const W_EXEC = 0.20;
const W_CRITIC = 0.25;
const W_VERIFY = 0.30;
const W_RISK = 0.10;

// ─── Decision Thresholds ─────────────────────────────────────────────

const T_APPLY = 0.85;
const T_REVIEW = 0.70;
const T_ESCALATE = 0.50;

// ─── Public API ──────────────────────────────────────────────────────

export function scoreRunConfidence(input: ConfidenceInput): ConfidenceBreakdown {
  const basis: string[] = [];
  const penalties: string[] = [];

  const plan = scorePlanning(input, basis);
  const exec = scoreExecution(input, basis);
  const critic = scoreCritic(input, basis);
  const verify = scoreVerification(input, basis);
  const risk = scoreRisk(input, basis, penalties);

  // Weighted combination
  let overall = clamp01(
    plan * W_PLAN + exec * W_EXEC + critic * W_CRITIC + verify * W_VERIFY + risk * W_RISK,
  );

  // Apply penalty deductions
  for (const penalty of penalties) {
    // Each penalty line encodes a deduction at the end: "... → -0.05"
    const match = penalty.match(/→ -([\d.]+)$/);
    if (match) {
      overall = clamp01(overall - parseFloat(match[1]!));
    }
  }

  basis.push(
    `overall = ${W_PLAN}·plan(${plan.toFixed(2)}) + ${W_EXEC}·exec(${exec.toFixed(2)}) + ${W_CRITIC}·crit(${critic.toFixed(2)}) + ${W_VERIFY}·verify(${verify.toFixed(2)}) + ${W_RISK}·risk(${risk.toFixed(2)}) = ${overall.toFixed(2)}`,
  );

  const decision = decideFromConfidence(overall);
  const reason = explainDecision(decision, overall, penalties);

  return {
    overall,
    planning: plan,
    execution: exec,
    critic,
    verification: verify,
    risk,
    penalties,
    decision,
    reason,
    basis,
  };
}

// ─── Decision logic ──────────────────────────────────────────────────

function decideFromConfidence(overall: number): ConfidenceDecision {
  if (overall >= T_APPLY) return "apply";
  if (overall >= T_REVIEW) return "review";
  if (overall >= T_ESCALATE) return "escalate";
  return "reject";
}

function explainDecision(decision: ConfidenceDecision, overall: number, penalties: readonly string[]): string {
  const pct = (overall * 100).toFixed(0);
  switch (decision) {
    case "apply": return `High confidence (${pct}%) — apply candidate`;
    case "review": return `Moderate confidence (${pct}%) — human review recommended${penalties.length > 0 ? ` (${penalties.length} penalties)` : ""}`;
    case "escalate": return `Low confidence (${pct}%) — escalation to stronger model recommended${penalties.length > 0 ? ` (${penalties.length} penalties)` : ""}`;
    case "reject": return `Very low confidence (${pct}%) — reject or return structured failure`;
  }
}

// ─── Sub-scores ──────────────────────────────────────────────────────

function scorePlanning(input: ConfidenceInput, basis: string[]): number {
  const scope = input.scopeClassification ?? null;
  let score = 0.5; // neutral baseline

  if (!scope) {
    basis.push("plan:no-scope-classification → 0.50 baseline");
    return score;
  }

  switch (scope.type) {
    case "single-file":
      score = 0.9;
      basis.push("plan:single-file → 0.90 (bounded scope)");
      break;
    case "multi-file":
      score = 0.7;
      basis.push("plan:multi-file → 0.70 (coordinated scope)");
      break;
    case "architectural":
      score = 0.4;
      basis.push("plan:architectural → 0.40 (wide surface)");
      break;
    case "migration":
      score = 0.35;
      basis.push("plan:migration → 0.35 (migration scope)");
      break;
  }

  if (scope.recommendDecompose) {
    score = Math.max(0, score - 0.1);
    basis.push("plan:decompose-recommended → -0.10");
  }

  return clamp01(score);
}

function scoreExecution(input: ConfidenceInput, basis: string[]): number {
  const receipt = input.receipt;
  let score = 0;

  if (receipt.executionVerified) {
    score = 0.70;
    basis.push("exec:gate verified → 0.70");
  } else {
    basis.push("exec:gate NOT verified → 0.00");
    return 0;
  }

  // Evidence items
  const evidenceCount = receipt.executionEvidence?.length ?? 0;
  if (evidenceCount >= 3) {
    score += 0.10;
    basis.push(`exec:${evidenceCount} evidence items → +0.10`);
  } else if (evidenceCount >= 1) {
    score += 0.05;
    basis.push(`exec:${evidenceCount} evidence item(s) → +0.05`);
  }

  // Commit produced
  if (receipt.commitSha) {
    score += 0.10;
    basis.push(`exec:commit ${receipt.commitSha.slice(0, 8)} → +0.10`);
  }

  // Worker confidence signal
  if (typeof input.averageWorkerConfidence === "number" && input.averageWorkerConfidence > 0) {
    const boost = (input.averageWorkerConfidence - 0.5) * 0.15;
    score += boost;
    basis.push(`exec:avg worker conf ${input.averageWorkerConfidence.toFixed(2)} → ${boost >= 0 ? "+" : ""}${boost.toFixed(2)}`);
  }

  // Failed graph nodes
  const failed = receipt.graphSummary?.failed ?? 0;
  if (failed > 0) {
    const penalty = 0.15 * Math.min(failed, 3);
    score -= penalty;
    basis.push(`exec:${failed} failed node(s) → -${penalty.toFixed(2)}`);
  }

  return clamp01(score);
}

function scoreCritic(input: ConfidenceInput, basis: string[]): number {
  // If no critic data, use neutral baseline
  if (input.criticVerdict === undefined && input.criticConfidence === undefined) {
    basis.push("critic:no data → 0.60 baseline");
    return 0.6;
  }

  let score = 0.5;

  // Critic verdict
  switch (input.criticVerdict) {
    case "approved":
      score = 0.90;
      basis.push("critic:approved → 0.90");
      break;
    case "needs-revision":
      score = 0.55;
      basis.push("critic:needs-revision → 0.55");
      break;
    case "rejected":
      score = 0.15;
      basis.push("critic:rejected → 0.15");
      break;
  }

  // Critic confidence modulates the verdict score
  if (typeof input.criticConfidence === "number") {
    const modulation = (input.criticConfidence - 0.5) * 0.2;
    score += modulation;
    basis.push(`critic:confidence ${input.criticConfidence.toFixed(2)} → ${modulation >= 0 ? "+" : ""}${modulation.toFixed(2)}`);
  }

  // Findings penalty — more unresolved findings = less trust
  if (typeof input.criticFindings === "number" && input.criticFindings > 0) {
    const penalty = Math.min(input.criticFindings * 0.08, 0.3);
    score -= penalty;
    basis.push(`critic:${input.criticFindings} finding(s) → -${penalty.toFixed(2)}`);
  }

  return clamp01(score);
}

function scoreVerification(input: ConfidenceInput, basis: string[]): number {
  const v = input.receipt.verificationReceipt;
  if (!v) {
    basis.push("verify:not run → 0.25 (no positive signal)");
    return 0.25;
  }
  switch (v.verdict) {
    case "pass": {
      const score = 0.6 + v.confidenceScore * 0.4;
      basis.push(`verify:pass (pipeline conf ${v.confidenceScore.toFixed(2)}) → ${score.toFixed(2)}`);
      return clamp01(score);
    }
    case "pass-with-warnings": {
      const score = 0.5 + v.confidenceScore * 0.25;
      basis.push(`verify:pass-with-warnings (pipeline conf ${v.confidenceScore.toFixed(2)}) → ${score.toFixed(2)}`);
      return clamp01(score);
    }
    case "fail": {
      basis.push("verify:fail → 0.05");
      return 0.05;
    }
    default:
      basis.push(`verify:unknown(${v.verdict}) → 0.25`);
      return 0.25;
  }
}

function scoreRisk(input: ConfidenceInput, basis: string[], penalties: string[]): number {
  let score = 1.0; // start at full, deduct for risk factors

  // Multi-file breadth
  const filesTouched = input.filesTouched ?? 0;
  if (filesTouched > 5) {
    const penalty = Math.min((filesTouched - 5) * 0.05, 0.25);
    score -= penalty;
    penalties.push(`${filesTouched} files touched (>5) → -${penalty.toFixed(2)}`);
    basis.push(`risk:${filesTouched} files → -${penalty.toFixed(2)}`);
  }

  // Rehearsal retries
  if (typeof input.rehearsalRetries === "number" && input.rehearsalRetries > 0) {
    const penalty = input.rehearsalRetries * 0.08;
    score -= penalty;
    penalties.push(`${input.rehearsalRetries} rehearsal retry(ies) → -${penalty.toFixed(2)}`);
    basis.push(`risk:${input.rehearsalRetries} retries → -${penalty.toFixed(2)}`);
  }

  // Fallback used
  if (input.usedFallback) {
    score -= 0.05;
    penalties.push("fallback provider used → -0.05");
    basis.push("risk:fallback → -0.05");
  }

  // Escalation triggered
  if (input.escalationTriggered) {
    score -= 0.05;
    penalties.push("escalation triggered → -0.05");
    basis.push("risk:escalation → -0.05");
  }

  // Section-edit mode (large file risk)
  if (input.sectionEditUsed) {
    score -= 0.05;
    penalties.push("section-edit mode (large file) → -0.05");
    basis.push("risk:section-edit → -0.05");
  }

  // Partial success
  if (input.partialSuccess) {
    score -= 0.15;
    penalties.push("partial success → -0.15");
    basis.push("risk:partial → -0.15");
  }

  // Sensitive files
  if (typeof input.sensitiveFilesTouched === "number" && input.sensitiveFilesTouched > 0) {
    const penalty = input.sensitiveFilesTouched * 0.10;
    score -= penalty;
    penalties.push(`${input.sensitiveFilesTouched} sensitive file(s) → -${penalty.toFixed(2)}`);
    basis.push(`risk:sensitive files → -${penalty.toFixed(2)}`);
  }

  if (score >= 1.0) {
    basis.push("risk:clean → 1.00 (no risk factors)");
  }

  return clamp01(score);
}

// ─── Worker-level confidence helpers ────────────────────────────────
// These replace the fixed constants in scout.ts and builder.ts.

/**
 * Compute builder confidence from actual run signals.
 * Replaces the fixed BUILDER_CONFIDENCE = 0.78 constant.
 */
export function computeBuilderConfidence(signals: {
  /** Did the diff apply cleanly? */
  diffApplied: boolean;
  /** Was section-edit mode used? (large file risk) */
  sectionEdit: boolean;
  /** Section retention ratio (0-1), if section-edit was used. */
  sectionRetention?: number;
  /** Did the builder use a fallback provider? */
  usedFallback: boolean;
  /** How many lines were changed? */
  linesChanged: number;
  /** Total lines in target file. */
  totalLines: number;
  /** Number of files modified (should be 1 for builder). */
  filesModified: number;
}): number {
  let confidence = 0.80; // base: higher than old 0.78 because we now deduct for real signals

  // Diff didn't apply → major risk
  if (!signals.diffApplied) {
    confidence -= 0.30;
  }

  // Section edit risk
  if (signals.sectionEdit) {
    confidence -= 0.05;
    if (typeof signals.sectionRetention === "number" && signals.sectionRetention < 0.97) {
      confidence -= 0.10; // significant content loss
    }
  }

  // Fallback provider used
  if (signals.usedFallback) {
    confidence -= 0.05;
  }

  // Change magnitude — very large changes relative to file size
  if (signals.totalLines > 0) {
    const changeRatio = signals.linesChanged / signals.totalLines;
    if (changeRatio > 0.5) {
      confidence -= 0.10; // more than half the file changed
    } else if (changeRatio > 0.3) {
      confidence -= 0.05;
    }
  }

  // Multiple files modified (unexpected for a builder)
  if (signals.filesModified > 1) {
    confidence -= 0.10;
  }

  return clamp01(confidence);
}

/**
 * Compute scout confidence from actual scan results.
 * Replaces the fixed SCOUT_CONFIDENCE = 0.92 constant.
 */
export function computeScoutConfidence(signals: {
  /** Number of target files found and read. */
  filesRead: number;
  /** Number of target files requested. */
  filesRequested: number;
  /** Whether git status was available. */
  gitStatusAvailable: boolean;
  /** Complexity level of the target. */
  complexityLevel: "low" | "medium" | "high" | "very-high";
}): number {
  let confidence = 0.90; // base

  // File coverage — how many requested files were actually read
  if (signals.filesRequested > 0) {
    const coverage = signals.filesRead / signals.filesRequested;
    if (coverage < 1.0) {
      confidence -= (1.0 - coverage) * 0.20; // up to -0.20 for missing files
    }
  }

  // Git status available
  if (!signals.gitStatusAvailable) {
    confidence -= 0.05;
  }

  // Complexity deduction
  switch (signals.complexityLevel) {
    case "very-high": confidence -= 0.10; break;
    case "high": confidence -= 0.05; break;
  }

  return clamp01(confidence);
}

// ─── Utilities ───────────────────────────────────────────────────────

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
