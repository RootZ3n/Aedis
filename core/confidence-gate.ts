/**
 * Confidence Gate — simple, rule-based confidence scoring for runs.
 *
 * Inputs:
 *   - tests_passed: did post-build tests pass?
 *   - integration_passed: did the IntegrationJudge pass?
 *   - critic_iterations: how many Critic rehearsal rounds?
 *   - impact_level: from the impact classifier
 *
 * Output:
 *   - "high" | "medium" | "low"
 *
 * Rules:
 *   HIGH  → all pass + low/medium impact
 *   MEDIUM → minor issues (warnings, 1 retry, high impact but passing)
 *   LOW   → failures, multiple retries, or warnings on high impact
 *
 * This does NOT replace the numeric confidence in RunSummary.
 * It is a discrete, human-readable gate label for the receipt.
 */

import type { ImpactLevel } from "./impact-classifier.js";
import type { GuardFinding } from "./adversarial-guard.js";

export type ConfidenceLevel = "high" | "medium" | "low";

export interface ConfidenceInput {
  readonly testsPassed: boolean;
  readonly integrationPassed: boolean;
  readonly criticIterations: number;
  readonly impactLevel: ImpactLevel;
  /**
   * Phase 8 — adversarial-guard findings collected across the run
   * (scout injection scans, execution-gate content-identity, judge
   * consensus / intent-satisfaction). Null/empty when no signals
   * fired. The gate treats them as downward pressure on confidence,
   * never upward.
   */
  readonly adversarialFindings?: readonly GuardFinding[];
}

export interface ConfidenceResult {
  readonly level: ConfidenceLevel;
  readonly reasons: string[];
  /** Phase 8 — true when any `escalate`-severity finding fired. */
  readonly escalationRecommended?: boolean;
}

export function scoreConfidence(input: ConfidenceInput): ConfidenceResult {
  const reasons: string[] = [];
  const findings = input.adversarialFindings ?? [];
  const hasEscalate = findings.some((f) => f.severity === "escalate");
  const hasDowngrade = findings.some((f) => f.severity === "downgrade");
  const hasWarn = findings.some((f) => f.severity === "warn");

  // Phase 8 — content-identity, execution-unverified, or an attempted
  // instruction override all force LOW. These are the strongest
  // signals that the run did not produce real, intended work.
  if (hasDowngrade || hasEscalate) {
    const codes = [...new Set(findings
      .filter((f) => f.severity === "downgrade" || f.severity === "escalate")
      .map((f) => f.code))];
    reasons.push(`adversarial signals: ${codes.join(", ")}`);
    return {
      level: "low",
      reasons,
      escalationRecommended: hasEscalate,
    };
  }

  // Tests failed → LOW regardless
  if (!input.testsPassed) {
    reasons.push("tests failed");
    return { level: "low", reasons };
  }

  // Integration failed → LOW regardless
  if (!input.integrationPassed) {
    reasons.push("integration check failed");
    return { level: "low", reasons };
  }

  // Multiple critic iterations → concern
  if (input.criticIterations > 2) {
    reasons.push(`${input.criticIterations} critic iterations (excessive retries)`);
    return { level: "low", reasons };
  }

  // HIGH impact with any retries → MEDIUM at best
  if (input.impactLevel === "high" && input.criticIterations > 0) {
    reasons.push(`high impact with ${input.criticIterations} critic iteration(s)`);
    return { level: "medium", reasons };
  }

  // Phase 8 — any warn-severity adversarial finding caps confidence at MEDIUM
  // even if everything else is green. Warns are softer signals (partial
  // consensus, weak intent match) that we surface without LOW-ing the run.
  if (hasWarn) {
    reasons.push(`adversarial warnings present: ${findings
      .filter((f) => f.severity === "warn")
      .slice(0, 2)
      .map((f) => f.code)
      .join(", ")}`);
    return { level: "medium", reasons };
  }

  // Single critic retry → MEDIUM
  if (input.criticIterations === 1) {
    reasons.push("1 critic iteration (minor rework)");
    return { level: "medium", reasons };
  }

  // HIGH impact, everything passed, no retries → MEDIUM
  // (high-impact changes warrant extra caution even when clean)
  if (input.impactLevel === "high") {
    reasons.push("high impact — elevated caution despite clean pass");
    return { level: "medium", reasons };
  }

  // Everything passed, low/medium impact, no retries → HIGH
  reasons.push("all gates passed, low/medium impact, no retries");
  return { level: "high", reasons };
}
