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

/**
 * Lane the candidate was produced on. Orthogonal to role:
 *   - role:  primary | shadow  — workspace identity (only primary may promote)
 *   - lane:  local   | cloud   — where the model runs (privacy/cost preference)
 *
 * A candidate may be primary+local, primary+cloud, shadow+local, or
 * shadow+cloud. Selection prefers local on quality ties; promote
 * eligibility is determined by role only.
 */
export type Lane = "local" | "cloud";

/**
 * Candidate lifecycle status. Existing values
 * ("pending" | "passed" | "failed") are preserved; the additional
 * values express the failure modes selection needs to reason about
 * without parsing free-form reason strings.
 */
export type CandidateStatus =
  | "pending"
  | "passed"
  | "failed"
  | "no_effective_change"
  | "timeout"
  | "rejected";

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
  // ─── Optional metadata used by the local-vs-cloud selection policy ──
  // Every field below is OPTIONAL so candidates produced by the
  // existing minimal runShadowBuilder path keep working unchanged.
  // selectBestCandidate treats missing values as "unknown" and does
  // not penalize candidates for omitting them.
  /** Local vs cloud lane. Undefined when the policy doesn't apply. */
  readonly lane?: Lane;
  /** Provider id (e.g. "ollama", "openrouter", "anthropic"). */
  readonly provider?: string;
  /** Model id (e.g. "qwen3.5:9b", "xiaomi/mimo-v2.5"). */
  readonly model?: string;
  /** Number of ADVISORY findings. Lower is better at the tiebreaker level. */
  readonly advisoryFindings?: number;
  /** True when the run produced every required deliverable. False disqualifies. */
  readonly requiredDeliverablesCompleted?: boolean;
  /** True when the verifier's test stage passed. False disqualifies. */
  readonly testsPassed?: boolean;
  /** True when typecheck passed. False disqualifies. */
  readonly typecheckPassed?: boolean;
  /** Confidence score in [0, 1]. Higher is better at the tiebreaker level. */
  readonly confidence?: number;
  /** Files this candidate's patch touched. Used for diff-size comparison. */
  readonly changedFiles?: readonly string[];
}

/**
 * Reason a candidate is disqualified from selection, or null when
 * the candidate is qualified. Pure-function and exported so tests
 * and diagnostics can assert specific disqualification reasons
 * rather than just "selectBestCandidate returned null".
 *
 * Disqualification rules (in order):
 *   1. status not in {"passed", "pending"} → disqualified by status
 *      (failed / no_effective_change / timeout / rejected all out)
 *   2. criticalFindings > 0 → disqualified
 *   3. requiredDeliverablesCompleted === false → disqualified
 *   4. verifierVerdict === "fail" → disqualified
 *   5. testsPassed === false → disqualified
 *   6. typecheckPassed === false → disqualified
 *
 * undefined optional fields (verifierVerdict, testsPassed, etc.)
 * are NOT disqualifications — selection only acts on positive
 * negative signals. This keeps backward compat for candidates
 * produced by the minimal runShadowBuilder path that doesn't run
 * the verifier.
 */
export function candidateDisqualification(c: Candidate): string | null {
  if (c.status !== "passed" && c.status !== "pending") {
    return `status=${c.status}`;
  }
  if (c.criticalFindings > 0) {
    return `criticalFindings=${c.criticalFindings}`;
  }
  if (c.requiredDeliverablesCompleted === false) {
    return "requiredDeliverablesCompleted=false";
  }
  if (c.verifierVerdict === "fail") {
    return "verifierVerdict=fail";
  }
  if (c.testsPassed === false) {
    return "testsPassed=false";
  }
  if (c.typecheckPassed === false) {
    return "typecheckPassed=false";
  }
  return null;
}

/**
 * Estimated diff size for ranking. Prefers explicit changedFiles
 * count, falls back to patch byte length, falls back to 0.
 * "Smaller cleaner diff" preference comes from the user's policy:
 * given equal correctness signals, the candidate that touched
 * fewer files is preferred.
 */
function diffSize(c: Candidate): number {
  if (c.changedFiles && c.changedFiles.length > 0) return c.changedFiles.length;
  if (c.patchArtifact?.changedFiles && c.patchArtifact.changedFiles.length > 0) {
    return c.patchArtifact.changedFiles.length;
  }
  if (c.patchArtifact?.diff) return c.patchArtifact.diff.length;
  return 0;
}

/**
 * Pick the best candidate for the approval gate, or null when no
 * candidate qualifies.
 *
 * Phase 1 — DISQUALIFY. Any candidate that trips
 * candidateDisqualification is removed from contention. Reasons:
 * critical findings, missing required deliverables, failed
 * verifier/tests/typecheck, status fail/timeout/rejected/etc.
 *
 * Phase 2 — RANK qualified candidates by tiered comparison
 * (lower is better; first non-equal tier decides):
 *   1. advisoryFindings  (fewer is better)
 *   2. diffSize          (smaller cleaner diff)
 *   3. costUsd           (cheaper wins on quality tie)
 *   4. lane              (local wins for privacy/cost)
 *   5. role              (primary wins as final tiebreaker —
 *                         preserves the existing single-workspace
 *                         flow when only a primary candidate
 *                         exists or when both candidates qualify
 *                         equally)
 *
 * Pure function: no I/O, no mutation, deterministic on the input
 * order. Exported standalone so it can be unit-tested without a
 * Coordinator instance.
 */
export function selectBestCandidate(
  candidates: readonly Candidate[],
): Candidate | null {
  if (candidates.length === 0) return null;

  const qualified = candidates.filter((c) => candidateDisqualification(c) === null);
  if (qualified.length === 0) return null;
  if (qualified.length === 1) return qualified[0];

  const sorted = [...qualified].sort(compareCandidates);
  return sorted[0];
}

/**
 * Tiered comparator on the user's policy. Negative → a wins;
 * positive → b wins; zero → fully equal (caller may rely on
 * input order as the implicit final tiebreaker).
 */
function compareCandidates(a: Candidate, b: Candidate): number {
  // Tier 1: fewer advisories wins
  const advA = a.advisoryFindings ?? 0;
  const advB = b.advisoryFindings ?? 0;
  if (advA !== advB) return advA - advB;

  // Tier 2: smaller diff wins
  const sizeA = diffSize(a);
  const sizeB = diffSize(b);
  if (sizeA !== sizeB) return sizeA - sizeB;

  // Tier 3: lower cost wins (only when quality is comparable —
  // tiers 1 and 2 already removed candidates with worse quality
  // signals from contention by sorting them later).
  if (a.costUsd !== b.costUsd) return a.costUsd - b.costUsd;

  // Tier 4: local lane wins for privacy/cost. Only fires when
  // both candidates set their lane — a candidate with no lane
  // declared neither wins nor loses on this tier.
  if (a.lane === "local" && b.lane === "cloud") return -1;
  if (a.lane === "cloud" && b.lane === "local") return 1;

  // Tier 5: primary role wins as final tiebreaker. Preserves
  // existing single-workspace flow + ensures shadow candidates
  // need a strict quality advantage to displace a primary.
  if (a.role === "primary" && b.role === "shadow") return -1;
  if (a.role === "shadow" && b.role === "primary") return 1;

  return 0;
}
