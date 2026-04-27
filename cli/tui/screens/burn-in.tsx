/**
 * Burn-in screen — run and inspect the soft/hard burn-in suites
 * without leaving the TUI.
 *
 * Hotkeys:
 *   s   run soft burn-in (npm run burn:soft)
 *   h   run hard burn-in — requires a second 'h' within HARD_CONFIRM_MS
 *   r   refresh JSONL summaries from disk
 *   esc back to the dashboard
 *
 * Hard runs are gated behind a re-press because they can take ~20+
 * minutes and burn real cost. Soft runs go through immediately.
 *
 * The runner is injectable so tests can drive the screen without
 * actually spawning processes.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { spawn } from "node:child_process";

import {
  HARD_RESULTS_PATH,
  SOFT_RESULTS_PATH,
  type BurnSuiteSummary,
  formatDurationMs,
  readSuite,
} from "../burn-results.js";

const TAIL_LINES = 20;
const HARD_CONFIRM_MS = 5_000;

export type BurnSuiteKind = "soft" | "hard";

export interface BurnRunHandle {
  /** Stops listening / kills the process. Idempotent. */
  readonly stop: () => void;
}

export interface BurnRunner {
  (
    suite: BurnSuiteKind,
    onLine: (line: string) => void,
    onExit: (code: number | null) => void,
  ): BurnRunHandle;
}

/**
 * Default runner: spawns `npm run burn:soft` / `npm run burn:hard` in
 * the current working directory and streams stdout+stderr line-by-line
 * to the caller. Buffers the trailing partial line until newline.
 */
export const defaultBurnRunner: BurnRunner = (suite, onLine, onExit) => {
  const script = suite === "soft" ? "burn:soft" : "burn:hard";
  const child = spawn("npm", ["run", script], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, FORCE_COLOR: "0" },
  });
  let buffer = "";
  const handleChunk = (chunk: Buffer): void => {
    buffer += chunk.toString("utf-8");
    let idx = buffer.indexOf("\n");
    while (idx !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      onLine(line);
      idx = buffer.indexOf("\n");
    }
  };
  child.stdout?.on("data", handleChunk);
  child.stderr?.on("data", handleChunk);
  let exited = false;
  const finish = (code: number | null): void => {
    if (exited) return;
    exited = true;
    if (buffer.length > 0) {
      onLine(buffer);
      buffer = "";
    }
    onExit(code);
  };
  child.on("close", (code) => finish(code));
  child.on("error", () => finish(null));
  return {
    stop: () => {
      if (!exited) {
        try { child.kill("SIGINT"); } catch { /* ignore */ }
      }
    },
  };
};

interface RunningState {
  readonly suite: BurnSuiteKind;
  readonly startedAt: number;
  readonly lines: readonly string[];
  readonly exitCode: number | null;
  readonly finishedAt: number | null;
}

export interface BurnInScreenProps {
  readonly onExit: () => void;
  /** Inject a runner in tests so we don't spawn npm. */
  readonly runner?: BurnRunner;
  /** Inject a summary loader; defaults to disk reads. */
  readonly loadSummary?: (path: string) => BurnSuiteSummary;
  /** Tick interval for elapsed time updates. Tests can disable. */
  readonly tickMs?: number;
}

export function BurnInScreen({
  onExit,
  runner = defaultBurnRunner,
  loadSummary = readSuite,
  tickMs = 1000,
}: BurnInScreenProps) {
  const [softSummary, setSoftSummary] = useState<BurnSuiteSummary>(() =>
    loadSummary(SOFT_RESULTS_PATH),
  );
  const [hardSummary, setHardSummary] = useState<BurnSuiteSummary>(() =>
    loadSummary(HARD_RESULTS_PATH),
  );
  const [running, setRunning] = useState<RunningState | null>(null);
  const [hardConfirmAt, setHardConfirmAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const handleRef = useRef<BurnRunHandle | null>(null);

  const refresh = (): void => {
    setSoftSummary(loadSummary(SOFT_RESULTS_PATH));
    setHardSummary(loadSummary(HARD_RESULTS_PATH));
  };

  // Periodic clock so elapsed time updates while running. We only
  // arm the interval when something is actively running to avoid
  // unnecessary renders on a static dashboard.
  useEffect(() => {
    if (!running || running.finishedAt !== null || tickMs <= 0) return;
    const id = setInterval(() => setNow(Date.now()), tickMs);
    return () => clearInterval(id);
  }, [running, tickMs]);

  // Tear down any in-flight runner if the screen unmounts.
  useEffect(() => () => {
    handleRef.current?.stop();
    handleRef.current = null;
  }, []);

  const startRun = (suite: BurnSuiteKind): void => {
    if (running && running.finishedAt === null) {
      setActionMsg("a burn-in is already running — wait for it to finish");
      return;
    }
    handleRef.current?.stop();
    setRunning({ suite, startedAt: Date.now(), lines: [], exitCode: null, finishedAt: null });
    setActionMsg(`started ${suite} burn-in`);
    const handle = runner(
      suite,
      (line) => {
        setRunning((prev) => {
          if (!prev || prev.suite !== suite) return prev;
          const next = [...prev.lines, line];
          const trimmed = next.length > TAIL_LINES ? next.slice(next.length - TAIL_LINES) : next;
          return { ...prev, lines: trimmed };
        });
      },
      (code) => {
        setRunning((prev) => {
          if (!prev || prev.suite !== suite) return prev;
          return { ...prev, exitCode: code, finishedAt: Date.now() };
        });
        // Reload summaries — the harness should have appended new
        // rows to the JSONL by exit time.
        setSoftSummary(loadSummary(SOFT_RESULTS_PATH));
        setHardSummary(loadSummary(HARD_RESULTS_PATH));
      },
    );
    handleRef.current = handle;
  };

  useInput((char, key) => {
    if (key.escape) {
      onExit();
      return;
    }
    if (char === "s") {
      setHardConfirmAt(null);
      startRun("soft");
      return;
    }
    if (char === "h") {
      const isConfirming =
        hardConfirmAt !== null && Date.now() - hardConfirmAt < HARD_CONFIRM_MS;
      if (isConfirming) {
        setHardConfirmAt(null);
        startRun("hard");
      } else {
        setHardConfirmAt(Date.now());
        setActionMsg(
          "hard burn-in is expensive — press [h] again within 5s to confirm",
        );
      }
      return;
    }
    if (char === "r") {
      refresh();
      setActionMsg("refreshed from disk");
      return;
    }
  });

  const elapsedMs = useMemo(() => {
    if (!running) return 0;
    const end = running.finishedAt ?? now;
    return end - running.startedAt;
  }, [running, now]);

  const hardConfirmActive =
    hardConfirmAt !== null && Date.now() - hardConfirmAt < HARD_CONFIRM_MS;

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold color="cyan">Aedis TUI — Burn-in</Text>
      </Box>

      <Box marginTop={1} flexDirection="row">
        <Box flexDirection="column" marginRight={4}>
          <Text bold>Soft suite</Text>
          <SuiteSummaryView summary={softSummary} />
        </Box>
        <Box flexDirection="column">
          <Text bold>Hard suite</Text>
          <SuiteSummaryView summary={hardSummary} />
        </Box>
      </Box>

      {running && (
        <Box marginTop={1} flexDirection="column" borderStyle="round" borderColor={runColor(running)} paddingX={1}>
          <Text bold color={runColor(running)}>
            {running.finishedAt === null ? "RUNNING" : `EXIT ${running.exitCode ?? "?"}`}
            {"  "}
            {running.suite}  •  elapsed {formatDurationMs(elapsedMs)}
          </Text>
          {running.lines.length === 0 ? (
            <Text dimColor>(no output yet)</Text>
          ) : (
            running.lines.map((line, i) => (
              <Text key={`${running.startedAt}-${i}`}>{line}</Text>
            ))
          )}
        </Box>
      )}

      <Box marginTop={1} flexDirection="column">
        <Text dimColor>
          [s] soft  [h] hard{hardConfirmActive ? " (press again to confirm)" : ""}  [r] refresh  [esc] back
        </Text>
        {actionMsg && <Text color="yellow">Last action: {actionMsg}</Text>}
      </Box>
    </Box>
  );
}

function runColor(running: RunningState): string {
  if (running.finishedAt === null) return "cyan";
  return running.exitCode === 0 ? "green" : "red";
}

function SuiteSummaryView({ summary }: { summary: BurnSuiteSummary }) {
  if (!summary.exists) {
    return (
      <Box flexDirection="column">
        <Text dimColor>No results yet</Text>
        <Text dimColor>{summary.path}</Text>
      </Box>
    );
  }
  if (summary.total === 0) {
    return (
      <Box flexDirection="column">
        <Text dimColor>0 scenarios</Text>
        <Text dimColor>{summary.path}</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      <Text>scenarios: {summary.total}</Text>
      <Text>
        <Text color="green">pass {summary.pass}</Text>
        {"  "}
        <Text color="red">fail {summary.fail}</Text>
        {"  "}
        <Text color="magenta">err {summary.error}</Text>
        {"  "}
        <Text color="yellow">timeout {summary.timeout}</Text>
        {summary.blocked > 0 && (
          <>
            {"  "}
            <Text color="blue">blocked {summary.blocked}</Text>
          </>
        )}
      </Text>
      <Text>cost:     ${summary.totalCostUsd.toFixed(4)}</Text>
      <Text>duration: {formatDurationMs(summary.totalDurationMs)}</Text>
      <Text>last run: {summary.lastTimestamp ?? "—"}</Text>
      <Text dimColor>{summary.path}</Text>
      {summary.parseErrors > 0 && (
        <Text color="yellow">⚠ {summary.parseErrors} unparseable line(s)</Text>
      )}
    </Box>
  );
}
