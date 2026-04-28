import test from "node:test";
import assert from "node:assert/strict";
import { render } from "ink-testing-library";

import { RunDetailScreen } from "./screens/run-detail.js";
import type { RunDetailData } from "./api.js";

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function mkDetail(over: Partial<RunDetailData> = {}): RunDetailData {
  return {
    id: "run-abc123",
    runId: "run-abc123",
    status: "VERIFIED_PASS",
    prompt: "add feature x",
    submittedAt: "2026-04-26T10:00:00.000Z",
    completedAt: "2026-04-26T10:05:00.000Z",
    filesChanged: [
      { path: "src/index.ts", operation: "modify" },
      { path: "src/new.ts", operation: "create" },
    ],
    summary: {
      classification: "FULL_SUCCESS",
      headline: "Added feature x successfully",
      narrative: "Modified index and created new module.",
      verification: "pass",
      verificationChecks: [
        { kind: "typecheck", name: "tsc", executed: true, passed: true },
        { kind: "test", name: "vitest", executed: true, passed: false },
        { kind: "lint", name: "eslint", executed: false, passed: false },
      ],
      failureExplanation: null,
    },
    confidence: 0.92,
    errors: [],
    totalCostUsd: 0.1234,
    ...over,
  };
}

function mkFailedDetail(): RunDetailData {
  return mkDetail({
    status: "EXECUTION_ERROR",
    summary: {
      classification: "TOTAL_FAILURE",
      headline: "Build failed",
      narrative: "TypeScript errors prevented completion.",
      verification: "fail",
      verificationChecks: [
        { kind: "typecheck", name: "tsc", executed: true, passed: false },
      ],
      failureExplanation: {
        code: "ts-compile-error",
        rootCause: "Undefined variable referenced in handler",
        stage: "building",
        suggestedFix: "Check variable declarations in src/handler.ts",
      },
    },
    errors: [
      { source: "builder", message: "TS2304: Cannot find name 'foo'", suggestedFix: "Import foo from bar" },
      { source: "verifier", message: "typecheck failed" },
    ],
  });
}

// ─── Open detail / render summary ───────────────────────────────────

test("tui run-detail: renders summary fields after loading", async () => {
  const detail = mkDetail();
  const { lastFrame, unmount } = render(
    <RunDetailScreen
      runId="run-abc123"
      onBack={() => {}}
      getRunDetail={async () => detail}
    />,
  );
  try {
    await wait(60);
    const frame = lastFrame() ?? "";
    assert.match(frame, /Run Detail/);
    assert.match(frame, /run-abc123/);
    assert.match(frame, /VERIFIED_PASS/);
    assert.match(frame, /FULL_SUCCESS/);
    assert.match(frame, /\$0\.1234/);
    assert.match(frame, /5m/);
    assert.match(frame, /src\/index\.ts/);
    assert.match(frame, /src\/new\.ts/);
  } finally {
    unmount();
  }
});

test("tui run-detail: shows loading state before data arrives", async () => {
  let resolve: (d: RunDetailData) => void;
  const pending = new Promise<RunDetailData>((r) => { resolve = r; });
  const { lastFrame, unmount } = render(
    <RunDetailScreen
      runId="run-abc123"
      onBack={() => {}}
      getRunDetail={async () => pending}
    />,
  );
  try {
    await wait(40);
    const frame = lastFrame() ?? "";
    assert.match(frame, /Loading run-abc1/);
    resolve!(mkDetail());
  } finally {
    unmount();
  }
});

// ─── Render failure explanation ─────────────────────────────────────

test("tui run-detail: renders failure explanation when present", async () => {
  const detail = mkFailedDetail();
  const { lastFrame, unmount } = render(
    <RunDetailScreen
      runId="run-abc123"
      onBack={() => {}}
      getRunDetail={async () => detail}
    />,
  );
  try {
    await wait(60);
    const frame = lastFrame() ?? "";
    assert.match(frame, /Failure/);
    assert.match(frame, /ts-compile-error/);
    assert.match(frame, /building/);
    assert.match(frame, /Undefined variable/);
    assert.match(frame, /Check variable declarations/);
  } finally {
    unmount();
  }
});

test("tui run-detail: no failure section on successful run", async () => {
  const detail = mkDetail();
  const { lastFrame, unmount } = render(
    <RunDetailScreen
      runId="run-abc123"
      onBack={() => {}}
      getRunDetail={async () => detail}
    />,
  );
  try {
    await wait(60);
    const frame = lastFrame() ?? "";
    assert.doesNotMatch(frame, /Failure/);
    assert.doesNotMatch(frame, /rootCause/);
  } finally {
    unmount();
  }
});

// ─── Toggle panels ──────────────────────────────────────────────────

test("tui run-detail: [d] shows diff panel with file operations", async () => {
  const detail = mkDetail();
  const { stdin, lastFrame, unmount } = render(
    <RunDetailScreen
      runId="run-abc123"
      onBack={() => {}}
      getRunDetail={async () => detail}
    />,
  );
  try {
    await wait(60);
    stdin.write("d");
    await wait(40);
    const frame = lastFrame() ?? "";
    assert.match(frame, /Diff/);
    assert.match(frame, /modify.*src\/index\.ts/);
    assert.match(frame, /create.*src\/new\.ts/);
    assert.match(frame, /Panel: diff/);
  } finally {
    unmount();
  }
});

test("tui run-detail: [v] shows verifier stages with pass/fail", async () => {
  const detail = mkDetail();
  const { stdin, lastFrame, unmount } = render(
    <RunDetailScreen
      runId="run-abc123"
      onBack={() => {}}
      getRunDetail={async () => detail}
    />,
  );
  try {
    await wait(60);
    stdin.write("v");
    await wait(40);
    const frame = lastFrame() ?? "";
    assert.match(frame, /Verifier Stages/);
    assert.match(frame, /PASS.*typecheck/);
    assert.match(frame, /FAIL.*test/);
    assert.match(frame, /SKIP.*lint/);
    assert.match(frame, /Panel: verifier/);
  } finally {
    unmount();
  }
});

test("tui run-detail: [e] shows errors panel with suggested fixes", async () => {
  const detail = mkFailedDetail();
  const { stdin, lastFrame, unmount } = render(
    <RunDetailScreen
      runId="run-abc123"
      onBack={() => {}}
      getRunDetail={async () => detail}
    />,
  );
  try {
    await wait(60);
    stdin.write("e");
    await wait(40);
    const frame = lastFrame() ?? "";
    assert.match(frame, /Errors/);
    assert.match(frame, /TS2304/);
    assert.match(frame, /Import foo from bar/);
    assert.match(frame, /typecheck failed/);
    assert.match(frame, /Panel: errors/);
  } finally {
    unmount();
  }
});

test("tui run-detail: [e] on run with no errors shows 'No errors'", async () => {
  const detail = mkDetail();
  const { stdin, lastFrame, unmount } = render(
    <RunDetailScreen
      runId="run-abc123"
      onBack={() => {}}
      getRunDetail={async () => detail}
    />,
  );
  try {
    await wait(60);
    stdin.write("e");
    await wait(40);
    const frame = lastFrame() ?? "";
    assert.match(frame, /No errors/);
  } finally {
    unmount();
  }
});

// ─── Navigation ─────────────────────────────────────────────────────

test("tui run-detail: [esc] calls onBack", async () => {
  let backed = false;
  const { stdin, unmount } = render(
    <RunDetailScreen
      runId="run-abc123"
      onBack={() => { backed = true; }}
      getRunDetail={async () => mkDetail()}
    />,
  );
  try {
    await wait(60);
    stdin.write("\x1b");
    await wait(40);
    assert.ok(backed, "onBack must be called on esc");
  } finally {
    unmount();
  }
});

test("tui run-detail: switching panels replaces previous panel", async () => {
  const detail = mkDetail();
  const { stdin, lastFrame, unmount } = render(
    <RunDetailScreen
      runId="run-abc123"
      onBack={() => {}}
      getRunDetail={async () => detail}
    />,
  );
  try {
    await wait(60);
    stdin.write("d");
    await wait(40);
    assert.match(lastFrame() ?? "", /Diff/);
    stdin.write("v");
    await wait(40);
    const frame = lastFrame() ?? "";
    assert.match(frame, /Verifier Stages/);
    assert.doesNotMatch(frame, /\bDiff\b/);
    assert.match(frame, /Panel: verifier/);
  } finally {
    unmount();
  }
});

// ─── Lane rescue rendering — selected shadow ─────────────────────────

test("run-detail Candidate Lanes panel: selected SHADOW renders ★ marker and 'selected' line", async () => {
  // Lane-rescue scenario: primary failed verification, shadow took
  // over and was selected. The Candidate Lanes panel must clearly
  // mark the shadow with a ★ so the operator can tell at a glance
  // which lane produced the change they're about to approve.
  const detail = mkDetail({
    laneMode: "local_then_cloud",
    selectedCandidateWorkspaceId: "shadow-1",
    candidates: [
      {
        workspaceId: "primary",
        role: "primary",
        lane: "local",
        provider: "ollama",
        model: "qwen3.5:9b",
        status: "failed",
        disqualification: "verifierVerdict=fail",
        verifierVerdict: "fail",
        costUsd: 0,
        latencyMs: 100,
        criticalFindings: 1,
      },
      {
        workspaceId: "shadow-1",
        role: "shadow",
        lane: "cloud",
        provider: "openrouter",
        model: "xiaomi/mimo-v2.5",
        status: "passed",
        disqualification: null,
        verifierVerdict: null,
        costUsd: 0.01,
        latencyMs: 200,
      },
    ],
  });
  const { stdin, lastFrame, unmount } = render(
    <RunDetailScreen
      runId="run-abc123"
      onBack={() => {}}
      getRunDetail={async () => detail}
    />,
  );
  try {
    await wait(40);
    stdin.write("c");
    await wait(40);
    const frame = lastFrame() ?? "";
    assert.match(frame, /Candidate Lanes/, "panel header must render");
    assert.match(frame, /selectedCandidate:\s+shadow-1/);
    // Both rows render, primary first (input order), then shadow.
    assert.match(frame, /primary/);
    assert.match(frame, /shadow/);
    // Shadow row must carry the ★ marker.
    assert.match(frame, /★\s+shadow/, "selected shadow MUST be marked with ★");
    // The "selected" annotation appears under the chosen row.
    assert.match(frame, /selected/);
    // Primary's disqualification reason is surfaced so the operator
    // can audit the rescue.
    assert.match(frame, /disqualified:\s*verifierVerdict=fail/);
  } finally {
    unmount();
  }
});

test("run-detail Candidate Lanes panel: when shadow is selected, primary row is NOT bolded", async () => {
  // The bold/marker is the visual "this is the one" — accidentally
  // bolding the primary too would make the rescue ambiguous. Soft
  // pin: each row's bold attribute stays attached to selection only.
  const detail = mkDetail({
    laneMode: "local_then_cloud",
    selectedCandidateWorkspaceId: "shadow-1",
    candidates: [
      {
        workspaceId: "primary",
        role: "primary",
        lane: "local",
        provider: "ollama",
        model: "qwen3.5:9b",
        status: "failed",
        disqualification: "status=failed",
        verifierVerdict: "fail",
        costUsd: 0,
        latencyMs: 1,
      },
      {
        workspaceId: "shadow-1",
        role: "shadow",
        lane: "cloud",
        provider: "openrouter",
        model: "xiaomi/mimo-v2.5",
        status: "passed",
        disqualification: null,
        costUsd: 0.01,
        latencyMs: 1,
      },
    ],
  });
  const { stdin, lastFrame, unmount } = render(
    <RunDetailScreen
      runId="run-abc123"
      onBack={() => {}}
      getRunDetail={async () => detail}
    />,
  );
  try {
    await wait(40);
    stdin.write("c");
    await wait(40);
    const frame = lastFrame() ?? "";
    // Only the shadow row carries the ★. The primary row gets the
    // two-space prefix used for unselected rows.
    const lines = frame.split("\n");
    const primaryLine = lines.find((l) => l.includes("primary") && /local/.test(l));
    const shadowLine = lines.find((l) => l.includes("shadow") && /cloud/.test(l));
    assert.ok(primaryLine, "primary row must render");
    assert.ok(shadowLine, "shadow row must render");
    assert.doesNotMatch(primaryLine, /★/, "unselected primary row must NOT carry ★");
    assert.match(shadowLine, /★/, "selected shadow row MUST carry ★");
  } finally {
    unmount();
  }
});
