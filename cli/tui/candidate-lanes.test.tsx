/**
 * Phase C — TUI candidate lane visibility.
 *
 * Tests cover the formatLaneIndicator pure helper, the dashboard
 * row's lane tag, and the run-detail "Candidate Lanes" panel
 * (selection marker, disqualification reason, empty state, [c]
 * toggle behavior). Existing run-detail tests assert that the
 * other panel toggles ([d]/[v]/[e]) keep working — no need to
 * re-pin those here.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { render } from "ink-testing-library";

import { RunsScreen, formatLaneIndicator } from "./screens/runs.js";
import { RunDetailScreen } from "./screens/run-detail.js";
import type { CandidateManifestRow, RunDetailData, RunListEntry, SubmitResponse } from "./api.js";

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ─── Fixtures ────────────────────────────────────────────────────────

const RUN_DEFAULTS = {
  status: "AWAITING_APPROVAL",
  classification: "VERIFIED_PASS" as string | null,
  prompt: "modify widget",
  summary: "",
  costUsd: 0,
  confidence: 0.9,
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
}

function staticApi(runs: readonly RunListEntry[]): MockApi {
  return {
    listRuns: async () => [...runs],
    submitRun: async () => ({ run_id: "sub", status: "running" }),
    approveRun: async () => ({ ok: true }),
    rejectRun: async () => ({ ok: true }),
    getRuntimePolicy: async () => null,
  };
}

const PRIMARY_PASSED: CandidateManifestRow = {
  workspaceId: "primary",
  role: "primary",
  lane: "local",
  provider: "ollama",
  model: "qwen3.5:9b",
  status: "passed",
  disqualification: null,
  costUsd: 0,
  latencyMs: 100,
  verifierVerdict: "pass",
  reason: "merge approved",
  criticalFindings: 0,
  advisoryFindings: 1,
  testsPassed: true,
  typecheckPassed: true,
};
const PRIMARY_FAILED: CandidateManifestRow = {
  ...PRIMARY_PASSED,
  status: "failed",
  disqualification: "status=failed",
  reason: "tests failed",
  verifierVerdict: "fail",
  testsPassed: false,
};
const SHADOW_PASSED: CandidateManifestRow = {
  workspaceId: "shadow-1",
  role: "shadow",
  lane: "cloud",
  provider: "openrouter",
  model: "xiaomi/mimo-v2.5",
  status: "passed",
  disqualification: null,
  costUsd: 0.012,
  latencyMs: 8000,
  verifierVerdict: "pass-with-warnings",
  reason: "shadow builder produced changes",
  criticalFindings: 0,
  advisoryFindings: 0,
};

function mkDetail(over: Partial<RunDetailData> = {}): RunDetailData {
  return {
    id: "run-abc123",
    runId: "run-abc123",
    status: "AWAITING_APPROVAL",
    prompt: "modify widget",
    submittedAt: "2026-04-27T10:00:00.000Z",
    completedAt: "2026-04-27T10:00:42.000Z",
    filesChanged: [{ path: "core/widget.ts", operation: "modify" }],
    summary: {
      classification: "VERIFIED_PASS",
      headline: "ok",
      narrative: "",
      verification: "pass",
      verificationChecks: [],
      failureExplanation: null,
    },
    confidence: 0.9,
    errors: [],
    totalCostUsd: 0,
    ...over,
  };
}

// ─── formatLaneIndicator ─────────────────────────────────────────────

test("formatLaneIndicator returns null when laneMode is missing or primary_only", () => {
  assert.equal(formatLaneIndicator(mkRun({ runId: "r-1" })), null);
  assert.equal(formatLaneIndicator(mkRun({ runId: "r-2", laneMode: "primary_only" })), null);
});

test("formatLaneIndicator renders the local_then_cloud short-form with count + selection", () => {
  const tag = formatLaneIndicator(mkRun({
    runId: "r-3",
    laneMode: "local_then_cloud",
    candidatesCount: 2,
    selectedCandidateWorkspaceId: "shadow-1",
  }));
  assert.equal(tag, "[L→C 2c sel:shadow-1]");
});

test("formatLaneIndicator omits count when zero and omits selection when missing", () => {
  const tag = formatLaneIndicator(mkRun({
    runId: "r-4",
    laneMode: "local_then_cloud",
    candidatesCount: 0,
  }));
  assert.equal(tag, "[L→C]");
});

test("formatLaneIndicator handles future modes by passing them through", () => {
  const tag = formatLaneIndicator(mkRun({
    runId: "r-5",
    laneMode: "local_vs_cloud",
    candidatesCount: 2,
    selectedCandidateWorkspaceId: "primary",
  }));
  assert.equal(tag, "[L|C 2c sel:primary]");
});

// ─── Dashboard row indicator ─────────────────────────────────────────

test("tui runs dashboard: row shows lane indicator when candidate metadata exists", async () => {
  const runs = [
    mkRun({
      runId: "run-with-lanes",
      status: "AWAITING_APPROVAL",
      laneMode: "local_then_cloud",
      candidatesCount: 2,
      selectedCandidateWorkspaceId: "shadow-1",
    }),
  ];
  const { lastFrame, unmount } = render(
    <RunsScreen api={staticApi(runs)} pollMs={99_999} />,
  );
  try {
    await wait(40);
    const frame = lastFrame() ?? "";
    assert.match(frame, /\[L→C 2c sel:shadow-1\]/, "dashboard must render the lane indicator");
  } finally {
    unmount();
  }
});

test("tui runs dashboard: row without candidate metadata renders no lane indicator", async () => {
  const runs = [
    mkRun({ runId: "run-plain", status: "AWAITING_APPROVAL" }),
  ];
  const { lastFrame, unmount } = render(
    <RunsScreen api={staticApi(runs)} pollMs={99_999} />,
  );
  try {
    await wait(40);
    const frame = lastFrame() ?? "";
    // No square-bracketed L→C / L|C / C+L token should leak in.
    assert.doesNotMatch(frame, /\[L→C/);
    assert.doesNotMatch(frame, /\[L\|C/);
    assert.doesNotMatch(frame, /\[C\+L/);
  } finally {
    unmount();
  }
});

// ─── Run-detail Candidate Lanes panel ────────────────────────────────

test("tui run-detail: [c] reveals the Candidate Lanes panel with mode and selection", async () => {
  const detail = mkDetail({
    laneMode: "local_then_cloud",
    selectedCandidateWorkspaceId: "shadow-1",
    candidates: [PRIMARY_FAILED, SHADOW_PASSED],
  });
  const { stdin, lastFrame, unmount } = render(
    <RunDetailScreen runId="run-abc123" onBack={() => {}} getRunDetail={async () => detail} />,
  );
  try {
    await wait(60);
    stdin.write("c");
    await wait(40);
    const frame = lastFrame() ?? "";
    assert.match(frame, /Candidate Lanes/);
    assert.match(frame, /laneMode:\s+local_then_cloud/);
    assert.match(frame, /selectedCandidate:\s+shadow-1/);
    assert.match(frame, /Panel: candidates/);
  } finally {
    unmount();
  }
});

test("tui run-detail: candidate table shows role/lane/provider/model/status for each row", async () => {
  const detail = mkDetail({
    laneMode: "local_then_cloud",
    selectedCandidateWorkspaceId: "shadow-1",
    candidates: [PRIMARY_FAILED, SHADOW_PASSED],
  });
  const { stdin, lastFrame, unmount } = render(
    <RunDetailScreen runId="run-abc123" onBack={() => {}} getRunDetail={async () => detail} />,
  );
  try {
    await wait(60);
    stdin.write("c");
    await wait(40);
    const frame = lastFrame() ?? "";
    // Primary row
    assert.match(frame, /primary/);
    assert.match(frame, /local/);
    assert.match(frame, /ollama/);
    assert.match(frame, /qwen3\.5:9b/);
    // Shadow row
    assert.match(frame, /shadow/);
    assert.match(frame, /cloud/);
    assert.match(frame, /openrouter/);
    assert.match(frame, /xiaomi\/mimo-v2\.5/);
  } finally {
    unmount();
  }
});

test("tui run-detail: selected candidate is marked and labeled", async () => {
  const detail = mkDetail({
    laneMode: "local_then_cloud",
    selectedCandidateWorkspaceId: "shadow-1",
    candidates: [PRIMARY_FAILED, SHADOW_PASSED],
  });
  const { stdin, lastFrame, unmount } = render(
    <RunDetailScreen runId="run-abc123" onBack={() => {}} getRunDetail={async () => detail} />,
  );
  try {
    await wait(60);
    stdin.write("c");
    await wait(40);
    const frame = lastFrame() ?? "";
    // The ★ marker only appears next to the selected workspace.
    // The role/lane/provider rendering uses padded fields so the
    // line is `★ shadow  cloud openrouter  …`. Match on a single
    // line so the unrelated `selectedCandidate: shadow-1` header
    // (which doesn't carry ★) doesn't satisfy the assertion.
    const selectedLine = (frame.split("\n").find((l) => l.includes("★")) ?? "").trim();
    assert.ok(selectedLine.length > 0, "expected a row with ★ marker; frame had none");
    assert.match(selectedLine, /shadow/);
    assert.match(selectedLine, /cloud/);
    assert.match(selectedLine, /openrouter/);
    assert.match(frame, /selected/);
  } finally {
    unmount();
  }
});

test("tui run-detail: disqualified candidate renders the disqualification reason", async () => {
  const detail = mkDetail({
    laneMode: "local_then_cloud",
    selectedCandidateWorkspaceId: "shadow-1",
    candidates: [PRIMARY_FAILED, SHADOW_PASSED],
  });
  const { stdin, lastFrame, unmount } = render(
    <RunDetailScreen runId="run-abc123" onBack={() => {}} getRunDetail={async () => detail} />,
  );
  try {
    await wait(60);
    stdin.write("c");
    await wait(40);
    const frame = lastFrame() ?? "";
    assert.match(frame, /disqualified: status=failed/, "primary's disqualification reason must render");
    // The disqualification line should appear exactly once — for
    // the failing primary. The passing shadow must not produce a
    // second one. Counting matches sidesteps the layout-dependent
    // ordering between header lines and table rows.
    const matches = frame.match(/disqualified:/g) ?? [];
    assert.equal(matches.length, 1, `expected exactly one disqualification line; got ${matches.length}`);
  } finally {
    unmount();
  }
});

test("tui run-detail: empty candidates produces the empty-state message", async () => {
  const detail = mkDetail({}); // no laneMode / candidates
  const { stdin, lastFrame, unmount } = render(
    <RunDetailScreen runId="run-abc123" onBack={() => {}} getRunDetail={async () => detail} />,
  );
  try {
    await wait(60);
    stdin.write("c");
    await wait(40);
    const frame = lastFrame() ?? "";
    assert.match(frame, /Candidate Lanes/);
    assert.match(frame, /No candidate lane data for this run\./);
  } finally {
    unmount();
  }
});

test("tui run-detail: [c] toggles back to summary when pressed twice", async () => {
  const detail = mkDetail({
    laneMode: "local_then_cloud",
    candidates: [PRIMARY_PASSED],
    selectedCandidateWorkspaceId: "primary",
  });
  const { stdin, lastFrame, unmount } = render(
    <RunDetailScreen runId="run-abc123" onBack={() => {}} getRunDetail={async () => detail} />,
  );
  try {
    await wait(60);
    stdin.write("c");
    await wait(40);
    assert.match(lastFrame() ?? "", /Panel: candidates/);
    stdin.write("c");
    await wait(40);
    const frame = lastFrame() ?? "";
    assert.match(frame, /Panel: summary/, "second [c] press must close the panel");
    assert.doesNotMatch(frame, /Candidate Lanes/);
  } finally {
    unmount();
  }
});

test("tui run-detail: existing toggles still work alongside [c] (no regression)", async () => {
  const detail = mkDetail({
    laneMode: "local_then_cloud",
    candidates: [PRIMARY_PASSED],
    selectedCandidateWorkspaceId: "primary",
  });
  const { stdin, lastFrame, unmount } = render(
    <RunDetailScreen runId="run-abc123" onBack={() => {}} getRunDetail={async () => detail} />,
  );
  try {
    await wait(60);
    stdin.write("c");
    await wait(40);
    stdin.write("d");
    await wait(40);
    assert.match(lastFrame() ?? "", /Panel: diff/, "[d] must still switch to diff after [c] was used");
    stdin.write("v");
    await wait(40);
    assert.match(lastFrame() ?? "", /Panel: verifier/, "[v] must still switch to verifier");
  } finally {
    unmount();
  }
});

test("tui run-detail: footer help-bar lists [c] alongside the existing toggles", async () => {
  const detail = mkDetail();
  const { lastFrame, unmount } = render(
    <RunDetailScreen runId="run-abc123" onBack={() => {}} getRunDetail={async () => detail} />,
  );
  try {
    await wait(60);
    const frame = lastFrame() ?? "";
    assert.match(frame, /\[c\] candidate lanes/);
    assert.match(frame, /\[d\] diff/);
    assert.match(frame, /\[v\] verifier/);
    assert.match(frame, /\[e\] errors/);
  } finally {
    unmount();
  }
});
