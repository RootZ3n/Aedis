import test from "node:test";
import assert from "node:assert/strict";

import {
  type BurnHttpClient,
  type JsonResponse,
  type RunDetail,
  classifyOutcome,
  filterScenarios,
  formatProgressLine,
  isTerminal,
  pollUntilTerminal,
  resolveTimeoutMs,
  runScenarioOnce,
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

test("classifyOutcome: READY_FOR_PROMOTION → PENDING_APPROVAL with cleanup=cancel", () => {
  const o = classifyOutcome({ status: "READY_FOR_PROMOTION" });
  assert.equal(o.verdict, "PENDING_APPROVAL");
  assert.equal(o.cleanup, "cancel");
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

test("classifyOutcome: PROMOTED / VERIFIED_PASS / COMPLETE → PASS", () => {
  for (const status of ["PROMOTED", "VERIFIED_PASS", "COMPLETE", "COMPLETED"] as const) {
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
  const get: Handler = () => {
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
  });
  assert.equal(row.verdict, "PENDING_APPROVAL");
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
  const get: Handler = () => {
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
});

test("runScenarioOnce: never auto-approves — no POST to /approvals/:runId/approve", async () => {
  let polls = 0;
  const post: Handler = (path) => {
    if (path === "/tasks") return ok({ task_id: "t", run_id: "r" });
    return ok({ ok: true });
  };
  const get: Handler = () => {
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
