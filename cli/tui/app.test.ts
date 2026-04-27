import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { render } from "ink-testing-library";

import { App } from "./app.js";

test("tui app: default (noSplash=false) renders the splash first", () => {
  const { lastFrame, unmount } = render(createElement(App, { noSplash: false }));
  try {
    const frame = lastFrame() ?? "";
    assert.match(frame, /A\s+E\s+D\s+I\s+S/, "splash heading must appear on first frame");
    assert.doesNotMatch(frame, /Runs Dashboard/, "runs dashboard must NOT appear yet");
  } finally {
    unmount();
  }
});

test("tui app: --no-splash (noSplash=true) renders runs dashboard directly", () => {
  const { lastFrame, unmount } = render(createElement(App, { noSplash: true }));
  try {
    const frame = lastFrame() ?? "";
    assert.match(frame, /Runs Dashboard/, "runs dashboard heading must be on the first frame");
    assert.doesNotMatch(frame, /A\s+E\s+D\s+I\s+S/, "splash heading must NOT appear");
  } finally {
    unmount();
  }
});
