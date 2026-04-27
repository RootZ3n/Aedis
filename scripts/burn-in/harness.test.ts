import test from "node:test";
import assert from "node:assert/strict";

import {
  type BurnHttpClient,
  type BurnResultRow,
  type JsonResponse,
  type RunDetail,
  type SourceRepoGuard,
  classifyOutcome,
  computeSummary,
  filterByInvocation,
  filterScenarios,
  formatProgressLine,
  formatSummaryBlock,
  isTerminal,
  normaliseBurnRow,
  parseJsonlRows,
  pollUntilTerminal,
  resolveTimeoutMs,
  runScenarioOnce,
  safePad,
  safeStr,
  summariseDetail,
} from "./harness.js";

// ─── Mock HTTP client ─────────────────────────────────────────────────

type Handler = (path: string, body?: unknown) => JsonResponse<unknown>;

interface MockOptions {
  readonly get?: Handler;
  readonly post?: Handler;
}

function mockHttp(opts: MockOptions): {
  http: BurnHttpClient;
  calls: { method: "GET" | "POST"; path: string; body?: unknown }[];
} {
  const calls: { method: "GET" | "POST"; path: string; body?: unknown }[] = [];
  const http: BurnHttpClient = {
    async getJson<T>(path: string): Promise<JsonResponse<T>> {
      calls.push({ method: "GET", path });
      const res = opts.get ? opts.get(path) : { ok: false, status: 404, body: null };
      return res as JsonResponse<T>;
    },
    async postJson<T>(path: string, body?: unknown): Promise<JsonResponse<T>> {
      calls.push({ method: "POST", path, body });
      const res = opts.post ? opts.post(path, body) : { ok: true, status: 200, body: null };
      return res as JsonResponse<T>;
    },
  };
  return { http, calls };
}

const ok = <T,>(body: T): JsonResponse<T> => ({ ok: true, status: 200, body });
const notFound = (): JsonResponse<null> => ({ ok: false, status: 404, body: null });
const cleanRepoGuard: SourceRepoGuard = {
  async snapshot() {
    return { head: "base-head", status: "" };
  },
  async restoreAndVerify() {
    return { headUnchanged: true, clean: true, ok: true, restored: false, error: null };
  },
};

// ─── Status / classification helpers ─────────────────────────────────

test("isTerminal includes all coordinator terminal states (incl. AWAITING_APPROVAL/READY_FOR_PROMOTION)", () => {
  assert.equal(isTerminal("PROMOTED"), true);
  assert.equal(isTerminal("AWAITING_APPROVAL"), true);
  assert.equal(isTerminal("READY_FOR_PROMOTION"), true);
  assert.equal(isTerminal("EXECUTION_ERROR"), true);
  assert.equal(isTerminal("VERIFIED_PASS"), true);
  assert.equal(isTerminal("VERIFIED_FAIL"), true);
  assert.equal(isTerminal("CRUCIBULUM_FAIL"), true);
  assert.equal(isTerminal("REJECTED"), true);
  assert.equal(isTerminal("INTERRUPTED"), true);
  assert.equal(isTerminal("CLEANUP_ERROR"), true);
  // Active in-flight states must NOT be terminal.
  assert.equal(isTerminal("running"), false);
  assert.equal(isTerminal("EXECUTING_IN_WORKSPACE"), false);
  assert.equal(isTerminal("RUNNING"), false);
  assert.equal(isTerminal("VERIFICATION_PENDING"), false);
  assert.equal(isTerminal(null), false);
});

test("classifyOutcome: AWAITING_APPROVAL → PENDING_APPROVAL with cleanup=reject", () => {
  const detail: RunDetail = {
    status: "AWAITING_APPROVAL",
    summary: { changes: [{ path: "core/run-summary.ts" }] },
  };
  const o = classifyOutcome(detail);
  assert.equal(o.verdict, "PENDING_APPROVAL");
  assert.equal(o.cleanup, "reject");
  assert.match(o.note ?? "", /AWAITING_APPROVAL/);
});

test("classifyOutcome: READY_FOR_PROMOTION → PENDING_APPROVAL with cleanup=reject", () => {
  const o = classifyOutcome({ status: "READY_FOR_PROMOTION" });
  assert.equal(o.verdict, "PENDING_APPROVAL");
  assert.equal(o.cleanup, "reject");
});

test("classifyOutcome: EXECUTION_ERROR with no files changed → SAFE_FAILURE (source untouched)", () => {
  const o = classifyOutcome({
    status: "EXECUTION_ERROR",
    summary: { changes: [], failureExplanation: { code: "BUILDER_ERROR", rootCause: "boom" } },
  });
  assert.equal(o.verdict, "SAFE_FAILURE");
  assert.equal(o.cleanup, "none");
  assert.match(o.note ?? "", /source untouched/);
});

test("classifyOutcome: EXECUTION_ERROR with files changed → FAIL", () => {
  const o = classifyOutcome({
    status: "EXECUTION_ERROR",
    summary: { changes: [{ path: "core/x.ts" }, { path: "core/y.ts" }] },
  });
  assert.equal(o.verdict, "FAIL");
  assert.match(o.note ?? "", /2 file/);
});

test("classifyOutcome: PROMOTED is unsafe unless --allow-promote is enabled", () => {
  const unsafe = classifyOutcome({ status: "PROMOTED" });
  assert.equal(unsafe.verdict, "FAIL");
  assert.equal(unsafe.cleanup, "reject");

  const allowed = classifyOutcome({ status: "PROMOTED" }, { allowPromote: true });
  assert.equal(allowed.verdict, "PASS");
  assert.equal(allowed.cleanup, "none");
});

test("classifyOutcome: VERIFIED_PASS / COMPLETE → PASS", () => {
  for (const status of ["VERIFIED_PASS", "COMPLETE", "COMPLETED"] as const) {
    assert.equal(classifyOutcome({ status }).verdict, "PASS", `${status} should be PASS`);
  }
});

test("classifyOutcome: INTERRUPTED → BLOCKED (clarification refusal, not a system failure)", () => {
  const o = classifyOutcome({ status: "INTERRUPTED" });
  assert.equal(o.verdict, "BLOCKED");
});

test("classifyOutcome: null detail → ERROR", () => {
  const o = classifyOutcome(null);
  assert.equal(o.verdict, "ERROR");
});

// ─── summariseDetail / progress ──────────────────────────────────────

test("summariseDetail extracts phase from runState OR top-level body", () => {
  const a = summariseDetail({ status: "running", runState: { phase: "verifying" } });
  assert.equal(a.phase, "verifying");
  const b = summariseDetail({ status: "running", phase: "building" });
  assert.equal(b.phase, "building");
});

test("formatProgressLine handles RUNNING / EXECUTING_IN_WORKSPACE snapshots", () => {
  const running = formatProgressLine(
    { status: "RUNNING", phase: "building", costUsd: 0.0123, filesChanged: 0 },
    45_000,
  );
  assert.match(running, /elapsed=45s/);
  assert.match(running, /status=RUNNING/);
  assert.match(running, /phase=building/);
  assert.match(running, /\$0\.0123/);
  const inWs = formatProgressLine(
    { status: "EXECUTING_IN_WORKSPACE", phase: "scouting", costUsd: null, filesChanged: 0 },
    5_000,
  );
  assert.match(inWs, /status=EXECUTING_IN_WORKSPACE/);
  assert.match(inWs, /\$\?/, "null cost must render as $?");
});

// ─── Polling loop ────────────────────────────────────────────────────

test("pollUntilTerminal stops as soon as the run reaches a terminal status", async () => {
  let tick = 0;
  const get: Handler = (path) => {
    assert.equal(path, "/api/runs/run-1");
    tick += 1;
    if (tick < 3) return ok<RunDetail>({ status: "running", runState: { phase: "building" } });
    return ok<RunDetail>({ status: "PROMOTED", summary: { changes: [{ path: "x.ts" }] } });
  };
  const fakeNow = mkClock();
  const result = await pollUntilTerminal({
    http: mockHttp({ get }).http,
    runId: "run-1",
    timeoutMs: 60_000,
    pollIntervalMs: 1000,
    progressIntervalMs: 99_999,
    now: fakeNow.now,
    sleep: fakeNow.sleep,
  });
  assert.equal(result.timedOut, false);
  assert.equal(result.detail?.status, "PROMOTED");
  assert.equal(tick, 3);
});

test("pollUntilTerminal returns timedOut=true and keeps the last good detail when deadline hits", async () => {
  const get: Handler = () => ok<RunDetail>({ status: "running", runState: { phase: "scouting" } });
  const fakeNow = mkClock();
  const result = await pollUntilTerminal({
    http: mockHttp({ get }).http,
    runId: "r",
    timeoutMs: 5_000,
    pollIntervalMs: 1000,
    progressIntervalMs: 99_999,
    now: fakeNow.now,
    sleep: fakeNow.sleep,
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.detail?.status, "running");
  assert.ok(result.elapsedMs >= 5_000);
});

test("pollUntilTerminal calls onProgress at the configured interval", async () => {
  const get: Handler = () => ok<RunDetail>({ status: "running", runState: { phase: "building" }, totalCostUsd: 0.005 });
  const progress: { elapsed: number; status: string }[] = [];
  const fakeNow = mkClock();
  await pollUntilTerminal({
    http: mockHttp({ get }).http,
    runId: "r",
    timeoutMs: 60_000,
    pollIntervalMs: 5_000,
    progressIntervalMs: 15_000,
    onProgress: (snap, elapsed) => progress.push({ elapsed, status: snap.status }),
    now: fakeNow.now,
    sleep: fakeNow.sleep,
  });
  // 60s window with 15s interval → 4 progress callbacks (at 0, 15, 30, 45s).
  assert.ok(progress.length >= 3, `expected ≥3 progress ticks, got ${progress.length}`);
  for (const p of progress) {
    assert.equal(p.status, "RUNNING", "status passed through normalised to upper case");
  }
});

// ─── End-to-end runScenarioOnce ──────────────────────────────────────

test("runScenarioOnce: AWAITING_APPROVAL is handled and rejected via /approvals/:runId/reject", async () => {
  const detail: RunDetail = {
    status: "AWAITING_APPROVAL",
    runState: { phase: "verifying" },
    totalCostUsd: 0.05,
    summary: { changes: [{ path: "core/run-summary.ts" }], headline: "Verifier passed" },
  };
  let getCount = 0;
  const get: Handler = (path) => {
    if (path === "/tasks/task_abc") return ok({ active_run: false });
    if (path === "/approvals/pending") return ok({ pending: [] });
    getCount += 1;
    return ok<RunDetail>(detail);
  };
  const post: Handler = (path) => {
    if (path === "/tasks") return ok({ task_id: "task_abc", run_id: "run-xyz" });
    if (path === "/approvals/run-xyz/reject") return ok({ ok: true });
    return notFound();
  };
  const fakeNow = mkClock();
  const { http, calls } = mockHttp({ get, post });
  const row = await runScenarioOnce({
    http,
    scenarioId: "s1",
    prompt: "do thing",
    repoPath: "/mnt/ai/aedis",
    timeoutMs: 60_000,
    pollIntervalMs: 1000,
    now: fakeNow.now,
    sleep: fakeNow.sleep,
    sourceRepoGuard: cleanRepoGuard,
  });
  // After cleanup passes, AWAITING_APPROVAL upgrades to SAFE_FAILURE.
  assert.equal(row.verdict, "SAFE_FAILURE");
  assert.equal(row.classification, "approval_required_restored");
  assert.equal(row.cleanup, "reject");
  assert.equal(row.cleanupOk, true);
  assert.equal(row.status, "AWAITING_APPROVAL");
  assert.equal(row.phase, "verifying");
  assert.equal(row.costUsd, 0.05);
  // Verify we hit the right cleanup endpoint and never tried the
  // bogus /api/runs/:runId/{approve,cancel} paths from the old code.
  const approveCall = calls.find((c) => c.path === "/approvals/run-xyz/reject");
  assert.ok(approveCall, "must POST /approvals/:runId/reject");
  const oldApproveCall = calls.find((c) => c.path.includes("/api/runs/") && c.path.endsWith("/approve"));
  assert.equal(oldApproveCall, undefined, "must NEVER POST /api/runs/:runId/approve");
  assert.ok(getCount >= 1, "polled at least once");
});

test("runScenarioOnce: PROMOTED is rejected, cancelled as fallback, and source repo is restored", async () => {
  let restored = false;
  const sourceRepoGuard: SourceRepoGuard = {
    async snapshot() {
      return { head: "before", status: "" };
    },
    async restoreAndVerify(_repoPath, before) {
      assert.equal(before.head, "before");
      restored = true;
      return { headUnchanged: true, clean: true, ok: true, restored: true, error: null };
    },
  };
  const post: Handler = (path) => {
    if (path === "/tasks") return ok({ task_id: "task-promoted", run_id: "run-promoted" });
    if (path === "/approvals/run-promoted/reject") return notFound();
    if (path === "/tasks/run-promoted/cancel") return ok({ ok: true });
    return notFound();
  };
  const get: Handler = (path) => {
    if (path === "/api/runs/run-promoted") return ok<RunDetail>({ status: "PROMOTED", summary: { changes: [{ path: "x.ts" }] } });
    if (path === "/tasks/task-promoted") return ok({ active_run: false });
    if (path === "/approvals/pending") return ok({ pending: [] });
    return notFound();
  };
  const fakeNow = mkClock();
  const { http, calls } = mockHttp({ get, post });

  const row = await runScenarioOnce({
    http,
    scenarioId: "promoted",
    prompt: "p",
    repoPath: "/repo",
    timeoutMs: 60_000,
    pollIntervalMs: 1000,
    now: fakeNow.now,
    sleep: fakeNow.sleep,
    sourceRepoGuard,
  });

  assert.equal(row.status, "PROMOTED");
  assert.equal(row.verdict, "SAFE_FAILURE");
  assert.equal(row.classification, "promote_blocked_restored");
  assert.match(row.narrative ?? "", /restored source repo as designed/);
  assert.equal(row.cleanup, "reject");
  assert.equal(row.cleanupOk, true);
  assert.equal(restored, true, "source repo must be restored after unsafe PROMOTED state");
  assert.ok(calls.find((c) => c.path === "/approvals/run-promoted/reject"), "must attempt reject first");
  assert.ok(calls.find((c) => c.path === "/tasks/run-promoted/cancel"), "must fall back to cancel");
  assert.match(row.notes.join("\n"), /active_run=false pending_approval=false/);
  assert.match(row.notes.join("\n"), /head_unchanged=true clean=true restored=true/);
});

test("runScenarioOnce: --allow-promote accepts PROMOTED and skips cleanup/restore", async () => {
  let restoreCalls = 0;
  const sourceRepoGuard: SourceRepoGuard = {
    async snapshot() {
      return { head: "before", status: "" };
    },
    async restoreAndVerify() {
      restoreCalls += 1;
      return { headUnchanged: true, clean: true, ok: true, restored: false, error: null };
    },
  };
  const post: Handler = (path) => path === "/tasks" ? ok({ task_id: "task-ok", run_id: "run-ok" }) : notFound();
  const get: Handler = (path) =>
    path === "/api/runs/run-ok"
      ? ok<RunDetail>({ status: "PROMOTED", summary: { changes: [{ path: "x.ts" }] } })
      : notFound();
  const fakeNow = mkClock();
  const { http, calls } = mockHttp({ get, post });

  const row = await runScenarioOnce({
    http,
    scenarioId: "promoted-allowed",
    prompt: "p",
    repoPath: "/repo",
    timeoutMs: 60_000,
    pollIntervalMs: 1000,
    now: fakeNow.now,
    sleep: fakeNow.sleep,
    allowPromote: true,
    sourceRepoGuard,
  });

  assert.equal(row.verdict, "PASS");
  assert.equal(row.cleanup, "none");
  assert.equal(row.cleanupOk, null);
  assert.equal(restoreCalls, 0);
  assert.equal(calls.some((c) => c.path.includes("/reject") || c.path.includes("/cancel")), false);
});

test("runScenarioOnce: PROMOTED + cleanup fail → FAIL with cleanup_failed classification", async () => {
  const sourceRepoGuard: SourceRepoGuard = {
    async snapshot() {
      return { head: "before", status: "" };
    },
    async restoreAndVerify() {
      return { headUnchanged: false, clean: false, ok: false, restored: false, error: "restore failed" };
    },
  };
  const post: Handler = (path) => {
    if (path === "/tasks") return ok({ task_id: "task-p", run_id: "run-p" });
    if (path === "/approvals/run-p/reject") return notFound();
    if (path === "/tasks/run-p/cancel") return ok({ ok: true });
    return notFound();
  };
  const get: Handler = (path) => {
    if (path === "/api/runs/run-p") return ok<RunDetail>({ status: "PROMOTED", summary: { changes: [{ path: "x.ts" }] } });
    if (path === "/tasks/task-p") return ok({ active_run: false });
    if (path === "/approvals/pending") return ok({ pending: [] });
    return notFound();
  };
  const fakeNow = mkClock();
  const { http } = mockHttp({ get, post });

  const row = await runScenarioOnce({
    http,
    scenarioId: "promoted-fail",
    prompt: "p",
    repoPath: "/repo",
    timeoutMs: 60_000,
    pollIntervalMs: 1000,
    now: fakeNow.now,
    sleep: fakeNow.sleep,
    sourceRepoGuard,
  });

  assert.equal(row.verdict, "FAIL");
  assert.equal(row.classification, "cleanup_failed");
  assert.ok(row.error, "must surface the restore error");
});

test("runScenarioOnce: READY_FOR_PROMOTION + cleanup ok → SAFE_FAILURE with promote_blocked_restored", async () => {
  const sourceRepoGuard: SourceRepoGuard = {
    async snapshot() {
      return { head: "before", status: "" };
    },
    async restoreAndVerify() {
      return { headUnchanged: true, clean: true, ok: true, restored: false, error: null };
    },
  };
  const post: Handler = (path) => {
    if (path === "/tasks") return ok({ task_id: "task-rfp", run_id: "run-rfp" });
    if (path === "/approvals/run-rfp/reject") return ok({ ok: true });
    return notFound();
  };
  const get: Handler = (path) => {
    if (path === "/api/runs/run-rfp") return ok<RunDetail>({ status: "READY_FOR_PROMOTION", summary: { changes: [{ path: "x.ts" }] } });
    if (path === "/tasks/task-rfp") return ok({ active_run: false });
    if (path === "/approvals/pending") return ok({ pending: [] });
    return notFound();
  };
  const fakeNow = mkClock();
  const { http } = mockHttp({ get, post });

  const row = await runScenarioOnce({
    http,
    scenarioId: "rfp-restored",
    prompt: "p",
    repoPath: "/repo",
    timeoutMs: 60_000,
    pollIntervalMs: 1000,
    now: fakeNow.now,
    sleep: fakeNow.sleep,
    sourceRepoGuard,
  });

  assert.equal(row.verdict, "SAFE_FAILURE");
  assert.equal(row.classification, "promote_blocked_restored");
  assert.match(row.narrative ?? "", /restored source repo as designed/);
});

test("runScenarioOnce: PROMOTED + reject fails + cancel fails but verification passes → SAFE_FAILURE", async () => {
  const sourceRepoGuard: SourceRepoGuard = {
    async snapshot() {
      return { head: "before", status: "" };
    },
    async restoreAndVerify() {
      return { headUnchanged: true, clean: true, ok: true, restored: true, error: null };
    },
  };
  // Both reject and cancel fail (run already completed)
  const post: Handler = (path) => {
    if (path === "/tasks") return ok({ task_id: "task-p2", run_id: "run-p2" });
    if (path === "/approvals/run-p2/reject") return notFound();
    if (path === "/tasks/run-p2/cancel") return notFound();
    return notFound();
  };
  const get: Handler = (path) => {
    if (path === "/api/runs/run-p2") return ok<RunDetail>({ status: "PROMOTED", summary: { changes: [{ path: "x.ts" }] } });
    if (path === "/tasks/task-p2") return ok({ active_run: false });
    if (path === "/approvals/pending") return ok({ pending: [] });
    return notFound();
  };
  const fakeNow = mkClock();
  const { http } = mockHttp({ get, post });

  const row = await runScenarioOnce({
    http,
    scenarioId: "promoted-reject-fail-safe",
    prompt: "p",
    repoPath: "/repo",
    timeoutMs: 60_000,
    pollIntervalMs: 1000,
    now: fakeNow.now,
    sleep: fakeNow.sleep,
    sourceRepoGuard,
  });

  assert.equal(row.verdict, "SAFE_FAILURE", "must be SAFE_FAILURE when final state is safe despite reject/cancel failing");
  assert.equal(row.classification, "promote_blocked_restored");
  assert.equal(row.cleanupOk, false, "API-level cleanup failed");
  assert.match(row.narrative ?? "", /restored source repo as designed/);
  assert.match(row.notes.join("\n"), /active_run=false pending_approval=false/);
  assert.match(row.notes.join("\n"), /head_unchanged=true clean=true restored=true/);
});

test("runScenarioOnce: PROMOTED + pending approval remains → FAIL cleanup_failed", async () => {
  const sourceRepoGuard: SourceRepoGuard = {
    async snapshot() {
      return { head: "before", status: "" };
    },
    async restoreAndVerify() {
      return { headUnchanged: true, clean: true, ok: true, restored: false, error: null };
    },
  };
  const post: Handler = (path) => {
    if (path === "/tasks") return ok({ task_id: "task-pa", run_id: "run-pa" });
    if (path === "/approvals/run-pa/reject") return notFound();
    if (path === "/tasks/run-pa/cancel") return ok({ ok: true });
    return notFound();
  };
  const get: Handler = (path) => {
    if (path === "/api/runs/run-pa") return ok<RunDetail>({ status: "PROMOTED", summary: { changes: [{ path: "x.ts" }] } });
    if (path === "/tasks/task-pa") return ok({ active_run: false });
    // Pending approval still present
    if (path === "/approvals/pending") return ok({ pending: [{ runId: "run-pa" }] });
    return notFound();
  };
  const fakeNow = mkClock();
  const { http } = mockHttp({ get, post });

  const row = await runScenarioOnce({
    http,
    scenarioId: "promoted-pending-remains",
    prompt: "p",
    repoPath: "/repo",
    timeoutMs: 60_000,
    pollIntervalMs: 1000,
    now: fakeNow.now,
    sleep: fakeNow.sleep,
    sourceRepoGuard,
  });

  assert.equal(row.verdict, "FAIL");
  assert.equal(row.classification, "cleanup_failed");
});

test("runScenarioOnce: PROMOTED + active run remains → FAIL cleanup_failed", async () => {
  const sourceRepoGuard: SourceRepoGuard = {
    async snapshot() {
      return { head: "before", status: "" };
    },
    async restoreAndVerify() {
      return { headUnchanged: true, clean: true, ok: true, restored: false, error: null };
    },
  };
  const post: Handler = (path) => {
    if (path === "/tasks") return ok({ task_id: "task-ar", run_id: "run-ar" });
    if (path === "/approvals/run-ar/reject") return notFound();
    if (path === "/tasks/run-ar/cancel") return ok({ ok: true });
    return notFound();
  };
  const get: Handler = (path) => {
    if (path === "/api/runs/run-ar") return ok<RunDetail>({ status: "PROMOTED", summary: { changes: [{ path: "x.ts" }] } });
    // Active run still present
    if (path === "/tasks/task-ar") return ok({ active_run: true });
    if (path === "/approvals/pending") return ok({ pending: [] });
    return notFound();
  };
  const fakeNow = mkClock();
  const { http } = mockHttp({ get, post });

  const row = await runScenarioOnce({
    http,
    scenarioId: "promoted-active-remains",
    prompt: "p",
    repoPath: "/repo",
    timeoutMs: 60_000,
    pollIntervalMs: 1000,
    now: fakeNow.now,
    sleep: fakeNow.sleep,
    sourceRepoGuard,
  });

  assert.equal(row.verdict, "FAIL");
  assert.equal(row.classification, "cleanup_failed");
});

test("runScenarioOnce: PROMOTED + source repo dirty after restore → FAIL cleanup_failed", async () => {
  const sourceRepoGuard: SourceRepoGuard = {
    async snapshot() {
      return { head: "before", status: "" };
    },
    async restoreAndVerify() {
      return { headUnchanged: true, clean: false, ok: false, restored: false, error: "working tree dirty" };
    },
  };
  const post: Handler = (path) => {
    if (path === "/tasks") return ok({ task_id: "task-d", run_id: "run-d" });
    if (path === "/approvals/run-d/reject") return ok({ ok: true });
    return notFound();
  };
  const get: Handler = (path) => {
    if (path === "/api/runs/run-d") return ok<RunDetail>({ status: "PROMOTED", summary: { changes: [{ path: "x.ts" }] } });
    if (path === "/tasks/task-d") return ok({ active_run: false });
    if (path === "/approvals/pending") return ok({ pending: [] });
    return notFound();
  };
  const fakeNow = mkClock();
  const { http } = mockHttp({ get, post });

  const row = await runScenarioOnce({
    http,
    scenarioId: "promoted-dirty",
    prompt: "p",
    repoPath: "/repo",
    timeoutMs: 60_000,
    pollIntervalMs: 1000,
    now: fakeNow.now,
    sleep: fakeNow.sleep,
    sourceRepoGuard,
  });

  assert.equal(row.verdict, "FAIL");
  assert.equal(row.classification, "cleanup_failed");
  assert.ok(row.error, "must surface the dirty repo error");
});

test("runScenarioOnce: PROMOTED + reject succeeds → SAFE_FAILURE", async () => {
  const sourceRepoGuard: SourceRepoGuard = {
    async snapshot() {
      return { head: "before", status: "" };
    },
    async restoreAndVerify() {
      return { headUnchanged: true, clean: true, ok: true, restored: false, error: null };
    },
  };
  const post: Handler = (path) => {
    if (path === "/tasks") return ok({ task_id: "task-rs", run_id: "run-rs" });
    if (path === "/approvals/run-rs/reject") return ok({ ok: true });
    return notFound();
  };
  const get: Handler = (path) => {
    if (path === "/api/runs/run-rs") return ok<RunDetail>({ status: "PROMOTED", summary: { changes: [{ path: "x.ts" }] } });
    if (path === "/tasks/task-rs") return ok({ active_run: false });
    if (path === "/approvals/pending") return ok({ pending: [] });
    return notFound();
  };
  const fakeNow = mkClock();
  const { http } = mockHttp({ get, post });

  const row = await runScenarioOnce({
    http,
    scenarioId: "promoted-reject-ok",
    prompt: "p",
    repoPath: "/repo",
    timeoutMs: 60_000,
    pollIntervalMs: 1000,
    now: fakeNow.now,
    sleep: fakeNow.sleep,
    sourceRepoGuard,
  });

  assert.equal(row.verdict, "SAFE_FAILURE");
  assert.equal(row.classification, "promote_blocked_restored");
  assert.equal(row.cleanupOk, true, "reject succeeded at API level");
});

test("computeSummary: counts promote_blocked_restored (SAFE_FAILURE) in safeFail bucket, not fail", () => {
  const rows: BurnResultRow[] = [
    normaliseBurnRow({ verdict: "SAFE_FAILURE", classification: "promote_blocked_restored", costUsd: 0.02, durationMs: 5000 }),
    normaliseBurnRow({ verdict: "PASS", costUsd: 0.10, durationMs: 3000 }),
    normaliseBurnRow({ verdict: "FAIL", classification: "cleanup_failed", costUsd: 0.05, durationMs: 2000 }),
  ];
  const s = computeSummary(rows);
  assert.equal(s.total, 3);
  assert.equal(s.pass, 1);
  assert.equal(s.fail, 1);
  assert.equal(s.safeFail, 1);
});

test("runScenarioOnce: AWAITING_APPROVAL + cleanup ok → SAFE_FAILURE approval_required_restored", async () => {
  const sourceRepoGuard: SourceRepoGuard = {
    async snapshot() {
      return { head: "before", status: "" };
    },
    async restoreAndVerify() {
      return { headUnchanged: true, clean: true, ok: true, restored: false, error: null };
    },
  };
  const post: Handler = (path) => {
    if (path === "/tasks") return ok({ task_id: "task-aa", run_id: "run-aa" });
    if (path === "/approvals/run-aa/reject") return ok({ ok: true });
    return notFound();
  };
  const get: Handler = (path) => {
    if (path === "/api/runs/run-aa") return ok<RunDetail>({ status: "AWAITING_APPROVAL", summary: { changes: [{ path: "x.ts" }] } });
    if (path === "/tasks/task-aa") return ok({ active_run: false });
    if (path === "/approvals/pending") return ok({ pending: [] });
    return notFound();
  };
  const fakeNow = mkClock();
  const { http } = mockHttp({ get, post });

  const row = await runScenarioOnce({
    http,
    scenarioId: "awaiting-cleanup-ok",
    prompt: "p",
    repoPath: "/repo",
    timeoutMs: 60_000,
    pollIntervalMs: 1000,
    now: fakeNow.now,
    sleep: fakeNow.sleep,
    sourceRepoGuard,
  });

  assert.equal(row.verdict, "SAFE_FAILURE");
  assert.equal(row.classification, "approval_required_restored");
  assert.equal(row.narrative, "Valid change produced; burn-in rejected it to preserve source.");
  assert.equal(row.cleanupOk, true, "reject succeeded at API level");
});

test("runScenarioOnce: AWAITING_APPROVAL + cleanup verification fails → FAIL cleanup_failed", async () => {
  const sourceRepoGuard: SourceRepoGuard = {
    async snapshot() {
      return { head: "before", status: "" };
    },
    async restoreAndVerify() {
      return { headUnchanged: true, clean: false, ok: false, restored: false, error: "working tree dirty" };
    },
  };
  const post: Handler = (path) => {
    if (path === "/tasks") return ok({ task_id: "task-af", run_id: "run-af" });
    if (path === "/approvals/run-af/reject") return ok({ ok: true });
    return notFound();
  };
  const get: Handler = (path) => {
    if (path === "/api/runs/run-af") return ok<RunDetail>({ status: "AWAITING_APPROVAL", summary: { changes: [{ path: "x.ts" }] } });
    if (path === "/tasks/task-af") return ok({ active_run: false });
    if (path === "/approvals/pending") return ok({ pending: [] });
    return notFound();
  };
  const fakeNow = mkClock();
  const { http } = mockHttp({ get, post });

  const row = await runScenarioOnce({
    http,
    scenarioId: "awaiting-cleanup-fail",
    prompt: "p",
    repoPath: "/repo",
    timeoutMs: 60_000,
    pollIntervalMs: 1000,
    now: fakeNow.now,
    sleep: fakeNow.sleep,
    sourceRepoGuard,
  });

  assert.equal(row.verdict, "FAIL");
  assert.equal(row.classification, "cleanup_failed");
  assert.ok(row.error, "must surface the dirty repo error");
});

test("classifyOutcome: AWAITING_APPROVAL without cleanup stays PENDING_APPROVAL", () => {
  const detail: RunDetail = { status: "AWAITING_APPROVAL", summary: { changes: [{ path: "x.ts" }] } };
  const result = classifyOutcome(detail);
  assert.equal(result.verdict, "PENDING_APPROVAL");
  assert.equal(result.cleanup, "reject");
});

test("runScenarioOnce: EXECUTION_ERROR with no files changed → SAFE_FAILURE, no cleanup attempted", async () => {
  const detail: RunDetail = {
    status: "EXECUTION_ERROR",
    runState: { phase: "building" },
    totalCostUsd: 0.01,
    summary: {
      changes: [],
      failureExplanation: { code: "BUILDER_NO_OUTPUT", rootCause: "model returned empty patch" },
    },
  };
  const post: Handler = (path) => {
    if (path === "/tasks") return ok({ task_id: "t", run_id: "r" });
    return ok({ ok: true });
  };
  const get: Handler = () => ok<RunDetail>(detail);
  const fakeNow = mkClock();
  const { http, calls } = mockHttp({ get, post });
  const row = await runScenarioOnce({
    http,
    scenarioId: "s2",
    prompt: "p",
    repoPath: "/r",
    timeoutMs: 60_000,
    pollIntervalMs: 1000,
    now: fakeNow.now,
    sleep: fakeNow.sleep,
    sourceRepoGuard: cleanRepoGuard,
  });
  assert.equal(row.verdict, "SAFE_FAILURE");
  assert.equal(row.cleanup, "none");
  assert.equal(row.cleanupOk, null, "no cleanup → null cleanupOk");
  assert.equal(row.status, "EXECUTION_ERROR");
  assert.equal(row.failureCode, "BUILDER_NO_OUTPUT");
  assert.equal(row.failureRootCause, "model returned empty patch");
  // No cancel/reject POSTs allowed.
  const cleanupCalls = calls.filter((c) => c.method === "POST" && c.path !== "/tasks");
  assert.equal(cleanupCalls.length, 0, "must NOT call cancel/reject when source is untouched");
});

test("runScenarioOnce: timeout fetches one final detail and attempts cancel via /tasks/:id/cancel", async () => {
  let polls = 0;
  let cancelCalled = false;
  const post: Handler = (path) => {
    if (path === "/tasks") return ok({ task_id: "t-99", run_id: "r-99" });
    if (path === "/tasks/r-99/cancel") {
      cancelCalled = true;
      return ok({ ok: true });
    }
    return notFound();
  };
  const get: Handler = (path) => {
    if (path === "/tasks/t-99") return ok({ active_run: false });
    if (path === "/approvals/pending") return ok({ pending: [] });
    polls += 1;
    return ok<RunDetail>({ status: "running", runState: { phase: "building" }, totalCostUsd: 0.02 });
  };
  const fakeNow = mkClock();
  const { http, calls } = mockHttp({ get, post });
  const row = await runScenarioOnce({
    http,
    scenarioId: "s3",
    prompt: "p",
    repoPath: "/r",
    timeoutMs: 4_000,
    pollIntervalMs: 1_000,
    now: fakeNow.now,
    sleep: fakeNow.sleep,
    sourceRepoGuard: cleanRepoGuard,
  });
  assert.equal(row.verdict, "TIMEOUT");
  assert.equal(row.timedOut, true);
  assert.equal(row.cleanup, "cancel");
  assert.equal(cancelCalled, true, "must POST /tasks/:id/cancel after timeout");
  // Final detail re-fetch on timeout is best-effort but should fire.
  assert.ok(polls >= 2, `expected at least 2 GETs (polls + final), got ${polls}`);
  // Old broken cancel path must NEVER appear.
  const oldCancel = calls.find((c) => c.path.includes("/api/runs/") && c.path.endsWith("/cancel"));
  assert.equal(oldCancel, undefined, "must NEVER POST /api/runs/:runId/cancel");
  assert.equal(row.status, "running");
  assert.equal(row.phase, "building");
  assert.equal(row.costUsd, 0.02);
  // Timeout-specific classification fields.
  assert.equal(row.classification, "timeout", "timeout must set classification=timeout");
  assert.equal(row.failureCode, "timeout", "timeout must set failureCode=timeout");
  assert.equal(row.failureRootCause, "Run exceeded time limit without reaching terminal state");
  assert.match(row.narrative ?? "", /Timeout after.*last status=RUNNING.*phase=building/);
});

test("runScenarioOnce: timeout preserves last known state in JSONL row", async () => {
  const post: Handler = (path) => {
    if (path === "/tasks") return ok({ task_id: "t-t", run_id: "r-t" });
    return ok({ ok: true });
  };
  const get: Handler = (path) => {
    if (path === "/tasks/t-t") return ok({ active_run: false });
    if (path === "/approvals/pending") return ok({ pending: [] });
    return ok<RunDetail>({ status: "running", runState: { phase: "scouting" }, totalCostUsd: 0.07 });
  };
  const fakeNow = mkClock();
  const { http } = mockHttp({ get, post });
  const row = await runScenarioOnce({
    http,
    scenarioId: "s-timeout-state",
    prompt: "p",
    repoPath: "/r",
    timeoutMs: 3_000,
    pollIntervalMs: 1_000,
    now: fakeNow.now,
    sleep: fakeNow.sleep,
    sourceRepoGuard: cleanRepoGuard,
  });
  assert.equal(row.verdict, "TIMEOUT");
  assert.equal(row.status_, "TIMEOUT");
  // Last known state carried through.
  assert.equal(row.status, "running");
  assert.equal(row.phase, "scouting");
  assert.equal(row.costUsd, 0.07);
  assert.ok(row.filesChanged === 0);
  // Must NOT be classified as ERROR.
  assert.notEqual(row.verdict, "ERROR");
  assert.notEqual(row.classification, "ERROR");
});

test("runScenarioOnce: never auto-approves — no POST to /approvals/:runId/approve", async () => {
  let polls = 0;
  const post: Handler = (path) => {
    if (path === "/tasks") return ok({ task_id: "t", run_id: "r" });
    return ok({ ok: true });
  };
  const get: Handler = (path) => {
    if (path === "/tasks/t") return ok({ active_run: false });
    if (path === "/approvals/pending") return ok({ pending: [] });
    polls += 1;
    return ok<RunDetail>({ status: polls < 2 ? "running" : "AWAITING_APPROVAL", summary: { changes: [] } });
  };
  const fakeNow = mkClock();
  const { http, calls } = mockHttp({ get, post });
  await runScenarioOnce({
    http,
    scenarioId: "s4",
    prompt: "p",
    repoPath: "/r",
    timeoutMs: 60_000,
    pollIntervalMs: 1000,
    now: fakeNow.now,
    sleep: fakeNow.sleep,
    sourceRepoGuard: cleanRepoGuard,
  });
  const approveCall = calls.find((c) => c.path.endsWith("/approve"));
  assert.equal(approveCall, undefined, "harness must never call any /approve endpoint");
});

test("runScenarioOnce: JSONL row carries status, phase, failureCode, narrative, timedOut, fetchError", async () => {
  const detail: RunDetail = {
    status: "VERIFIED_FAIL",
    runState: { phase: "verifying" },
    totalCostUsd: 0.07,
    classification: "FAIL",
    summary: {
      changes: [{ path: "core/x.ts" }],
      headline: "Verifier rejected the patch",
      narrative: "tsc reported 3 new errors",
      failureExplanation: { code: "TYPECHECK_FAIL", rootCause: "missing import" },
    },
    errors: [{ source: "verifier", message: "tsc: 3 errors" }],
  };
  const post: Handler = (path) =>
    path === "/tasks" ? ok({ task_id: "t", run_id: "r" }) : ok({ ok: true });
  const get: Handler = () => ok<RunDetail>(detail);
  const fakeNow = mkClock();
  const { http } = mockHttp({ get, post });
  const row = await runScenarioOnce({
    http,
    scenarioId: "s5",
    prompt: "fix it",
    repoPath: "/r",
    timeoutMs: 60_000,
    pollIntervalMs: 1000,
    now: fakeNow.now,
    sleep: fakeNow.sleep,
    sourceRepoGuard: cleanRepoGuard,
  });
  assert.equal(row.verdict, "FAIL");
  assert.equal(row.status, "VERIFIED_FAIL");
  assert.equal(row.phase, "verifying");
  assert.equal(row.classification, "FAIL");
  assert.equal(row.failureCode, "TYPECHECK_FAIL");
  assert.equal(row.failureRootCause, "missing import");
  assert.equal(row.narrative, "tsc reported 3 new errors");
  assert.deepEqual(row.errors, ["tsc: 3 errors"]);
  assert.equal(row.timedOut, false);
  assert.equal(row.fetchError, null);
  // status_ alias must mirror verdict so the existing TUI parser still works.
  assert.equal(row.status_, row.verdict);
});

// ─── Config helper ───────────────────────────────────────────────────

test("resolveTimeoutMs: env override wins, garbage falls back", () => {
  assert.equal(resolveTimeoutMs(undefined, 900_000), 900_000);
  assert.equal(resolveTimeoutMs("600000", 900_000), 600_000);
  assert.equal(resolveTimeoutMs("not-a-number", 900_000), 900_000);
  assert.equal(resolveTimeoutMs("0", 900_000), 900_000);
  assert.equal(resolveTimeoutMs("-50", 900_000), 900_000);
});

// ─── filterScenarios ─────────────────────────────────────────────

const SAMPLE_SCENARIOS = [
  { id: "s-01", prompt: "a" },
  { id: "s-02", prompt: "b" },
  { id: "s-03", prompt: "c" },
] as const;

test("filterScenarios: exact --scenario runs one scenario", () => {
  const result = filterScenarios(SAMPLE_SCENARIOS, ["node", "test.ts", "--scenario", "s-02"]);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "s-02");
});

test("filterScenarios: unknown scenario exits nonzero", () => {
  const origExit = process.exit;
  let exitCode: number | undefined;
  process.exit = ((code: number) => { exitCode = code; throw new Error("exit"); }) as never;
  try {
    filterScenarios(SAMPLE_SCENARIOS, ["node", "test.ts", "--scenario", "nope"]);
    assert.fail("should have called process.exit");
  } catch (e) {
    assert.equal((e as Error).message, "exit");
    assert.equal(exitCode, 1);
  } finally {
    process.exit = origExit;
  }
});

test("filterScenarios: no --scenario flag returns all scenarios", () => {
  const result = filterScenarios(SAMPLE_SCENARIOS, ["node", "test.ts"]);
  assert.equal(result.length, SAMPLE_SCENARIOS.length);
});

// ─── safePad / safeStr never throw ───────────────────────────────────

test("safePad never throws on undefined/null/number", () => {
  assert.equal(safePad(undefined, 10), "—         ");
  assert.equal(safePad(null, 10), "—         ");
  assert.equal(safePad(42, 10), "42        ");
  assert.equal(safePad("PASS", 10), "PASS      ");
});

test("safeStr returns fallback for null/undefined", () => {
  assert.equal(safeStr(undefined), "—");
  assert.equal(safeStr(null, "n/a"), "n/a");
  assert.equal(safeStr("hello"), "hello");
  assert.equal(safeStr(0), "0");
});

// ─── parseJsonlRows — defensive JSONL parsing ───────────────────────

test("parseJsonlRows: skips malformed lines without crashing", () => {
  const text = [
    '{"scenarioId":"s1","verdict":"PASS","costUsd":0.05,"durationMs":1000}',
    "this is not json",
    '{"broken',
    "",
    '{"scenarioId":"s2","verdict":"FAIL","costUsd":0.10,"durationMs":2000}',
  ].join("\n");
  const { rows, parseErrors } = parseJsonlRows(text);
  assert.equal(rows.length, 2);
  assert.equal(parseErrors, 2);
  assert.equal(rows[0].scenarioId, "s1");
  assert.equal(rows[1].scenarioId, "s2");
});

test("parseJsonlRows: empty text returns empty rows, zero errors", () => {
  const { rows, parseErrors } = parseJsonlRows("");
  assert.equal(rows.length, 0);
  assert.equal(parseErrors, 0);
});

// ─── normaliseBurnRow — missing fields get safe defaults ─────────────

test("normaliseBurnRow: missing fields get safe defaults", () => {
  const row = normaliseBurnRow({});
  assert.equal(row.scenarioId, "unknown");
  assert.equal(row.verdict, "ERROR");
  assert.equal(row.costUsd, 0);
  assert.equal(row.durationMs, 0);
  assert.equal(row.filesChanged, 0);
  assert.equal(row.status, null);
  assert.equal(row.classification, null);
  assert.deepEqual(row.errors, []);
  assert.deepEqual(row.notes, []);
});

test("normaliseBurnRow: preserves valid fields", () => {
  const row = normaliseBurnRow({
    scenarioId: "s1",
    verdict: "PASS",
    costUsd: 0.05,
    durationMs: 3000,
    filesChanged: 2,
    status: "PROMOTED",
    classification: "SUCCESS",
    notes: ["note1"],
    errors: ["err1"],
  });
  assert.equal(row.scenarioId, "s1");
  assert.equal(row.verdict, "PASS");
  assert.equal(row.costUsd, 0.05);
  assert.equal(row.durationMs, 3000);
  assert.equal(row.filesChanged, 2);
  assert.equal(row.status, "PROMOTED");
  assert.deepEqual(row.notes, ["note1"]);
});

// ─── computeSummary + formatSummaryBlock ─────────────────────────────

test("computeSummary: counts are correct", () => {
  const rows: BurnResultRow[] = [
    normaliseBurnRow({ verdict: "PASS", costUsd: 0.10, durationMs: 5000 }),
    normaliseBurnRow({ verdict: "PASS", costUsd: 0.20, durationMs: 3000 }),
    normaliseBurnRow({ verdict: "FAIL", costUsd: 0.05, durationMs: 2000 }),
    normaliseBurnRow({ verdict: "SAFE_FAILURE", costUsd: 0, durationMs: 1000 }),
    normaliseBurnRow({ verdict: "TIMEOUT", costUsd: 0.15, durationMs: 900000 }),
    normaliseBurnRow({ verdict: "ERROR", costUsd: 0, durationMs: 500 }),
  ];
  const s = computeSummary(rows, 1);
  assert.equal(s.total, 6);
  assert.equal(s.pass, 2);
  assert.equal(s.fail, 1);
  assert.equal(s.safeFail, 1);
  assert.equal(s.timeout, 1);
  assert.equal(s.error, 1);
  assert.equal(s.parseErrors, 1);
  assert.ok(s.avgCostUsd > 0);
  assert.ok(s.avgDurationSec > 0);
});

test("formatSummaryBlock: contains expected labels", () => {
  const s = computeSummary([
    normaliseBurnRow({ verdict: "PASS", costUsd: 0.10, durationMs: 5000 }),
  ]);
  const block = formatSummaryBlock(s);
  assert.match(block, /Total:\s+1 scenarios/);
  assert.match(block, /PASS:\s+1/);
  assert.match(block, /Avg cost:/);
  assert.match(block, /Avg duration:/);
});

// ─── filterByInvocation ──────────────────────────────────────────────

test("filterByInvocation: explicit id returns only matching rows", () => {
  const rows: BurnResultRow[] = [
    normaliseBurnRow({ scenarioId: "s1", invocationId: "inv-a" }),
    normaliseBurnRow({ scenarioId: "s2", invocationId: "inv-b" }),
    normaliseBurnRow({ scenarioId: "s3", invocationId: "inv-a" }),
  ];
  const filtered = filterByInvocation(rows, "inv-a");
  assert.equal(filtered.length, 2);
  assert.deepEqual(filtered.map((r) => r.scenarioId), ["s1", "s3"]);
});

test("filterByInvocation: no id returns latest invocation (last seen)", () => {
  const rows: BurnResultRow[] = [
    normaliseBurnRow({ scenarioId: "s1", invocationId: "inv-old" }),
    normaliseBurnRow({ scenarioId: "s2", invocationId: "inv-old" }),
    normaliseBurnRow({ scenarioId: "s3", invocationId: "inv-new" }),
    normaliseBurnRow({ scenarioId: "s4", invocationId: "inv-new" }),
  ];
  const filtered = filterByInvocation(rows);
  assert.equal(filtered.length, 2);
  assert.deepEqual(filtered.map((r) => r.scenarioId), ["s3", "s4"]);
});

test("filterByInvocation: single scenario with --scenario shows Total: 1", () => {
  const rows: BurnResultRow[] = [
    normaliseBurnRow({ scenarioId: "s1", invocationId: "inv-single" }),
  ];
  const filtered = filterByInvocation(rows, "inv-single");
  assert.equal(filtered.length, 1);
  const summary = computeSummary(filtered);
  assert.equal(summary.total, 1);
});

test("filterByInvocation: no invocationId on any row returns all rows", () => {
  const rows: BurnResultRow[] = [
    normaliseBurnRow({ scenarioId: "s1" }),
    normaliseBurnRow({ scenarioId: "s2" }),
  ];
  const filtered = filterByInvocation(rows);
  assert.equal(filtered.length, 2);
});

test("filterByInvocation: mixed rows with/without invocationId filters by latest id", () => {
  const rows: BurnResultRow[] = [
    normaliseBurnRow({ scenarioId: "legacy-1" }),
    normaliseBurnRow({ scenarioId: "s1", invocationId: "inv-1" }),
    normaliseBurnRow({ scenarioId: "s2", invocationId: "inv-1" }),
  ];
  const filtered = filterByInvocation(rows);
  assert.equal(filtered.length, 2);
  assert.deepEqual(filtered.map((r) => r.scenarioId), ["s1", "s2"]);
});

// ─── Adaptive polling ────────────────────────────────────────────────

test("pollUntilTerminal: uses shorter interval once cost > 0 (adaptive polling)", async () => {
  let pollCount = 0;
  const sleepDurations: number[] = [];
  const clock = mkClock();

  const { http } = mockHttp({
    get: () => {
      pollCount++;
      if (pollCount <= 2) {
        // First 2 polls: no cost, no files — should use default 5000ms
        return {
          ok: true, status: 200,
          body: { status: "RUNNING", totalCostUsd: 0, filesChanged: [] } as unknown as RunDetail,
        };
      }
      if (pollCount <= 4) {
        // Polls 3-4: cost tracked — should use adaptive 2000ms
        return {
          ok: true, status: 200,
          body: { status: "RUNNING", totalCostUsd: 0.01, filesChanged: [] } as unknown as RunDetail,
        };
      }
      // Poll 5: terminal
      return {
        ok: true, status: 200,
        body: { status: "PROMOTED", totalCostUsd: 0.02 } as unknown as RunDetail,
      };
    },
  });

  const result = await pollUntilTerminal({
    http,
    runId: "test-run",
    timeoutMs: 300_000,
    pollIntervalMs: 5000,
    now: clock.now,
    sleep: async (ms) => {
      sleepDurations.push(ms);
      await clock.sleep(ms);
    },
  });

  assert.equal(result.timedOut, false);
  assert.equal(pollCount, 5);
  // First 2 sleeps should be 5000ms (no cost/files yet)
  assert.equal(sleepDurations[0], 5000, "pre-cost poll should use default interval");
  assert.equal(sleepDurations[1], 5000, "pre-cost poll should use default interval");
  // Sleeps 3-4 should be 2000ms (cost tracked → adaptive)
  assert.equal(sleepDurations[2], 2000, "post-cost poll should use adaptive 2000ms");
  assert.equal(sleepDurations[3], 2000, "post-cost poll should use adaptive 2000ms");
});

test("pollUntilTerminal: uses shorter interval once filesChanged > 0 (adaptive polling)", async () => {
  let pollCount = 0;
  const sleepDurations: number[] = [];
  const clock = mkClock();

  const { http } = mockHttp({
    get: () => {
      pollCount++;
      if (pollCount === 1) {
        return {
          ok: true, status: 200,
          body: { status: "RUNNING", totalCostUsd: 0 } as unknown as RunDetail,
        };
      }
      if (pollCount === 2) {
        return {
          ok: true, status: 200,
          body: {
            status: "RUNNING", totalCostUsd: 0,
            summary: { changes: [{ path: "test.ts" }] },
          } as unknown as RunDetail,
        };
      }
      return {
        ok: true, status: 200,
        body: { status: "PROMOTED" } as unknown as RunDetail,
      };
    },
  });

  const result = await pollUntilTerminal({
    http,
    runId: "test-run",
    timeoutMs: 300_000,
    pollIntervalMs: 5000,
    now: clock.now,
    sleep: async (ms) => {
      sleepDurations.push(ms);
      await clock.sleep(ms);
    },
  });

  assert.equal(result.timedOut, false);
  assert.equal(sleepDurations[0], 5000, "pre-files poll uses default");
  assert.equal(sleepDurations[1], 2000, "post-files poll uses adaptive 2000ms");
});

// ─── Helpers ─────────────────────────────────────────────────────────

function mkClock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let t = 1_700_000_000_000;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}
