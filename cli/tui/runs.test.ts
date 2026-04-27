import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { render } from "ink-testing-library";

import { RunsScreen } from "./screens/runs.js";

test("tui: runs dashboard renders heading on first frame", () => {
  const { lastFrame, unmount } = render(createElement(RunsScreen));
  try {
    const frame = lastFrame() ?? "";
    assert.match(frame, /Aedis TUI/, "heading must be visible on first frame");
    assert.match(frame, /Runs Dashboard/, "screen subtitle must be visible");
    assert.match(frame, /\[s\] submit/, "footer hotkey hints must be visible");
  } finally {
    unmount();
  }
});
