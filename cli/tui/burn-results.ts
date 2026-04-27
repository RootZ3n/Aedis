/**
 * Parser for burn-in JSONL result files.
 *
 * The two harnesses (scripts/burn-in/test-burn-in.ts and
 * test-burn-in-hard.ts) share enough fields to be summarised together
 * but each emits its own superset. This module reads either file and
 * returns a normalised summary the TUI can render without caring which
 * suite produced the line.
 *
 * Important: classification text is passed through verbatim — the TUI
 * surfaces whatever the script emits (PASS / FAIL / ERROR / TIMEOUT /
 * BLOCKED / SAFE_FAILURE etc) without re-classifying.
 */

import { existsSync, readFileSync, statSync } from "node:fs";

export const SOFT_RESULTS_PATH = "/mnt/ai/tmp/aedis-burn-in-results.jsonl";
export const HARD_RESULTS_PATH = "/mnt/ai/tmp/aedis-burn-in-hard.jsonl";

export type BurnVerdict =
  | "PASS"
  | "FAIL"
  | "ERROR"
  | "TIMEOUT"
  | "BLOCKED"
  | "SAFE_FAILURE"
  | "UNKNOWN";

export interface BurnResultRow {
  readonly scenarioId: string;
  readonly verdict: BurnVerdict;
  readonly status: string | null;
  readonly classification: string | null;
  readonly costUsd: number | null;
  readonly durationMs: number | null;
  readonly timestamp: string | null;
}

export interface BurnSuiteSummary {
  readonly path: string;
  readonly exists: boolean;
  readonly fileMtime: string | null;
  readonly total: number;
  readonly pass: number;
  readonly fail: number;
  readonly error: number;
  readonly timeout: number;
  readonly blocked: number;
  readonly totalCostUsd: number;
  readonly totalDurationMs: number;
  readonly lastTimestamp: string | null;
  readonly rows: readonly BurnResultRow[];
  /** Raw lines that failed to parse — surfaced so the TUI can warn. */
  readonly parseErrors: number;
}

const KNOWN_VERDICTS: ReadonlySet<string> = new Set([
  "PASS",
  "FAIL",
  "ERROR",
  "TIMEOUT",
  "BLOCKED",
  "SAFE_FAILURE",
]);

function normaliseVerdict(raw: unknown): BurnVerdict {
  if (typeof raw !== "string") return "UNKNOWN";
  const upper = raw.toUpperCase();
  return KNOWN_VERDICTS.has(upper) ? (upper as BurnVerdict) : "UNKNOWN";
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

export function parseRow(raw: unknown): BurnResultRow | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const scenarioId = str(r["scenarioId"]);
  if (!scenarioId) return null;
  // The classification field on soft results often holds the
  // BLOCKED/SAFE_FAILURE marker; if status_ is generic but
  // classification carries a richer label, prefer the richer one for
  // the verdict surface.
  const baseVerdict = normaliseVerdict(r["status_"]);
  const classification = str(r["classification"]);
  const verdict =
    classification && KNOWN_VERDICTS.has(classification.toUpperCase())
      ? (classification.toUpperCase() as BurnVerdict)
      : baseVerdict;
  return {
    scenarioId,
    verdict,
    status: str(r["status"]),
    classification,
    costUsd: num(r["costUsd"]),
    durationMs: num(r["durationMs"]),
    timestamp: str(r["timestamp"]),
  };
}

export function parseJsonl(text: string): {
  rows: BurnResultRow[];
  parseErrors: number;
} {
  const rows: BurnResultRow[] = [];
  let parseErrors = 0;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line) as unknown;
      const row = parseRow(obj);
      if (row) rows.push(row);
      else parseErrors += 1;
    } catch {
      parseErrors += 1;
    }
  }
  return { rows, parseErrors };
}

export function summariseRows(
  path: string,
  rows: readonly BurnResultRow[],
  exists: boolean,
  fileMtime: string | null,
  parseErrors: number,
): BurnSuiteSummary {
  let totalCostUsd = 0;
  let totalDurationMs = 0;
  let pass = 0;
  let fail = 0;
  let error = 0;
  let timeout = 0;
  let blocked = 0;
  let lastTimestamp: string | null = null;
  for (const row of rows) {
    if (row.costUsd !== null) totalCostUsd += row.costUsd;
    if (row.durationMs !== null) totalDurationMs += row.durationMs;
    switch (row.verdict) {
      case "PASS": pass += 1; break;
      case "FAIL": fail += 1; break;
      case "ERROR": error += 1; break;
      case "TIMEOUT": timeout += 1; break;
      case "BLOCKED":
      case "SAFE_FAILURE": blocked += 1; break;
      // UNKNOWN intentionally excluded from counts so the buckets sum
      // to total - unknown rather than silently miscategorising.
    }
    if (row.timestamp && (lastTimestamp === null || row.timestamp > lastTimestamp)) {
      lastTimestamp = row.timestamp;
    }
  }
  return {
    path,
    exists,
    fileMtime,
    total: rows.length,
    pass,
    fail,
    error,
    timeout,
    blocked,
    totalCostUsd,
    totalDurationMs,
    lastTimestamp,
    rows,
    parseErrors,
  };
}

export interface ReadOptions {
  /** Injectable for tests; defaults to fs.readFileSync. */
  readonly readFile?: (path: string) => string;
  readonly fileExists?: (path: string) => boolean;
  readonly fileMtime?: (path: string) => string | null;
}

const defaultMtime = (path: string): string | null => {
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return null;
  }
};

export function readSuite(path: string, opts: ReadOptions = {}): BurnSuiteSummary {
  const exists = (opts.fileExists ?? existsSync)(path);
  if (!exists) {
    return summariseRows(path, [], false, null, 0);
  }
  const text = (opts.readFile ?? ((p) => readFileSync(p, "utf-8")))(path);
  const { rows, parseErrors } = parseJsonl(text);
  const mtime = (opts.fileMtime ?? defaultMtime)(path);
  return summariseRows(path, rows, true, mtime, parseErrors);
}

export function formatDurationMs(ms: number): string {
  if (ms <= 0) return "0s";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = seconds % 60;
  if (minutes < 60) return rem ? `${minutes}m${rem}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const minRem = minutes % 60;
  return minRem ? `${hours}h${minRem}m` : `${hours}h`;
}
