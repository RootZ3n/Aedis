import { useState } from "react";

import { RunsScreen } from "./screens/runs.js";
import { BurnInScreen } from "./screens/burn-in.js";
import { Splash } from "./components/Splash.js";

export interface AppProps {
  readonly noSplash: boolean;
}

type Screen = "runs" | "burn-in";

export function App({ noSplash }: AppProps) {
  const [showSplash, setShowSplash] = useState(!noSplash);
  const [screen, setScreen] = useState<Screen>("runs");
  if (showSplash) return <Splash onDone={() => setShowSplash(false)} />;
  if (screen === "burn-in") {
    return <BurnInScreen onExit={() => setScreen("runs")} />;
  }
  return <RunsScreen onOpenBurnIn={() => setScreen("burn-in")} />;
}
