/**
 * Pure helper for the global run-status banner.
 *
 * Single source of truth for the rule that lets the UI surface the
 * difference between "a plan exists but nothing has run yet" and
 * "the previous run finished, so the banner should still say
 * COMPLETE."
 *
 * The bug this fixes: when a user creates a mission/plan via Loqui
 * (POST /missions/start), the response writes a brand-new TaskPlan
 * but does *not* create a tracked Coordinator run. The previous
 * run's status (often "complete" from the prior task) used to leak
 * into the banner because the UI only overrode the banner for
 * paused/blocked/running plan states. A pending plan now becomes
 * `plan_ready` here, which the UI maps to a distinct ready banner.
 *
 * Pure function — no I/O, no time, no side effects. The HTML UI
 * inlines the same rule; tests pin the behavior here.
 */

export type EffectiveBannerStatus =
  | "idle"
  | "queued"
  | "running"
  | "blocked"
  | "paused"
  | "plan_ready"
  | "complete"
  | "partial"
  | "failed"
  | "cancelled";

export type PlanStatus =
  | "pending"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "blocked";

export interface BannerInputs {
  /**
   * The previous (or current) tracked run's status, normalized to
   * the same vocabulary the UI's `normalizeRunStatus` produces.
   */
  readonly runStatus: EffectiveBannerStatus;
  /**
   * The currently-loaded TaskPlan's status, or null when no plan is
   * loaded.
   */
  readonly planStatus: PlanStatus | null;
}

/**
 * Compute the banner status from the run + plan state.
 *
 * Precedence rules, top-down:
 *   1. Active plan running → `running` (plan trumps prior run)
 *   2. Active plan paused/blocked → `blocked` (operator action needed)
 *   3. Plan exists & is pending → `plan_ready`
 *      (a freshly created plan that has not started; explicitly
 *      overrides any stale prior `complete` / `failed` / etc.)
 *   4. Otherwise: fall back to the run status as-is
 */
export function computeEffectiveBannerStatus(
  inputs: BannerInputs,
): EffectiveBannerStatus {
  const { runStatus, planStatus } = inputs;
  if (planStatus === "running") return "running";
  if (planStatus === "paused" || planStatus === "blocked") return "blocked";
  if (planStatus === "pending") return "plan_ready";
  return runStatus;
}

/**
 * Human label for the banner word — kept in one place so the UI
 * and any test assertion read from the same vocabulary.
 */
export function bannerStatusLabel(status: EffectiveBannerStatus): string {
  switch (status) {
    case "plan_ready":
      return "READY";
    case "idle":
      return "IDLE";
    case "queued":
      return "QUEUED";
    case "running":
      return "RUNNING";
    case "blocked":
      return "BLOCKED";
    case "paused":
      return "PAUSED";
    case "complete":
      return "COMPLETE";
    case "partial":
      return "PARTIAL";
    case "failed":
      return "FAILED";
    case "cancelled":
      return "CANCELLED";
  }
}

/**
 * Subtitle / strapline shown beneath the banner word.
 */
export function bannerStatusSubtitle(status: EffectiveBannerStatus): string {
  switch (status) {
    case "plan_ready":
      return "Plan ready";
    case "blocked":
      return "Operator action required";
    case "running":
      return "Workers running";
    case "complete":
      return "Run complete";
    case "failed":
      return "Run failed";
    case "cancelled":
      return "Run cancelled";
    case "partial":
      return "Run partial";
    case "queued":
      return "Queued";
    case "paused":
      return "Paused";
    case "idle":
      return "";
  }
}

/**
 * Progress percentage shown on the status strip. A `plan_ready`
 * banner explicitly resolves to 0% — never 100% — so the UI cannot
 * accidentally imply that a freshly created plan has finished.
 */
export function bannerProgressPct(
  status: EffectiveBannerStatus,
  planCounts?: { completed: number; total: number } | null,
): number {
  if (status === "plan_ready") return 0;
  if (status === "complete") return 100;
  if (status === "failed" || status === "cancelled") return 100;
  if (status === "running") {
    if (planCounts && planCounts.total > 0) {
      return Math.min(100, Math.round((planCounts.completed / planCounts.total) * 100));
    }
    return 50;
  }
  return 0;
}
