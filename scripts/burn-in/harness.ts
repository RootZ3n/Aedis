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

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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

const SAFE_PASS_STATUSES: ReadonlySet<string> = new Set([
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

/**
 * One persisted worker dispatch entry. Mirrors
 * core/receipt-store.ts:ReceiptWorkerEvent. Used by the repair-loop
 * predicates below to count builder/verifier dispatches without
 * importing the full receipt-store types into the burn-in harness.
 */
export interface RunDetailWorkerEvent {
  readonly workerType?: string | null;
  readonly status?: string | null;
  readonly taskId?: string | null;
}

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
    /** Verification verdict surfaced by run-summary, when present. */
    verification?: string | null;
  } | null;
  /**
   * Worker dispatch events persisted on the receipt. Optional because
   * legacy receipts and the in-flight tracked-runs path leave it
   * empty; predicates below treat undefined/empty as "no evidence".
   */
  workerEvents?: ReadonlyArray<RunDetailWorkerEvent> | null;
  /**
   * Persisted verification receipt. Read for the final verifier
   * verdict pass/pass-with-warnings/fail. Predicates below treat a
   * missing verdict as "not-run".
   */
  verificationReceipt?: { verdict?: string | null } | null;
  errors?: ReadonlyArray<{ source?: string; message?: string }> | null;
}

// ─── Repair-loop predicates ─────────────────────────────────────────
//
// These are pure functions over RunDetail used by burn-in-10's
// expectation block. Kept here (not in test-burn-in.ts) so unit tests
// can import them without dragging in the polling main().

/**
 * True when the run actually executed validation commands — at least
 * one verifier worker event reached status="completed". Without this,
 * the scenario's "run npm test" instruction was never honoured and
 * the outcome cannot be considered verified.
 */
export function hasCommandEvidence(detail: RunDetail | null): boolean {
  const events = detail?.workerEvents ?? [];
  return events.some(
    (e) => e?.workerType === "verifier" && e?.status === "completed",
  );
}

/**
 * Count repair attempts. A repair attempt = a builder dispatch beyond
 * the first one. Multiple builder events arise from the recovery path
 * after a failed dispatch (executeGraph → attemptRecovery → re-dispatch)
 * or from in-loop fix-and-rerun within a single task. Returns 0 when
 * no builder events are present (legacy or in-flight detail).
 */
export function countRepairAttempts(detail: RunDetail | null): number {
  const events = detail?.workerEvents ?? [];
  const builderCount = events.filter((e) => e?.workerType === "builder").length;
  return Math.max(0, builderCount - 1);
}

/**
 * Final verifier verdict — "pass" | "pass-with-warnings" | "fail" |
 * "not-run". Reads first from the persisted verificationReceipt.verdict;
 * falls back to summary.verification. "not-run" is the safe default
 * for anything we can't confirm — never assume verified silence.
 */
export function finalVerifierVerdict(
  detail: RunDetail | null,
): "pass" | "pass-with-warnings" | "fail" | "not-run" {
  const fromReceipt = detail?.verificationReceipt?.verdict;
  if (fromReceipt === "pass" || fromReceipt === "pass-with-warnings" || fromReceipt === "fail") {
    return fromReceipt;
  }
  const fromSummary = detail?.summary?.verification;
  if (
    fromSummary === "pass" ||
    fromSummary === "pass-with-warnings" ||
    fromSummary === "fail"
  ) {
    return fromSummary;
  }
  return "not-run";
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
  /** Override classification in the JSONL row (e.g. "promote_blocked_restored"). */
  readonly classification?: string | null;
  /** Override narrative in the JSONL row. */
  readonly narrative?: string | null;
}

export interface ClassifyOptions {
  readonly allowPromote?: boolean;
}

/**
 * Map a final run detail to a burn-in verdict. The key non-obvious
 * call is EXECUTION_ERROR with zero changed files: the run failed to
 * produce a patch but the source repo is untouched, which is exactly
 * what the safe-failure model is supposed to optimise for. We
 * surface that as SAFE_FAILURE so the dashboard doesn't lump it in
 * with hard failures.
 */
export function classifyOutcome(detail: RunDetail | null, opts: ClassifyOptions = {}): OutcomeClassification {
  if (!detail) {
    return { verdict: "ERROR", cleanup: "none", note: "no run detail available" };
  }
  const snap = summariseDetail(detail);
  const status = snap.status;

  if (status === "PROMOTED") {
    if (opts.allowPromote) {
      return { verdict: "PASS", cleanup: "none", note: "--allow-promote enabled; PROMOTED accepted" };
    }
    return {
      verdict: "FAIL",
      cleanup: "reject",
      note: "Run reached PROMOTED — rejecting/cancelling and restoring source repo",
    };
  }

  if (SAFE_PASS_STATUSES.has(status)) {
    return { verdict: "PASS", cleanup: "none", note: null };
  }

  if (PENDING_APPROVAL_STATUSES.has(status)) {
    // Verifier passed and the run is now sitting waiting for a human
    // to merge. The harness must NOT merge — reject first for
    // clarity; applyCleanup falls back to cancel if no pending
    // approval exists for that state.
    const cleanup = "reject";
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
  const res = await http.postJson<{ ok?: boolean }>(`/tasks/${encodeURIComponent(idOrRunId)}/cancel`);
  return res.ok && res.body?.ok !== false;
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
  const res = await http.postJson<{ ok?: boolean }>(`/approvals/${encodeURIComponent(runId)}/reject`);
  return res.ok && res.body?.ok !== false;
}

export async function applyCleanup(
  http: BurnHttpClient,
  cleanup: OutcomeClassification["cleanup"],
  ids: { runId?: string | null; taskId?: string | null },
): Promise<boolean> {
  if (cleanup === "none") return true;
  if (cleanup === "reject" && ids.runId) {
    const rejected = await rejectAwaitingApproval(http, ids.runId);
    if (rejected) return true;
  }
  // Either explicit cancel or fallback for reject without runId.
  const target = ids.runId ?? ids.taskId ?? "";
  return cancelRun(http, target);
}

export interface CleanupVerification {
  readonly activeRun: boolean | null;
  readonly pendingApproval: boolean | null;
  readonly ok: boolean;
  readonly error: string | null;
}

export async function verifyCleanupState(
  http: BurnHttpClient,
  ids: { runId?: string | null; taskId?: string | null },
): Promise<CleanupVerification> {
  let activeRun: boolean | null = null;
  let pendingApproval: boolean | null = null;
  const errors: string[] = [];
  const taskTarget = ids.taskId ?? ids.runId ?? "";

  if (taskTarget) {
    try {
      const taskRes = await http.getJson<{ active_run?: boolean }>(`/tasks/${encodeURIComponent(taskTarget)}`);
      if (taskRes.ok && taskRes.body && typeof taskRes.body.active_run === "boolean") {
        activeRun = taskRes.body.active_run;
      } else if (!taskRes.ok) {
        errors.push(`task status HTTP ${taskRes.status}`);
      }
    } catch (err) {
      errors.push(`task status: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  try {
    const pendingRes = await http.getJson<{ pending?: ReadonlyArray<{ runId?: string }> }>("/approvals/pending");
    if (pendingRes.ok && pendingRes.body && Array.isArray(pendingRes.body.pending)) {
      pendingApproval = pendingRes.body.pending.some((p) => p.runId === ids.runId);
    } else if (!pendingRes.ok) {
      errors.push(`pending approvals HTTP ${pendingRes.status}`);
    }
  } catch (err) {
    errors.push(`pending approvals: ${err instanceof Error ? err.message : String(err)}`);
  }

  const ok = activeRun === false && pendingApproval === false && errors.length === 0;
  return { activeRun, pendingApproval, ok, error: errors.length > 0 ? errors.join("; ") : null };
}

export interface SourceRepoSnapshot {
  readonly head: string;
  readonly status: string;
}

export interface SourceRepoVerification {
  readonly headUnchanged: boolean;
  readonly clean: boolean;
  readonly ok: boolean;
  readonly restored: boolean;
  readonly error: string | null;
}

export interface SourceRepoGuard {
  snapshot(repoPath: string): Promise<SourceRepoSnapshot>;
  restoreAndVerify(repoPath: string, before: SourceRepoSnapshot): Promise<SourceRepoVerification>;
}

async function git(repoPath: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repoPath, ...args], {
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trim();
}

export async function snapshotSourceRepo(repoPath: string): Promise<SourceRepoSnapshot> {
  return {
    head: await git(repoPath, ["rev-parse", "HEAD"]),
    status: await git(repoPath, ["status", "--porcelain"]),
  };
}

export async function restoreAndVerifySourceRepo(
  repoPath: string,
  before: SourceRepoSnapshot,
): Promise<SourceRepoVerification> {
  let restored = false;
  let error: string | null = null;
  try {
    const currentHead = await git(repoPath, ["rev-parse", "HEAD"]);
    if (currentHead !== before.head) {
      await git(repoPath, ["reset", "--hard", before.head]);
      restored = true;
    }
    const statusAfterReset = await git(repoPath, ["status", "--porcelain"]);
    if (statusAfterReset !== before.status && before.status === "") {
      await git(repoPath, ["clean", "-fd"]);
      restored = true;
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  try {
    const finalHead = await git(repoPath, ["rev-parse", "HEAD"]);
    const finalStatus = await git(repoPath, ["status", "--porcelain"]);
    const headUnchanged = finalHead === before.head;
    const clean = finalStatus === "";
    return { headUnchanged, clean, ok: headUnchanged && clean && !error, restored, error };
  } catch (err) {
    const finalError = err instanceof Error ? err.message : String(err);
    return { headUnchanged: false, clean: false, ok: false, restored, error: error ? `${error}; ${finalError}` : finalError };
  }
}

export const gitSourceRepoGuard: SourceRepoGuard = {
  snapshot: snapshotSourceRepo,
  restoreAndVerify: restoreAndVerifySourceRepo,
};

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

    // Adaptive polling: once files have changed or cost is tracked,
    // the run is past the slow planning phase — poll faster to catch
    // terminal status sooner and reduce post-completion latency.
    const snap = summariseDetail(detail ?? lastDetail);
    const adaptive = snap.filesChanged > 0 || (snap.costUsd !== null && snap.costUsd > 0);
    await sleep(adaptive ? Math.min(pollIntervalMs, 2000) : pollIntervalMs);
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
  /** Unique per harness invocation — used to separate current-run rows from history. */
  invocationId?: string;
  /**
   * Repair-loop signals — populated for every row from the last
   * successful detail fetch. Used by the burn-in-10 expectation
   * block (and by post-hoc summaries) to verify the create →
   * validate → repair → rerun cycle actually happened.
   */
  commandEvidence?: boolean;
  repairAttempts?: number;
  finalVerifierVerdict?: "pass" | "pass-with-warnings" | "fail" | "not-run";
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

  // Timeout-specific overrides: populate failure fields from last
  // known state so the JSONL row is self-describing.
  const isTimeout = poll.timedOut;
  const lastStatus = snap.status || "UNKNOWN";
  const lastPhase = snap.phase ?? "—";

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
    classification: isTimeout ? "timeout" : (outcome.classification ?? detail?.classification ?? null),
    verdict: finalVerdict,
    status_: finalVerdict,
    costUsd: snap.costUsd,
    durationMs: poll.elapsedMs,
    filesChanged: snap.filesChanged,
    failureCode: isTimeout
      ? "timeout"
      : (explanation?.code ?? null),
    failureRootCause: isTimeout
      ? "Run exceeded time limit without reaching terminal state"
      : (explanation?.rootCause ?? null),
    narrative: isTimeout
      ? `Timeout after ${Math.round(poll.elapsedMs / 1000)}s — last status=${lastStatus} phase=${lastPhase}`
      : (outcome.narrative ?? detail?.summary?.narrative ?? detail?.summary?.headline ?? null),
    errors,
    cleanup: outcome.cleanup,
    cleanupOk,
    timedOut: poll.timedOut,
    fetchError: poll.lastFetchError,
    notes: outcome.note ? [outcome.note, ...notes] : [...notes],
    error,
    commandEvidence: hasCommandEvidence(detail),
    repairAttempts: countRepairAttempts(detail),
    finalVerifierVerdict: finalVerifierVerdict(detail),
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
  readonly allowPromote?: boolean;
  readonly sourceRepoGuard?: SourceRepoGuard;
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
    allowPromote = false,
    sourceRepoGuard = gitSourceRepoGuard,
  } = opts;

  let submitted = false;
  let taskId = "";
  let runId = "";
  let error: string | null = null;
  let cleanupOk: boolean | null = null;
  let repoSnapshot: SourceRepoSnapshot | null = null;
  const notes = [...extraNotes];

  try {
    repoSnapshot = await sourceRepoGuard.snapshot(repoPath);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    return buildResultRow({
      scenarioId,
      prompt,
      repo: repoPath,
      taskId,
      runId,
      submitted: false,
      poll: { detail: null, timedOut: false, elapsedMs: 0, lastFetchError: "source repo snapshot failed" },
      outcome: { verdict: "ERROR", cleanup: "none", note: "source repo snapshot failed" },
      cleanupOk: null,
      notes,
      error,
    });
  }

  if (!allowPromote && repoSnapshot.status !== "") {
    return buildResultRow({
      scenarioId,
      prompt,
      repo: repoPath,
      taskId,
      runId,
      submitted: false,
      poll: { detail: null, timedOut: false, elapsedMs: 0, lastFetchError: "source repo dirty before burn-in" },
      outcome: { verdict: "ERROR", cleanup: "none", note: "source repo dirty before burn-in; refusing to run" },
      cleanupOk: null,
      notes,
      error: "source repo dirty before burn-in",
    });
  }

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
      notes,
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
      notes,
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
  let outcome: OutcomeClassification = pollWithFinal.timedOut
    ? { verdict: "TIMEOUT", cleanup: "cancel", note: `timed out after ${timeoutMs}ms` }
    : classifyOutcome(pollWithFinal.detail, { allowPromote });

  // ── Cleanup ───────────────────────────────────────────────────────
  // Track API action result separately from final safety verification.
  if (outcome.cleanup !== "none") {
    try {
      cleanupOk = await applyCleanup(http, outcome.cleanup, { runId, taskId });
    } catch (err) {
      cleanupOk = false;
      error = error ?? (err as Error).message;
    }
  }

  let cleanupVerified = true;
  if (!allowPromote && (outcome.cleanup !== "none" || normaliseStatus(pollWithFinal.detail?.status) === "PROMOTED")) {
    const verification = await verifyCleanupState(http, { runId, taskId });
    notes.push(`cleanup verification: active_run=${verification.activeRun} pending_approval=${verification.pendingApproval}`);
    if (!verification.ok) {
      cleanupVerified = false;
      error = error ?? verification.error ?? "cleanup verification failed";
    }
  }

  let sourceVerified = true;
  if (!allowPromote && repoSnapshot) {
    const source = await sourceRepoGuard.restoreAndVerify(repoPath, repoSnapshot);
    notes.push(`source repo verification: head_unchanged=${source.headUnchanged} clean=${source.clean}${source.restored ? " restored=true" : ""}`);
    if (!source.ok) {
      sourceVerified = false;
      error = error ?? source.error ?? "source repo verification failed";
    }
  }

  // ── Upgrade promoted-then-restored runs ─────────────────────────
  // Score by final safety state, not by whether the reject/cancel API
  // call succeeded. A PROMOTED run where reject(404) + cancel(404)
  // both fail but the source repo is restored and no active run /
  // pending approval remains is safe.
  const finalStatus = normaliseStatus(pollWithFinal.detail?.status);
  if (
    !allowPromote &&
    (finalStatus === "PROMOTED" || finalStatus === "READY_FOR_PROMOTION") &&
    cleanupVerified &&
    sourceVerified
  ) {
    outcome = {
      verdict: "SAFE_FAILURE",
      cleanup: outcome.cleanup,
      note: outcome.note,
      classification: "promote_blocked_restored",
      narrative: "Run reached promotion state; burn-in restored source repo as designed.",
    };
  } else if (
    !allowPromote &&
    (finalStatus === "PROMOTED" || finalStatus === "READY_FOR_PROMOTION") &&
    (!cleanupVerified || !sourceVerified)
  ) {
    outcome = {
      verdict: "FAIL",
      cleanup: outcome.cleanup,
      note: outcome.note,
      classification: "cleanup_failed",
    };
  }

  // ── Upgrade approval-required runs after successful cleanup ───
  // Same pattern as PROMOTED: if auto-reject executed and both
  // cleanup verification and source repo verification pass, the run
  // produced a valid change but the harness correctly rejected it —
  // that's a safe outcome, not a pending one.
  // Only AWAITING_APPROVAL — READY_FOR_PROMOTION is already handled
  // by the PROMOTED/READY_FOR_PROMOTION block above.
  if (
    !allowPromote &&
    finalStatus === "AWAITING_APPROVAL" &&
    cleanupVerified &&
    sourceVerified
  ) {
    outcome = {
      verdict: "SAFE_FAILURE",
      cleanup: outcome.cleanup,
      note: outcome.note,
      classification: "approval_required_restored",
      narrative: "Valid change produced; burn-in rejected it to preserve source.",
    };
  } else if (
    !allowPromote &&
    finalStatus === "AWAITING_APPROVAL" &&
    (!cleanupVerified || !sourceVerified)
  ) {
    outcome = {
      verdict: "FAIL",
      cleanup: outcome.cleanup,
      note: outcome.note,
      classification: "cleanup_failed",
    };
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
    notes,
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
    invocationId: typeof raw["invocationId"] === "string" ? raw["invocationId"] : undefined,
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

// ─── Invocation filtering ────────────────────────────────────────────

/**
 * Return rows belonging to a specific invocation, or the latest
 * invocation if no id is given. Returns all rows when no rows carry
 * an invocationId (backwards compat with old JSONL files).
 */
export function filterByInvocation(
  rows: readonly BurnResultRow[],
  invocationId?: string,
): BurnResultRow[] {
  if (invocationId) {
    return rows.filter((r) => r.invocationId === invocationId);
  }
  // Find the latest invocationId by scanning from the end.
  let latestId: string | undefined;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].invocationId) {
      latestId = rows[i].invocationId;
      break;
    }
  }
  if (!latestId) return [...rows];
  return rows.filter((r) => r.invocationId === latestId);
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

// ─── Lane-rescue cost guard ─────────────────────────────────────────
//
// burn-in-11-lane-rescue is the only scenario that intentionally
// triggers a paid cloud-shadow dispatch. Three guards must clear
// before it runs:
//   1. lane-config mode is "local_then_cloud" (the only mode that
//      can rescue via shadow); other modes have nothing to prove.
//   2. shadow lane provider is a *cloud* provider (real spend); a
//      shadow on a local provider is free and the guard relaxes.
//   3. operator passed `--allow-shadow-cost` to acknowledge cost.
//
// Returns a discriminated union so the burn-in loop can either run
// the scenario or log a clear SKIPPED reason.

const CLOUD_PROVIDERS: ReadonlySet<string> = new Set([
  "openrouter",
  "anthropic",
  "openai",
  "minimax",
  "modelstudio",
  "zai",
  "glm-5.1-openrouter",
  "glm-5.1-direct",
]);

export function isCloudShadowProvider(provider: string | undefined): boolean {
  return typeof provider === "string" && CLOUD_PROVIDERS.has(provider);
}

export interface LaneRescueGuardInput {
  /** Lane mode read from .aedis/lane-config.json (or "primary_only" default). */
  readonly laneMode?: string;
  /** Configured shadow provider (e.g. "openrouter"); undefined when no shadow. */
  readonly shadowProvider?: string;
  /** True when the operator passed --allow-shadow-cost. */
  readonly allowShadowCost: boolean;
}

export type LaneRescueGuard =
  | { readonly run: true }
  | { readonly run: false; readonly reason: string };

/**
 * Pure projection — decide whether to run burn-in-11. Two no-cost
 * skips (lane mode mismatch, no shadow configured) plus one cost
 * skip (cloud shadow without --allow-shadow-cost). Local shadows
 * pass through without the flag because there's no spend to gate.
 */
export function shouldRunLaneRescue(input: LaneRescueGuardInput): LaneRescueGuard {
  if (input.laneMode !== "local_then_cloud") {
    return {
      run: false,
      reason:
        `lane mode is ${JSON.stringify(input.laneMode ?? "unset")}; ` +
        `lane-rescue only runs under "local_then_cloud"`,
    };
  }
  if (!input.shadowProvider) {
    return {
      run: false,
      reason:
        `lane-config has no shadow lane configured — nothing to rescue with`,
    };
  }
  if (isCloudShadowProvider(input.shadowProvider) && !input.allowShadowCost) {
    return {
      run: false,
      reason:
        `shadow provider "${input.shadowProvider}" is a paid cloud — ` +
        `pass --allow-shadow-cost to authorise the spend`,
    };
  }
  return { run: true };
}

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
