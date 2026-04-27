import { render } from "ink";

import { App } from "./app.js";

const noSplash = process.argv.includes("--no-splash");
const instance = render(<App noSplash={noSplash} />);
instance.waitUntilExit().catch(() => {
  // Render-level errors are surfaced inside the Ink tree; nothing
  // useful to do at the process boundary beyond letting Node exit.
});
