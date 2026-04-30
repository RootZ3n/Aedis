export interface RunListEntry {
  readonly id: string;
  readonly runId: string;
  readonly status: string;
  readonly classification: string | null;
  readonly prompt: string;
  readonly summary: string;
  readonly costUsd: number;
  readonly confidence: number;
  readonly timestamp: string;
  readonly completedAt: string | null;
}

/**
 * Loqui routing decision projected onto the run-detail response.
 *
 * Mirrors the shape returned by `routeLoquiInput` so the UI can render
 * the same intent badge / confidence / signal audit it shows in the
 * chat panel, but for any persisted run the operator opens later.
 *
 * Optional — runs created before the Loqui-decision tracker landed
 * (or runs submitted via the legacy /tasks path that never went
 * through the unified router) carry no decision and the field is
 * omitted entirely.
 */
export interface RunLoquiDecisionView {
  readonly intent: string;
  readonly action: string;
  readonly label: string;
  readonly confidence: number;
  readonly reason: string;
  readonly signals: readonly string[];
  /** True when the strong-scoped-build signal fired in the classifier. */
  readonly scopedBuildSignal: boolean;
  /** True when the safe-fallback was suppressed because the prompt was clear-target. */
  readonly safeFallbackSuppressed: boolean;
  /** Filled when the router demanded clarification; empty otherwise. */
  readonly clarification: string;
}

/**
 * Per-candidate row surfaced to the UI. Mirrors CandidateManifestEntry
 * but adds derived fields the UI needs (changedFilesCount, confidence,
 * outcome, selection reason). Independent of the persisted manifest
 * shape so receipt-schema changes don't ripple into the UI contract.
 */
export interface RunCandidateView {
  readonly workspaceId: string;
  readonly role: "primary" | "shadow";
  readonly lane: "local" | "cloud" | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly status: string;
  readonly disqualification: string | null;
  readonly costUsd: number;
  readonly latencyMs: number;
  readonly verifierVerdict: "pass" | "pass-with-warnings" | "fail" | null;
  readonly confidence: number | null;
  readonly advisoryFindings: number | null;
  readonly criticalFindings: number | null;
  readonly changedFilesCount: number | null;
  readonly outcome: "selected" | "lost" | "disqualified" | "pending";
  readonly reason: string;
}

export interface RunCandidatesBlock {
  /**
   * "active" when the run produced multiple candidates. "inactive"
   * when only the primary ran (primary_only mode, or shadow lane was
   * unavailable); the UI shows an explainer rather than empty cards.
   */
  readonly shadowMode: "active" | "inactive";
  /** Lane mode the run executed under. "primary_only" when no shadow ran. */
  readonly laneMode: string;
  /** Set when shadowMode === "inactive": short reason for the empty state. */
  readonly inactiveReason: string;
  readonly candidates: readonly RunCandidateView[];
  readonly selection: {
    readonly winnerWorkspaceId: string | null;
    readonly winnerRole: "primary" | "shadow" | null;
    readonly rolePreferenceUsed: boolean;
    readonly costAffected: boolean;
    readonly advisoryAffected: boolean;
    /** Architectural invariant — shadow workspaces can never promote. */
    readonly shadowPromoteAllowed: false;
    readonly note: string;
  };
}

export interface RunDetailResponse {
  readonly id: string;
  readonly taskId: string | null;
  readonly runId: string;
  readonly status: string;
  readonly prompt: string;
  readonly submittedAt: string;
  readonly completedAt: string | null;
  readonly receipt: unknown | null;
  readonly filesChanged: readonly { path: string; operation: string }[];
  readonly summary: {
    readonly classification: string | null;
    readonly headline: string;
    readonly narrative: string;
    readonly verification: string;
    readonly verificationChecks?: readonly unknown[];
    readonly failureExplanation?: unknown;
  };
  readonly confidence: unknown;
  readonly errors: readonly { source: string; message: string; suggestedFix?: string }[];
  readonly executionVerified: boolean | null;
  readonly executionGateReason: string | null;
  readonly blastRadius: unknown | null;
  readonly totalCostUsd: number;
  readonly workerEvents: readonly unknown[];
  readonly checkpoints: readonly unknown[];
  /** Loqui routing decision for the run. Omitted when unknown. */
  readonly loqui?: RunLoquiDecisionView;
  /** Candidate workspaces summary. Always present — empty cases use shadowMode="inactive". */
  readonly candidates?: RunCandidatesBlock;
}

export interface RunIntegrationResponse {
  readonly runId: string;
  readonly status: string;
  readonly integration: {
    readonly verdict: "approved" | "blocked" | "pending" | "not-available";
    readonly summary: string;
    readonly events: readonly unknown[];
    readonly lastCheck: unknown | null;
  };
  readonly workerEvents: readonly unknown[];
  readonly checkpoints: readonly unknown[];
}

export function buildRunListEntry(input: RunListEntry): RunListEntry {
  return input;
}

export function buildRunDetailResponse(input: RunDetailResponse): RunDetailResponse {
  return input;
}

export function buildRunIntegrationResponse(input: RunIntegrationResponse): RunIntegrationResponse {
  return input;
}

// ─── Helpers used by /runs/:id ──────────────────────────────────────

const SCOPED_BUILD_SIGNAL = "build:scoped-build-signal";
const SAFE_FALLBACK_PREFIX = "safe-fallback:";

/**
 * Project a LoquiRouteDecision-shaped record into the UI view. Tolerant
 * of partial shapes so the function can run against either a tracked
 * decision (full shape) or a persisted record that may have lost some
 * fields across a server restart.
 */
export function buildLoquiDecisionView(decision: {
  readonly intent?: string;
  readonly action?: string;
  readonly label?: string;
  readonly confidence?: number;
  readonly reason?: string;
  readonly signals?: readonly string[];
  readonly clarification?: string;
}): RunLoquiDecisionView {
  const signals = Array.isArray(decision.signals) ? decision.signals : [];
  const scopedBuildSignal = signals.includes(SCOPED_BUILD_SIGNAL);
  const safeFallbackFired = signals.some((s) => s.startsWith(SAFE_FALLBACK_PREFIX));
  return {
    intent: String(decision.intent ?? "unknown"),
    action: String(decision.action ?? "unknown"),
    label: String(decision.label ?? ""),
    confidence: Number(decision.confidence ?? 0),
    reason: String(decision.reason ?? ""),
    signals: [...signals],
    scopedBuildSignal,
    // "Safe-fallback suppressed" is the inverse — a clear scoped-build
    // run never tripped the fallback. The UI uses this to render a
    // green "build path: clear scope" chip.
    safeFallbackSuppressed: scopedBuildSignal && !safeFallbackFired,
    clarification: String(decision.clarification ?? ""),
  };
}

/**
 * Project the persisted-receipt candidate manifest into the UI block.
 * Pure function so tests can pin the projection without booting a
 * server. Returns the inactive empty-state block when no candidates
 * are present.
 *
 * Signature accepts the raw receipt (or null) and a fallback laneMode
 * so callers from /runs/:id can pass `persisted.finalReceipt` directly.
 */
export interface ManifestReceiptInput {
  readonly candidates?: ReadonlyArray<{
    workspaceId: string;
    role: "primary" | "shadow";
    lane?: "local" | "cloud";
    provider?: string;
    model?: string;
    status: string;
    disqualification: string | null;
    costUsd: number;
    latencyMs: number;
    verifierVerdict: "pass" | "pass-with-warnings" | "fail" | null;
    reason: string;
  }>;
  readonly selectedCandidateWorkspaceId?: string | null;
  readonly laneMode?: string;
}

export function projectCandidatesFromReceipt(
  finalReceipt: ManifestReceiptInput | null | undefined,
): RunCandidatesBlock {
  const laneMode = finalReceipt?.laneMode ?? "primary_only";
  const manifest = finalReceipt?.candidates;
  if (!manifest || manifest.length === 0) {
    return buildInactiveCandidatesBlock(laneMode);
  }

  const winnerId = finalReceipt?.selectedCandidateWorkspaceId ?? null;
  const hasShadow = manifest.some((c) => c.role === "shadow");
  const candidates: RunCandidateView[] = manifest.map((c) => {
    const isWinner = winnerId !== null && c.workspaceId === winnerId;
    const outcome: RunCandidateView["outcome"] = c.disqualification
      ? "disqualified"
      : isWinner
        ? "selected"
        : winnerId === null
          ? "pending"
          : "lost";
    const reason = c.disqualification
      ? `disqualified: ${c.disqualification}`
      : isWinner
        ? "selected: best on tier comparison (advisories → diff size → cost → lane → role)"
        : winnerId === null
          ? "pending: selection has not run yet"
          : `lost: ${c.role} candidate beaten on tier comparison`;
    return {
      workspaceId: c.workspaceId,
      role: c.role,
      lane: c.lane ?? null,
      provider: c.provider ?? null,
      model: c.model ?? null,
      status: c.status,
      disqualification: c.disqualification,
      costUsd: c.costUsd,
      latencyMs: c.latencyMs,
      verifierVerdict: c.verifierVerdict,
      // CandidateManifestEntry doesn't carry confidence / advisory /
      // changedFiles — those live on the in-memory Candidate, not the
      // persisted manifest. The UI tolerates null and renders "—".
      confidence: null,
      advisoryFindings: null,
      criticalFindings: null,
      changedFilesCount: null,
      outcome,
      reason: c.reason || reason,
    };
  });

  const winner = candidates.find((c) => c.outcome === "selected") ?? null;

  return {
    shadowMode: hasShadow ? "active" : "inactive",
    laneMode,
    inactiveReason: hasShadow
      ? ""
      : "Shadow workspace inactive for this run — only the primary lane recorded a candidate.",
    candidates,
    selection: {
      winnerWorkspaceId: winner?.workspaceId ?? null,
      winnerRole: winner?.role ?? null,
      // The persisted manifest is intentionally a pruned subset — it
      // doesn't carry advisoryFindings or per-tier diffs, so the UI
      // can't reconstruct exactly which tiebreak fired. We surface
      // false defaults; the chat-time live decision (active-run path
      // in runs.ts) carries the real values.
      rolePreferenceUsed: false,
      costAffected: false,
      advisoryAffected: false,
      shadowPromoteAllowed: false,
      note: "Only primary workspaces can promote. Shadow candidates are produced for comparison and never write to the source repo.",
    },
  };
}

/**
 * Build the empty-state candidates block for runs that ran in
 * primary_only mode (no shadow workspace). Keeps the UI rendering
 * stable — the panel always has a block to render, even when there
 * are zero candidates persisted.
 */
export function buildInactiveCandidatesBlock(
  laneMode: string = "primary_only",
  reason?: string,
): RunCandidatesBlock {
  return {
    shadowMode: "inactive",
    laneMode,
    inactiveReason:
      reason ??
      "Shadow workspace inactive for this run — lane mode is primary_only. Configure .aedis/lane-config.json to enable a shadow lane.",
    candidates: [],
    selection: {
      winnerWorkspaceId: null,
      winnerRole: null,
      rolePreferenceUsed: false,
      costAffected: false,
      advisoryAffected: false,
      shadowPromoteAllowed: false,
      note: "Only primary workspaces can promote. No selection ran — primary candidate is the only one.",
    },
  };
}
