/**
 * Server-staleness assessor — pure-function tests for assessStaleness.
 * Pin the three independent stale conditions and the conservative
 * "missing data is not stale" contract.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { assessStaleness } from "./staleness.js";

// ─── No-data / negative cases ───────────────────────────────────────

test("assessStaleness: empty input returns not-stale (no false positives on missing data)", () => {
  const r = assessStaleness({});
  assert.equal(r.stale, false);
  assert.deepEqual(r.reasons, []);
});

test("assessStaleness: 'unknown' commit values are treated as missing, not as mismatch", () => {
  const r = assessStaleness({ localCommit: "unknown", serverCommit: "unknown" });
  assert.equal(r.stale, false);
});

test("assessStaleness: empty-string commit on either side does not flag mismatch", () => {
  const r = assessStaleness({ localCommit: "", serverCommit: "abc12345" });
  assert.equal(r.stale, false);
});

// ─── Rule 1: commit mismatch ────────────────────────────────────────

test("assessStaleness: commit mismatch fires when both sides are known and differ", () => {
  const r = assessStaleness({
    localCommit: "abcdef0123",
    serverCommit: "fedcba9876",
  });
  assert.equal(r.stale, true);
  assert.equal(r.reasons.length, 1);
  assert.equal(r.reasons[0]!.code, "commit-mismatch");
  assert.match(r.reasons[0]!.message, /abcdef01/);
  assert.match(r.reasons[0]!.message, /fedcba98/);
});

test("assessStaleness: matching commits do not flag mismatch", () => {
  const r = assessStaleness({
    localCommit: "deadbeef",
    serverCommit: "deadbeef",
  });
  assert.equal(r.stale, false);
});

// ─── Rule 2: dist older than source ─────────────────────────────────

test("assessStaleness: dist older than source flags dist-older-than-source", () => {
  const r = assessStaleness({
    distBuildTimeMs: 1000,
    newestSourceMtimeMs: 5000, // 4 seconds newer
    newestSourcePath: "core/coordinator.ts",
  });
  assert.equal(r.stale, true);
  assert.equal(r.reasons[0]!.code, "dist-older-than-source");
  assert.match(r.reasons[0]!.message, /4s newer/);
  assert.match(r.reasons[0]!.message, /core\/coordinator\.ts/);
});

test("assessStaleness: dist newer than source does NOT flag", () => {
  const r = assessStaleness({
    distBuildTimeMs: 5000,
    newestSourceMtimeMs: 1000,
  });
  assert.equal(r.stale, false);
});

// ─── Rule 3: server uptime predates latest build ────────────────────

test("assessStaleness: server started BEFORE latest build → uptime-predates-build", () => {
  const startedAt = "2026-04-28T10:00:00.000Z";
  const buildTimeMs = Date.parse(startedAt) + 30_000; // build 30s after start
  const r = assessStaleness({
    distBuildTimeMs: buildTimeMs,
    serverStartedAtIso: startedAt,
  });
  assert.equal(r.stale, true);
  assert.equal(r.reasons[0]!.code, "uptime-predates-build");
  assert.match(r.reasons[0]!.message, /30s before/);
});

test("assessStaleness: server started AFTER latest build → not stale on this rule", () => {
  const startedAt = "2026-04-28T10:00:00.000Z";
  const buildTimeMs = Date.parse(startedAt) - 60_000; // build 60s BEFORE start
  const r = assessStaleness({
    distBuildTimeMs: buildTimeMs,
    serverStartedAtIso: startedAt,
  });
  assert.equal(r.stale, false);
});

test("assessStaleness: invalid startedAt date is ignored (not stale)", () => {
  const r = assessStaleness({
    distBuildTimeMs: 5000,
    serverStartedAtIso: "not-a-date",
  });
  assert.equal(r.stale, false);
});

// ─── Multiple rules can fire simultaneously ─────────────────────────

test("assessStaleness: all three rules fire together when every signal is bad", () => {
  const startedAt = "2026-04-28T10:00:00.000Z";
  const buildTimeMs = Date.parse(startedAt) + 60_000;
  const r = assessStaleness({
    localCommit: "aaaa1111",
    serverCommit: "bbbb2222",
    distBuildTimeMs: buildTimeMs,
    newestSourceMtimeMs: buildTimeMs + 10_000,
    newestSourcePath: "src/x.ts",
    serverStartedAtIso: startedAt,
  });
  assert.equal(r.stale, true);
  assert.equal(r.reasons.length, 3);
  const codes = r.reasons.map((x) => x.code).sort();
  assert.deepEqual(codes, [
    "commit-mismatch",
    "dist-older-than-source",
    "uptime-predates-build",
  ]);
});
