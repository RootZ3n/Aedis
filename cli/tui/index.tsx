import { useState } from "react";
import { render } from "ink";

import { RunsScreen } from "./screens/runs.js";
import { Splash } from "./components/Splash.js";

function App({ noSplash }: { noSplash: boolean }) {
  const [showSplash, setShowSplash] = useState(!noSplash);
  if (showSplash) return <Splash onDone={() => setShowSplash(false)} />;
  return <RunsScreen />;
}

const noSplash = process.argv.includes("--no-splash");
const instance = render(<App noSplash={noSplash} />);
instance.waitUntilExit().catch(() => {
  // Render-level errors are surfaced inside the Ink tree; nothing
  // useful to do at the process boundary beyond letting Node exit.
});
