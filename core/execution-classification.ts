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
 * Extra signals not present on RunReceipt itself but computed in
 * higher layers (run-summary). Letting classifyExecution see them
 * keeps the no-silent-success guarantees in one place rather than
 * scattering them across narrative + headline + classification.
 *
 * Every field is optional. Callers from older paths or unit tests
 * can pass an empty `{}` and behavior matches the legacy receipt-only
 * signature exactly.
 */
export interface ClassifyExtraSignals {
  /**
   * Files the planner declared as required deliverables but the
   * builder did not produce. When non-empty, a "success" verdict is
   * downgraded to FAILED with reasonCode "missing-deliverable" — a
   * run that didn't deliver what was asked for cannot be a success.
   */
  readonly missingRequiredDeliverables?: readonly string[];
  /**
   * True when the verification pipeline produced no real signal
   * (no required checks configured AND no file was actively
   * validated). When true, a "success" verdict is downgraded to
   * FAILED with reasonCode "verification-not-run" — silently
   * unchecked code cannot be a verified success.
   */
  readonly verificationNoSignal?: boolean;
}

/**
 * Classify a RunReceipt into one of the four user-facing labels.
 * Pure function — no side effects, no network, no state.
 */
export function classifyExecution(
  receipt: RunReceipt,
  extra: ClassifyExtraSignals = {},
): ExecutionClassificationResult {
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
  if (receipt.rollback) factors.push(`rollback:${receipt.rollback.status}`);
  if (receipt.providerLaneTruth) factors.push(`providerLane:${receipt.providerLaneTruth.status}`);

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

  // ── Rule 1a: rollback failure/incomplete → always FAILED ─────────
  // Rollback integrity dominates all earlier stage evidence. A run can
  // preserve "verification passed" as evidence, but if cleanup left the
  // workspace/repo unsafe the final classification must be failure.
  if (receipt.rollback && receipt.rollback.status !== "clean") {
    return {
      classification: "FAILED",
      reasonCode: receipt.rollback.status === "incomplete"
        ? "rollback-incomplete"
        : receipt.rollback.status === "unsafe_state"
          ? "rollback-unsafe-state"
          : "rollback-failed",
      reason: receipt.rollback.summary,
      factors,
    };
  }

  if (receipt.providerLaneTruth?.status === "not_run") {
    return {
      classification: "FAILED",
      reasonCode: "unsupported-provider-lane-config",
      reason: receipt.providerLaneTruth.reason,
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

  // ── Rule 4a: awaiting manual approval → PARTIAL_SUCCESS ─────────
  // A pending approval receipt with a real patch artifact is not a
  // no-op. The run intentionally paused before source promotion, so
  // surface the review state instead of falling through to the
  // defensive "unverified partial" rule below.
  if (
    verdict === "partial" &&
    receipt.diffApproval?.status === "pending" &&
    typeof receipt.patchArtifact?.diff === "string" &&
    receipt.patchArtifact.diff.trim().length > 0
  ) {
    factors.push("approval:pending");
    return {
      classification: "PARTIAL_SUCCESS",
      reasonCode: "approval-required",
      reason: "Review required before applying the diff",
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

  // ── Rule 5a: missing required deliverable → FAILED ────────────────
  // The planner declared one or more deliverable files; the builder
  // did not produce them. A run that didn't deliver what was asked
  // for cannot be reported as success — even when every gate passed
  // on the files that DID change. Caught the regression where a
  // single-file edit was accepted while the requested test file was
  // never created.
  const missingDeliverables = extra.missingRequiredDeliverables ?? [];
  if (
    (verdict === "success" || verdict === "partial") &&
    missingDeliverables.length > 0
  ) {
    factors.push(`missing:${missingDeliverables.join(",")}`);
    const list = missingDeliverables.slice(0, 3).join(", ");
    const more = missingDeliverables.length > 3
      ? ` (+${missingDeliverables.length - 3} more)`
      : "";
    return {
      classification: "FAILED",
      reasonCode: "missing-deliverable",
      reason: `Required deliverable(s) not produced: ${list}${more}`,
      factors,
    };
  }

  // ── Rule 5b: verification did not run → FAILED ────────────────────
  // The verification pipeline produced no real signal — no required
  // checks configured AND no file was actively validated. Without
  // verification we cannot honestly call a run a verified success;
  // claiming so would let a bare repo with no lint/typecheck/tests
  // pass as clean. Map to FAILED rather than NO_OP because the
  // run DID write files; the failure is the missing assurance.
  if (
    (verdict === "success" || verdict === "partial") &&
    extra.verificationNoSignal === true
  ) {
    factors.push("verification:no-signal");
    return {
      classification: "FAILED",
      reasonCode: "verification-not-run",
      reason:
        "Verification produced no signal — no required checks configured " +
        "and no file was actively validated. Changes are not a verified success.",
      factors,
    };
  }

  // ── Rule 5c: shadow selected but no source commit → FAILED ────────
  // The local-vs-cloud selection picked a shadow candidate, but no
  // commit landed on the source repo (commitSha is null). The shadow
  // workspace can never promote — the workspace-role guard in
  // promoteToSource enforces that. So a "selected shadow with no
  // commit" run is reporting work that never reached the operator's
  // repo. Surface it explicitly so the operator can re-run rather
  // than believing the changes are live.
  const candidates = receipt.candidates ?? [];
  const selectedId = receipt.selectedCandidateWorkspaceId ?? null;
  const selectedCandidate = selectedId
    ? candidates.find((c) => c.workspaceId === selectedId) ?? null
    : null;
  if (
    (verdict === "success" || verdict === "partial") &&
    selectedCandidate?.role === "shadow" &&
    !receipt.commitSha
  ) {
    factors.push(`selection:shadow-no-commit:${selectedId}`);
    return {
      classification: "FAILED",
      reasonCode: "shadow-selected-not-applied",
      reason:
        `Shadow candidate ${selectedId} was selected but no commit was applied ` +
        "to the source repo — shadow workspaces can never promote, so this run " +
        "produced no live changes.",
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
