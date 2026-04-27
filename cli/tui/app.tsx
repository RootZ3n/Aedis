import { useState } from "react";

import { RunsScreen } from "./screens/runs.js";
import { BurnInScreen } from "./screens/burn-in.js";
import { RunDetailScreen } from "./screens/run-detail.js";
import { Splash } from "./components/Splash.js";

export interface AppProps {
  readonly noSplash: boolean;
}

type Screen = { kind: "runs" } | { kind: "burn-in" } | { kind: "run-detail"; runId: string };

export function App({ noSplash }: AppProps) {
  const [showSplash, setShowSplash] = useState(!noSplash);
  const [screen, setScreen] = useState<Screen>({ kind: "runs" });
  if (showSplash) return <Splash onDone={() => setShowSplash(false)} />;
  if (screen.kind === "burn-in") {
    return <BurnInScreen onExit={() => setScreen({ kind: "runs" })} />;
  }
  if (screen.kind === "run-detail") {
    return (
      <RunDetailScreen
        runId={screen.runId}
        onBack={() => setScreen({ kind: "runs" })}
      />
    );
  }
  return (
    <RunsScreen
      onOpenBurnIn={() => setScreen({ kind: "burn-in" })}
      onOpenDetail={(runId) => setScreen({ kind: "run-detail", runId })}
    />
  );
}
