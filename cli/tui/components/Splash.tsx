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

const API_BASE = process.env["AEDIS_API_BASE"] ?? "http://127.0.0.1:18796";
const DEFAULT_DURATION_MS = 1000;
const INPUT_GRACE_MS = 150;

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
  /**
   * How long after mount input is ignored. Absorbs raw-mode startup
   * noise (terminal probe responses, escape-prefixed fragments)
   * which otherwise dismiss the splash before it visibly renders.
   * Tests override this to 0 when they want immediate input.
   */
  readonly inputGraceMs?: number;
}

/**
 * Ink fires `useInput` for every parsed keypress, including ones
 * with empty `input` and no key flag — see node_modules/ink/build/
 * hooks/use-input.js where `input` is set to '' for non-alphanumeric
 * keys and stripped escape fragments. Treat those as noise so the
 * splash isn't dismissed by terminal startup probes.
 */
export function isMeaningfulInput(
  input: string,
  key: { return?: boolean; escape?: boolean; tab?: boolean; backspace?: boolean; delete?: boolean; upArrow?: boolean; downArrow?: boolean; leftArrow?: boolean; rightArrow?: boolean; pageUp?: boolean; pageDown?: boolean; ctrl?: boolean; meta?: boolean },
): boolean {
  if (input && input.length > 0) return true;
  return Boolean(
    key.return || key.escape || key.tab || key.backspace || key.delete ||
    key.upArrow || key.downArrow || key.leftArrow || key.rightArrow ||
    key.pageUp || key.pageDown || key.ctrl || key.meta,
  );
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
  inputGraceMs = INPUT_GRACE_MS,
}: SplashProps) {
  const [checks, setChecks] = useState<SplashChecks>({ apiOk: null, workersReady: null });
  const finishedRef = useRef(false);
  const mountedAtRef = useRef<number>(Date.now());

  const finish = (): void => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    onDone();
  };

  useEffect(() => {
    mountedAtRef.current = Date.now();
    let alive = true;
    runChecks()
      .then((c) => { if (alive) setChecks(c); })
      .catch(() => { if (alive) setChecks({ apiOk: false, workersReady: false }); });
    const id = setTimeout(finish, durationMs);
    return () => { alive = false; clearTimeout(id); };
    // intentionally empty deps — splash mounts once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useInput((input, key) => {
    if (Date.now() - mountedAtRef.current < inputGraceMs) return;
    if (!isMeaningfulInput(input, key)) return;
    finish();
  });

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
