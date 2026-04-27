import { useEffect, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";

import {
  approveRun,
  listRuns,
  rejectRun,
  submitRun,
  type RunListEntry,
} from "../api.js";

const POLL_MS = 1000;
const MAX_RUNS = 20;

type Mode = "list" | "submit" | "detail";

export function RunsScreen() {
  const { exit } = useApp();
  const [runs, setRuns] = useState<readonly RunListEntry[]>([]);
  const [selected, setSelected] = useState(0);
  const [mode, setMode] = useState<Mode>("list");
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    async function tick(): Promise<void> {
      try {
        const data = await listRuns(MAX_RUNS);
        if (!alive) return;
        setRuns(data);
        setError(null);
      } catch (err) {
        if (!alive) return;
        setError((err as Error).message);
      }
    }
    void tick();
    const id = setInterval(() => { void tick(); }, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  useInput((char, key) => {
    if (mode === "submit") {
      if (key.escape) {
        setInput("");
        setMode("list");
        return;
      }
      if (key.return) {
        const prompt = input.trim();
        setInput("");
        setMode("list");
        if (prompt) {
          setStatus("submitting…");
          submitRun(prompt, process.cwd())
            .then((r) => setStatus(`submitted: run=${r.run_id ?? "?"} status=${r.status ?? "?"}`))
            .catch((e: Error) => setStatus(`submit failed: ${e.message}`));
        }
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
      if (key.escape) setMode("list");
      return;
    }

    if (char === "q" || key.escape) {
      exit();
      return;
    }
    if (char === "s") { setMode("submit"); return; }
    if (key.upArrow || char === "k") { setSelected((s) => Math.max(0, s - 1)); return; }
    if (key.downArrow || char === "j") {
      setSelected((s) => Math.min(Math.max(0, runs.length - 1), s + 1));
      return;
    }
    if (key.return) {
      if (runs[selected]) setMode("detail");
      return;
    }
    const target = runs[selected];
    if (!target) return;
    if (char === "a") {
      const id = target.runId;
      setStatus(`approving ${id.slice(0, 8)}…`);
      approveRun(id)
        .then(() => setStatus(`approved ${id.slice(0, 8)}`))
        .catch((e: Error) => setStatus(`approve failed: ${e.message}`));
      return;
    }
    if (char === "r") {
      const id = target.runId;
      setStatus(`rejecting ${id.slice(0, 8)}…`);
      rejectRun(id)
        .then(() => setStatus(`rejected ${id.slice(0, 8)}`))
        .catch((e: Error) => setStatus(`reject failed: ${e.message}`));
    }
  });

  const detail = runs[selected];

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold color="cyan">Aedis TUI — Runs Dashboard</Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        {runs.length === 0 ? (
          <Text dimColor>No runs yet. Press [s] to submit one.</Text>
        ) : (
          runs.map((r, i) => (
            <Text key={r.runId} inverse={i === selected}>
              {i === selected ? "▶ " : "  "}
              {r.status.padEnd(20).slice(0, 20)}{"  "}
              {r.runId.slice(0, 8)}{"  "}
              ${r.costUsd.toFixed(4)}{"  "}
              {(r.classification ?? "—").padEnd(18).slice(0, 18)}{"  "}
              {(r.prompt ?? "").replace(/\s+/g, " ").slice(0, 60)}
            </Text>
          ))
        )}
      </Box>

      {mode === "submit" && (
        <Box marginTop={1}>
          <Text>prompt&gt; {input}</Text>
        </Box>
      )}

      {mode === "detail" && detail && (
        <Box marginTop={1} flexDirection="column" borderStyle="single" paddingX={1}>
          <Text bold>Run detail</Text>
          <Text>id:             {detail.runId}</Text>
          <Text>status:         {detail.status}</Text>
          <Text>classification: {detail.classification ?? "—"}</Text>
          <Text>cost:           ${detail.costUsd.toFixed(4)}</Text>
          <Text>confidence:     {(detail.confidence * 100).toFixed(0)}%</Text>
          <Text>timestamp:      {detail.timestamp}</Text>
          <Text>prompt:         {detail.prompt}</Text>
          <Text dimColor>Detail screen is a stub. Press Esc to return.</Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>
          {mode === "list"
            ? "[s] submit  [a] approve  [r] reject  [↑/↓] select  [enter] detail  [q] quit"
            : mode === "submit"
              ? "[enter] send  [esc] cancel"
              : "[esc] back"}
        </Text>
      </Box>

      {status && <Text color="yellow">{status}</Text>}
      {error && <Text color="red">error: {error}</Text>}
    </Box>
  );
}
