import { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";

import {
  getRunDetail as defaultGetRunDetail,
  type RunDetailData,
} from "../api.js";

type Panel = "summary" | "diff" | "verifier" | "errors";

export interface RunDetailProps {
  readonly runId: string;
  readonly onBack: () => void;
  readonly getRunDetail?: typeof defaultGetRunDetail;
}

function formatDuration(start: string, end: string | null): string {
  if (!end) return "in-progress";
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return rem ? `${m}m${rem}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const mRem = m % 60;
  return mRem ? `${h}h${mRem}m` : `${h}h`;
}

export function RunDetailScreen({
  runId,
  onBack,
  getRunDetail = defaultGetRunDetail,
}: RunDetailProps) {
  const [detail, setDetail] = useState<RunDetailData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel>("summary");

  useEffect(() => {
    let alive = true;
    void getRunDetail(runId).then(
      (d) => { if (alive) setDetail(d); },
      (e) => { if (alive) setError((e as Error).message); },
    );
    return () => { alive = false; };
  }, [runId, getRunDetail]);

  useInput((char, key) => {
    if (key.escape || char === "q") { onBack(); return; }
    if (char === "d") { setPanel("diff"); return; }
    if (char === "v") { setPanel("verifier"); return; }
    if (char === "e") { setPanel("errors"); return; }
  });

  if (error) {
    return (
      <Box flexDirection="column">
        <Text bold color="red">Error loading run {runId.slice(0, 8)}</Text>
        <Text>{error}</Text>
        <Text dimColor>[esc] back</Text>
      </Box>
    );
  }

  if (!detail) {
    return (
      <Box flexDirection="column">
        <Text bold color="cyan">Run Detail</Text>
        <Text dimColor>Loading {runId.slice(0, 8)}...</Text>
        <Text dimColor>[esc] back</Text>
      </Box>
    );
  }

  const fe = detail.summary.failureExplanation;
  const checks = detail.summary.verificationChecks ?? [];
  const duration = formatDuration(detail.submittedAt, detail.completedAt);

  return (
    <Box flexDirection="column">
      <Text bold color="cyan">Run Detail</Text>

      {/* Summary section — always visible */}
      <Box marginTop={1} flexDirection="column" borderStyle="single" paddingX={1}>
        <Text bold>Summary</Text>
        <Text>runId:          {detail.runId}</Text>
        <Text>status:         <Text color={detail.status === "PROMOTED" || detail.status === "VERIFIED_PASS" ? "green" : detail.status === "REJECTED" || detail.status === "VERIFIED_FAIL" || detail.status === "EXECUTION_ERROR" ? "red" : "yellow"}>{detail.status}</Text></Text>
        <Text>classification: {detail.summary.classification ?? "—"}</Text>
        <Text>cost:           ${detail.totalCostUsd.toFixed(4)}</Text>
        <Text>duration:       {duration}</Text>
        <Text>filesChanged:   {detail.filesChanged.length === 0
          ? "none"
          : detail.filesChanged.map((f) => `${f.operation} ${f.path}`).join(", ")}</Text>
      </Box>

      {/* Failure explanation — show when present */}
      {fe && (
        <Box marginTop={1} flexDirection="column" borderStyle="single" borderColor="red" paddingX={1}>
          <Text bold color="red">Failure</Text>
          <Text>code:         {fe.code}</Text>
          <Text>stage:        {fe.stage}</Text>
          <Text>rootCause:    {fe.rootCause}</Text>
          <Text>suggestedFix: {fe.suggestedFix}</Text>
        </Box>
      )}

      {/* Toggle panels */}
      {panel === "diff" && (
        <Box marginTop={1} flexDirection="column" borderStyle="single" borderColor="cyan" paddingX={1}>
          <Text bold>Diff</Text>
          {detail.filesChanged.length === 0
            ? <Text dimColor>No files changed.</Text>
            : detail.filesChanged.map((f) => (
                <Text key={f.path} color={f.operation === "create" ? "green" : f.operation === "delete" ? "red" : "yellow"}>
                  {f.operation.padEnd(8)} {f.path}
                </Text>
              ))}
        </Box>
      )}

      {panel === "verifier" && (
        <Box marginTop={1} flexDirection="column" borderStyle="single" borderColor="cyan" paddingX={1}>
          <Text bold>Verifier Stages</Text>
          <Text>overall: {detail.summary.verification}</Text>
          {checks.length === 0
            ? <Text dimColor>No verification checks recorded.</Text>
            : checks.map((c) => (
                <Text
                  key={c.kind + c.name}
                  color={!c.executed ? "gray" : c.passed ? "green" : "red"}
                >
                  {c.executed ? (c.passed ? "PASS" : "FAIL") : "SKIP"}  {c.kind}: {c.name}
                </Text>
              ))}
        </Box>
      )}

      {panel === "errors" && (
        <Box marginTop={1} flexDirection="column" borderStyle="single" borderColor="red" paddingX={1}>
          <Text bold>Errors</Text>
          {detail.errors.length === 0
            ? <Text dimColor>No errors.</Text>
            : detail.errors.map((e, i) => (
                <Box key={`${e.source}-${i}`} flexDirection="column">
                  <Text color="red">[{e.source}] {e.message}</Text>
                  {e.suggestedFix && <Text color="yellow">  fix: {e.suggestedFix}</Text>}
                </Box>
              ))}
        </Box>
      )}

      <Box marginTop={1} flexDirection="column">
        <Text dimColor>
          [d] diff  [v] verifier  [e] errors  [esc] back
        </Text>
        <Text dimColor>Panel: {panel}</Text>
      </Box>
    </Box>
  );
}
