/**
 * Burn-in harness — shared polling + classification logic.
 *
 * Both test-burn-in.ts (soft) and test-burn-in-hard.ts (hard) consume
 * this module so they classify run outcomes the same way and don't
 * silently 404 against non-existent endpoints (the original bug:
 * `/api/runs/:runId/cancel` and `/api/runs/:runId/approve` don't
 * exist; the real paths are `/tasks/:id/cancel` and
 * `/approvals/:runId/reject`).
 *
 * The HTTP client is injectable so tests can drive the full
 * AWAITING_APPROVAL → reject → record path without spinning up a
 * server.
 */

// ─── Status sets ─────────────────────────────────────────────────────

/**
 * Statuses that mean the coordinator is no longer mutating state on
 * its own and the harness should stop polling. AWAITING_APPROVAL and
 * READY_FOR_PROMOTION are "soft terminal" — the run paused waiting
 * for a human and will sit there forever unless we explicitly
 * cancel/reject it (which is exactly what the harness does so source
 * never gets mutated).
 *
 * Match against status.toUpperCase() — the in-flight `/api/runs/:id`
 * response uses lowercase "running"/"complete"; the persisted store
 * uses the canonical uppercase enum from core/receipt-store.ts.
 */
export const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  // Persisted-store terminal states (core/receipt-store.ts:49-70)
  "PROMOTED",
  "VERIFIED_PASS",
  "VERIFIED_FAIL",
  "CRUCIBULUM_FAIL",
  "REJECTED",
  "ABORTED",
  "INTERRUPTED",
  "EXECUTION_ERROR",
  "CLEANUP_ERROR",
  // Pause-for-human states the harness treats as terminal so it can
  // record + clean up without auto-approving.
  "AWAITING_APPROVAL",
  "READY_FOR_PROMOTION",
  // Legacy aliases the receipt store accepts on read.
  "COMPLETE",
  "COMPLETED",
  "FAILED",
  "CRASHED",
  "CANCELLED",
]);

const PASS_STATUSES: ReadonlySet<string> = new Set([
  "PROMOTED",
  "VERIFIED_PASS",
  "COMPLETE",
  "COMPLETED",
]);

const PENDING_APPROVAL_STATUSES: ReadonlySet<string> = new Set([
  "AWAITING_APPROVAL",
  "READY_FOR_PROMOTION",
]);

const HARD_FAIL_STATUSES: ReadonlySet<string> = new Set([
  "VERIFIED_FAIL",
  "CRUCIBULUM_FAIL",
  "FAILED",
  "CRASHED",
]);

const ERROR_STATUSES: ReadonlySet<string> = new Set([
  "ABORTED",
  "CANCELLED",
  "CLEANUP_ERROR",
]);

export type BurnVerdict =
  | "PASS"
  | "FAIL"
  | "ERROR"
  | "TIMEOUT"
  | "SAFE_FAILURE"
  | "PENDING_APPROVAL"
  | "BLOCKED";

export function normaliseStatus(s: string | null | undefined): string {
  return (s ?? "").toString().toUpperCase();
}

export function isTerminal(status: string | null | undefined): boolean {
  return TERMINAL_STATUSES.has(normaliseStatus(status));
}

// ─── Run detail shape (subset we care about) ─────────────────────────

export interface RunDetail {
  status: string | null;
  /** Sometimes "phase" is on the body root, sometimes inside runState. */
  phase?: string | null;
  runState?: { phase?: string | null } | null;
  totalCostUsd?: number | null;
  classification?: string | null;
  filesChanged?: ReadonlyArray<unknown> | null;
  summary?: {
    headline?: string | null;
    narrative?: string | null;
    changes?: ReadonlyArray<{ path?: string | null }> | null;
    failureExplanation?: {
      code?: string | null;
      stage?: string | null;
      rootCause?: string | null;
      suggestedFix?: string | null;
      evidence?: ReadonlyArray<string> | null;
    } | null;
  } | null;
  errors?: ReadonlyArray<{ source?: string; message?: string }> | null;
}

export interface RunSnapshot {
  status: string;
  phase: string | null;
  costUsd: number | null;
  filesChanged: number;
}

export function summariseDetail(detail: RunDetail | null): RunSnapshot {
  if (!detail) return { status: "UNKNOWN", phase: null, costUsd: null, filesChanged: 0 };
  const phase = detail.runState?.phase ?? detail.phase ?? null;
  const filesArr = detail.summary?.changes ?? detail.filesChanged ?? [];
  return {
    status: normaliseStatus(detail.status),
    phase: phase ?? null,
    costUsd: typeof detail.totalCostUsd === "number" ? detail.totalCostUsd : null,
    filesChanged: Array.isArray(filesArr) ? filesArr.length : 0,
  };
}

// ─── Outcome classification ──────────────────────────────────────────

export interface OutcomeClassification {
  readonly verdict: BurnVerdict;
  /**
   * What cleanup the harness should perform after recording. Hint
   * only — the runner decides whether to honour it.
   */
  readonly cleanup: "none" | "cancel" | "reject";
  readonly note: string | null;
}

/**
 * Map a final run detail to a burn-in verdict. The key non-obvious
 * call is EXECUTION_ERROR with zero changed files: the run failed to
 * produce a patch but the source repo is untouched, which is exactly
 * what the safe-failure model is supposed to optimise for. We
 * surface that as SAFE_FAILURE so the dashboard doesn't lump it in
 * with hard failures.
 */
export function classifyOutcome(detail: RunDetail | null): OutcomeClassification {
  if (!detail) {
    return { verdict: "ERROR", cleanup: "none", note: "no run detail available" };
  }
  const snap = summariseDetail(detail);
  const status = snap.status;

  if (PASS_STATUSES.has(status)) {
    return { verdict: "PASS", cleanup: "none", note: null };
  }

  if (PENDING_APPROVAL_STATUSES.has(status)) {
    // Verifier passed and the run is now sitting waiting for a human
    // to merge. The harness must NOT merge — reject for
    // AWAITING_APPROVAL (clears the pending entry cleanly), cancel
    // for READY_FOR_PROMOTION (no dedicated reject endpoint exists
    // for that state).
    const cleanup = status === "AWAITING_APPROVAL" ? "reject" : "cancel";
    return {
      verdict: "PENDING_APPROVAL",
      cleanup,
      note: `Run reached ${status} — auto-${cleanup} to keep source clean`,
    };
  }

  if (status === "EXECUTION_ERROR") {
    if (snap.filesChanged === 0) {
      return {
        verdict: "SAFE_FAILURE",
        cleanup: "none",
        note: "EXECUTION_ERROR with zero files changed — source untouched",
      };
    }
    return {
      verdict: "FAIL",
      cleanup: "none",
      note: `EXECUTION_ERROR with ${snap.filesChanged} file(s) changed`,
    };
  }

  if (HARD_FAIL_STATUSES.has(status)) {
    return { verdict: "FAIL", cleanup: "none", note: null };
  }

  if (status === "INTERRUPTED" || status === "REJECTED") {
    // INTERRUPTED is what the coordinator emits when it asks for
    // clarification on an ambiguous prompt — not a failure of the
    // system, a successful refusal to guess.
    return { verdict: "BLOCKED", cleanup: "none", note: null };
  }

  if (ERROR_STATUSES.has(status)) {
    return { verdict: "ERROR", cleanup: "none", note: null };
  }

  return {
    verdict: "ERROR",
    cleanup: "none",
    note: `Unexpected terminal status: ${status}`,
  };
}

// ─── HTTP client ─────────────────────────────────────────────────────

export interface JsonResponse<T = unknown> {
  ok: boolean;
  status: number;
  body: T | null;
}

export interface BurnHttpClient {
  getJson<T>(path: string): Promise<JsonResponse<T>>;
  postJson<T>(path: string, body?: unknown): Promise<JsonResponse<T>>;
}

export function createFetchClient(baseUrl: string): BurnHttpClient {
  return {
    async getJson<T>(path: string): Promise<JsonResponse<T>> {
      const res = await fetch(`${baseUrl}${path}`);
      const body = (await safeJson(res)) as T | null;
      return { ok: res.ok, status: res.status, body };
    },
    async postJson<T>(path: string, body?: unknown): Promise<JsonResponse<T>> {
      const res = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const parsed = (await safeJson(res)) as T | null;
      return { ok: res.ok, status: res.status, body: parsed };
    },
  };
}

async function safeJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text) as unknown; }
  catch { return text; }
}

// ─── Cleanup helpers ─────────────────────────────────────────────────

/**
 * POST /tasks/:id/cancel — works for both task and run IDs (the route
 * resolves either via cancelTrackedTask). Returns true if the server
 * acknowledged cancellation, false on 404 / non-2xx.
 */
export async function cancelRun(
  http: BurnHttpClient,
  idOrRunId: string,
): Promise<boolean> {
  if (!idOrRunId) return false;
  const res = await http.postJson(`/tasks/${encodeURIComponent(idOrRunId)}/cancel`);
  return res.ok;
}

/**
 * POST /approvals/:runId/reject — only valid for runs in
 * AWAITING_APPROVAL. Clears the pending-approval entry without
 * promoting the changeset.
 */
export async function rejectAwaitingApproval(
  http: BurnHttpClient,
  runId: string,
): Promise<boolean> {
  if (!runId) return false;
  const res = await http.postJson(`/approvals/${encodeURIComponent(runId)}/reject`);
  return res.ok;
}

export async function applyCleanup(
  http: BurnHttpClient,
  cleanup: OutcomeClassification["cleanup"],
  ids: { runId?: string | null; taskId?: string | null },
): Promise<boolean> {
  if (cleanup === "none") return true;
  if (cleanup === "reject" && ids.runId) {
    return rejectAwaitingApproval(http, ids.runId);
  }
  // Either explicit cancel or fallback for reject without runId.
  const target = ids.runId ?? ids.taskId ?? "";
  return cancelRun(http, target);
}

// ─── Polling loop ────────────────────────────────────────────────────

export interface PollOptions {
  readonly http: BurnHttpClient;
  readonly runId: string;
  /** Whole-run cap; harness aborts at this point. */
  readonly timeoutMs: number;
  /** How often to fetch /api/runs/:id. Default 5000ms. */
  readonly pollIntervalMs?: number;
  /** How often to invoke onProgress. Default 15000ms. */
  readonly progressIntervalMs?: number;
  /** Receives a snapshot every progressIntervalMs while polling. */
  readonly onProgress?: (snap: RunSnapshot, elapsedMs: number) => void;
  /** Injectable for tests. Returns ms-since-epoch; default Date.now. */
  readonly now?: () => number;
  /** Injectable for tests. Default real setTimeout. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface PollResult {
  /** Last successful run-detail fetch, or null if none ever succeeded. */
  readonly detail: RunDetail | null;
  /** True iff we exited because timeoutMs elapsed. */
  readonly timedOut: boolean;
  /** Final wall-clock duration of the poll. */
  readonly elapsedMs: number;
  /** Last fetch error, if any. Surfaced for the JSONL row. */
  readonly lastFetchError: string | null;
}

export async function pollUntilTerminal(opts: PollOptions): Promise<PollResult> {
  const {
    http,
    runId,
    timeoutMs,
    pollIntervalMs = 5000,
    progressIntervalMs = 15_000,
    onProgress,
    now = Date.now,
    sleep = (ms) => new Promise<void>((r) => setTimeout(r, ms)),
  } = opts;

  const start = now();
  const deadline = start + timeoutMs;
  let lastDetail: RunDetail | null = null;
  let lastFetchError: string | null = null;
  let lastProgressAt = 0;

  while (now() < deadline) {
    const elapsed = now() - start;
    let detail: RunDetail | null = null;
    try {
      const res = await http.getJson<RunDetail>(`/api/runs/${encodeURIComponent(runId)}`);
      if (res.ok && res.body) {
        detail = res.body;
        lastDetail = detail;
        lastFetchError = null;
      } else {
        lastFetchError = `HTTP ${res.status}`;
      }
    } catch (err) {
      lastFetchError = (err as Error).message;
    }

    if (onProgress && elapsed - lastProgressAt >= progressIntervalMs) {
      onProgress(summariseDetail(detail ?? lastDetail), elapsed);
      lastProgressAt = elapsed;
    }

    if (detail && isTerminal(detail.status)) {
      return { detail, timedOut: false, elapsedMs: now() - start, lastFetchError: null };
    }

    await sleep(pollIntervalMs);
  }

  return {
    detail: lastDetail,
    timedOut: true,
    elapsedMs: now() - start,
    lastFetchError,
  };
}

// ─── Progress + JSONL formatting ─────────────────────────────────────

export function formatProgressLine(snap: RunSnapshot, elapsedMs: number): string {
  const elapsedSec = Math.floor(elapsedMs / 1000);
  const cost = snap.costUsd !== null ? `$${snap.costUsd.toFixed(4)}` : "$?";
  return `[burn-in] elapsed=${elapsedSec}s status=${snap.status} phase=${snap.phase ?? "—"} cost=${cost} files=${snap.filesChanged}`;
}

export interface ResultRowInput {
  readonly scenarioId: string;
  readonly prompt: string;
  readonly repo: string;
  readonly taskId: string;
  readonly runId: string;
  readonly submitted: boolean;
  readonly poll: PollResult;
  readonly outcome: OutcomeClassification;
  readonly cleanupOk: boolean | null;
  readonly notes: string[];
  readonly error: string | null;
  /** Defaulted to new Date().toISOString() for production; injectable for tests. */
  readonly nowIso?: string;
}

export interface BurnResultRow {
  scenarioId: string;
  timestamp: string;
  prompt: string;
  repo: string;
  submitted: boolean;
  taskId: string;
  runId: string;
  // Final coordinator status (e.g. PROMOTED, AWAITING_APPROVAL, EXECUTION_ERROR)
  status: string | null;
  phase: string | null;
  classification: string | null;
  // Categorical verdict from classifyOutcome.
  verdict: BurnVerdict | "TIMEOUT";
  // Legacy alias kept so the existing TUI parser (status_) keeps working.
  status_: BurnVerdict | "TIMEOUT";
  costUsd: number | null;
  durationMs: number;
  filesChanged: number;
  failureCode: string | null;
  failureRootCause: string | null;
  narrative: string | null;
  errors: string[];
  cleanup: OutcomeClassification["cleanup"];
  cleanupOk: boolean | null;
  timedOut: boolean;
  fetchError: string | null;
  notes: string[];
  error: string | null;
}

export function buildResultRow(input: ResultRowInput): BurnResultRow {
  const { scenarioId, prompt, repo, taskId, runId, submitted, poll, outcome, cleanupOk, notes, error } = input;
  const detail = poll.detail;
  const snap = summariseDetail(detail);
  const finalVerdict: BurnVerdict | "TIMEOUT" = poll.timedOut ? "TIMEOUT" : outcome.verdict;
  const explanation = detail?.summary?.failureExplanation ?? null;
  const errors = (detail?.errors ?? [])
    .map((e) => (typeof e?.message === "string" ? e.message : ""))
    .filter((m) => m.length > 0);
  return {
    scenarioId,
    timestamp: input.nowIso ?? new Date().toISOString(),
    prompt,
    repo,
    submitted,
    taskId,
    runId,
    status: detail?.status ?? null,
    phase: snap.phase,
    classification: detail?.classification ?? null,
    verdict: finalVerdict,
    status_: finalVerdict,
    costUsd: snap.costUsd,
    durationMs: poll.elapsedMs,
    filesChanged: snap.filesChanged,
    failureCode: explanation?.code ?? null,
    failureRootCause: explanation?.rootCause ?? null,
    narrative: detail?.summary?.narrative ?? detail?.summary?.headline ?? null,
    errors,
    cleanup: outcome.cleanup,
    cleanupOk,
    timedOut: poll.timedOut,
    fetchError: poll.lastFetchError,
    notes: outcome.note ? [outcome.note, ...notes] : [...notes],
    error,
  };
}

// ─── Run executor ────────────────────────────────────────────────────

export interface RunOnceOptions {
  readonly http: BurnHttpClient;
  readonly scenarioId: string;
  readonly prompt: string;
  readonly repoPath: string;
  readonly timeoutMs: number;
  readonly pollIntervalMs?: number;
  readonly progressIntervalMs?: number;
  readonly onProgress?: (line: string) => void;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly extraNotes?: string[];
}

interface SubmitResponse {
  task_id?: string;
  run_id?: string;
  id?: string;
}

/**
 * Submit, poll, classify, clean up — produces a single BurnResultRow
 * suitable for appending to JSONL. Never auto-approves a run. On
 * timeout, fetches one final detail then attempts cancel so the row
 * carries the most accurate snapshot we can produce.
 */
export async function runScenarioOnce(opts: RunOnceOptions): Promise<BurnResultRow> {
  const {
    http,
    scenarioId,
    prompt,
    repoPath,
    timeoutMs,
    pollIntervalMs,
    progressIntervalMs,
    onProgress,
    now = Date.now,
    sleep,
    extraNotes = [],
  } = opts;

  let submitted = false;
  let taskId = "";
  let runId = "";
  let error: string | null = null;
  let cleanupOk: boolean | null = null;

  // ── Submit ────────────────────────────────────────────────────────
  const submitRes = await http.postJson<SubmitResponse>("/tasks", { prompt, repoPath });
  if (!submitRes.ok || !submitRes.body) {
    return buildResultRow({
      scenarioId,
      prompt,
      repo: repoPath,
      taskId,
      runId,
      submitted: false,
      poll: {
        detail: null,
        timedOut: false,
        elapsedMs: 0,
        lastFetchError: `submit failed HTTP ${submitRes.status}`,
      },
      outcome: { verdict: "ERROR", cleanup: "none", note: "POST /tasks failed" },
      cleanupOk: null,
      notes: extraNotes,
      error: `submit failed HTTP ${submitRes.status}`,
    });
  }
  submitted = true;
  taskId = submitRes.body.task_id ?? "";
  runId = submitRes.body.run_id ?? submitRes.body.id ?? "";

  if (!runId) {
    return buildResultRow({
      scenarioId,
      prompt,
      repo: repoPath,
      taskId,
      runId,
      submitted,
      poll: { detail: null, timedOut: false, elapsedMs: 0, lastFetchError: "no run_id in submit response" },
      outcome: { verdict: "ERROR", cleanup: "none", note: "submit returned no run_id" },
      cleanupOk: null,
      notes: extraNotes,
      error: "no run_id in submit response",
    });
  }

  // ── Poll ──────────────────────────────────────────────────────────
  const poll = await pollUntilTerminal({
    http,
    runId,
    timeoutMs,
    pollIntervalMs,
    progressIntervalMs,
    onProgress: onProgress
      ? (snap, elapsed) => onProgress(formatProgressLine(snap, elapsed))
      : undefined,
    now,
    sleep,
  });

  // ── Final fetch on timeout (best-effort) ──────────────────────────
  let pollWithFinal = poll;
  if (poll.timedOut) {
    try {
      const finalRes = await http.getJson<RunDetail>(`/api/runs/${encodeURIComponent(runId)}`);
      if (finalRes.ok && finalRes.body) {
        pollWithFinal = { ...poll, detail: finalRes.body };
      }
    } catch (err) {
      error = (err as Error).message;
    }
  }

  // ── Classify ──────────────────────────────────────────────────────
  const outcome: OutcomeClassification = pollWithFinal.timedOut
    ? { verdict: "ERROR", cleanup: "cancel", note: `timed out after ${timeoutMs}ms` }
    : classifyOutcome(pollWithFinal.detail);

  // ── Cleanup ───────────────────────────────────────────────────────
  if (outcome.cleanup !== "none") {
    try {
      cleanupOk = await applyCleanup(http, outcome.cleanup, { runId, taskId });
    } catch (err) {
      cleanupOk = false;
      error = error ?? (err as Error).message;
    }
  }

  return buildResultRow({
    scenarioId,
    prompt,
    repo: repoPath,
    taskId,
    runId,
    submitted,
    poll: pollWithFinal,
    outcome,
    cleanupOk,
    notes: extraNotes,
    error,
  });
}

// ─── Safe string formatting ──────────────────────────────────────────

/** Convert any value to a display string — never throws. */
export function safeStr(v: unknown, fallback = "—"): string {
  if (v === null || v === undefined) return fallback;
  return String(v);
}

/** Safe padEnd — converts to string first, never throws. */
export function safePad(v: unknown, width: number, fallback = "—"): string {
  return safeStr(v, fallback).padEnd(width);
}

// ─── JSONL parsing ───────────────────────────────────────────────────

export interface ParsedJsonl<T> {
  readonly rows: T[];
  readonly parseErrors: number;
}

/**
 * Parse JSONL text into rows. Never throws — malformed lines are
 * counted as parseErrors and skipped.
 */
export function parseJsonlRows(text: string): ParsedJsonl<BurnResultRow> {
  const rows: BurnResultRow[] = [];
  let parseErrors = 0;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      rows.push(normaliseBurnRow(obj));
    } catch {
      parseErrors += 1;
    }
  }
  return { rows, parseErrors };
}

/** Ensure all expected BurnResultRow fields have safe defaults. */
export function normaliseBurnRow(raw: Record<string, unknown>): BurnResultRow {
  return {
    scenarioId: safeStr(raw["scenarioId"], "unknown"),
    timestamp: safeStr(raw["timestamp"], new Date().toISOString()),
    prompt: safeStr(raw["prompt"], ""),
    repo: safeStr(raw["repo"], ""),
    submitted: Boolean(raw["submitted"]),
    taskId: safeStr(raw["taskId"], ""),
    runId: safeStr(raw["runId"], ""),
    status: typeof raw["status"] === "string" ? raw["status"] : null,
    phase: typeof raw["phase"] === "string" ? raw["phase"] : null,
    classification: typeof raw["classification"] === "string" ? raw["classification"] : null,
    verdict: (safeStr(raw["verdict"], "ERROR") as BurnVerdict | "TIMEOUT"),
    status_: (safeStr(raw["status_"] ?? raw["verdict"], "ERROR") as BurnVerdict | "TIMEOUT"),
    costUsd: typeof raw["costUsd"] === "number" ? raw["costUsd"] : 0,
    durationMs: typeof raw["durationMs"] === "number" ? raw["durationMs"] : 0,
    filesChanged: typeof raw["filesChanged"] === "number" ? raw["filesChanged"] : 0,
    failureCode: typeof raw["failureCode"] === "string" ? raw["failureCode"] : null,
    failureRootCause: typeof raw["failureRootCause"] === "string" ? raw["failureRootCause"] : null,
    narrative: typeof raw["narrative"] === "string" ? raw["narrative"] : null,
    errors: Array.isArray(raw["errors"]) ? raw["errors"].filter((e): e is string => typeof e === "string") : [],
    cleanup: (safeStr(raw["cleanup"], "none") as BurnResultRow["cleanup"]),
    cleanupOk: typeof raw["cleanupOk"] === "boolean" ? raw["cleanupOk"] : null,
    timedOut: Boolean(raw["timedOut"]),
    fetchError: typeof raw["fetchError"] === "string" ? raw["fetchError"] : null,
    notes: Array.isArray(raw["notes"]) ? raw["notes"].filter((n): n is string => typeof n === "string") : [],
    error: typeof raw["error"] === "string" ? raw["error"] : null,
  };
}

// ─── Summary formatting ─────────────────────────────────────────────

export interface BurnSummaryBlock {
  total: number;
  pass: number;
  fail: number;
  safeFail: number;
  timeout: number;
  error: number;
  blocked: number;
  pendingApproval: number;
  avgCostUsd: number;
  avgDurationSec: number;
  parseErrors: number;
}

export function computeSummary(rows: readonly BurnResultRow[], parseErrors = 0): BurnSummaryBlock {
  const buckets: Record<string, number> = {
    PASS: 0, FAIL: 0, SAFE_FAILURE: 0, TIMEOUT: 0, ERROR: 0, BLOCKED: 0, PENDING_APPROVAL: 0,
  };
  let totalCost = 0;
  let totalDuration = 0;
  for (const r of rows) {
    const v = safeStr(r.verdict, "ERROR");
    buckets[v] = (buckets[v] ?? 0) + 1;
    totalCost += r.costUsd ?? 0;
    totalDuration += r.durationMs ?? 0;
  }
  const n = rows.length || 1;
  return {
    total: rows.length,
    pass: buckets["PASS"] ?? 0,
    fail: buckets["FAIL"] ?? 0,
    safeFail: buckets["SAFE_FAILURE"] ?? 0,
    timeout: buckets["TIMEOUT"] ?? 0,
    error: buckets["ERROR"] ?? 0,
    blocked: buckets["BLOCKED"] ?? 0,
    pendingApproval: buckets["PENDING_APPROVAL"] ?? 0,
    avgCostUsd: totalCost / n,
    avgDurationSec: totalDuration / n / 1000,
    parseErrors,
  };
}

export function formatSummaryBlock(s: BurnSummaryBlock): string {
  const lines: string[] = [
    "",
    "─".repeat(50),
    "BURN-IN SUMMARY",
    "─".repeat(50),
    `Total:        ${s.total} scenarios`,
    `PASS:         ${s.pass}`,
    `FAIL:         ${s.fail}`,
    `SAFE_FAILURE: ${s.safeFail}`,
    `TIMEOUT:      ${s.timeout}`,
    `ERROR:        ${s.error}`,
    `BLOCKED:      ${s.blocked}`,
    `PENDING:      ${s.pendingApproval}`,
    "",
    `Avg cost:     $${s.avgCostUsd.toFixed(2)}`,
    `Avg duration: ${s.avgDurationSec.toFixed(1)}s`,
  ];
  if (s.parseErrors > 0) {
    lines.push(`Parse errors: ${s.parseErrors}`);
  }
  lines.push("─".repeat(50));
  lines.push("");
  return lines.join("\n");
}

// ─── Config helpers ──────────────────────────────────────────────────

export const DEFAULT_BURN_TIMEOUT_MS = 900_000; // 15 min

export function resolveTimeoutMs(
  envValue: string | undefined,
  fallbackMs: number = DEFAULT_BURN_TIMEOUT_MS,
): number {
  if (!envValue) return fallbackMs;
  const parsed = Number.parseInt(envValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallbackMs;
  return parsed;
}

// ─── Scenario filter ─────────────────────────────────────────────────

/**
 * Parse `--scenario <id>` from argv and return the filtered list.
 * Exits with code 1 and a helpful message when the id doesn't match.
 * Returns the full list when `--scenario` is absent.
 */
export function filterScenarios<T extends { id: string }>(
  scenarios: readonly T[],
  argv: string[] = process.argv,
): T[] {
  const idx = argv.indexOf("--scenario");
  if (idx === -1 || idx + 1 >= argv.length) return [...scenarios];
  const target = argv[idx + 1];
  const match = scenarios.filter((s) => s.id === target);
  if (match.length === 0) {
    const ids = scenarios.map((s) => s.id).join("\n  ");
    console.error(`Unknown scenario: ${target}\nAvailable:\n  ${ids}`);
    process.exit(1);
  }
  return match;
}
