import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { render } from "ink-testing-library";

import { App } from "./app.js";
import {
  BurnInScreen,
  type BurnRunHandle,
  type BurnRunner,
  type BurnSuiteKind,
} from "./screens/burn-in.js";
import {
  HARD_RESULTS_PATH,
  SOFT_RESULTS_PATH,
  summariseRows,
  type BurnSuiteSummary,
} from "./burn-results.js";

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const emptySummary = (path: string): BurnSuiteSummary =>
  summariseRows(path, [], false, null, 0);

const noopRunner: BurnRunner = () => ({ stop: () => {} });

// ─── Empty state ────────────────────────────────────────────────────

test("burn-in: empty state shows 'No results yet' for both suites", () => {
  const { lastFrame, unmount } = render(
    createElement(BurnInScreen, {
      onExit: () => {},
      runner: noopRunner,
      loadSummary: emptySummary,
      tickMs: 0,
    }),
  );
  try {
    const frame = lastFrame() ?? "";
    assert.match(frame, /Aedis TUI — Burn-in/);
    assert.match(frame, /Soft suite/);
    assert.match(frame, /Hard suite/);
    // Both suites missing → both should print the empty hint.
    const occurrences = (frame.match(/No results yet/g) ?? []).length;
    assert.equal(occurrences, 2, `expected two empty-state hints, got ${occurrences}`);
    assert.match(frame, /\[s\] soft/);
    assert.match(frame, /\[h\] hard/);
    assert.match(frame, /\[esc\] back/);
  } finally {
    unmount();
  }
});

// ─── Sample summary parsing + render ────────────────────────────────

test("burn-in: renders parsed summary stats from injected loader", () => {
  const sample: BurnSuiteSummary = summariseRows(
    SOFT_RESULTS_PATH,
    [
      {
        scenarioId: "burn-in-01",
        verdict: "PASS",
        status: "PROMOTED",
        classification: null,
        costUsd: 0.0123,
        durationMs: 10_000,
        timestamp: "2026-04-27T02:28:14.682Z",
      },
      {
        scenarioId: "burn-in-02",
        verdict: "FAIL",
        status: "EXECUTION_ERROR",
        classification: null,
        costUsd: 0.05,
        durationMs: 5_000,
        timestamp: "2026-04-27T02:30:00.000Z",
      },
    ],
    true,
    "2026-04-27T03:00:00.000Z",
    0,
  );
  const loadSummary = (p: string): BurnSuiteSummary =>
    p === SOFT_RESULTS_PATH ? sample : emptySummary(p);
  const { lastFrame, unmount } = render(
    createElement(BurnInScreen, {
      onExit: () => {},
      runner: noopRunner,
      loadSummary,
      tickMs: 0,
    }),
  );
  try {
    const frame = lastFrame() ?? "";
    assert.match(frame, /scenarios: 2/);
    assert.match(frame, /pass 1/);
    assert.match(frame, /fail 1/);
    assert.match(frame, /\$0\.0623/, "cost must aggregate to 0.0623");
    assert.match(frame, /2026-04-27T02:30:00/, "lastTimestamp must surface");
  } finally {
    unmount();
  }
});

// ─── Dashboard navigation ───────────────────────────────────────────

test("dashboard: pressing [b] opens the burn-in screen", async () => {
  const { stdin, lastFrame, unmount } = render(
    createElement(App, { noSplash: true }),
  );
  try {
    await wait(40);
    let frame = lastFrame() ?? "";
    assert.match(frame, /Runs Dashboard/);
    stdin.write("b");
    await wait(60);
    frame = lastFrame() ?? "";
    assert.match(frame, /Burn-in/, "burn-in title must be visible after [b]");
    assert.doesNotMatch(frame, /Runs Dashboard/, "dashboard heading must be gone");
  } finally {
    unmount();
  }
});

test("burn-in: pressing [esc] returns to the runs dashboard", async () => {
  const { stdin, lastFrame, unmount } = render(
    createElement(App, { noSplash: true }),
  );
  try {
    await wait(40);
    stdin.write("b");
    await wait(60);
    let frame = lastFrame() ?? "";
    assert.match(frame, /Burn-in/);
    stdin.write("\x1b"); // ESC
    await wait(60);
    frame = lastFrame() ?? "";
    assert.match(frame, /Runs Dashboard/, "dashboard must reappear after esc");
  } finally {
    unmount();
  }
});

// ─── Run controls ───────────────────────────────────────────────────

test("burn-in: pressing [s] invokes the soft runner immediately", async () => {
  const calls: BurnSuiteKind[] = [];
  const runner: BurnRunner = (suite, _onLine, _onExit) => {
    calls.push(suite);
    return { stop: () => {} };
  };
  const { stdin, lastFrame, unmount } = render(
    createElement(BurnInScreen, {
      onExit: () => {},
      runner,
      loadSummary: emptySummary,
      tickMs: 0,
    }),
  );
  try {
    await wait(40);
    stdin.write("s");
    await wait(60);
    assert.deepEqual(calls, ["soft"], "soft runner must fire on first [s] press");
    const frame = lastFrame() ?? "";
    assert.match(frame, /RUNNING/);
    assert.match(frame, /soft/);
  } finally {
    unmount();
  }
});

test("burn-in: hard runner requires a confirming second [h]", async () => {
  const calls: BurnSuiteKind[] = [];
  const runner: BurnRunner = (suite) => {
    calls.push(suite);
    return { stop: () => {} };
  };
  const { stdin, lastFrame, unmount } = render(
    createElement(BurnInScreen, {
      onExit: () => {},
      runner,
      loadSummary: emptySummary,
      tickMs: 0,
    }),
  );
  try {
    await wait(40);
    stdin.write("h"); // first press → confirmation prompt only
    await wait(40);
    assert.equal(calls.length, 0, "first [h] must NOT spawn the hard run");
    const promptFrame = lastFrame() ?? "";
    assert.match(promptFrame, /press \[h\] again/);
    stdin.write("h"); // confirming second press
    await wait(60);
    assert.deepEqual(calls, ["hard"], "second [h] within window must spawn hard run");
    const runFrame = lastFrame() ?? "";
    assert.match(runFrame, /RUNNING/);
    assert.match(runFrame, /hard/);
  } finally {
    unmount();
  }
});

test("burn-in: stdout from the runner is tailed into the running pane", async () => {
  const captured: {
    onLine?: (line: string) => void;
    onExit?: (code: number | null) => void;
  } = {};
  const runner: BurnRunner = (_suite, onLine, onExit): BurnRunHandle => {
    captured.onLine = onLine;
    captured.onExit = onExit;
    return { stop: () => {} };
  };
  const { stdin, lastFrame, unmount } = render(
    createElement(BurnInScreen, {
      onExit: () => {},
      runner,
      loadSummary: emptySummary,
      tickMs: 0,
    }),
  );
  try {
    await wait(40);
    stdin.write("s");
    await wait(40);
    if (!captured.onLine || !captured.onExit) {
      throw new Error("runner did not receive line/exit callbacks");
    }
    captured.onLine("hello from harness");
    await wait(40);
    let frame = lastFrame() ?? "";
    assert.match(frame, /hello from harness/);
    captured.onExit(0);
    await wait(40);
    frame = lastFrame() ?? "";
    assert.match(frame, /EXIT 0/);
  } finally {
    unmount();
  }
});

test("burn-in: pressing [r] reloads summaries via injected loader", async () => {
  let calls = 0;
  const loadSummary = (path: string): BurnSuiteSummary => {
    calls += 1;
    return emptySummary(path);
  };
  const { stdin, unmount } = render(
    createElement(BurnInScreen, {
      onExit: () => {},
      runner: noopRunner,
      loadSummary,
      tickMs: 0,
    }),
  );
  try {
    await wait(40);
    const initialCalls = calls;
    stdin.write("r");
    await wait(40);
    // Two paths (soft + hard) are reloaded per refresh.
    assert.equal(
      calls - initialCalls,
      2,
      `[r] should call loadSummary twice; got ${calls - initialCalls}`,
    );
  } finally {
    unmount();
  }
});

// Sanity: HARD_RESULTS_PATH and SOFT_RESULTS_PATH are stable strings the
// screen depends on. If someone moves the JSONL location the screen will
// silently report empty — keep the path coupling explicit.
test("burn-in: result path constants point at /mnt/ai/tmp", () => {
  assert.equal(SOFT_RESULTS_PATH, "/mnt/ai/tmp/aedis-burn-in-results.jsonl");
  assert.equal(HARD_RESULTS_PATH, "/mnt/ai/tmp/aedis-burn-in-hard.jsonl");
});
