/**
 * MergeGate — Hard stop between accepted changes and the final commit.
 *
 * The Coordinator runs a series of signals before committing:
 *   - IntegrationJudge report (cross-file coherence)
 *   - VerificationPipeline receipt (diff/contract/lint/typecheck/hooks)
 *   - Change-set level gate (wave completion, invariant satisfaction,
 *     repair-pass findings)
 *
 * Each of those signals produces *findings* with a severity. MergeGate
 * collects every finding, classifies it as `critical` or `advisory`,
 * and produces a single `MergeDecision` with a binary action: `apply`
 * or `block`.
 *
 * Contract:
 *   - A `critical` finding ALWAYS blocks. There is no "looks mostly
 *     good" path — the whole point of the gate is that one hard
 *     failure is enough.
 *   - `advisory` findings are surfaced in the decision and the Lumen
 *     stream but never block on their own.
 *   - The decision is pure — it does not touch the filesystem or emit
 *     events. The Coordinator owns rollback / emit / commit.
 *   - Every finding carries a `source` so Lumen and run history can
 *     attribute failures to the subsystem that flagged them.
 */

import type { JudgmentReport, JudgmentIssue } from "./integration-judge.js";
import type {
  VerificationReceipt,
  VerificationIssue,
} from "./verification-pipeline.js";
import type { ChangeSet } from "./change-set.js";
import type { RepairResult } from "./repair-pass.js";

// ─── Types ───────────────────────────────────────────────────────────

export type MergeFindingSource =
  | "integration-judge"
  | "verification-pipeline"
  | "change-set-gate"
  | "coordinator";

export type MergeFindingSeverity = "critical" | "advisory";

export interface MergeFinding {
  readonly source: MergeFindingSource;
  readonly severity: MergeFindingSeverity;
  /** Short machine code for UI filtering (e.g. "judge:type-alignment"). */
  readonly code: string;
  /** Human-readable reason. Shown in Lumen and run history. */
  readonly message: string;
  /** Optional file paths that this finding is about. */
  readonly files?: readonly string[];
}

export interface MergeDecision {
  readonly action: "apply" | "block";
  /** Every finding collected from every source. */
  readonly findings: readonly MergeFinding[];
  /** Findings that caused or would cause a block. */
  readonly critical: readonly MergeFinding[];
  /** Findings that did not block. */
  readonly advisory: readonly MergeFinding[];
  /**
   * Primary blocking reason for UI display. Empty string when action is
   * "apply". Always the first critical finding's message, not a joined
   * summary — we show one clear reason, not a wall of text.
   */
  readonly primaryBlockReason: string;
  /** One-line summary for logs and receipt. */
  readonly summary: string;
}

// ─── Inputs ──────────────────────────────────────────────────────────

export interface MergeGateInputs {
  /** IntegrationJudge report (phase 8). Null means the judge did not run. */
  readonly judgment: JudgmentReport | null;
  /**
   * VerificationPipeline receipt (phase 9). Null means verification did
   * not run — typically because the judge already failed.
   */
  readonly verification: VerificationReceipt | null;
  /**
   * Change-set level signals (phase 9b). Undefined for single-file
   * changes where a change-set gate is not meaningful.
   */
  readonly changeSetGate?: ChangeSetGateInput;
  /**
   * Whether the run was cancelled. A cancelled run always blocks commit.
   */
  readonly cancelled: boolean;
  /**
   * Whether the task graph has failed nodes that were not recovered.
   * Presence of failed nodes always blocks commit.
   */
  readonly hasFailedNodes: boolean;
}

export interface ChangeSetGateInput {
  readonly changeSet: ChangeSet;
  readonly allWavesComplete: boolean;
  readonly invariantsSatisfied: boolean;
  readonly invariantCount: number;
  readonly repairPass: RepairResult;
}

// ─── Decision ────────────────────────────────────────────────────────

/**
 * Compute a MergeDecision from every signal the Coordinator has.
 *
 * Pure — no IO, no event emission, no mutation. Callers are responsible
 * for rolling back file changes and emitting the resulting events.
 */
export function decideMerge(inputs: MergeGateInputs): MergeDecision {
  const findings: MergeFinding[] = [];

  if (inputs.cancelled) {
    findings.push({
      source: "coordinator",
      severity: "critical",
      code: "coordinator:cancelled",
      message: "Run was cancelled before the merge gate.",
    });
  }

  if (inputs.hasFailedNodes) {
    findings.push({
      source: "coordinator",
      severity: "critical",
      code: "coordinator:failed-nodes",
      message: "One or more task nodes failed and were not recovered.",
    });
  }

  if (inputs.judgment) {
    findings.push(...translateJudgment(inputs.judgment));
  } else if (!inputs.cancelled && !inputs.hasFailedNodes) {
    // The judge is supposed to run before we land. If it did not run and
    // we were otherwise healthy, that is itself a critical failure — we
    // refuse to merge without a coherence verdict.
    findings.push({
      source: "integration-judge",
      severity: "critical",
      code: "judge:missing-report",
      message:
        "IntegrationJudge did not produce a report — refusing to merge without a coherence verdict.",
    });
  }

  if (inputs.verification) {
    findings.push(...translateVerification(inputs.verification));
  } else if (inputs.judgment?.passed && !inputs.cancelled && !inputs.hasFailedNodes) {
    // Verification should have run because the judge passed. Missing
    // receipt when the judge passed is a critical contract failure.
    findings.push({
      source: "verification-pipeline",
      severity: "critical",
      code: "verification:missing-receipt",
      message:
        "VerificationPipeline did not produce a receipt after a passing judgment — refusing to merge.",
    });
  }

  if (inputs.changeSetGate) {
    findings.push(...translateChangeSetGate(inputs.changeSetGate));
  }

  const critical = findings.filter((f) => f.severity === "critical");
  const advisory = findings.filter((f) => f.severity === "advisory");
  const action: MergeDecision["action"] = critical.length === 0 ? "apply" : "block";
  const primaryBlockReason = critical[0]?.message ?? "";

  const summary =
    action === "apply"
      ? `MERGE APPROVED — ${advisory.length} advisory finding(s), 0 critical`
      : `MERGE BLOCKED — ${critical.length} critical, ${advisory.length} advisory`;

  return {
    action,
    findings,
    critical,
    advisory,
    primaryBlockReason,
    summary,
  };
}

// ─── Translators ─────────────────────────────────────────────────────

function translateJudgment(report: JudgmentReport): MergeFinding[] {
  const out: MergeFinding[] = [];

  for (const blocker of report.blockers) {
    out.push(judgmentIssueToFinding(blocker, "critical"));
  }
  for (const warning of report.warnings) {
    out.push(judgmentIssueToFinding(warning, "advisory"));
  }

  // The judge's overall passed flag is the source of truth. If it says
  // "failed" but produced zero blockers (can happen when coherenceScore
  // dipped under the minimum without any hard check failing), we still
  // emit a critical finding so the gate blocks.
  if (!report.passed && out.every((f) => f.severity !== "critical")) {
    out.push({
      source: "integration-judge",
      severity: "critical",
      code: "judge:below-threshold",
      message: `Coherence score ${(report.coherenceScore * 100).toFixed(0)}% below minimum`,
    });
  }

  return out;
}

function judgmentIssueToFinding(
  issue: JudgmentIssue,
  severity: MergeFindingSeverity,
): MergeFinding {
  return {
    source: "integration-judge",
    severity,
    code: `judge:${issue.category}`,
    message: issue.message,
    files: issue.files,
  };
}

function translateVerification(receipt: VerificationReceipt): MergeFinding[] {
  const out: MergeFinding[] = [];

  for (const issue of receipt.allIssues) {
    // Severity mapping: the verification pipeline has its own 4-level
    // scale (info/warning/error/blocker). Blockers are always critical;
    // errors are critical too (a type error, a broken contract — these
    // block merges even if the pipeline didn't label them "blocker").
    // Warnings and info are advisory.
    const severity: MergeFindingSeverity =
      issue.severity === "blocker" || issue.severity === "error"
        ? "critical"
        : "advisory";
    out.push(verificationIssueToFinding(issue, severity));
  }

  // Mirror the judge contract: if the receipt says "fail" and we didn't
  // pick up any critical findings from individual issues, emit a
  // critical finding so the gate blocks.
  if (
    receipt.verdict === "fail" &&
    !out.some((f) => f.severity === "critical")
  ) {
    out.push({
      source: "verification-pipeline",
      severity: "critical",
      code: "verification:fail",
      message: `Verification failed: ${receipt.summary}`,
    });
  }

  return out;
}

function verificationIssueToFinding(
  issue: VerificationIssue,
  severity: MergeFindingSeverity,
): MergeFinding {
  return {
    source: "verification-pipeline",
    severity,
    code: `verification:${issue.stage}`,
    message: issue.message,
    files: issue.file ? [issue.file] : undefined,
  };
}

function translateChangeSetGate(gate: ChangeSetGateInput): MergeFinding[] {
  const out: MergeFinding[] = [];

  if (!gate.allWavesComplete) {
    out.push({
      source: "change-set-gate",
      severity: "critical",
      code: "change-set:incomplete-waves",
      message: "Not every wave of the change-set completed cleanly.",
    });
  }

  if (!gate.invariantsSatisfied) {
    out.push({
      source: "change-set-gate",
      severity: "critical",
      code: "change-set:invariants-unsatisfied",
      message:
        gate.invariantCount > 0
          ? `Shared invariants (${gate.invariantCount}) not satisfied across the change-set.`
          : "Change-set coherence verdict failed.",
    });
  }

  if (gate.repairPass.issues.length > 0) {
    // Repair-pass findings are advisory unless they represent structural
    // damage (missing imports, broken exports). Repair-pass currently
    // only surfaces strings, so we treat them uniformly as advisory —
    // the critic/verifier are the ones that block on broken contracts.
    for (const issue of gate.repairPass.issues) {
      out.push({
        source: "change-set-gate",
        severity: "advisory",
        code: "change-set:repair",
        message: issue,
      });
    }
  }

  return out;
}

// ─── Summary helpers ─────────────────────────────────────────────────

/**
 * Group findings by source for compact UI display. The UI usually wants
 * "judge: 2 critical, 1 advisory" rather than a flat list.
 */
export function groupFindingsBySource(
  findings: readonly MergeFinding[],
): Record<MergeFindingSource, { critical: number; advisory: number }> {
  const base: Record<MergeFindingSource, { critical: number; advisory: number }> = {
    "integration-judge": { critical: 0, advisory: 0 },
    "verification-pipeline": { critical: 0, advisory: 0 },
    "change-set-gate": { critical: 0, advisory: 0 },
    "coordinator": { critical: 0, advisory: 0 },
  };

  for (const finding of findings) {
    base[finding.source][finding.severity]++;
  }

  return base;
}
