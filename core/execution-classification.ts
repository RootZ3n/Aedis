/**
 * Execution Classification — Human-Readable Execution + Trust Layer v1.
 *
 * Maps the raw coordinator verdict + execution gate decision +
 * verification outcome into one of four user-facing labels:
 *
 *   VERIFIED_SUCCESS — the run produced real evidence, every gate
 *                      passed, verification was positive.
 *   PARTIAL_SUCCESS  — real evidence exists but at least one gate
 *                      raised a warning (pass-with-warnings,
 *                      repair-audit findings, failed waves).
 *   NO_OP            — no real evidence at all. The execution gate
 *                      blocked the run; no files were written, no
 *                      commit was made. This is the fake-success
 *                      path that Execution Truth Enforcement v1
 *                      closed, surfaced explicitly so the UI can
 *                      render it as such.
 *   FAILED           — the run actively failed: an error was
 *                      thrown, verification rejected the changes,
 *                      the merge gate blocked, or the user
 *                      cancelled.
 *
 * The classification is a pure function of the RunReceipt fields
 * the Coordinator already populates — no new worker signals, no
 * new state. Every output is inspectable: `reasonCode` names the
 * specific rule that fired, and `factors` lists every signal that
 * contributed.
 */

import type { RunReceipt } from "./coordinator.js";

// ─── Types ───────────────────────────────────────────────────────────

export type ExecutionClassification =
  | "VERIFIED_SUCCESS"
  | "PARTIAL_SUCCESS"
  | "NO_OP"
  | "FAILED";

export interface ExecutionClassificationResult {
  readonly classification: ExecutionClassification;
  /** Short machine-readable code for the rule that fired. */
  readonly reasonCode: string;
  /** Human-readable one-line reason suitable for UI display. */
  readonly reason: string;
  /** Every signal that contributed to the decision. */
  readonly factors: readonly string[];
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Classify a RunReceipt into one of the four user-facing labels.
 * Pure function — no side effects, no network, no state.
 */
export function classifyExecution(receipt: RunReceipt): ExecutionClassificationResult {
  const factors: string[] = [];

  const verdict = receipt.verdict;
  const executionVerified = receipt.executionVerified;
  const gateReason = receipt.executionGateReason ?? "";
  const verification = receipt.verificationReceipt;
  const mergeAction = receipt.mergeDecision?.action ?? null;
  const graph = receipt.graphSummary;

  factors.push(`verdict:${verdict}`);
  factors.push(`executionVerified:${executionVerified}`);
  if (verification) factors.push(`verification:${verification.verdict}`);
  if (mergeAction) factors.push(`merge:${mergeAction}`);

  // ── Rule 1: aborted → always FAILED ──────────────────────────────
  // A cancelled run is never a success, partial or otherwise.
  if (verdict === "aborted") {
    return {
      classification: "FAILED",
      reasonCode: "aborted",
      reason: "Run was cancelled before completion",
      factors,
    };
  }

  // ── Rule 1b: scope-violation merge block → FAILED (scope-violation)
  // When the merge gate blocks because of an explicit scope-lock
  // breach — either via the integration-judge scope-boundary check
  // (`judge:scope-boundary`) or the git-diff verifier's
  // unexpected-reference signal (`git-diff:unexpected-reference-change`)
  // — surface that as the primary cause. Otherwise the gate-no-op
  // rule below would mask the real reason, exactly as observed in
  // burn-in-01: a content-identical bogus edit on the out-of-scope
  // file got reported as NO_OP instead of "you touched a file that
  // wasn't allowed". Fires before the no-op rule on purpose.
  const scopeViolation = receipt.mergeDecision?.critical.find(
    (f) =>
      f.code === "judge:scope-boundary" ||
      f.code === "git-diff:unexpected-reference-change",
  );
  if (scopeViolation && mergeAction === "block") {
    factors.push(`scope:${scopeViolation.code}`);
    return {
      classification: "FAILED",
      reasonCode: "scope-violation",
      reason: `Scope violation: ${scopeViolation.message}`,
      factors,
    };
  }

  // ── Rule 2: gate blocked as no-op → NO_OP ───────────────────────
  // The execution gate reports a "no_op" via its reason text. We
  // detect it by the specific marker the gate uses, which is stable
  // across versions (see core/execution-gate.ts).
  const gateSaysNoOp = /no-op execution detected/i.test(gateReason);
  if (gateSaysNoOp) {
    factors.push("gate:no_op");
    return {
      classification: "NO_OP",
      reasonCode: "gate-no-op",
      reason:
        receipt.graphSummary.totalNodes === 0
          ? "Planner produced zero actionable nodes — nothing to execute"
          : "No files were created, modified, or deleted and no commit was produced",
      factors,
    };
  }

  // ── Rule 3: gate errored → FAILED ────────────────────────────────
  // "Execution errored" markers come from the thrown-error path in
  // the execution gate.
  if (/execution errored/i.test(gateReason)) {
    factors.push("gate:errored");
    return {
      classification: "FAILED",
      reasonCode: "gate-errored",
      reason: "Run raised an error before producing verifiable work",
      factors,
    };
  }

  // ── Rule 4: verdict failed → FAILED ──────────────────────────────
  // Any remaining "failed" verdict is a real failure with a real
  // reason — verification rejected, merge gate blocked, judgment
  // failed, etc.
  if (verdict === "failed") {
    const reasonCode = verification?.verdict === "fail"
      ? "verification-fail"
      : mergeAction === "block"
        ? "merge-blocked"
        : "verdict-failed";
    return {
      classification: "FAILED",
      reasonCode,
      reason:
        reasonCode === "verification-fail"
          ? "Verification pipeline rejected the changes"
          : reasonCode === "merge-blocked"
            ? `Merge gate blocked the commit: ${receipt.mergeDecision?.primaryBlockReason || "policy violation"}`
            : "Run did not pass all required gates",
      factors,
    };
  }

  // ── Rule 5: unverified success → NO_OP ───────────────────────────
  // Defensive check — a success verdict without execution
  // verification should never happen after Execution Truth
  // Enforcement v1, but if something upstream regresses we label
  // it as no-op rather than silently passing it through. This is
  // the "strict default: unknown gate state is a failure" rule.
  if ((verdict === "success" || verdict === "partial") && !executionVerified) {
    factors.push("regression:unverified-non-failed-verdict");
    return {
      classification: "NO_OP",
      reasonCode: "unverified-verdict",
      reason: "Run finished without verifiable evidence of real work",
      factors,
    };
  }

  // ── Rule 6: partial → PARTIAL_SUCCESS ────────────────────────────
  if (verdict === "partial") {
    const flagged: string[] = [];
    if (verification?.verdict === "pass-with-warnings") flagged.push("verification warnings");
    if (graph.failed > 0) flagged.push(`${graph.failed} failed node(s)`);
    if (receipt.mergeDecision && receipt.mergeDecision.advisory.length > 0) {
      flagged.push(`${receipt.mergeDecision.advisory.length} advisory finding(s)`);
    }
    factors.push("partial:" + (flagged.join(",") || "none"));
    return {
      classification: "PARTIAL_SUCCESS",
      reasonCode: "partial",
      reason: flagged.length > 0
        ? `Changes applied but flagged: ${flagged.join(", ")}`
        : "Changes applied with partial coverage",
      factors,
    };
  }

  // ── Rule 7: success → VERIFIED_SUCCESS ───────────────────────────
  return {
    classification: "VERIFIED_SUCCESS",
    reasonCode: "verified",
    reason:
      verification?.verdict === "pass"
        ? "All changes produced real evidence and verification passed"
        : "Changes produced real evidence and all gates passed",
    factors,
  };
}
