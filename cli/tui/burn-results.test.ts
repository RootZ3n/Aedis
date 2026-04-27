import test from "node:test";
import assert from "node:assert/strict";

import {
  formatDurationMs,
  parseJsonl,
  parseRow,
  readSuite,
  summariseRows,
  type BurnSuiteSummary,
} from "./burn-results.js";

const SAMPLE_SOFT = JSON.stringify({
  scenarioId: "burn-in-01",
  timestamp: "2026-04-27T02:28:14.682Z",
  status_: "PASS",
  status: "PROMOTED",
  classification: "PARTIAL_SUCCESS",
  costUsd: 0.0123,
  durationMs: 12_500,
});

const SAMPLE_HARD_TIMEOUT = JSON.stringify({
  scenarioId: "h05-cross-file-rename",
  status_: "TIMEOUT",
  status: "TIMEOUT",
  costUsd: null,
  durationMs: 720_000,
});

const SAMPLE_BLOCKED = JSON.stringify({
  scenarioId: "h11-ambiguous-should-ask",
  status_: "FAIL",
  status: "INTERRUPTED",
  classification: "BLOCKED",
  costUsd: 0.001,
  durationMs: 4_000,
});

test("parseRow accepts a soft burn-in result and lifts verdict from status_", () => {
  const row = parseRow(JSON.parse(SAMPLE_SOFT));
  assert.ok(row);
  assert.equal(row.scenarioId, "burn-in-01");
  assert.equal(row.verdict, "PASS");
  assert.equal(row.costUsd, 0.0123);
  assert.equal(row.durationMs, 12_500);
});

test("parseRow lifts BLOCKED/SAFE_FAILURE from classification", () => {
  const row = parseRow(JSON.parse(SAMPLE_BLOCKED));
  assert.ok(row);
  assert.equal(row.verdict, "BLOCKED", "classification BLOCKED must override status_ FAIL");
});

test("parseRow returns null for missing scenarioId", () => {
  assert.equal(parseRow({ status_: "PASS" }), null);
  assert.equal(parseRow(null), null);
  assert.equal(parseRow("not an object"), null);
});

test("parseJsonl skips blanks and counts unparseable lines", () => {
  const text = [SAMPLE_SOFT, "", "not-json", SAMPLE_HARD_TIMEOUT, "  "].join("\n");
  const { rows, parseErrors } = parseJsonl(text);
  assert.equal(rows.length, 2);
  assert.equal(parseErrors, 1);
});

test("summariseRows aggregates costs, durations, verdict buckets", () => {
  const rows = parseJsonl([SAMPLE_SOFT, SAMPLE_HARD_TIMEOUT, SAMPLE_BLOCKED].join("\n")).rows;
  const summary = summariseRows("/tmp/x.jsonl", rows, true, null, 0);
  assert.equal(summary.total, 3);
  assert.equal(summary.pass, 1);
  assert.equal(summary.fail, 0, "BLOCKED takes precedence over FAIL classification");
  assert.equal(summary.timeout, 1);
  assert.equal(summary.blocked, 1);
  // Cost is 0.0123 + null + 0.001 = 0.0133.
  assert.ok(Math.abs(summary.totalCostUsd - 0.0133) < 1e-9);
  assert.equal(summary.totalDurationMs, 12_500 + 720_000 + 4_000);
  assert.equal(summary.lastTimestamp, "2026-04-27T02:28:14.682Z");
});

test("readSuite returns empty-but-valid summary when file does not exist", () => {
  const summary = readSuite("/path/that/should/not/exist.jsonl", {
    fileExists: () => false,
    readFile: () => "",
    fileMtime: () => null,
  });
  assert.equal(summary.exists, false);
  assert.equal(summary.total, 0);
  assert.equal(summary.rows.length, 0);
});

test("readSuite parses an injected file body", () => {
  const summary = readSuite("/fake/path.jsonl", {
    fileExists: () => true,
    readFile: () => [SAMPLE_SOFT, SAMPLE_BLOCKED].join("\n"),
    fileMtime: () => "2026-04-27T03:00:00.000Z",
  });
  assert.equal(summary.exists, true);
  assert.equal(summary.total, 2);
  assert.equal(summary.pass, 1);
  assert.equal(summary.blocked, 1);
  assert.equal(summary.fileMtime, "2026-04-27T03:00:00.000Z");
});

test("formatDurationMs renders compact human strings", () => {
  assert.equal(formatDurationMs(0), "0s");
  assert.equal(formatDurationMs(12_500), "12s");
  assert.equal(formatDurationMs(60_000), "1m");
  assert.equal(formatDurationMs(75_000), "1m15s");
  assert.equal(formatDurationMs(3_600_000), "1h");
  assert.equal(formatDurationMs(3_660_000), "1h1m");
});

test("summariseRows: empty rows produce zero-everything summary", () => {
  const summary: BurnSuiteSummary = summariseRows("/x", [], true, null, 0);
  assert.equal(summary.total, 0);
  assert.equal(summary.totalCostUsd, 0);
  assert.equal(summary.totalDurationMs, 0);
  assert.equal(summary.lastTimestamp, null);
});
