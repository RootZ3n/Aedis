import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { render } from "ink-testing-library";

import { Splash, isMeaningfulInput } from "./components/Splash.js";

const okChecks = async () => ({ apiOk: true, workersReady: true });

test("tui splash: renders spaced A E D I S title and copy", () => {
  let done = false;
  const { lastFrame, unmount } = render(
    createElement(Splash, {
      onDone: () => { done = true; },
      durationMs: 99_999,
      runChecks: okChecks,
      inputGraceMs: 0,
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

test("tui splash: any keystroke calls onDone immediately (after grace)", async () => {
  let done = false;
  const { stdin, unmount } = render(
    createElement(Splash, {
      onDone: () => { done = true; },
      durationMs: 99_999,
      runChecks: okChecks,
      inputGraceMs: 0,
    }),
  );
  try {
    stdin.write("x");
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
      inputGraceMs: 0,
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
      inputGraceMs: 0,
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

test("tui splash: input during grace window is ignored, accepted after", async () => {
  let done = false;
  const { stdin, unmount } = render(
    createElement(Splash, {
      onDone: () => { done = true; },
      durationMs: 99_999,
      runChecks: okChecks,
      inputGraceMs: 100,
    }),
  );
  try {
    // Within grace — must NOT skip (mirrors the raw-mode startup
    // noise that was dismissing the live splash).
    stdin.write("x");
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(done, false, "input within grace window must be ignored");

    // Past grace — same key now fires.
    await new Promise((r) => setTimeout(r, 120));
    stdin.write("x");
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(done, true, "input after grace window must fire onDone");
  } finally {
    unmount();
  }
});

test("isMeaningfulInput: empty input with no key flags is treated as noise", () => {
  // The exact shape Ink produces for terminal probe responses /
  // unparseable escape fragments — see use-input.js lines 91-99.
  assert.equal(isMeaningfulInput("", {}), false, "empty input with no flags is noise");
  assert.equal(isMeaningfulInput("", { ctrl: false }), false, "explicit-false flags are noise");
});

test("isMeaningfulInput: any printable input is meaningful", () => {
  assert.equal(isMeaningfulInput("x", {}), true);
  assert.equal(isMeaningfulInput(" ", {}), true);
  assert.equal(isMeaningfulInput("abc", {}), true, "pasted strings are meaningful");
});

test("isMeaningfulInput: explicit key flags are meaningful even with empty input", () => {
  assert.equal(isMeaningfulInput("", { return: true }), true);
  assert.equal(isMeaningfulInput("", { escape: true }), true);
  assert.equal(isMeaningfulInput("", { upArrow: true }), true);
  assert.equal(isMeaningfulInput("", { ctrl: true }), true);
});
