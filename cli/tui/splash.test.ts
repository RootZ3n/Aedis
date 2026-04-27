import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { render } from "ink-testing-library";

import { Splash } from "./components/Splash.js";

const okChecks = async () => ({ apiOk: true, workersReady: true });

test("tui splash: renders spaced A E D I S title and copy", () => {
  let done = false;
  const { lastFrame, unmount } = render(
    createElement(Splash, {
      onDone: () => { done = true; },
      durationMs: 99_999,
      runChecks: okChecks,
    }),
  );
  try {
    const frame = lastFrame() ?? "";
    assert.match(frame, /A\s+E\s+D\s+I\s+S/, "title must show spaced A E D I S");
    assert.match(frame, /governed AI build orchestration/, "tagline must be visible");
    assert.match(frame, /safe patches/, "subline must be visible");
    assert.equal(done, false, "onDone must not fire before timeout or input");
  } finally {
    unmount();
  }
});

test("tui splash: any keystroke calls onDone immediately", async () => {
  let done = false;
  const { stdin, unmount } = render(
    createElement(Splash, {
      onDone: () => { done = true; },
      durationMs: 99_999,
      runChecks: okChecks,
    }),
  );
  try {
    stdin.write("x");
    // Allow Ink's input loop one tick to deliver the keystroke.
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(done, true, "onDone must fire on a keystroke");
  } finally {
    unmount();
  }
});

test("tui splash: failing checks do not block onDone — timer still fires", async () => {
  let done = false;
  const failingChecks = async (): Promise<never> => { throw new Error("ECONNREFUSED"); };
  const { unmount } = render(
    createElement(Splash, {
      onDone: () => { done = true; },
      durationMs: 60,
      runChecks: failingChecks,
    }),
  );
  try {
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(done, true, "onDone must fire after duration even when checks reject");
  } finally {
    unmount();
  }
});

test("tui splash: onDone fires at most once across timer + keystroke race", async () => {
  let count = 0;
  const { stdin, unmount } = render(
    createElement(Splash, {
      onDone: () => { count += 1; },
      durationMs: 50,
      runChecks: okChecks,
    }),
  );
  try {
    stdin.write("x");
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(count, 1, `onDone must fire exactly once; got ${count}`);
  } finally {
    unmount();
  }
});
