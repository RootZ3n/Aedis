/**
 * Stage-timeout retry policy — pure helper.
 *
 * The cost-control bug this exists to prevent (2026-05-03):
 *   • A Critic stage timed out on `claude-opus-4-7` at the 180s
 *     stage-timeout limit.
 *   • The task-loop's repair attempt re-dispatched the SAME model.
 *   • It timed out again, identically.
 *   • Aedis kept burning budget instead of either falling back to a
 *     configured cheaper/faster model or pausing for the operator.
 *
 * The fix has two parts that share this helper:
 *
 *   1. Persist `timedOutModels: TimedOutModelEntry[]` per subtask
 *      across repair attempts. Within a single coordinator.submit()
 *      the existing per-run blacklist (model-invoker.ts) handles
 *      the in-run case; this helper handles the across-repair case.
 *
 *   2. Compute the next dispatch decision deterministically:
 *        — Same model: skip unless the operator explicitly opted in
 *          via `policy.maxSameModelRetriesAfterTimeout`.
 *        — Fallback model: prefer the next chain entry that has not
 *          timed out for this stage in this subtask.
 *        — No fallback left: signal `needs_operator_decision` so the
 *          task-loop pauses rather than blindly retrying.
 *
 * Pure functions. No I/O. No fastify/UI imports. Tested in
 * `timeout-policy.test.ts`.
 */

export interface ChainEntry {
  readonly provider: string;
  readonly model: string;
  /**
   * Optional cost classification. When the operator marks an entry
   * as `expensive` or `slow`, the retry policy refuses to retry the
   * same model after a timeout regardless of
   * `maxSameModelRetriesAfterTimeout`. This is the cost-control
   * fail-safe — even an over-permissive config can't burn $$ on
   * an Opus-class model that has already failed.
   */
  readonly costClass?: "expensive" | "slow" | "standard" | undefined;
}

export interface TimedOutModelEntry {
  /** Worker stage — "critic" | "builder" | "verifier" | "integrator" | "scout" */
  readonly stage: string;
  readonly provider: string;
  readonly model: string;
  /**
   * ISO timestamp of the last timeout. Used by the UI to render
   * "Critic timed out 2 min ago on claude-opus-4-7."
   */
  readonly at: string;
  /**
   * Stage-timeout budget in milliseconds when the timeout fired.
   * Recorded so the operator can decide whether the retry policy
   * should raise the budget or change models.
   */
  readonly stageTimeoutMs: number;
  /**
   * Number of consecutive timeouts on this (stage, provider, model)
   * tuple within the current subtask scope. Increments on each
   * timeout; reset by a non-timeout outcome on the same tuple.
   */
  readonly consecutiveTimeouts: number;
}

export interface TimeoutRetryPolicy {
  /**
   * Maximum number of times the task-loop is allowed to RE-DISPATCH
   * the same (stage, provider, model) tuple after it timed out.
   *
   * Default `0` for cloud / expensive models (cost control).
   * Defaults to `0` everywhere; operators that want the old
   * "blindly retry" behavior must set it explicitly.
   */
  readonly maxSameModelRetriesAfterTimeout: number;
  /**
   * When true, models marked as `costClass: "expensive" | "slow"`
   * are NEVER retried after a timeout, regardless of the numeric
   * `maxSameModelRetriesAfterTimeout`. Hard fail-safe for cost.
   * Default true.
   */
  readonly hardBlockExpensiveModelRetry: boolean;
  /**
   * Whether the chain may be re-walked from the top after a timeout.
   * Set false to make the task-loop pause as soon as one chain entry
   * times out (most conservative). Default true so a configured
   * fallback can step in.
   */
  readonly preferFallbackAfterTimeout: boolean;
}

export const DEFAULT_TIMEOUT_RETRY_POLICY: TimeoutRetryPolicy = {
  maxSameModelRetriesAfterTimeout: 0,
  hardBlockExpensiveModelRetry: true,
  preferFallbackAfterTimeout: true,
};

export type TimeoutRetryDecisionKind =
  /** Dispatch the chosen entry; `entry` is the next attempt. */
  | "dispatch_entry"
  /** All chain entries are blocked; pause the run for operator input. */
  | "needs_operator_decision";

export interface TimeoutRetryDecision {
  readonly kind: TimeoutRetryDecisionKind;
  readonly entry: ChainEntry | null;
  readonly skipped: ReadonlyArray<{ readonly entry: ChainEntry; readonly reason: string }>;
  readonly reason: string;
}

/**
 * Decide what to do for the next dispatch of `stage` given the
 * configured `chain` and the persisted `timedOutModels` history.
 *
 * The decision is deterministic and total: every chain entry is
 * either chosen or has a `skipped` record explaining why.
 */
export function decideNextDispatch(input: {
  readonly stage: string;
  readonly chain: readonly ChainEntry[];
  readonly timedOutModels: readonly TimedOutModelEntry[];
  readonly policy?: TimeoutRetryPolicy;
  /** Operator override for "Retry Same Model" — only effective for the FIRST entry. */
  readonly operatorRetrySameModel?: boolean;
}): TimeoutRetryDecision {
  const policy = input.policy ?? DEFAULT_TIMEOUT_RETRY_POLICY;
  const skipped: Array<{ entry: ChainEntry; reason: string }> = [];
  if (input.chain.length === 0) {
    return {
      kind: "needs_operator_decision",
      entry: null,
      skipped: [],
      reason: "Empty chain — no model configured for this stage.",
    };
  }

  // If preferFallbackAfterTimeout is OFF and ANY chain entry has timed
  // out, we refuse to walk past the primary — the operator has opted
  // into the most conservative behavior. This check happens before the
  // per-entry walk so we don't accidentally dispatch a fresh fallback.
  const stageHasAnyTimeout = input.timedOutModels.some((h) => h.stage === input.stage);
  if (!policy.preferFallbackAfterTimeout && stageHasAnyTimeout) {
    return {
      kind: "needs_operator_decision",
      entry: null,
      skipped: input.chain.map((entry) => ({
        entry,
        reason: "preferFallbackAfterTimeout=false: paused on first timeout for operator decision.",
      })),
      reason: "Fallback walk disabled by policy; pausing for operator decision.",
    };
  }

  for (let i = 0; i < input.chain.length; i += 1) {
    const entry = input.chain[i];
    const history = input.timedOutModels.find(
      (h) => h.stage === input.stage && h.provider === entry.provider && h.model === entry.model,
    );
    if (!history) {
      // Untouched entry — dispatch.
      return {
        kind: "dispatch_entry",
        entry,
        skipped,
        reason: i === 0
          ? "Primary chain entry; no timeout history."
          : `Falling back after ${i} timed-out entr${i === 1 ? "y" : "ies"}.`,
      };
    }

    // This (stage, provider, model) has timed out before. Apply the policy.
    const expensive = entry.costClass === "expensive" || entry.costClass === "slow";
    const overrideOk = i === 0 && input.operatorRetrySameModel === true;

    if (overrideOk) {
      // Operator explicitly clicked "Retry Same Model". Allowed even
      // for expensive entries when explicit; the UI's button label
      // makes the cost trade-off visible.
      return {
        kind: "dispatch_entry",
        entry,
        skipped,
        reason: `Operator override — retrying ${entry.provider}/${entry.model} after ${history.consecutiveTimeouts} prior timeout(s).`,
      };
    }

    if (expensive && policy.hardBlockExpensiveModelRetry) {
      skipped.push({
        entry,
        reason: `${entry.provider}/${entry.model} is marked ${entry.costClass} and has timed out ${history.consecutiveTimeouts} time(s); hardBlockExpensiveModelRetry refuses to re-dispatch.`,
      });
      continue;
    }

    if (history.consecutiveTimeouts > policy.maxSameModelRetriesAfterTimeout) {
      skipped.push({
        entry,
        reason: `${entry.provider}/${entry.model} has timed out ${history.consecutiveTimeouts} time(s); maxSameModelRetriesAfterTimeout=${policy.maxSameModelRetriesAfterTimeout}.`,
      });
      continue;
    }

    if (!policy.preferFallbackAfterTimeout && i > 0) {
      skipped.push({
        entry,
        reason: `Fallback walk disabled by policy.preferFallbackAfterTimeout=false.`,
      });
      continue;
    }

    // Allowed retry within the policy budget.
    return {
      kind: "dispatch_entry",
      entry,
      skipped,
      reason: `${entry.provider}/${entry.model} retry permitted under maxSameModelRetriesAfterTimeout=${policy.maxSameModelRetriesAfterTimeout}.`,
    };
  }

  return {
    kind: "needs_operator_decision",
    entry: null,
    skipped,
    reason: "All chain entries are blocked by the timeout retry policy. Operator must choose.",
  };
}

/**
 * Append/update a TimedOutModelEntry on a persisted history list.
 * Pure: returns a new array. Increments consecutiveTimeouts when the
 * (stage, provider, model) tuple already has a record; otherwise
 * adds a new entry with consecutiveTimeouts=1.
 */
export function recordTimeout(
  history: readonly TimedOutModelEntry[],
  next: {
    readonly stage: string;
    readonly provider: string;
    readonly model: string;
    readonly at: string;
    readonly stageTimeoutMs: number;
  },
): readonly TimedOutModelEntry[] {
  const idx = history.findIndex(
    (h) => h.stage === next.stage && h.provider === next.provider && h.model === next.model,
  );
  if (idx === -1) {
    return [...history, { ...next, consecutiveTimeouts: 1 }];
  }
  const updated: TimedOutModelEntry = {
    ...history[idx],
    at: next.at,
    stageTimeoutMs: next.stageTimeoutMs,
    consecutiveTimeouts: history[idx].consecutiveTimeouts + 1,
  };
  return history.map((h, i) => (i === idx ? updated : h));
}

/**
 * Reset the consecutive-timeout counter for a (stage, provider,
 * model) tuple after a non-timeout outcome. Pure.
 */
export function clearTimeout(
  history: readonly TimedOutModelEntry[],
  match: { readonly stage: string; readonly provider: string; readonly model: string },
): readonly TimedOutModelEntry[] {
  return history.filter(
    (h) => !(h.stage === match.stage && h.provider === match.provider && h.model === match.model),
  );
}

/**
 * Build a UI-grade summary that explains the assessment in operator
 * language. Used by the timeout recovery card.
 */
export interface TimeoutRecoverySummary {
  readonly headline: string;
  readonly stage: string;
  readonly timedOutModel: { provider: string; model: string } | null;
  readonly fallbackAvailable: boolean;
  readonly fallbackEntry: { provider: string; model: string } | null;
  /** Total elapsed time in the most recent timeout. */
  readonly lastTimeoutMs: number;
}

export function buildTimeoutRecoverySummary(input: {
  readonly stage: string;
  readonly chain: readonly ChainEntry[];
  readonly timedOutModels: readonly TimedOutModelEntry[];
}): TimeoutRecoverySummary {
  const stageHistory = input.timedOutModels.filter((h) => h.stage === input.stage);
  const last = stageHistory.length > 0
    ? stageHistory.reduce((a, b) => (a.at >= b.at ? a : b))
    : null;
  const fallback = input.chain.find(
    (c) => !stageHistory.some((h) => h.provider === c.provider && h.model === c.model),
  ) ?? null;
  const headline = last
    ? `${input.stage[0].toUpperCase()}${input.stage.slice(1)} timed out on ${last.provider}/${last.model}.`
    : `No timeout history for stage ${input.stage}.`;
  return {
    headline,
    stage: input.stage,
    timedOutModel: last ? { provider: last.provider, model: last.model } : null,
    fallbackAvailable: fallback !== null,
    fallbackEntry: fallback ? { provider: fallback.provider, model: fallback.model } : null,
    lastTimeoutMs: last ? last.stageTimeoutMs : 0,
  };
}
