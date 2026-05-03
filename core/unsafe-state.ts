/**
 * Unsafe-state assessment — single source of truth for "this run's
 * workspace can no longer be trusted; the operator must inspect
 * before any approval/promotion can proceed."
 *
 * The bug this exists to prevent (release-blocker, 2026-05-03):
 *   • Verification failed mid-run.
 *   • rollbackChanges() ran and reported ROLLBACK_INCOMPLETE
 *     (3 file(s) still dirty after rollback).
 *   • The approval gate had already paused the run earlier in the
 *     same coordinator.submit() call, so a pendingApproval entry
 *     was sitting on disk.
 *   • The UI rendered the APPROVAL REQUIRED panel because its
 *     visibility check was "run.status contains await/approval OR
 *     plan.status === paused" — neither of which knew about
 *     ROLLBACK_INCOMPLETE.
 *   • One click on Approve would have promoted a contaminated
 *     workspace into source.
 *
 * Three contracts this module pins:
 *
 *   1. ANY of the following dominates everything else in the UI:
 *        • run.status ∈ { ROLLBACK_INCOMPLETE, ROLLBACK_FAILED, UNSAFE_STATE }
 *        • finalReceipt.rollback.status !== "clean"
 *        • finalReceipt.rollback.manualInspectionRequired === true
 *
 *   2. The approval API and source-promotion gate must both call
 *      `assertSafeForApproval` and refuse with a 409-style error
 *      whenever the run is unsafe. Approve-on-contaminated is the
 *      bug class we are eliminating.
 *
 *   3. The rendered "next operator action" must read from this
 *      single helper. UI / CLI / API parity is non-negotiable; the
 *      contradiction-with-approval-card UX bug came from each
 *      surface deriving its own ad-hoc rule.
 *
 * Pure function. No I/O. No fastify/UI imports. Tests live in
 * `unsafe-state.test.ts`.
 */

import type { PersistentRunStatus } from "./receipt-store.js";

/**
 * Reasons a run can be unsafe. Order matters: when multiple are
 * true the first listed wins for `primaryReason`.
 */
export type UnsafeStateReason =
  | "rollback_incomplete"
  | "rollback_failed"
  | "unsafe_state"
  | "manual_inspection_required";

export interface UnsafeStateAssessmentInput {
  /**
   * Persisted run status (PersistentRunStatus or normalized lowercase).
   * Either form is accepted — the helper uppercases internally.
   */
  readonly runStatus?: string | null | undefined;
  /**
   * Final receipt (RunReceipt) — only the `rollback` field is read.
   * Caller may pass the whole receipt or just the rollback subobject.
   * Typed loosely (`unknown` rollback) so call sites with the
   * persisted-receipt JSON shape (lacking the structural typing of
   * RunReceipt) compile without a cast.
   */
  readonly finalReceipt?: { readonly rollback?: unknown } | null | undefined;
  /**
   * Direct rollback outcome shortcut. When the caller has the
   * outcome already (in-memory active.rollbackOutcome), they can
   * pass it instead of the whole receipt.
   */
  readonly rollback?: RollbackLike | null | undefined;
  /**
   * Persisted error log entries. We scan for the historical
   * "ROLLBACK INCOMPLETE" / "ROLLBACK UNSAFE STATE" markers so that
   * older receipts (written before `rollback` was persisted on the
   * finalReceipt) still produce an unsafe assessment.
   */
  readonly errors?: readonly string[] | null | undefined;
}

interface RollbackLike {
  readonly status?: string | null;
  readonly manualInspectionRequired?: boolean | null;
  readonly dirtyFiles?: readonly string[] | null;
  readonly failedPaths?: readonly string[] | null;
  readonly summary?: string | null;
  readonly error?: string | null;
}

export interface UnsafeStateAssessment {
  /** True when the operator must NOT see Approve/Reject/Promote actions. */
  readonly unsafe: boolean;
  /** Empty when `unsafe` is false; otherwise ordered by severity. */
  readonly reasons: readonly UnsafeStateReason[];
  /** First reason in `reasons`, or null when safe. */
  readonly primaryReason: UnsafeStateReason | null;
  /** Files left dirty by an incomplete rollback (deduped, capped 50). */
  readonly dirtyFiles: readonly string[];
  /** Files that the rollback failed to restore (deduped, capped 50). */
  readonly failedPaths: readonly string[];
  /** Human-grade banner text. Present when unsafe; null otherwise. */
  readonly headline: string | null;
  /** Persistent run status the operator should see (for status-bar). */
  readonly displayStatus: "CONTAMINATED_WORKSPACE" | "MANUAL_INSPECTION_REQUIRED" | null;
  /**
   * Stable error code returned to the API/CLI/UI when an action is
   * refused due to this state. `null` when safe.
   */
  readonly errorCode: "unsafe_state" | null;
}

const UNSAFE_RUN_STATUSES: ReadonlySet<string> = new Set<PersistentRunStatus>([
  "ROLLBACK_INCOMPLETE",
  "ROLLBACK_FAILED",
  "UNSAFE_STATE",
]);

/**
 * Pattern in persisted error log entries that flags a contaminated
 * workspace even when the structured `rollback` object was lost
 * (older receipts, partial writes, etc.). Matches both
 *   "ROLLBACK INCOMPLETE — 3 file(s) still dirty…"
 *   "ROLLBACK UNSAFE STATE — git status check failed…"
 *   "ROLLBACK FAILED — N file(s) could not be restored…"
 *   "manual inspection required"
 */
const UNSAFE_ERROR_RE = /\bROLLBACK\s+(INCOMPLETE|FAILED|UNSAFE)\b|\bmanual\s+inspection\s+required\b/i;

export function assessUnsafeState(input: UnsafeStateAssessmentInput): UnsafeStateAssessment {
  const reasons = new Set<UnsafeStateReason>();
  const dirtyFiles = new Set<string>();
  const failedPaths = new Set<string>();

  const runStatus = String(input.runStatus ?? "").trim().toUpperCase();
  if (runStatus === "ROLLBACK_INCOMPLETE") reasons.add("rollback_incomplete");
  if (runStatus === "ROLLBACK_FAILED") reasons.add("rollback_failed");
  if (runStatus === "UNSAFE_STATE") reasons.add("unsafe_state");

  const rollback = (input.rollback ?? input.finalReceipt?.rollback ?? null) as RollbackLike | null;
  if (rollback) {
    const st = String(rollback.status ?? "").toLowerCase();
    if (st === "incomplete") reasons.add("rollback_incomplete");
    else if (st === "failed") reasons.add("rollback_failed");
    else if (st === "unsafe_state") reasons.add("unsafe_state");
    if (rollback.manualInspectionRequired === true) {
      reasons.add("manual_inspection_required");
    }
    for (const f of rollback.dirtyFiles ?? []) {
      if (typeof f === "string" && f.length > 0) dirtyFiles.add(f);
    }
    for (const f of rollback.failedPaths ?? []) {
      if (typeof f === "string" && f.length > 0) failedPaths.add(f);
    }
  }

  // Historical / textual fallback: scan persisted error strings for
  // the rollback markers. This catches older receipts written before
  // structured `rollback` was persisted on finalReceipt, AND catches
  // partial-write races where `appendErrors` landed but the
  // structured field didn't.
  for (const e of input.errors ?? []) {
    if (typeof e !== "string") continue;
    if (UNSAFE_ERROR_RE.test(e)) {
      // Default to manual_inspection_required when only text evidence
      // is present — we know it's unsafe but can't classify finely.
      reasons.add("manual_inspection_required");
    }
  }

  if (UNSAFE_RUN_STATUSES.has(runStatus)) {
    reasons.add("manual_inspection_required");
  }

  // Order outputs by severity: rollback_failed > rollback_incomplete >
  // unsafe_state > manual_inspection_required. The earlier categories
  // imply more specific evidence; prefer them as the primaryReason
  // for headline rendering.
  const ordered: UnsafeStateReason[] = [];
  for (const r of [
    "rollback_failed",
    "rollback_incomplete",
    "unsafe_state",
    "manual_inspection_required",
  ] as const) {
    if (reasons.has(r)) ordered.push(r);
  }

  if (ordered.length === 0) {
    return {
      unsafe: false,
      reasons: [],
      primaryReason: null,
      dirtyFiles: [],
      failedPaths: [],
      headline: null,
      displayStatus: null,
      errorCode: null,
    };
  }

  const primary = ordered[0];
  const dirty = [...dirtyFiles].slice(0, 50);
  const failed = [...failedPaths].slice(0, 50);

  let headline: string;
  let displayStatus: UnsafeStateAssessment["displayStatus"];
  switch (primary) {
    case "rollback_failed":
      headline = failed.length > 0
        ? `CONTAMINATED WORKSPACE — rollback could not restore ${failed.length} file(s); manual inspection required.`
        : `CONTAMINATED WORKSPACE — rollback failed; manual inspection required.`;
      displayStatus = "CONTAMINATED_WORKSPACE";
      break;
    case "rollback_incomplete":
      headline = dirty.length > 0
        ? `CONTAMINATED WORKSPACE — ${dirty.length} file(s) still dirty after rollback; manual inspection required.`
        : `CONTAMINATED WORKSPACE — rollback incomplete; manual inspection required.`;
      displayStatus = "CONTAMINATED_WORKSPACE";
      break;
    case "unsafe_state":
      headline = "CONTAMINATED WORKSPACE — rollback status check failed; manual inspection required.";
      displayStatus = "CONTAMINATED_WORKSPACE";
      break;
    case "manual_inspection_required":
      headline = "MANUAL INSPECTION REQUIRED — workspace cannot be trusted until reviewed.";
      displayStatus = "MANUAL_INSPECTION_REQUIRED";
      break;
  }

  return {
    unsafe: true,
    reasons: ordered,
    primaryReason: primary,
    dirtyFiles: dirty,
    failedPaths: failed,
    headline,
    displayStatus,
    errorCode: "unsafe_state",
  };
}

/**
 * Convenience: throws a structured Error when assessment is unsafe.
 * The thrown error carries `code: "unsafe_state"` and `details` for
 * the caller to surface in 409 responses / nonzero CLI exits.
 */
export class UnsafeStateError extends Error {
  readonly code = "unsafe_state" as const;
  readonly assessment: UnsafeStateAssessment;
  constructor(assessment: UnsafeStateAssessment) {
    super(assessment.headline ?? "unsafe state");
    this.name = "UnsafeStateError";
    this.assessment = assessment;
  }
}

export function assertSafeForApproval(input: UnsafeStateAssessmentInput): void {
  const a = assessUnsafeState(input);
  if (a.unsafe) throw new UnsafeStateError(a);
}

/**
 * Build a stable inspection plan the UI can render and the CLI can
 * print. The commands are read-only and never mutate the repo. Pure;
 * the caller decides whether to display.
 */
export interface InspectionPlan {
  readonly heading: string;
  readonly steps: ReadonlyArray<{
    readonly label: string;
    readonly command?: string;
    readonly note?: string;
  }>;
  readonly warning: string;
}

export function buildInspectionPlan(
  assessment: UnsafeStateAssessment,
  context: { readonly workspacePath?: string | null; readonly sourceRepo?: string | null } = {},
): InspectionPlan {
  const where = context.workspacePath ?? context.sourceRepo ?? "the affected repo";
  const fileList = [...assessment.dirtyFiles, ...assessment.failedPaths].slice(0, 10);
  const steps: InspectionPlan["steps"] = [
    {
      label: "List anything still dirty",
      command: `git -C ${shellQuote(where)} status --porcelain`,
    },
    {
      label: "Diff what would be discarded",
      command: `git -C ${shellQuote(where)} diff --stat`,
    },
    fileList.length > 0
      ? {
          label: "Inspect the affected files individually",
          command: fileList.map((f) => `git -C ${shellQuote(where)} diff -- ${shellQuote(f)}`).join(" && "),
        }
      : {
          label: "Inspect the affected files individually",
          note: "No specific dirty files listed on the assessment — inspect the whole worktree.",
        },
    {
      label: "Once you've decided the workspace is safe to discard",
      command: `git -C ${shellQuote(where)} restore --source=HEAD --staged --worktree -- .`,
      note: "Only run after you've reviewed the diff. This discards uncommitted work.",
    },
  ];
  return {
    heading: assessment.headline ?? "Manual inspection required",
    steps,
    warning: "Do NOT trust this workspace until you've inspected the listed files. Approval and source promotion are blocked until cleared.",
  };
}

function shellQuote(s: string): string {
  if (/^[\w./@-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}
