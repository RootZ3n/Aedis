import { render } from "ink";

import { RunsScreen } from "./screens/runs.js";

const instance = render(<RunsScreen />);
instance.waitUntilExit().catch(() => {
  // Render-level errors are surfaced inside the Ink tree; nothing
  // useful to do at the process boundary beyond letting Node exit.
});
