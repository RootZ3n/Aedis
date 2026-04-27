import { useState } from "react";

import { RunsScreen } from "./screens/runs.js";
import { Splash } from "./components/Splash.js";

export interface AppProps {
  readonly noSplash: boolean;
}

export function App({ noSplash }: AppProps) {
  const [showSplash, setShowSplash] = useState(!noSplash);
  if (showSplash) return <Splash onDone={() => setShowSplash(false)} />;
  return <RunsScreen />;
}
