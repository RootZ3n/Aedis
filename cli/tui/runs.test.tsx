import test from "node:test";
import assert from "node:assert/strict";
import { render } from "ink-testing-library";

import {
  RunsScreen,
  filterRuns,
  isApprovableStatus,
  isTerminalStatus,
} from "./screens/runs.js";
import type { RunListEntry, SubmitResponse } from "./api.js";

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const RUN_DEFAULTS = {
  status: "EXECUTING_IN_WORKSPACE",
  classification: null,
  prompt: "task",
  summary: "",
  costUsd: 0,
  confidence: 0,
  timestamp: "2026-04-26T00:00:00.000Z",
  completedAt: null,
} as const;

function mkRun(over: { runId: string } & Partial<RunListEntry>): RunListEntry {
  return { id: over.runId, ...RUN_DEFAULTS, ...over };
}

interface MockApi {
  listRuns: (limit?: number) => Promise<RunListEntry[]>;
  submitRun: (prompt: string, repoPath: string) => Promise<SubmitResponse>;
  approveRun: (runId: string) => Promise<unknown>;
  rejectRun: (runId: string) => Promise<unknown>;
  getRuntimePolicy: () => Promise<import("./api.js").RuntimePolicySummary | null>;
  getServerHealth: () => Promise<import("./api.js").ServerHealth | null>;
}

function staticApi(runs: readonly RunListEntry[]): MockApi {
  return {
    listRuns: async () => [...runs],
    submitRun: async () => ({ run_id: "sub-1234", status: "running" }),
    approveRun: async () => ({ ok: true }),
    rejectRun: async () => ({ ok: true }),
    getRuntimePolicy: async () => null,
    getServerHealth: async () => null,
  };
}

// ─── Smoke / structural ──────────────────────────────────────────────

test("tui runs: dashboard renders heading and footer hints on first frame", () => {
  const { lastFrame, unmount } = render(
    <RunsScreen api={staticApi([])} pollMs={99_999} />,
  );
  try {
    const frame = lastFrame() ?? "";
    assert.match(frame, /Aedis TUI/);
    assert.match(frame, /Runs Dashboard/);
    assert.match(frame, /\[s\] submit/);
    assert.match(frame, /Mode: dashboard/);
  } finally {
    unmount();
  }
});

// ─── Submit mode ─────────────────────────────────────────────────────

test("tui runs: pressing [s] visibly switches to submit mode with input box", async () => {
  const { stdin, lastFrame, unmount } = render(
    <RunsScreen api={staticApi([])} pollMs={99_999} />,
  );
  try {
    await wait(40);
    stdin.write("s");
    await wait(40);
    const frame = lastFrame() ?? "";
    assert.match(frame, /Submit task/, "submit input header must render");
    assert.match(frame, /\[enter\] send/, "submit-mode hints must render");
    assert.match(frame, /Mode: submit/, "footer must reflect mode change");
  } finally {
    unmount();
  }
});

test("tui runs: typing then [enter] submits the prompt and clears input", async () => {
  let submittedPrompt: string | null = null;
  const api: MockApi = {
    ...staticApi([]),
    submitRun: async (prompt: string) => {
      submittedPrompt = prompt;
      return { run_id: "abc12345", status: "running" };
    },
  };
  const { stdin, lastFrame, unmount } = render(
    <RunsScreen api={api} pollMs={99_999} />,
  );
  try {
    await wait(40);
    stdin.write("s");
    await wait(40);
    stdin.write("hello world");
    await wait(40);
    stdin.write("\r"); // Enter
    await wait(80);
    assert.equal(submittedPrompt, "hello world", "submitRun must receive the typed prompt");
    const frame = lastFrame() ?? "";
    assert.match(frame, /submitted: run=abc12345/, "success message must surface");
    assert.match(frame, /Mode: dashboard/, "submit mode must close after enter");
    assert.doesNotMatch(frame, /Submit task/, "submit panel must be hidden");
  } finally {
    unmount();
  }
});

test("tui runs: [esc] in submit mode cancels and clears input", async () => {
  const { stdin, lastFrame, unmount } = render(
    <RunsScreen api={staticApi([])} pollMs={99_999} />,
  );
  try {
    await wait(40);
    stdin.write("s");
    await wait(40);
    stdin.write("partial");
    await wait(40);
    stdin.write("\x1b"); // ESC
    await wait(40);
    const frame = lastFrame() ?? "";
    assert.match(frame, /submit cancelled/);
    assert.match(frame, /Mode: dashboard/);
    assert.doesNotMatch(frame, /Submit task/);
  } finally {
    unmount();
  }
});

// ─── Approve / reject feedback ───────────────────────────────────────

test("tui runs: [a] on a terminal run shows 'No pending approval' and does NOT call API", async () => {
  let approveCalls = 0;
  const api: MockApi = {
    ...staticApi([mkRun({ runId: "term-001", status: "PROMOTED" })]),
    approveRun: async () => {
      approveCalls += 1;
      return { ok: true };
    },
  };
  const { stdin, lastFrame, unmount } = render(
    <RunsScreen api={api} pollMs={99_999} />,
  );
  try {
    await wait(40);
    stdin.write("a");
    await wait(40);
    const frame = lastFrame() ?? "";
    assert.match(frame, /No pending approval/);
    assert.match(frame, /status=PROMOTED/);
    assert.equal(approveCalls, 0, "approveRun must NOT be called for a terminal run");
  } finally {
    unmount();
  }
});

test("tui runs: [r] on a terminal run shows 'No pending approval' and does NOT call API", async () => {
  let rejectCalls = 0;
  const api: MockApi = {
    ...staticApi([mkRun({ runId: "term-002", status: "REJECTED" })]),
    rejectRun: async () => {
      rejectCalls += 1;
      return { ok: true };
    },
  };
  const { stdin, lastFrame, unmount } = render(
    <RunsScreen api={api} pollMs={99_999} />,
  );
  try {
    await wait(40);
    stdin.write("r");
    await wait(40);
    const frame = lastFrame() ?? "";
    assert.match(frame, /No pending approval/);
    assert.equal(rejectCalls, 0, "rejectRun must NOT be called for a terminal run");
  } finally {
    unmount();
  }
});

test("tui runs: [a] on AWAITING_APPROVAL run calls API and surfaces 'Approved'", async () => {
  let approvedRunId: string | null = null;
  const api: MockApi = {
    ...staticApi([mkRun({ runId: "pending1", status: "AWAITING_APPROVAL" })]),
    approveRun: async (runId: string) => {
      approvedRunId = runId;
      return { ok: true };
    },
  };
  const { stdin, lastFrame, unmount } = render(
    <RunsScreen api={api} pollMs={99_999} />,
  );
  try {
    await wait(40);
    stdin.write("a");
    await wait(80);
    assert.equal(approvedRunId, "pending1");
    const frame = lastFrame() ?? "";
    assert.match(frame, /Approved pending1/);
  } finally {
    unmount();
  }
});

test("tui runs: server-side {ok:false} on reject is surfaced as an error", async () => {
  const api: MockApi = {
    ...staticApi([mkRun({ runId: "pending2", status: "AWAITING_APPROVAL" })]),
    rejectRun: async () => ({ ok: false, error: "No pending approval for run pending2" }),
  };
  const { stdin, lastFrame, unmount } = render(
    <RunsScreen api={api} pollMs={99_999} />,
  );
  try {
    await wait(40);
    stdin.write("r");
    await wait(60);
    const frame = lastFrame() ?? "";
    assert.match(frame, /reject failed: No pending approval/);
  } finally {
    unmount();
  }
});

// ─── Terminal-history filter ─────────────────────────────────────────

test("filterRuns: hides terminal beyond limit by default; toggle exposes all", () => {
  const runs: RunListEntry[] = [
    mkRun({ runId: "live-1", status: "EXECUTING_IN_WORKSPACE" }),
    ...Array.from({ length: 12 }, (_, i) =>
      mkRun({ runId: `term-${i}`, status: "PROMOTED" }),
    ),
  ];
  const filtered = filterRuns(runs, false, 10);
  assert.equal(filtered.length, 11, "should keep live + first 10 terminal");
  assert.equal(filtered[0].runId, "live-1");
  const all = filterRuns(runs, true, 10);
  assert.equal(all.length, 13, "history-on returns everything");
});

test("tui runs: [t] toggles terminal-history visibility", async () => {
  const runs = [
    mkRun({ runId: "live-1", status: "EXECUTING_IN_WORKSPACE" }),
    ...Array.from({ length: 12 }, (_, i) =>
      mkRun({ runId: `t${i}`, status: "PROMOTED" }),
    ),
  ];
  const { stdin, lastFrame, unmount } = render(
    <RunsScreen api={staticApi(runs)} pollMs={99_999} />,
  );
  try {
    await wait(40);
    let frame = lastFrame() ?? "";
    assert.match(frame, /Showing 11 of 13/, "default: live + 10 terminal of 13 total");
    stdin.write("t");
    await wait(40);
    frame = lastFrame() ?? "";
    assert.match(frame, /Showing 13 of 13/, "history-on: all 13 visible");
    assert.match(frame, /showing all runs/);
  } finally {
    unmount();
  }
});

// ─── Selection bounds ────────────────────────────────────────────────

test("tui runs: selection is clamped when the visible list shrinks", async () => {
  let calls = 0;
  const longList = [
    mkRun({ runId: "run-1", status: "EXECUTING_IN_WORKSPACE" }),
    mkRun({ runId: "run-2", status: "EXECUTING_IN_WORKSPACE" }),
    mkRun({ runId: "run-3", status: "EXECUTING_IN_WORKSPACE" }),
  ];
  const shortList = [longList[0]];
  const api: MockApi = {
    listRuns: async () => {
      calls += 1;
      return calls === 1 ? longList : shortList;
    },
    submitRun: async () => ({ run_id: "x" }),
    approveRun: async () => ({ ok: true }),
    rejectRun: async () => ({ ok: true }),
    getRuntimePolicy: async () => null,
    getServerHealth: async () => null,
  };
  const { stdin, lastFrame, unmount } = render(
    <RunsScreen api={api} pollMs={300} />,
  );
  try {
    await wait(40); // first tick already fired during mount
    // Move selection past row 0 while long list is still visible.
    stdin.write("j");
    stdin.write("j");
    await wait(40);
    let frame = lastFrame() ?? "";
    assert.match(frame, /run-3/, "longer list should be visible before shrink");
    // Next poll runs at ~300ms; wait past it for the shrink + clamp.
    await wait(360);
    frame = lastFrame() ?? "";
    assert.match(frame, /run-1/, "remaining run is visible");
    assert.doesNotMatch(frame, /run-2/, "run-2 must be filtered out");
    assert.doesNotMatch(frame, /run-3/, "run-3 must be filtered out");
    assert.match(frame, /Showing 1 of 1/);
    assert.match(frame, /▶/, "selection marker must still render (clamped to row 0)");
  } finally {
    unmount();
  }
});

// ─── Pure helpers ────────────────────────────────────────────────────

test("isTerminalStatus / isApprovableStatus are wired to the right enum members", () => {
  assert.equal(isApprovableStatus("AWAITING_APPROVAL"), true);
  assert.equal(isApprovableStatus("EXECUTING_IN_WORKSPACE"), false);
  assert.equal(isApprovableStatus("PROMOTED"), false);
  assert.equal(isTerminalStatus("PROMOTED"), true);
  assert.equal(isTerminalStatus("REJECTED"), true);
  assert.equal(isTerminalStatus("EXECUTING_IN_WORKSPACE"), false);
  assert.equal(isTerminalStatus("AWAITING_APPROVAL"), false);
});

// ─── Runtime safety policy panel ─────────────────────────────────────
//
// The dashboard shows an at-a-glance summary of what the running
// server is allowed to do. Without this row the operator can't tell
// whether they're about to auto-promote, whether approval is in the
// loop, or which lane mode is in effect.

test("tui runs: policy panel renders the safe-default values from /health", async () => {
  const safe = {
    autoPromote: false,
    approvalRequired: true,
    destructiveOps: "blocked" as const,
    laneMode: "primary_only",
    shadowPromoteAllowed: false,
    requireWorkspace: true,
  };
  const api: MockApi = {
    listRuns: async () => [],
    submitRun: async () => ({ run_id: "x" }),
    approveRun: async () => ({ ok: true }),
    rejectRun: async () => ({ ok: true }),
    getRuntimePolicy: async () => safe,
    getServerHealth: async () => null,
  };
  const { lastFrame, unmount } = render(
    <RunsScreen api={api} pollMs={99_999} />,
  );
  try {
    await wait(40);
    const frame = lastFrame() ?? "";
    assert.match(frame, /policy:/, "policy line must render");
    assert.match(frame, /autoPromote=off/);
    assert.match(frame, /approval=required/);
    assert.match(frame, /destructive=blocked/);
    assert.match(frame, /lane=primary_only/);
    assert.match(frame, /shadowPromote=blocked/);
  } finally {
    unmount();
  }
});

test("tui runs: policy panel surfaces an unsafe config so the operator sees it", async () => {
  const unsafe = {
    autoPromote: true,
    approvalRequired: false,
    destructiveOps: "allowed" as const,
    laneMode: "local_then_cloud",
    shadowPromoteAllowed: false,
    requireWorkspace: true,
  };
  const api: MockApi = {
    listRuns: async () => [],
    submitRun: async () => ({ run_id: "x" }),
    approveRun: async () => ({ ok: true }),
    rejectRun: async () => ({ ok: true }),
    getRuntimePolicy: async () => unsafe,
    getServerHealth: async () => null,
  };
  const { lastFrame, unmount } = render(
    <RunsScreen api={api} pollMs={99_999} />,
  );
  try {
    await wait(40);
    const frame = lastFrame() ?? "";
    assert.match(frame, /autoPromote=on/);
    assert.match(frame, /approval=skipped/);
    assert.match(frame, /destructive=allowed/);
    assert.match(frame, /lane=local_then_cloud/);
  } finally {
    unmount();
  }
});

test("tui runs: policy panel falls back to 'unknown' when /health is unreachable", async () => {
  const api: MockApi = {
    listRuns: async () => [],
    submitRun: async () => ({ run_id: "x" }),
    approveRun: async () => ({ ok: true }),
    rejectRun: async () => ({ ok: true }),
    getRuntimePolicy: async () => null,
    getServerHealth: async () => null,
  };
  const { lastFrame, unmount } = render(
    <RunsScreen api={api} pollMs={99_999} />,
  );
  try {
    await wait(40);
    const frame = lastFrame() ?? "";
    assert.match(frame, /policy:/);
    assert.match(frame, /unknown/);
  } finally {
    unmount();
  }
});

// ─── Stale-server banner ────────────────────────────────────────────

test("tui runs: stale banner renders when server has no commit metadata", async () => {
  const api: MockApi = {
    listRuns: async () => [],
    submitRun: async () => ({ run_id: "x" }),
    approveRun: async () => ({ ok: true }),
    rejectRun: async () => ({ ok: true }),
    getRuntimePolicy: async () => null,
    getServerHealth: async () => ({ build: {} }),
  };
  const { lastFrame, unmount } = render(
    <RunsScreen api={api} pollMs={99_999} />,
  );
  try {
    await wait(40);
    const frame = lastFrame() ?? "";
    assert.match(frame, /STALE SERVER/);
    assert.match(frame, /no build metadata/);
  } finally {
    unmount();
  }
});

test("tui runs: stale banner renders when server is running from non-build-info source", async () => {
  const api: MockApi = {
    listRuns: async () => [],
    submitRun: async () => ({ run_id: "x" }),
    approveRun: async () => ({ ok: true }),
    rejectRun: async () => ({ ok: true }),
    getRuntimePolicy: async () => null,
    getServerHealth: async () => ({
      build: {
        commit: "abc12345",
        commitShort: "abc12345",
        source: "git-runtime",
      },
    }),
  };
  const { lastFrame, unmount } = render(
    <RunsScreen api={api} pollMs={99_999} />,
  );
  try {
    await wait(40);
    const frame = lastFrame() ?? "";
    assert.match(frame, /STALE SERVER/);
    assert.match(frame, /git-runtime/);
  } finally {
    unmount();
  }
});

test("tui runs: NO stale banner when server reports a clean built dist", async () => {
  const api: MockApi = {
    listRuns: async () => [],
    submitRun: async () => ({ run_id: "x" }),
    approveRun: async () => ({ ok: true }),
    rejectRun: async () => ({ ok: true }),
    getRuntimePolicy: async () => null,
    getServerHealth: async () => ({
      build: {
        commit: "abc12345",
        commitShort: "abc12345",
        source: "build-info",
      },
    }),
  };
  const { lastFrame, unmount } = render(
    <RunsScreen api={api} pollMs={99_999} />,
  );
  try {
    await wait(40);
    const frame = lastFrame() ?? "";
    assert.doesNotMatch(frame, /STALE SERVER/);
  } finally {
    unmount();
  }
});

// deriveTuiStaleness pure-function tests
test("deriveTuiStaleness: null health returns null", async () => {
  const { deriveTuiStaleness } = await import("./api.js");
  assert.equal(deriveTuiStaleness(null), null);
});

test("deriveTuiStaleness: missing commit fires", async () => {
  const { deriveTuiStaleness } = await import("./api.js");
  const r = deriveTuiStaleness({ build: {} });
  assert.ok(r);
  assert.match(r.reason, /no build metadata/);
});

test("deriveTuiStaleness: 'unknown' commit also fires", async () => {
  const { deriveTuiStaleness } = await import("./api.js");
  const r = deriveTuiStaleness({ build: { commit: "unknown" } });
  assert.ok(r);
  assert.match(r.reason, /no build metadata/);
});

test("deriveTuiStaleness: build-info source with commit returns null (clean)", async () => {
  const { deriveTuiStaleness } = await import("./api.js");
  const r = deriveTuiStaleness({
    build: { commit: "abc123", source: "build-info" },
  });
  assert.equal(r, null);
});
