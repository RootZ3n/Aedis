import { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";

import {
  approveRun as defaultApproveRun,
  listRuns as defaultListRuns,
  rejectRun as defaultRejectRun,
  submitRun as defaultSubmitRun,
  type RunListEntry,
} from "../api.js";

const DEFAULT_POLL_MS = 1000;
const MAX_RUNS = 20;
const TERMINAL_LIMIT = 10;

// Terminal statuses — the run reached a final state and won't change
// further. Keeps the dashboard from drowning in old runs while still
// exposing the most recent N for context.
const TERMINAL_STATUSES = new Set<string>([
  "PROMOTED",
  "REJECTED",
  "ABORTED",
  "INTERRUPTED",
  "EXECUTION_ERROR",
  "CRUCIBULUM_FAIL",
  "VERIFIED_FAIL",
  "VERIFIED_PASS",
  "CLEANUP_ERROR",
  // Legacy aliases the receipt store still accepts on read.
  "COMPLETE",
  "FAILED",
  "CRASHED",
]);

// The only status the coordinator actually accepts an approval for.
// Anything else triggers `{ ok: false, error: "No pending approval…" }`
// from the server, so we short-circuit client-side and tell the user.
const APPROVABLE_STATUSES = new Set<string>(["AWAITING_APPROVAL"]);

export function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function isApprovableStatus(status: string): boolean {
  return APPROVABLE_STATUSES.has(status);
}

/**
 * Default filter: all non-terminal runs + the most recent
 * `terminalLimit` terminal runs. Order is preserved from the API,
 * which returns newest-first.
 */
export function filterRuns(
  runs: readonly RunListEntry[],
  showHistory: boolean,
  terminalLimit = TERMINAL_LIMIT,
): RunListEntry[] {
  if (showHistory) return [...runs];
  const out: RunListEntry[] = [];
  let terminalSeen = 0;
  for (const r of runs) {
    if (isTerminalStatus(r.status)) {
      if (terminalSeen >= terminalLimit) continue;
      terminalSeen += 1;
    }
    out.push(r);
  }
  return out;
}

interface ApiSurface {
  readonly listRuns: typeof defaultListRuns;
  readonly submitRun: typeof defaultSubmitRun;
  readonly approveRun: typeof defaultApproveRun;
  readonly rejectRun: typeof defaultRejectRun;
}

const defaultApi: ApiSurface = {
  listRuns: defaultListRuns,
  submitRun: defaultSubmitRun,
  approveRun: defaultApproveRun,
  rejectRun: defaultRejectRun,
};

type Mode = "dashboard" | "submit" | "detail";
type ActionKind = "info" | "ok" | "error";
interface ActionMessage {
  readonly kind: ActionKind;
  readonly text: string;
}

export interface RunsScreenProps {
  readonly api?: ApiSurface;
  readonly pollMs?: number;
}

export function RunsScreen({
  api = defaultApi,
  pollMs = DEFAULT_POLL_MS,
}: RunsScreenProps = {}) {
  const { exit } = useApp();
  const [allRuns, setAllRuns] = useState<readonly RunListEntry[]>([]);
  const [selected, setSelected] = useState(0);
  const [mode, setMode] = useState<Mode>("dashboard");
  const [input, setInput] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  const [action, setAction] = useState<ActionMessage | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const refreshRef = useRef<(() => Promise<void>) | null>(null);

  const filteredRuns = useMemo(
    () => filterRuns(allRuns, showHistory, TERMINAL_LIMIT),
    [allRuns, showHistory],
  );

  // Clamp `selected` whenever the visible list shrinks. Without this
  // the user can be pointing at an index that no longer exists, which
  // (a) breaks approve/reject targeting and (b) hides the selection
  // marker entirely.
  useEffect(() => {
    setSelected((s) => {
      if (filteredRuns.length === 0) return 0;
      return Math.min(s, filteredRuns.length - 1);
    });
  }, [filteredRuns.length]);

  // Polling loop. Refresh handle is exposed via ref so action handlers
  // can fire an immediate refresh after an approve/reject without
  // waiting for the next tick.
  useEffect(() => {
    let alive = true;
    const tick = async (): Promise<void> => {
      try {
        const data = await api.listRuns(MAX_RUNS);
        if (!alive) return;
        setAllRuns(data);
        setPollError(null);
      } catch (err) {
        if (!alive) return;
        setPollError((err as Error).message);
      }
    };
    refreshRef.current = tick;
    void tick();
    const id = setInterval(() => { void tick(); }, pollMs);
    return () => {
      alive = false;
      clearInterval(id);
      refreshRef.current = null;
    };
  }, [api, pollMs]);

  const refreshNow = async (): Promise<void> => {
    if (refreshRef.current) await refreshRef.current();
  };

  const tryApprove = async (entry: RunListEntry): Promise<void> => {
    if (!isApprovableStatus(entry.status)) {
      setAction({
        kind: "info",
        text: `No pending approval for ${entry.runId.slice(0, 8)} (status=${entry.status})`,
      });
      return;
    }
    setAction({ kind: "info", text: `approving ${entry.runId.slice(0, 8)}…` });
    try {
      const res = (await api.approveRun(entry.runId)) as { ok?: boolean; error?: string };
      if (res?.ok === false) {
        setAction({ kind: "error", text: `approve failed: ${res.error ?? "unknown"}` });
      } else {
        setAction({ kind: "ok", text: `Approved ${entry.runId.slice(0, 8)}` });
        await refreshNow();
      }
    } catch (e) {
      setAction({ kind: "error", text: `approve failed: ${(e as Error).message}` });
    }
  };

  const tryReject = async (entry: RunListEntry): Promise<void> => {
    if (!isApprovableStatus(entry.status)) {
      setAction({
        kind: "info",
        text: `No pending approval for ${entry.runId.slice(0, 8)} (status=${entry.status})`,
      });
      return;
    }
    setAction({ kind: "info", text: `rejecting ${entry.runId.slice(0, 8)}…` });
    try {
      const res = (await api.rejectRun(entry.runId)) as { ok?: boolean; error?: string };
      if (res?.ok === false) {
        setAction({ kind: "error", text: `reject failed: ${res.error ?? "unknown"}` });
      } else {
        setAction({ kind: "ok", text: `Rejected ${entry.runId.slice(0, 8)}` });
        await refreshNow();
      }
    } catch (e) {
      setAction({ kind: "error", text: `reject failed: ${(e as Error).message}` });
    }
  };

  const trySubmit = async (prompt: string): Promise<void> => {
    setAction({ kind: "info", text: "submitting…" });
    try {
      const res = (await api.submitRun(prompt, process.cwd())) as {
        run_id?: string;
        status?: string;
      };
      const runIdShort = res?.run_id ? String(res.run_id).slice(0, 8) : "?";
      setAction({
        kind: "ok",
        text: `submitted: run=${runIdShort} status=${res?.status ?? "?"}`,
      });
      await refreshNow();
    } catch (e) {
      setAction({ kind: "error", text: `submit failed: ${(e as Error).message}` });
    }
  };

  useInput((char, key) => {
    if (mode === "submit") {
      if (key.escape) {
        setInput("");
        setMode("dashboard");
        setAction({ kind: "info", text: "submit cancelled" });
        return;
      }
      if (key.return) {
        const prompt = input.trim();
        setInput("");
        setMode("dashboard");
        if (prompt) void trySubmit(prompt);
        return;
      }
      if (key.backspace || key.delete) {
        setInput((s) => s.slice(0, -1));
        return;
      }
      if (char && !key.ctrl && !key.meta) setInput((s) => s + char);
      return;
    }

    if (mode === "detail") {
      if (key.escape || char === "q") setMode("dashboard");
      return;
    }

    // dashboard mode
    if (char === "q") { exit(); return; }
    if (char === "s") {
      setMode("submit");
      setAction({ kind: "info", text: "type prompt, [enter] to send, [esc] to cancel" });
      return;
    }
    if (char === "t") {
      setShowHistory((v) => {
        const next = !v;
        setAction({
          kind: "info",
          text: next ? "showing all runs (history on)" : "hiding old terminal runs",
        });
        return next;
      });
      return;
    }
    if (key.upArrow || char === "k") {
      setSelected((s) => Math.max(0, s - 1));
      return;
    }
    if (key.downArrow || char === "j") {
      setSelected((s) => Math.min(Math.max(0, filteredRuns.length - 1), s + 1));
      return;
    }
    if (key.return) {
      if (filteredRuns[selected]) setMode("detail");
      return;
    }
    const target = filteredRuns[selected];
    if (!target) return;
    if (char === "a") { void tryApprove(target); return; }
    if (char === "r") { void tryReject(target); return; }
  });

  const detail = filteredRuns[selected];
  const filterLabel = showHistory ? "all runs" : `live + last ${TERMINAL_LIMIT} terminal`;

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold color="cyan">Aedis TUI — Runs Dashboard</Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        {filteredRuns.length === 0 ? (
          <Text dimColor>
            {allRuns.length === 0
              ? "No runs yet. Press [s] to submit one."
              : `0 of ${allRuns.length} runs match current filter — press [t] to show history.`}
          </Text>
        ) : (
          filteredRuns.map((r, i) => {
            const isSel = i === selected;
            const marker = isSel ? "▶" : " ";
            const statusColor = isApprovableStatus(r.status)
              ? "yellow"
              : r.status === "PROMOTED"
                ? "green"
                : r.status === "REJECTED"
                  ? "red"
                  : isTerminalStatus(r.status)
                    ? "gray"
                    : "cyan";
            const row =
              `${marker} ` +
              `${r.status.padEnd(22).slice(0, 22)}  ` +
              `${r.runId.slice(0, 8)}  ` +
              `$${r.costUsd.toFixed(4)}  ` +
              `${(r.classification ?? "—").padEnd(18).slice(0, 18)}  ` +
              `${(r.prompt ?? "").replace(/\s+/g, " ").slice(0, 60)}`;
            return (
              <Text
                key={r.runId}
                inverse={isSel}
                bold={isSel}
                color={isSel ? undefined : statusColor}
              >
                {row}
              </Text>
            );
          })
        )}
      </Box>

      {mode === "submit" && (
        <Box
          marginTop={1}
          flexDirection="column"
          borderStyle="round"
          borderColor="cyan"
          paddingX={1}
        >
          <Text bold>Submit task</Text>
          <Text>
            &gt; {input}<Text inverse> </Text>
          </Text>
          <Text dimColor>[enter] send  [esc] cancel</Text>
        </Box>
      )}

      {mode === "detail" && detail && (
        <Box
          marginTop={1}
          flexDirection="column"
          borderStyle="single"
          paddingX={1}
        >
          <Text bold>Run detail</Text>
          <Text>id:             {detail.runId}</Text>
          <Text>status:         {detail.status}</Text>
          <Text>classification: {detail.classification ?? "—"}</Text>
          <Text>cost:           ${detail.costUsd.toFixed(4)}</Text>
          <Text>confidence:     {(detail.confidence * 100).toFixed(0)}%</Text>
          <Text>timestamp:      {detail.timestamp}</Text>
          <Text>prompt:         {detail.prompt}</Text>
          <Text dimColor>Detail screen is a stub. Press [esc] or [q] to return.</Text>
        </Box>
      )}

      <Box marginTop={1} flexDirection="column">
        <Text dimColor>
          {mode === "dashboard"
            ? "[s] submit  [a] approve  [r] reject  [t] toggle history  [↑/↓] select  [enter] detail  [q] quit"
            : mode === "submit"
              ? "[type] prompt  [enter] send  [esc] cancel"
              : "[esc] back"}
        </Text>
        <Text dimColor>
          Mode: {mode}  |  Filter: {filterLabel}  |  Showing {filteredRuns.length} of {allRuns.length}
        </Text>
        {action && (
          <Text
            color={
              action.kind === "ok" ? "green" : action.kind === "error" ? "red" : "yellow"
            }
          >
            Last action: {action.text}
          </Text>
        )}
        {pollError && <Text color="red">poll error: {pollError}</Text>}
      </Box>
    </Box>
  );
}
