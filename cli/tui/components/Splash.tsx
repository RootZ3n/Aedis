/**
 * Splash — startup card shown before the runs dashboard.
 *
 * Floats the spelled-out title "A   E   D   I   S" inside a round
 * border with generous vertical padding. Tagline + subline sit
 * beneath. A single status line below the card reports live API and
 * worker readiness.
 *
 * Contract:
 *   - onDone fires exactly once: on first keystroke OR after
 *     durationMs, whichever comes first.
 *   - A failing health/workers check NEVER blocks onDone — the timer
 *     fires regardless, and the labels degrade to "disconnected" /
 *     "degraded".
 *   - runChecks is injectable so tests can avoid real network.
 */

import { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";

const API_BASE = process.env["AEDIS_API_BASE"] ?? "http://localhost:18796";
const DEFAULT_DURATION_MS = 1000;

const TITLE = "A   E   D   I   S";
const TAGLINE = "governed AI build orchestration";
const SUBLINE = "safe patches • receipts • approvals • verify";

export interface SplashChecks {
  /** null = still in flight; true/false = settled. */
  readonly apiOk: boolean | null;
  readonly workersReady: boolean | null;
}

export interface SplashProps {
  readonly onDone: () => void;
  readonly durationMs?: number;
  /** Override the live readiness probe — used by tests. */
  readonly runChecks?: () => Promise<SplashChecks>;
}

async function liveChecks(): Promise<SplashChecks> {
  let apiOk: boolean = false;
  let workersReady: boolean = false;
  try {
    const r = await fetch(`${API_BASE}/health`);
    if (r.ok) {
      const j = (await r.json()) as { status?: string };
      apiOk = j.status === "healthy" || j.status === "degraded";
    }
  } catch {
    apiOk = false;
  }
  try {
    const r = await fetch(`${API_BASE}/workers`);
    if (r.ok) {
      const j = (await r.json()) as {
        summary?: { fully_staffed?: boolean };
      };
      workersReady = Boolean(j.summary?.fully_staffed);
    }
  } catch {
    workersReady = false;
  }
  return { apiOk, workersReady };
}

export function Splash({
  onDone,
  durationMs = DEFAULT_DURATION_MS,
  runChecks = liveChecks,
}: SplashProps) {
  const [checks, setChecks] = useState<SplashChecks>({ apiOk: null, workersReady: null });
  const finishedRef = useRef(false);

  const finish = (): void => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    onDone();
  };

  useEffect(() => {
    let alive = true;
    runChecks()
      .then((c) => { if (alive) setChecks(c); })
      .catch(() => { if (alive) setChecks({ apiOk: false, workersReady: false }); });
    const id = setTimeout(finish, durationMs);
    return () => { alive = false; clearTimeout(id); };
    // intentionally empty deps — splash mounts once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useInput(() => { finish(); });

  const apiLabel = checks.apiOk === null ? "checking…" : checks.apiOk ? "connected" : "disconnected";
  const apiColor = checks.apiOk === null ? undefined : checks.apiOk ? "green" : "red";
  const workersLabel = checks.workersReady === null ? "checking…" : checks.workersReady ? "ready" : "degraded";
  const workersColor = checks.workersReady === null ? undefined : checks.workersReady ? "green" : "yellow";

  return (
    <Box flexDirection="column">
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="cyan"
        paddingX={3}
        paddingY={1}
        alignItems="center"
      >
        <Text bold color="cyan">{TITLE}</Text>
        <Box marginTop={1}>
          <Text>{TAGLINE}</Text>
        </Box>
        <Text dimColor>{SUBLINE}</Text>
      </Box>
      <Box marginTop={1}>
        <Text>
          API: <Text color={apiColor}>{apiLabel}</Text>
          {"    "}
          Workers: <Text color={workersColor}>{workersLabel}</Text>
        </Text>
      </Box>
      <Text dimColor>(any key to continue)</Text>
    </Box>
  );
}
