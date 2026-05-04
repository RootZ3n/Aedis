/**
 * Metrics aggregation — Metrics + External API Layer v1.
 *
 * Pure functions that turn the tracked-run registry into the
 * read-only shapes the external API surfaces. No side effects,
 * no Fastify, no coordinator access — the aggregator takes a
 * snapshot of tracked runs and returns plain objects. The route
 * handlers wrap these and serialize them as JSON.
 *
 * Grounding: every metric is derived from fields the coordinator
 * already populates on `RunReceipt` (verdict, humanSummary,
 * totalCost, executionVerified). Nothing new is asked of workers
 * or of the coordinator — this is a read-only projection of
 * existing receipts.
 */

import type { RunReceipt } from "./coordinator.js";

// ─── Types ───────────────────────────────────────────────────────────

/**
 * The minimum shape metrics needs. Matches `TrackedRun` in
 * server/routes/tasks.ts, but typed locally so this module has
 * no dependency on Fastify or the server directory. The server
 * passes in `getAllTrackedRuns()` casts-safe into this shape.
 */
export interface TrackedRunLike {
  readonly taskId: string;
  readonly runId: string | null;
  readonly status: "queued" | "running" | "complete" | "partial" | "failed" | "cancelled";
  readonly prompt: string;
  readonly submittedAt: string;
  readonly completedAt: string | null;
  readonly receipt: RunReceipt | null | unknown;
  readonly error: string | null;
  readonly stateCategory?: "in-flight" | "completed" | "failed" | "crashed" | "blocked";
}

export interface MetricsSnapshot {
  readonly totalRuns: number;
  readonly successfulRuns: number;
  readonly failedRuns: number;
  readonly partialRuns: number;
  readonly noOpRuns: number;
  readonly inFlightRuns: number;
  readonly completedRuns: number;
  readonly crashedRuns: number;
  readonly successRate: number;
  readonly totalCostUsd: number;
  readonly avgCostPerRunUsd: number;
  readonly avgFilesTouched: number;
  readonly avgConfidence: number;
  readonly lastRunSummary: LastRunSummary | null;
  /** ISO timestamp when the snapshot was taken. */
  readonly generatedAt: string;
}

export interface LastRunSummary {
  readonly taskId: string;
  readonly runId: string | null;
  readonly classification: string | null;
  readonly headline: string;
  readonly confidence: number;
  readonly filesTouched: number;
  readonly costUsd: number;
  readonly verdict: string | null;
  readonly submittedAt: string;
  readonly completedAt: string | null;
  readonly executionVerified: boolean | null;
}

export interface RunListItem {
  readonly id: string;
  readonly runId: string | null;
  readonly status: TrackedRunLike["status"];
  readonly classification: string | null;
  readonly prompt: string;
  readonly summary: string;
  readonly costUsd: number;
  readonly filesTouched: number;
  readonly confidence: number;
  readonly timestamp: string;
  readonly completedAt: string | null;
  readonly executionVerified: boolean | null;
}

export interface RunDetail {
  readonly id: string;
  readonly runId: string | null;
  readonly status: TrackedRunLike["status"];
  readonly prompt: string;
  readonly submittedAt: string;
  readonly completedAt: string | null;
  readonly receipt: RunReceipt | null;
  readonly filesChanged: readonly { path: string; operation: string; diff?: string }[];
  readonly changes: readonly { path: string; operation: string; diff: string }[];
  readonly summary: {
    readonly classification: string | null;
    readonly headline: string;
    readonly narrative: string;
    readonly verification: string;
  };
  readonly confidence: {
    readonly overall: number;
    readonly planning: number;
    readonly execution: number;
    readonly verification: number;
  };
  readonly errors: readonly { source: string; message: string; suggestedFix?: string }[];
  readonly executionVerified: boolean | null;
  readonly executionGateReason: string | null;
  readonly blastRadius: {
    readonly level: string;
    readonly estimatedFiles: number;
    readonly rationale: string;
  } | null;
  readonly totalCostUsd: number;
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Aggregate tracked runs into a metrics snapshot. Pure function —
 * same input always yields the same output (except for
 * `generatedAt`, which is the caller's `now` if provided).
 */
export function computeMetrics(
  runs: readonly TrackedRunLike[],
  now: string = new Date().toISOString(),
): MetricsSnapshot {
  const totalRuns = runs.length;
  if (totalRuns === 0) {
    return emptySnapshot(now);
  }

  let successfulRuns = 0;
  let failedRuns = 0;
  let partialRuns = 0;
  let noOpRuns = 0;
  let inFlightRuns = 0;
  let completedRuns = 0;
  let crashedRuns = 0;
  let totalCostUsd = 0;
  let totalFilesTouched = 0;
  let totalConfidence = 0;
  let costDenominator = 0;
  let confidenceDenominator = 0;
  let filesDenominator = 0;

  for (const run of runs) {
    const receipt = receiptOf(run);
    if (!receipt) {
      switch (run.stateCategory ?? (run.status === "queued" || run.status === "running" ? "in-flight" : "failed")) {
        case "in-flight":
          inFlightRuns += 1;
          break;
        case "crashed":
          crashedRuns += 1;
          break;
        case "completed":
          completedRuns += 1;
          break;
        case "failed":
        default:
          failedRuns += 1;
          break;
      }
      continue;
    }

    const classification = classificationOf(receipt);
    completedRuns += 1;
    switch (classification) {
      case "VERIFIED_SUCCESS":
        successfulRuns += 1;
        break;
      case "PARTIAL_SUCCESS":
        partialRuns += 1;
        break;
      case "NO_OP":
        noOpRuns += 1;
        break;
      case "FAILED":
      default:
        failedRuns += 1;
        break;
    }

    const cost = Number(receipt.totalCost?.estimatedCostUsd ?? 0);
    if (Number.isFinite(cost)) {
      totalCostUsd += cost;
      costDenominator += 1;
    }

    const humanSummary = receipt.humanSummary;
    if (humanSummary) {
      const files = Number(humanSummary.filesTouchedCount ?? 0);
      if (Number.isFinite(files)) {
        totalFilesTouched += files;
        filesDenominator += 1;
      }
      const conf = Number(humanSummary.confidence?.overall ?? 0);
      if (Number.isFinite(conf)) {
        totalConfidence += conf;
        confidenceDenominator += 1;
      }
    }
  }

  const terminalRuns = successfulRuns + failedRuns + partialRuns + noOpRuns;
  const successRate = terminalRuns === 0 ? 0 : successfulRuns / terminalRuns;

  const avgCostPerRunUsd = costDenominator === 0 ? 0 : totalCostUsd / costDenominator;
  const avgFilesTouched = filesDenominator === 0 ? 0 : totalFilesTouched / filesDenominator;
  const avgConfidence = confidenceDenominator === 0 ? 0 : totalConfidence / confidenceDenominator;

  return {
    totalRuns,
    successfulRuns,
    failedRuns,
    partialRuns,
    noOpRuns,
    inFlightRuns,
    completedRuns,
    crashedRuns,
    successRate: round4(successRate),
    totalCostUsd: round6(totalCostUsd),
    avgCostPerRunUsd: round6(avgCostPerRunUsd),
    avgFilesTouched: round2(avgFilesTouched),
    avgConfidence: round4(avgConfidence),
    lastRunSummary: pickLastRunSummary(runs),
    generatedAt: now,
  };
}

/**
 * Project a tracked-run registry into the `/runs` list shape.
 */
export function projectRunList(
  runs: readonly TrackedRunLike[],
  limit: number = 20,
): RunListItem[] {
  return runs.slice(0, limit).map(toRunListItem);
}

/**
 * Project a single tracked run into the `/runs/:id` detail shape.
 * Returns `null` when the run is not found in the registry.
 */
export function projectRunDetail(run: TrackedRunLike | null | undefined): RunDetail | null {
  if (!run) return null;
  const receipt = receiptOf(run);
  const humanSummary = receipt?.humanSummary;

  const filesChanged = humanSummary?.whatChanged
    ? humanSummary.whatChanged.map((c) => ({ path: c.path, operation: c.operation }))
    : receipt?.executionEvidence
      ? receipt.executionEvidence
          .filter((e) => e.kind === "file_created" || e.kind === "file_modified" || e.kind === "file_deleted")
          .map((e) => ({
            path: e.ref,
            operation:
              e.kind === "file_created" ? "create" : e.kind === "file_deleted" ? "delete" : "modify",
          }))
      : [];
  const changes = extractApiChanges(receipt);

  const errors: { source: string; message: string; suggestedFix?: string }[] = [];
  if (run.error) {
    errors.push({ source: "runtime", message: run.error });
  }
  if (humanSummary?.failureExplanation) {
    errors.push({
      source: humanSummary.failureExplanation.stage,
      message: humanSummary.failureExplanation.rootCause,
      suggestedFix: humanSummary.failureExplanation.suggestedFix,
    });
  }

  return {
    id: run.taskId,
    runId: run.runId,
    status: run.status,
    prompt: run.prompt,
    submittedAt: run.submittedAt,
    completedAt: run.completedAt,
    receipt: receipt ?? null,
    filesChanged,
    changes,
    summary: {
      classification: classificationOf(receipt),
      headline: humanSummary?.headline ?? "",
      narrative: humanSummary?.narrative ?? "",
      verification: humanSummary?.verification ?? "not-run",
    },
    confidence: {
      overall: humanSummary?.confidence?.overall ?? 0,
      planning: humanSummary?.confidence?.planning ?? 0,
      execution: humanSummary?.confidence?.execution ?? 0,
      verification: humanSummary?.confidence?.verification ?? 0,
    },
    errors,
    executionVerified: receipt ? receipt.executionVerified : null,
    executionGateReason: receipt?.executionGateReason ?? null,
    blastRadius: humanSummary?.blastRadius
      ? {
          level: humanSummary.blastRadius.level,
          estimatedFiles: humanSummary.blastRadius.estimatedFiles,
          rationale: humanSummary.blastRadius.rationale,
        }
      : receipt?.blastRadius
        ? {
            level: receipt.blastRadius.level,
            estimatedFiles: receipt.blastRadius.estimatedFiles,
            rationale: receipt.blastRadius.rationale,
          }
        : null,
    totalCostUsd: Number(receipt?.totalCost?.estimatedCostUsd ?? 0),
  };
}

function extractApiChanges(receipt: RunReceipt | null): readonly { path: string; operation: string; diff: string }[] {
  const raw = (receipt as unknown as { changes?: unknown; patchArtifact?: unknown } | null)?.changes;
  if (Array.isArray(raw)) {
    return raw
      .filter((change): change is { path?: unknown; operation?: unknown; diff?: unknown } => Boolean(change))
      .map((change) => ({
        path: String(change.path ?? ""),
        operation: String(change.operation ?? "modify"),
        diff: typeof change.diff === "string" ? change.diff : "",
      }))
      .filter((change) => change.path && change.diff.trim());
  }
  return [];
}

// ─── Internals ───────────────────────────────────────────────────────

function emptySnapshot(now: string): MetricsSnapshot {
  return {
    totalRuns: 0,
    successfulRuns: 0,
    failedRuns: 0,
    partialRuns: 0,
    noOpRuns: 0,
    inFlightRuns: 0,
    completedRuns: 0,
    crashedRuns: 0,
    successRate: 0,
    totalCostUsd: 0,
    avgCostPerRunUsd: 0,
    avgFilesTouched: 0,
    avgConfidence: 0,
    lastRunSummary: null,
    generatedAt: now,
  };
}

function toRunListItem(run: TrackedRunLike): RunListItem {
  const receipt = receiptOf(run);
  const humanSummary = receipt?.humanSummary ?? null;
  return {
    id: run.taskId,
    runId: run.runId,
    status: run.status,
    classification: classificationOf(receipt),
    prompt: run.prompt,
    summary: humanSummary?.headline ?? receipt?.summary?.phase ?? run.prompt.slice(0, 140),
    costUsd: Number(receipt?.totalCost?.estimatedCostUsd ?? 0),
    filesTouched: Number(humanSummary?.filesTouchedCount ?? 0),
    confidence: Number(humanSummary?.confidence?.overall ?? 0),
    timestamp: run.submittedAt,
    completedAt: run.completedAt,
    executionVerified: receipt ? receipt.executionVerified : null,
  };
}

function pickLastRunSummary(runs: readonly TrackedRunLike[]): LastRunSummary | null {
  // `runs` is assumed newest-first (as returned by getAllTrackedRuns).
  // Fall back to the newest-submitted when the ordering is unclear.
  const latest = runs[0] ?? null;
  if (!latest) return null;
  const receipt = receiptOf(latest);
  const humanSummary = receipt?.humanSummary ?? null;
  return {
    taskId: latest.taskId,
    runId: latest.runId,
    classification: classificationOf(receipt),
    headline: humanSummary?.headline ?? latest.prompt.slice(0, 140),
    confidence: Number(humanSummary?.confidence?.overall ?? 0),
    filesTouched: Number(humanSummary?.filesTouchedCount ?? 0),
    costUsd: Number(receipt?.totalCost?.estimatedCostUsd ?? 0),
    verdict: receipt?.verdict ?? null,
    submittedAt: latest.submittedAt,
    completedAt: latest.completedAt,
    executionVerified: receipt ? receipt.executionVerified : null,
  };
}

function receiptOf(run: TrackedRunLike): RunReceipt | null {
  const r = run.receipt;
  if (!r || typeof r !== "object") return null;
  // Duck-type: a RunReceipt has runId + verdict. The tracked.receipt
  // field is typed as `unknown` in the server to avoid coupling.
  if (
    "runId" in (r as Record<string, unknown>) &&
    "verdict" in (r as Record<string, unknown>)
  ) {
    return r as RunReceipt;
  }
  return null;
}

function classificationOf(receipt: RunReceipt | null): string | null {
  if (!receipt) return null;
  return receipt.humanSummary?.classification ?? null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}
