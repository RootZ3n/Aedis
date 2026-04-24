/**
 * Failure Explainer — Human-Readable Execution + Trust Layer v1.
 *
 * When a run did not finish with a VERIFIED_SUCCESS classification,
 * this module turns the mess of failure signals on the RunReceipt
 * into a short human-readable explanation with three fields:
 *
 *   rootCause    — the best-guess cause in plain English
 *   stage        — which stage of the pipeline hit the wall
 *   suggestedFix — a concrete next step the user can take
 *
 * The module is deliberately *not* a full diagnostic engine. It is
 * a rule-based pattern matcher over the same signals the coordinator
 * already populates: executionGateReason, mergeDecision.primaryBlockReason,
 * verificationReceipt.summary, workerResults[].issues, run.failureReason,
 * graphSummary.failed, etc. Every rule returns both a root cause and
 * a suggested fix so users never see "it failed" without also seeing
 * what to try next.
 *
 * Pure function, no side effects. Attaches to the RunReceipt via
 * RunSummary.failureExplanation when the classification is anything
 * other than VERIFIED_SUCCESS.
 */

import type { RunReceipt } from "./coordinator.js";

// ─── Types ───────────────────────────────────────────────────────────

export type FailureStage =
  | "planning"
  | "scouting"
  | "building"
  | "reviewing"
  | "verifying"
  | "merging"
  | "committing"
  | "execution-gate"
  | "unknown";

export interface FailureExplanation {
  /** Short machine-readable tag for the matched rule. */
  readonly code: string;
  /** Best-guess root cause in plain English. */
  readonly rootCause: string;
  /** Which pipeline stage tripped the failure. */
  readonly stage: FailureStage;
  /** A concrete, user-actionable next step. */
  readonly suggestedFix: string;
  /** Every signal that contributed — useful for audit tooltips. */
  readonly evidence: readonly string[];
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Produce a failure explanation for a RunReceipt. Always returns a
 * valid explanation even when the signals are thin — the fallback
 * is "unknown root cause, check the worker logs."
 */
export function explainFailure(receipt: RunReceipt): FailureExplanation {
  const evidence: string[] = [];
  const verdict = receipt.verdict;
  const gateReason = receipt.executionGateReason ?? "";
  const mergeAction = receipt.mergeDecision?.action ?? null;
  const mergeReason = receipt.mergeDecision?.primaryBlockReason ?? "";
  const verification = receipt.verificationReceipt;
  const failedNodes = receipt.graphSummary?.failed ?? 0;
  const workerIssues = collectBlockerIssues(receipt);

  evidence.push(`verdict:${verdict}`);
  if (gateReason) evidence.push(`gate:${truncate(gateReason, 80)}`);
  if (mergeReason) evidence.push(`merge:${truncate(mergeReason, 80)}`);
  if (verification) evidence.push(`verification:${verification.verdict}`);
  if (failedNodes > 0) evidence.push(`failedNodes:${failedNodes}`);

  // ── Rule 1: user cancelled ─────────────────────────────────────
  if (verdict === "aborted") {
    return {
      code: "aborted",
      stage: "unknown",
      rootCause: "The run was cancelled before it could complete.",
      suggestedFix: "Re-submit the task when you're ready to let it finish.",
      evidence,
    };
  }

  // ── Rule 2: planner early-exit ─────────────────────────────────
  if (receipt.graphSummary.totalNodes === 0) {
    return {
      code: "empty-graph",
      stage: "planning",
      rootCause:
        "The planner could not identify any actionable work from the request. The task graph ended up empty, so no worker ever ran.",
      suggestedFix:
        "Rephrase the request to name a specific file or module (e.g. \"in core/coordinator.ts, add X\"), or ask Loqui for a plan first and iterate on the scope.",
      evidence,
    };
  }

  // ── Rule 3: execution gate errored (thrown exception) ─────────
  if (/execution errored/i.test(gateReason)) {
    const detail = gateReason.replace(/^Execution errored:\s*/i, "");
    const fsIssue = detectFilesystemIssue(detail);
    if (fsIssue) return fsIssue;
    const authIssue = detectAuthIssue(detail);
    if (authIssue) return authIssue;
    return {
      code: "runtime-error",
      stage: "unknown",
      rootCause: `A runtime error was raised during the run: ${truncate(detail, 160)}`,
      suggestedFix:
        "Check the worker logs for the full stack trace. If the error is transient (network, rate limit), retry the run. If the error names a specific file or path, fix or create it before retrying.",
      evidence,
    };
  }

  // ── Rule 4: execution gate no-op ───────────────────────────────
  if (/no-op execution detected/i.test(gateReason)) {
    return {
      code: "no-op",
      stage: "execution-gate",
      rootCause:
        "Every worker reported success but no files were created, modified, or deleted. The builder returned changes that never actually landed on disk, or the plan had no builder work to do.",
      suggestedFix:
        "Inspect the builder's raw output in the receipt to see what it returned. If the builder claimed changes that didn't land, the target files may be read-only, outside the project root, or excluded by your filesystem. Consider narrowing the scope or naming specific files explicitly.",
      evidence,
    };
  }

  // ── Rule 5: merge gate blocked ─────────────────────────────────
  if (mergeAction === "block") {
    const reason = mergeReason || "Merge gate policy violation";
    const matched = matchMergeBlocker(reason);
    if (matched) return { ...matched, evidence };
    return {
      code: "merge-blocked",
      stage: "merging",
      rootCause: `The merge gate blocked the commit: ${reason}`,
      suggestedFix:
        "Re-run with a tighter scope that avoids the blocked surface, or address the specific violation named above before retrying.",
      evidence,
    };
  }

  // ── Rule 6: verification failed ────────────────────────────────
  if (verification && verification.verdict === "fail") {
    const blocker = verification.blockers[0];
    const summary = blocker?.message ?? verification.summary;
    const matched = matchVerificationFailure(summary ?? "");
    if (matched) return { ...matched, evidence };
    return {
      code: "verification-fail",
      stage: "verifying",
      rootCause: `Verification pipeline rejected the changes: ${truncate(summary ?? "unknown reason", 140)}`,
      suggestedFix:
        "Run the verifier locally against the changes (typecheck, lint, tests) to reproduce the blocker, fix it, and retry.",
      evidence,
    };
  }

  // ── Rule 7: worker-reported blocker ────────────────────────────
  if (workerIssues.length > 0) {
    const first = workerIssues[0];
    return {
      code: "worker-issue",
      stage: first.stage,
      rootCause: `The ${first.stage} stage reported a blocker: ${first.message}`,
      suggestedFix:
        "Check the worker's output for more context. If the blocker names a missing dependency or configuration, resolve it and retry.",
      evidence,
    };
  }

  // ── Rule 8: failed graph nodes without a better signal ────────
  if (failedNodes > 0) {
    return {
      code: "failed-nodes",
      stage: "building",
      rootCause: `${failedNodes} worker node(s) failed during execution. The specific cause was not propagated to the run receipt.`,
      suggestedFix:
        "Open the worker grid for this run to see which node failed, then inspect its issues array. If the failure is transient, retry.",
      evidence,
    };
  }

  // ── Fallback ────────────────────────────────────────────────────
  return {
    code: "unknown",
    stage: "unknown",
    rootCause:
      "The run did not reach a verified success state, but no specific blocker was captured on the receipt. This typically means a gate failed silently or a worker returned an empty result.",
    suggestedFix:
      "Check the worker grid and Lumen log for this run. If nothing is visible, re-run with a tighter scope or ask Loqui for a dry-run plan first.",
    evidence,
  };
}

// ─── Rule matchers ──────────────────────────────────────────────────

function detectFilesystemIssue(detail: string): FailureExplanation | null {
  const lower = detail.toLowerCase();
  if (/enoent|no such file|does not exist/.test(lower)) {
    const pathMatch = detail.match(/['"]([^'"]+)['"]/);
    const path = pathMatch ? pathMatch[1] : null;
    return {
      code: "missing-path",
      stage: "execution-gate",
      rootCause: path
        ? `The path "${path}" does not exist on disk.`
        : "A target path referenced by the run does not exist on disk.",
      suggestedFix: path
        ? `Create "${path}" before running, or rephrase the request to target a path that exists.`
        : "Create the missing directory or file, or rephrase the request to target a path that exists.",
      evidence: [`error:${truncate(detail, 120)}`],
    };
  }
  if (/eacces|permission denied/.test(lower)) {
    return {
      code: "permission-denied",
      stage: "execution-gate",
      rootCause: "A file or directory referenced by the run is not writable by the Aedis process.",
      suggestedFix:
        "Check filesystem permissions on the target directory. If Aedis is running as a different user, make sure the path is owned by or writable by that user.",
      evidence: [`error:${truncate(detail, 120)}`],
    };
  }
  if (/eexist|already exists/.test(lower)) {
    return {
      code: "path-collision",
      stage: "execution-gate",
      rootCause:
        "A file the builder tried to create already exists. The builder refused to overwrite it.",
      suggestedFix:
        "Either delete the existing file first, or rephrase the request as a modify (\"in X, add Y\") instead of a create.",
      evidence: [`error:${truncate(detail, 120)}`],
    };
  }
  return null;
}

function detectAuthIssue(detail: string): FailureExplanation | null {
  const lower = detail.toLowerCase();
  if (/api[_ ]?key|unauthorized|401|403/.test(lower)) {
    return {
      code: "auth-missing",
      stage: "building",
      rootCause:
        "A model provider rejected the request — typically because an API key is missing, invalid, or expired.",
      suggestedFix:
        "Check the environment variables for the provider Aedis tried to call (e.g. ANTHROPIC_API_KEY, OPENROUTER_API_KEY). Rotate or re-export the key and retry.",
      evidence: [`error:${truncate(detail, 120)}`],
    };
  }
  if (/timeout|timed out|etimedout/.test(lower)) {
    return {
      code: "timeout",
      stage: "building",
      rootCause:
        "A model provider request timed out. The model was either slow or unreachable from this host.",
      suggestedFix:
        "Retry the run. If the timeout repeats, switch to the fallback model in .aedis/model-config.json or increase the provider timeout.",
      evidence: [`error:${truncate(detail, 120)}`],
    };
  }
  return null;
}

function matchMergeBlocker(reason: string): FailureExplanation | null {
  const lower = reason.toLowerCase();
  // Bugfix must-modify rule — the coordinator emits this with a
  // distinctive `bugfix_target_not_modified` stem so it surfaces
  // cleanly to the harness instead of being bucketed as generic
  // merge-blocked.
  if (/bugfix[_-]target[_-]not[_-]modified/.test(lower)) {
    return {
      code: "bugfix-target-not-modified",
      stage: "merging",
      rootCause: `Merge blocked: ${truncate(reason, 160)}`,
      suggestedFix:
        "The builder modified test files but never touched the source file containing the bug. Re-run the task with the specific source file named explicitly in the prompt, or split the work into a source fix followed by a test addition.",
      evidence: [],
    };
  }
  if (/typecheck/.test(lower)) {
    return {
      code: "merge-typecheck",
      stage: "merging",
      rootCause: `Merge blocked: typecheck failed (${truncate(reason, 120)}).`,
      suggestedFix:
        "Run `npx tsc --noEmit` locally against the changed files to see the type error, fix it, and retry.",
      evidence: [],
    };
  }
  if (/lint/.test(lower)) {
    return {
      code: "merge-lint",
      stage: "merging",
      rootCause: `Merge blocked: lint failed (${truncate(reason, 120)}).`,
      suggestedFix: "Run the project linter locally, fix the violations, and retry.",
      evidence: [],
    };
  }
  if (/invariant|coherence/.test(lower)) {
    return {
      code: "merge-invariant",
      stage: "merging",
      rootCause: `Merge blocked: a cross-file invariant or coherence check failed (${truncate(reason, 120)}).`,
      suggestedFix:
        "Check the integration judge report in the receipt. The change likely broke a shared type or interface — inspect the referenced files and make the change coherent.",
      evidence: [],
    };
  }
  return null;
}

function matchVerificationFailure(summary: string): FailureExplanation | null {
  const lower = summary.toLowerCase();
  if (/typecheck|type error|ts\d+/.test(lower)) {
    return {
      code: "verify-typecheck",
      stage: "verifying",
      rootCause: `Verification rejected: typecheck failed (${truncate(summary, 120)}).`,
      suggestedFix:
        "Run `npx tsc --noEmit` locally against the changed files, fix the type error, and retry.",
      evidence: [],
    };
  }
  if (/test.*fail|failed test/.test(lower)) {
    return {
      code: "verify-test",
      stage: "verifying",
      rootCause: `Verification rejected: one or more tests failed (${truncate(summary, 120)}).`,
      suggestedFix:
        "Run the failing test locally to reproduce the issue, fix the regression, and retry.",
      evidence: [],
    };
  }
  return null;
}

interface CollectedWorkerIssue {
  readonly stage: FailureStage;
  readonly message: string;
}

function collectBlockerIssues(receipt: RunReceipt): CollectedWorkerIssue[] {
  const out: CollectedWorkerIssue[] = [];
  const workers = receipt.executionReceipts ?? [];
  for (const w of workers) {
    if (w.verification === "fail") {
      out.push({
        stage: mapWorkerStage(w.workerType),
        message: `${w.workerType} reported ${w.changesMade}`,
      });
    }
  }
  return out;
}

function mapWorkerStage(workerType: string): FailureStage {
  switch (workerType) {
    case "scout":
      return "scouting";
    case "builder":
      return "building";
    case "critic":
      return "reviewing";
    case "verifier":
      return "verifying";
    case "integrator":
      return "merging";
    default:
      return "unknown";
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}
