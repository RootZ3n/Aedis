import test from "node:test";
import assert from "node:assert/strict";

import { formatDoctorReport, type DoctorInput } from "./aedis.js";

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
  assert.match(report, /server_built:\s+2026-04-27T22:00:00\.000Z/);
  assert.match(report, /local_commit:\s+abcdef01/);
  // No drift warnings expected on a matched checkout.
  assert.doesNotMatch(report, /differs from local/);
  assert.doesNotMatch(report, /no build metadata/);
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
  assert.match(report, /server commit 11111111 differs from local abcdef01/);
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
  assert.match(report, /source newer than dist/);
  assert.match(report, /\/repo\/core\/foo\.ts/);
  assert.match(report, /run `npm run build` and restart/);
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
  assert.doesNotMatch(report, /source newer than dist/);
});
