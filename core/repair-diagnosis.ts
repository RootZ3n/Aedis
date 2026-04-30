/**
 * Repair Diagnosis — Adaptive intelligence for failed subtasks/runs.
 *
 * When a run or subtask fails verification, this module analyzes the
 * failure evidence and produces a structured diagnosis with:
 *   - Likely cause
 *   - Suggested repair action
 *   - Confidence in the repair
 *   - Files likely involved
 *   - Bounded repair proposal
 *
 * Safety:
 *   - Never auto-promotes — diagnosis is advisory only
 *   - Never hides failure — every diagnosis carries the raw evidence
 *   - Respects max repair attempts — callers check budget before acting
 *   - Repair =/= success — verification must pass after repair
 *   - Never mutates source outside workspace
 */

import type { RunReceipt } from "./coordinator.js";
import type { ScoutReport } from "./scout-report.js";

// ─── Types ───────────────────────────────────────────────────────────

export type RepairCategory =
  | "verification-failure"   // tests/typecheck/lint failed
  | "empty-output"           // builder produced no changes
  | "scope-drift"            // builder changed wrong files
  | "syntax-error"           // produced invalid code
  | "missing-export"         // broke existing exports
  | "merge-blocked"          // merge gate rejected
  | "execution-gate-failed"  // execution gate said no real work
  | "timeout"                // timed out
  | "unknown";               // can't determine

export interface RepairDiagnosis {
  /** Machine-readable failure category */
  readonly category: RepairCategory;
  /** Human-readable root cause analysis */
  readonly rootCause: string;
  /** Concrete suggested repair action */
  readonly suggestedAction: string;
  /** 0–1 confidence that the suggested repair will work */
  readonly confidence: number;
  /** Files likely involved in the failure */
  readonly likelyFiles: readonly string[];
  /** Raw evidence strings that informed this diagnosis */
  readonly evidence: readonly string[];
  /** Whether this failure is likely retriable */
  readonly retriable: boolean;
  /** Hint to sharpen the repair prompt */
  readonly repairHint: string;
  /** Current attempt number when diagnosis was made */
  readonly attemptNumber: number;
  /** Max attempts allowed */
  readonly maxAttempts: number;
  /** ISO timestamp */
  readonly diagnosedAt: string;
}

// ─── Public API ──────────────────────────────────────────────────────

export interface DiagnoseFailureInput {
  /** The RunReceipt from the failed attempt */
  readonly receipt: RunReceipt;
  /** The original subtask prompt */
  readonly originalPrompt: string;
  /** Current attempt number (1-based) */
  readonly attemptNumber: number;
  /** Max attempts allowed by budget */
  readonly maxAttempts: number;
  /** Scout evidence if available */
  readonly scoutReports?: readonly ScoutReport[];
}

/**
 * Analyze a failed run and produce a structured repair diagnosis.
 * Pure function — no side effects.
 */
export function diagnoseFailure(input: DiagnoseFailureInput): RepairDiagnosis {
  const { receipt, originalPrompt, attemptNumber, maxAttempts } = input;
  const evidence: string[] = [];
  const likelyFiles: string[] = [];

  // Collect evidence from the receipt
  const verdict = receipt.verdict;
  evidence.push(`verdict: ${verdict}`);

  const gateReason = receipt.executionGateReason ?? "";
  if (gateReason) evidence.push(`execution-gate: ${gateReason}`);

  const mergeReason = receipt.mergeDecision?.primaryBlockReason ?? "";
  if (mergeReason) evidence.push(`merge-block: ${mergeReason}`);

  const verificationVerdict = receipt.verificationReceipt?.verdict ?? null;
  if (verificationVerdict) evidence.push(`verification: ${verificationVerdict}`);

  // Extract file info from receipt
  if (receipt.patchArtifact?.changedFiles) {
    for (const f of receipt.patchArtifact.changedFiles) {
      likelyFiles.push(f);
    }
  }

  // Use scout evidence for file hints
  if (input.scoutReports) {
    for (const report of input.scoutReports) {
      for (const target of report.recommendedTargets) {
        if (!likelyFiles.includes(target)) {
          likelyFiles.push(target);
        }
      }
    }
  }

  // Extract blocker messages from verification receipt
  const blockers: string[] = [];
  if (receipt.verificationReceipt) {
    const vr = receipt.verificationReceipt as {
      blockers?: readonly { message: string }[];
      summary?: string;
    };
    if (Array.isArray(vr.blockers)) {
      for (const b of vr.blockers) {
        blockers.push(typeof b === "string" ? b : b.message || String(b));
      }
    }
    if (vr.summary) evidence.push(`verification-summary: ${vr.summary}`);
  }

  // Extract worker issues
  const humanHeadline = receipt.humanSummary?.headline ?? "";
  if (humanHeadline) evidence.push(`headline: ${humanHeadline}`);

  const failureExplanation = receipt.humanSummary?.failureExplanation as {
    rootCause?: string;
    stage?: string;
    suggestedFix?: string;
  } | null;
  if (failureExplanation?.rootCause) {
    evidence.push(`failure-rootCause: ${failureExplanation.rootCause}`);
  }

  // ── Classify the failure ──────────────────────────────────────────
  const diagnosis = classifyFailure(
    verdict,
    gateReason,
    mergeReason,
    verificationVerdict,
    blockers,
    humanHeadline,
    failureExplanation,
    evidence,
    likelyFiles,
    originalPrompt,
  );

  return {
    ...diagnosis,
    attemptNumber,
    maxAttempts,
    diagnosedAt: new Date().toISOString(),
  };
}

// ─── Classification Rules ────────────────────────────────────────────

function classifyFailure(
  verdict: string,
  gateReason: string,
  mergeReason: string,
  verificationVerdict: string | null,
  blockers: string[],
  headline: string,
  failureExplanation: { rootCause?: string; stage?: string; suggestedFix?: string } | null,
  evidence: string[],
  likelyFiles: string[],
  originalPrompt: string,
): Omit<RepairDiagnosis, "attemptNumber" | "maxAttempts" | "diagnosedAt"> {
  const combinedText = [
    gateReason, mergeReason, headline,
    ...blockers,
    failureExplanation?.rootCause ?? "",
  ].join(" ").toLowerCase();

  // Rule 1: Verification failure (tests/typecheck/lint)
  if (
    verificationVerdict === "fail" ||
    combinedText.includes("typecheck") ||
    combinedText.includes("test") ||
    combinedText.includes("lint") ||
    combinedText.includes("tsc") ||
    combinedText.includes("assertion")
  ) {
    const testFailed = combinedText.includes("test");
    const typeFailed = combinedText.includes("typecheck") || combinedText.includes("tsc");
    const lintFailed = combinedText.includes("lint");

    const parts: string[] = [];
    if (testFailed) parts.push("test failures");
    if (typeFailed) parts.push("type errors");
    if (lintFailed) parts.push("lint violations");
    const what = parts.length > 0 ? parts.join(", ") : "verification checks";

    return {
      category: "verification-failure",
      rootCause: `Verification failed: ${what}. ${blockers.slice(0, 2).join("; ") || headline}`,
      suggestedAction: `Fix the ${what} in the affected files. ${failureExplanation?.suggestedFix || "Check the verification output for specific errors."}`,
      confidence: 0.6,
      likelyFiles,
      evidence,
      retriable: true,
      repairHint:
        `[REPAIR] The previous attempt failed verification (${what}). ` +
        `${blockers.length > 0 ? "Specific issues: " + blockers.slice(0, 3).join("; ") + ". " : ""}` +
        `Fix these issues while preserving the original intent: ${truncate(originalPrompt, 100)}`,
    };
  }

  // Rule 2: Empty output / no real changes
  if (
    combinedText.includes("no real output") ||
    combinedText.includes("empty") ||
    combinedText.includes("no change") ||
    combinedText.includes("no effective change") ||
    gateReason.includes("no real output")
  ) {
    return {
      category: "empty-output",
      rootCause: "The builder produced no effective changes. The model may have output prose instead of code, or the changes were trivial/empty.",
      suggestedAction: "Retry with a clearer prompt specifying exactly which file(s) to modify and what the concrete change should be.",
      confidence: 0.5,
      likelyFiles,
      evidence,
      retriable: true,
      repairHint:
        `[REPAIR] The previous attempt produced NO changes. You MUST make a concrete code edit this time. ` +
        `Target files: ${likelyFiles.slice(0, 3).join(", ") || "unknown"}. ` +
        `Original request: ${truncate(originalPrompt, 100)}`,
    };
  }

  // Rule 3: Scope drift
  if (
    combinedText.includes("scope") ||
    combinedText.includes("wrong file") ||
    combinedText.includes("out of scope") ||
    combinedText.includes("unrelated")
  ) {
    return {
      category: "scope-drift",
      rootCause: "The builder modified files outside the intended scope, or made changes unrelated to the task.",
      suggestedAction: "Retry with explicit file targets and a clearer scope constraint.",
      confidence: 0.55,
      likelyFiles,
      evidence,
      retriable: true,
      repairHint:
        `[REPAIR] The previous attempt changed wrong/unrelated files. ` +
        `Only modify files directly related to: ${truncate(originalPrompt, 80)}. ` +
        `Likely targets: ${likelyFiles.slice(0, 3).join(", ") || "check the original request"}.`,
    };
  }

  // Rule 4: Syntax / parse error
  if (
    combinedText.includes("syntax") ||
    combinedText.includes("parse error") ||
    combinedText.includes("unexpected token") ||
    combinedText.includes("cannot find module")
  ) {
    return {
      category: "syntax-error",
      rootCause: "The builder produced code with syntax or parse errors.",
      suggestedAction: "Retry — the model should produce valid code. Check for truncated output or mixed prose/code.",
      confidence: 0.65,
      likelyFiles,
      evidence,
      retriable: true,
      repairHint:
        `[REPAIR] The previous attempt had syntax errors. ` +
        `Produce ONLY valid, parseable code. Do not truncate files or mix prose with code. ` +
        `Original request: ${truncate(originalPrompt, 100)}`,
    };
  }

  // Rule 5: Missing exports
  if (
    combinedText.includes("export") ||
    combinedText.includes("exported") ||
    combinedText.includes("not exported")
  ) {
    return {
      category: "missing-export",
      rootCause: "The builder removed or broke existing exports that other files depend on.",
      suggestedAction: "Retry while preserving ALL existing exports. Add new exports alongside existing ones.",
      confidence: 0.7,
      likelyFiles,
      evidence,
      retriable: true,
      repairHint:
        `[REPAIR] The previous attempt removed or broke existing exports. ` +
        `Preserve EVERY existing export. Only ADD new functionality — do not remove or rename existing APIs. ` +
        `Original request: ${truncate(originalPrompt, 100)}`,
    };
  }

  // Rule 6: Merge blocked
  if (
    mergeReason ||
    combinedText.includes("merge blocked") ||
    combinedText.includes("critical finding")
  ) {
    return {
      category: "merge-blocked",
      rootCause: `Merge gate blocked the commit: ${mergeReason || "critical findings detected"}`,
      suggestedAction: failureExplanation?.suggestedFix || "Address the merge gate's critical findings before retrying.",
      confidence: 0.4,
      likelyFiles,
      evidence,
      retriable: true,
      repairHint:
        `[REPAIR] The merge gate blocked the previous attempt: ${mergeReason || "critical issues found"}. ` +
        `Fix these issues. Original request: ${truncate(originalPrompt, 100)}`,
    };
  }

  // Rule 7: Execution gate failed
  if (gateReason && !gateReason.includes("not evaluated")) {
    return {
      category: "execution-gate-failed",
      rootCause: `Execution gate rejected the run: ${gateReason}`,
      suggestedAction: "The run did not produce verifiable work. Try a more specific prompt with named targets.",
      confidence: 0.35,
      likelyFiles,
      evidence,
      retriable: true,
      repairHint:
        `[REPAIR] Execution gate rejected: ${truncate(gateReason, 80)}. ` +
        `Produce concrete, verifiable changes. Original request: ${truncate(originalPrompt, 100)}`,
    };
  }

  // Rule 8: Timeout
  if (combinedText.includes("timeout") || combinedText.includes("timed out")) {
    return {
      category: "timeout",
      rootCause: "The run timed out before completing. The task may be too large for a single attempt.",
      suggestedAction: "Try breaking the task into smaller, more focused subtasks.",
      confidence: 0.3,
      likelyFiles,
      evidence,
      retriable: false,
      repairHint: "",
    };
  }

  // Fallback: unknown
  return {
    category: "unknown",
    rootCause: headline || "The run failed for an unknown reason. Check the worker logs for details.",
    suggestedAction: failureExplanation?.suggestedFix || "Review the run receipt and worker logs, then try a more specific prompt.",
    confidence: 0.2,
    likelyFiles,
    evidence,
    retriable: true,
    repairHint:
      `[REPAIR] Previous attempt failed: ${truncate(headline || "unknown reason", 80)}. ` +
      `Try again with corrections. Original request: ${truncate(originalPrompt, 100)}`,
  };
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}
