/**
 * Builder attempt diagnostics — structured per-attempt evidence that
 * survives guard rejection, weak-output classification, and cost
 * accounting.
 *
 * Lives in its own module so it can be imported by the Builder, the
 * Coordinator's weak-output recovery layer, and the receipt store
 * without circular imports through workers/builder.ts.
 *
 * Every Builder attempt — successful or not — produces one
 * `BuilderAttemptRecord`. Each record carries:
 *   - attempt id + generation id (for cancellation correlation)
 *   - the file targeted
 *   - which patch mode was used (full-file / section-edit / diff-apply)
 *   - the provider / model / tier that was actually used
 *   - input/output tokens and estimated cost (even on failure)
 *   - whether a safety/quality guard rejected the output
 *   - the failure reason if any
 *   - export-diff diagnostics for TypeScript/JavaScript files
 */

import type { CostEntry } from "../core/runstate.js";

export type PatchMode = "full-file" | "section-edit" | "diff-apply";

export type AttemptOutcome =
  | "success"
  | "model-error"
  | "guard-empty-diff"
  | "guard-prose"
  | "guard-raw-diff"
  | "guard-export-loss"
  | "guard-doc-loss"
  | "guard-forbidden-change"
  | "guard-section-corruption"
  | "quality-reject"
  | "io-error"
  | "model-cancelled"
  | "unknown";

export interface ExportDiff {
  /** Exports present in the file before the attempt. */
  readonly original: readonly string[];
  /** Exports present in the model's proposed output. */
  readonly proposed: readonly string[];
  /** Exports in original but missing from proposed. */
  readonly missing: readonly string[];
  /** Exports in proposed but not in original. */
  readonly added: readonly string[];
}

export interface BuilderAttemptRecord {
  readonly attemptId: string;
  /** Monotonic counter within the run — 1 for first attempt, 2 for first repair, etc. */
  readonly attemptIndex: number;
  /** Coordinator-assigned generation id — bumped when this dispatch was canceled and reissued. */
  readonly generationId: string;
  readonly targetFile: string;
  readonly patchMode: PatchMode;
  readonly provider: string;
  readonly model: string;
  readonly tier: string;
  readonly fellBack: boolean;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCostUsd: number;
  readonly durationMs: number;
  readonly outcome: AttemptOutcome;
  /** Failure reason text — null on success. */
  readonly failureReason: string | null;
  /** Whether a safety/quality guard rejected the output. */
  readonly guardRejected: boolean;
  /** Specific guard name when guardRejected — e.g. "export-loss". */
  readonly guardName: string | null;
  /** Export-diff snapshot for TS/JS attempts. Null when not applicable. */
  readonly exportDiff: ExportDiff | null;
  /** True when this attempt's result was discarded because a newer attempt superseded it. */
  readonly stale: boolean;
}

/**
 * Error class that carries per-attempt diagnostics through guard
 * rejection so cost / model / export-diff are not lost when the
 * builder for-loop bails. Coordinator + Builder both unwrap this to
 * extract the underlying record.
 */
export class BuilderAttemptError extends Error {
  readonly record: BuilderAttemptRecord;

  constructor(message: string, record: BuilderAttemptRecord) {
    super(message);
    this.name = "BuilderAttemptError";
    this.record = record;
  }
}

export interface AttemptCostEntry {
  readonly model: string;
  readonly provider: string;
  readonly tier: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCostUsd: number;
}

/**
 * Aggregate a list of attempt records into a single CostEntry. Always
 * returns a non-null entry — when the records are empty we return a
 * zeroed entry tagged with `model="unknown"` so callers don't have to
 * branch on emptiness.
 */
export function sumAttemptCosts(records: readonly BuilderAttemptRecord[]): CostEntry {
  if (records.length === 0) {
    return { model: "unknown", inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 };
  }
  // Use the most-recent successful model name (or the last attempt's model when none succeeded)
  // so the receipt's primary `model` field reflects the model that actually shipped work.
  const lastSuccess = [...records].reverse().find((r) => r.outcome === "success");
  const tip = lastSuccess ?? records[records.length - 1];
  let inputTokens = 0;
  let outputTokens = 0;
  let cost = 0;
  for (const r of records) {
    inputTokens += r.inputTokens;
    outputTokens += r.outputTokens;
    cost += r.estimatedCostUsd;
  }
  return {
    model: tip.model,
    inputTokens,
    outputTokens,
    estimatedCostUsd: Number(cost.toFixed(6)),
  };
}
