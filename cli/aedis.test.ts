import test from "node:test";
import assert from "node:assert/strict";

import { formatDoctorReport, formatProviderCheckReport, type DoctorInput } from "./aedis.js";

const KNOWN_LOCAL: DoctorInput["localBuild"] = {
  version: "1.0.0",
  commit: "abcdef0123456789abcdef0123456789abcdef01",
  commitShort: "abcdef01",
  buildTime: "2026-04-27T22:00:00.000Z",
  source: "build-info",
};

test("doctor: server reachable + matching commit prints expected fields with no warnings", () => {
  const report = formatDoctorReport({
    apiBase: "http://localhost:18796",
    health: {
      pid: 12345,
      port: 18796,
      uptime_human: "5m 49s",
      startedAt: "2026-04-27T21:55:00.000Z",
      build: { ...KNOWN_LOCAL },
      state: {
        root: "/tmp/aedis-state",
        receipts: "/tmp/aedis-state/state/receipts",
        projectRoot: "/tmp/target-repo",
        isolatedFromProject: true,
      },
      providerContract: {
        profile: "default",
        localSmokeCapable: true,
        localSmokeEnv: "AEDIS_MODEL_PROFILE=local-smoke",
        localSmokeModel: "qwen3.5:9b",
        requiredCloudKeys: ["OPENROUTER_API_KEY", "ZAI_API_KEY"],
        cloudRequired: true,
      },
    },
    fetchError: null,
    localBuild: KNOWN_LOCAL,
    freshness: null,
  });
  // Required fields present.
  assert.match(report, /reachable:\s+yes/);
  assert.match(report, /pid:\s+12345/);
  assert.match(report, /port:\s+18796/);
  assert.match(report, /uptime:\s+5m 49s/);
  assert.match(report, /server_commit:\s+abcdef01/);
  assert.match(report, /state_root:\s+\/tmp\/aedis-state/);
  assert.match(report, /receipts:\s+\/tmp\/aedis-state\/state\/receipts/);
  assert.match(report, /state_isolated:\s+yes/);
  assert.match(report, /model_profile:\s+default/);
  assert.match(report, /cloud_required:\s+yes/);
  assert.match(report, /cloud_keys:\s+OPENROUTER_API_KEY, ZAI_API_KEY/);
  assert.match(report, /local_smoke:\s+available \(AEDIS_MODEL_PROFILE=local-smoke, model qwen3\.5:9b\)/);
  assert.match(report, /server_built:\s+2026-04-27T22:00:00\.000Z/);
  assert.match(report, /local_commit:\s+abcdef01/);
  // No drift warnings expected on a matched checkout.
  assert.doesNotMatch(report, /differs from local/);
  assert.doesNotMatch(report, /no build metadata/);
});

test("doctor provider report points missing cloud-key users at local smoke when Ollama is ready", () => {
  const lines = formatProviderCheckReport(
    { provider: "ollama", ok: true, detail: "reachable at http://localhost:11434 — 2 model(s) installed" },
    [
      { provider: "openrouter", ok: false, detail: "OPENROUTER_API_KEY not set in environment" },
      { provider: "zai", ok: false, detail: "ZAI_API_KEY not set in environment" },
    ],
    "default",
  ).join("\n");

  assert.match(lines, /openrouter\s+FAIL\s+OPENROUTER_API_KEY not set/);
  assert.match(lines, /zai\s+FAIL\s+ZAI_API_KEY not set/);
  assert.match(lines, /local smoke mode is available with Ollama only/);
  assert.match(lines, /AEDIS_MODEL_PROFILE=local-smoke npm run start:dist/);
});

test("doctor provider report does not treat missing cloud keys as local-smoke blockers", () => {
  const lines = formatProviderCheckReport(
    { provider: "ollama", ok: true, detail: "reachable at http://localhost:11434 — 2 model(s) installed" },
    [
      { provider: "openrouter", ok: false, detail: "OPENROUTER_API_KEY not set in environment" },
      { provider: "zai", ok: false, detail: "ZAI_API_KEY not set in environment" },
    ],
    "local-smoke",
  ).join("\n");

  assert.match(lines, /local smoke mode is active; cloud keys are not required/);
});

test("doctor: server unreachable emits a clear failure line and the local build context", () => {
  const report = formatDoctorReport({
    apiBase: "http://localhost:18796",
    health: null,
    fetchError: "ECONNREFUSED",
    localBuild: KNOWN_LOCAL,
    freshness: null,
  });
  assert.match(report, /reachable:\s+no/);
  assert.match(report, /fetch_error:\s+ECONNREFUSED/);
  // Local context still printed so the operator can see what THIS dist
  // would offer if it were started.
  assert.match(report, /local_commit:\s+abcdef01/);
});

test("doctor: warns when server commit differs from local checkout", () => {
  const report = formatDoctorReport({
    apiBase: "http://localhost:18796",
    health: {
      pid: 1,
      port: 18796,
      uptime_human: "1h",
      startedAt: "2026-04-27T20:00:00.000Z",
      build: {
        version: "1.0.0",
        commit: "1111111111111111111111111111111111111111",
        commitShort: "11111111",
        buildTime: "2026-04-26T00:00:00.000Z",
        source: "build-info",
      },
    },
    fetchError: null,
    localBuild: KNOWN_LOCAL,
    freshness: null,
  });
  // Phrasing now lives in the STALE SERVER block (the same wording
  // is shared with the burn-in preamble via assessStaleness).
  assert.match(report, /STALE SERVER/);
  assert.match(report, /commit-mismatch/);
  assert.match(report, /11111111/);
  assert.match(report, /abcdef01/);
});

test("doctor: warns when server reports no build metadata at all", () => {
  const report = formatDoctorReport({
    apiBase: "http://localhost:18796",
    health: {
      pid: 1,
      port: 18796,
      uptime_human: "1h",
      // pre-build-metadata server: no `build` field
    },
    fetchError: null,
    localBuild: KNOWN_LOCAL,
    freshness: null,
  });
  assert.match(report, /server_commit:\s+unknown/);
  assert.match(report, /no build metadata/);
});

test("doctor: warns when source is newer than dist", () => {
  const report = formatDoctorReport({
    apiBase: "http://localhost:18796",
    health: {
      pid: 1,
      port: 18796,
      uptime_human: "1h",
      build: { ...KNOWN_LOCAL },
    },
    fetchError: null,
    localBuild: KNOWN_LOCAL,
    freshness: {
      sourceNewerThanDist: true,
      newestSourcePath: "/repo/core/foo.ts",
      newestSourceMtime: 2_000_000,
      distBuildTime: 1_000_000,
    },
  });
  // Phrasing now lives in the STALE SERVER block (shared with burn-in).
  assert.match(report, /STALE SERVER/);
  assert.match(report, /dist-older-than-source/);
  assert.match(report, /\/repo\/core\/foo\.ts/);
  assert.match(report, /npm run build/);
});

test("doctor: source-newer warning is suppressed when freshness reports no drift", () => {
  const report = formatDoctorReport({
    apiBase: "http://localhost:18796",
    health: {
      pid: 1,
      port: 18796,
      uptime_human: "1h",
      build: { ...KNOWN_LOCAL },
    },
    fetchError: null,
    localBuild: KNOWN_LOCAL,
    freshness: {
      sourceNewerThanDist: false,
      newestSourcePath: "/repo/core/foo.ts",
      newestSourceMtime: 1_000_000,
      distBuildTime: 2_000_000,
    },
  });
  // The new STALE block likewise stays out of the report when there's no drift.
  assert.doesNotMatch(report, /STALE SERVER/);
  assert.doesNotMatch(report, /dist-older-than-source/);
});

// ─── STALE SERVER block — uptime predates latest build ──────────────

test("doctor: STALE block fires when server uptime predates the latest dist build", () => {
  // Server started 60s before the build that produced dist/build-info.
  // A fresh build landed AFTER the server started → server is now
  // running an older dist than what's on disk. Restart needed.
  const startedAt = "2026-04-28T10:00:00.000Z";
  const distBuildTime = Date.parse(startedAt) + 60_000; // build 60s after start
  const report = formatDoctorReport({
    apiBase: "http://localhost:18796",
    health: {
      pid: 1,
      port: 18796,
      uptime_human: "1m",
      startedAt,
      build: {
        version: "1.0.0",
        commit: "abcdef0123456789abcdef0123456789abcdef01",
        commitShort: "abcdef01",
        buildTime: "2026-04-28T09:59:00.000Z",
        source: "build-info",
      },
    },
    fetchError: null,
    localBuild: {
      version: "1.0.0",
      commit: "abcdef0123456789abcdef0123456789abcdef01",
      commitShort: "abcdef01",
      buildTime: "2026-04-28T10:01:00.000Z",
      source: "build-info",
    },
    freshness: {
      sourceNewerThanDist: false,
      newestSourcePath: "/repo/core/x.ts",
      newestSourceMtime: distBuildTime - 60_000,
      distBuildTime,
    },
  });
  assert.match(report, /STALE SERVER/);
  assert.match(report, /uptime-predates-build/);
  assert.match(report, /restart the server/);
});

test("doctor: clean checkout + matching commit + fresh dist → no STALE block", () => {
  const t = Date.now();
  const startedAt = new Date(t).toISOString();
  const report = formatDoctorReport({
    apiBase: "http://localhost:18796",
    health: {
      pid: 1,
      port: 18796,
      uptime_human: "1m",
      startedAt,
      build: { ...KNOWN_LOCAL },
    },
    fetchError: null,
    localBuild: KNOWN_LOCAL,
    freshness: {
      sourceNewerThanDist: false,
      newestSourcePath: "/repo/core/x.ts",
      newestSourceMtime: t - 60_000,
      distBuildTime: t - 30_000, // dist built before server started, source older
    },
  });
  assert.doesNotMatch(report, /STALE SERVER/);
});
