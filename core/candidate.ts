/**
 * Candidate — a Builder attempt's result, ready for selection.
 *
 * A run produces ONE primary candidate from its primary workspace and
 * MAY produce zero or more shadow candidates from shadow workspaces.
 * Selection logic (selectBestCandidate below) picks at most ONE
 * candidate to feed the approval gate; ties prefer primary.
 *
 * SAFETY: only candidates whose role === "primary" may be promoted.
 * Coordinator.promoteToSource enforces this independently as a
 * defense-in-depth guard against a future caller that picks a shadow
 * candidate by mistake.
 */
import {
  createWorkspace,
  type PatchArtifact,
  type WorkspaceHandle,
} from "./workspace-manager.js";

/**
 * Workspace role. Coordinator-side concern that lives outside
 * WorkspaceHandle so workspace-manager stays unaware of who is
 * allowed to promote a given handle. Only "primary" workspaces may
 * promote — shadow workspaces produce candidates for comparison.
 */
export type WorkspaceRole = "primary" | "shadow";

/**
 * Coordinator-side workspace registry entry. Wraps a vanilla
 * WorkspaceHandle with the role + stable id needed for
 * multi-workspace bookkeeping (active.workspaces map,
 * promoteToSource safety guard, candidate plumbing).
 */
export interface WorkspaceEntry {
  readonly workspaceId: string;
  readonly role: WorkspaceRole;
  readonly handle: WorkspaceHandle;
}

/**
 * Create a SHADOW workspace — an alternate sandbox cloned from the
 * same source repo as the primary, used for alternate Builder
 * attempts (different model, retry isolation, candidate comparison).
 *
 * The on-disk path visibly contains "shadow-N-" so operators can
 * tell shadow workspaces from primary ones at a glance. Returns a
 * WorkspaceEntry with role="shadow" and a stable workspaceId
 * ("shadow-N").
 *
 * SAFETY: shadow workspaces share the same SAFETY INVARIANT as
 * primary workspaces — Aedis must NEVER mutate the source repo
 * directly. The promote-time guard refuses any receipt whose
 * recorded workspace role is not "primary". Callers MUST NOT route
 * a shadow's commits or patch artifact through promoteToSource.
 */
export async function createShadowWorkspace(
  sourceRepo: string,
  primaryRunId: string,
  shadowIndex: number = 1,
): Promise<WorkspaceEntry> {
  // Synthetic runId so the on-disk path visibly contains "shadow-N-"
  // and is unique per (primary, shadow-index) pair. The primaryRunId
  // prefix lets operators correlate a shadow workspace with its
  // owning run without consulting the receipt store.
  const syntheticRunId = `shadow-${shadowIndex}-${primaryRunId.slice(0, 8)}`;
  const handle = await createWorkspace(sourceRepo, syntheticRunId);
  return {
    workspaceId: `shadow-${shadowIndex}`,
    role: "shadow",
    handle,
  };
}

export type CandidateStatus = "pending" | "passed" | "failed";

export interface Candidate {
  /** Stable workspace id within an ActiveRun ("primary", "shadow-1", …). */
  readonly workspaceId: string;
  /** Workspace role — only "primary" is promote-eligible. */
  readonly role: WorkspaceRole;
  /** Absolute path to the workspace this candidate was produced in. */
  readonly workspacePath: string;
  /** Patch artifact captured from the workspace. Null when no diff was produced. */
  readonly patchArtifact: PatchArtifact | null;
  /**
   * Verifier verdict if a verification pipeline ran for this
   * candidate. Null when the verifier did not run (minimal shadow
   * runs may skip verification — the merge gate / approval gate
   * still applies for primary candidates).
   */
  readonly verifierVerdict: "pass" | "pass-with-warnings" | "fail" | null;
  /** Number of CRITICAL findings. Zero for unverified candidates. */
  readonly criticalFindings: number;
  /** Cost in USD attributed to this candidate's Builder dispatch. */
  readonly costUsd: number;
  /** Wall-clock latency of the Builder dispatch in milliseconds. */
  readonly latencyMs: number;
  /** High-level status. "pending" → not yet evaluated; "passed" → builder succeeded; "failed" → builder errored. */
  readonly status: CandidateStatus;
  /** Free-form reason for the status (e.g. failure message). */
  readonly reason: string;
}

/**
 * Pick the best candidate for the approval gate, or null when no
 * candidate is suitable.
 *
 * Rules (per spec):
 *   - if only the primary exists → return it (preserves single-workspace behavior)
 *   - prefer status === "passed" AND criticalFindings === 0
 *     AND verifierVerdict !== "fail"
 *   - if multiple candidates qualify, prefer primary
 *   - if primary fails AND a shadow passes, return the shadow
 *   - if no candidate qualifies, return null
 *
 * Pure function: no I/O, no mutation, deterministic on the input
 * order. Exported standalone so it can be unit-tested without a
 * Coordinator instance.
 */
export function selectBestCandidate(
  candidates: readonly Candidate[],
): Candidate | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) {
    const sole = candidates[0];
    return isCandidatePassing(sole) ? sole : null;
  }

  const primary = candidates.find((c) => c.role === "primary");
  const shadows = candidates.filter((c) => c.role === "shadow");

  if (primary && isCandidatePassing(primary)) {
    return primary;
  }

  // Primary missing or failing: fall back to a passing shadow if any.
  // First-shadow-wins on ties — caller can supply candidates in
  // priority order if they want a different tiebreaker.
  const passingShadow = shadows.find(isCandidatePassing);
  if (passingShadow) return passingShadow;

  return null;
}

function isCandidatePassing(c: Candidate): boolean {
  if (c.status !== "passed") return false;
  if (c.criticalFindings > 0) return false;
  if (c.verifierVerdict === "fail") return false;
  return true;
}
