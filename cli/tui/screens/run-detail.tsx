import { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";

import {
  getRunDetail as defaultGetRunDetail,
  type CandidateManifestRow,
  type RunDetailData,
} from "../api.js";

type Panel = "summary" | "diff" | "verifier" | "errors" | "candidates";

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

/**
 * Pure formatters for the candidate-lanes panel. Exported so the test
 * suite can pin individual cells without rendering the screen.
 */
export function formatCandidateRow(c: CandidateManifestRow): string {
  const role = c.role.padEnd(7).slice(0, 7);
  const lane = (c.lane ?? "—").padEnd(5).slice(0, 5);
  const provider = (c.provider ?? "—").padEnd(11).slice(0, 11);
  const model = (c.model ?? "—").padEnd(20).slice(0, 20);
  const status = c.status.padEnd(8).slice(0, 8);
  const verifier = (c.verifierVerdict ?? "—").padEnd(18).slice(0, 18);
  const tests = c.testsPassed === undefined ? "—" : c.testsPassed ? "✓" : "✗";
  const types = c.typecheckPassed === undefined ? "—" : c.typecheckPassed ? "✓" : "✗";
  const findings =
    `${c.criticalFindings ?? 0}c/${c.advisoryFindings ?? 0}a`.padEnd(7).slice(0, 7);
  return `${role} ${lane} ${provider} ${model} ${status} ${verifier} t:${tests} tc:${types} ${findings}`;
}

/** Color hint for a candidate row's status. */
export function candidateStatusColor(c: CandidateManifestRow): "green" | "red" | "yellow" | "gray" {
  if (c.status === "passed" && (c.disqualification ?? null) === null) return "green";
  if (c.disqualification) return "red";
  if (c.status === "failed" || c.status === "rejected") return "red";
  if (c.status === "pending") return "yellow";
  return "gray";
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
    // [c] toggles the candidate-lanes panel. Pressing it twice
    // (once to open, once to close) returns to the summary-only
    // view so existing muscle memory ([d]/[v]/[e] swap, [c] also
    // swaps but is also a toggle) keeps working.
    if (char === "c") {
      setPanel((p) => (p === "candidates" ? "summary" : "candidates"));
      return;
    }
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

      {panel === "candidates" && (
        <Box marginTop={1} flexDirection="column" borderStyle="single" borderColor="cyan" paddingX={1}>
          <Text bold>Candidate Lanes</Text>
          {(!detail.candidates || detail.candidates.length === 0) ? (
            <Text dimColor>No candidate lane data for this run.</Text>
          ) : (
            <>
              <Text>laneMode:                  {detail.laneMode ?? "—"}</Text>
              <Text>selectedCandidate:         {detail.selectedCandidateWorkspaceId ?? "—"}</Text>
              <Box marginTop={1} flexDirection="column">
                <Text dimColor>
                  {"role".padEnd(7)} {"lane".padEnd(5)} {"provider".padEnd(11)} {"model".padEnd(20)} {"status".padEnd(8)} {"verdict".padEnd(18)} tests typecheck findings
                </Text>
                {detail.candidates.map((c) => {
                  const isSelected = c.workspaceId === detail.selectedCandidateWorkspaceId;
                  const marker = isSelected ? "★ " : "  ";
                  return (
                    <Box key={c.workspaceId} flexDirection="column">
                      <Text color={candidateStatusColor(c)} bold={isSelected}>
                        {marker}{formatCandidateRow(c)}
                      </Text>
                      {c.disqualification && (
                        <Text color="red">    disqualified: {c.disqualification}</Text>
                      )}
                      {isSelected && (
                        <Text color="green">    selected</Text>
                      )}
                    </Box>
                  );
                })}
              </Box>
            </>
          )}
        </Box>
      )}

      <Box marginTop={1} flexDirection="column">
        <Text dimColor>
          [d] diff  [v] verifier  [e] errors  [c] candidate lanes  [esc] back
        </Text>
        <Text dimColor>Panel: {panel}</Text>
      </Box>
    </Box>
  );
}
