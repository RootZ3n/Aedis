import test from "node:test";
import assert from "node:assert/strict";

import { healthRoutes } from "./health.js";

const STUB_BUILD = {
  version: "1.2.3",
  commit: "abcdef0123456789abcdef0123456789abcdef01",
  commitShort: "abcdef01",
  buildTime: "2026-04-27T22:00:00.000Z",
  source: "build-info" as const,
};

async function buildApp() {
  const fastify = (await import("fastify")).default;
  const app = fastify();
  (app as any).decorate("ctx", {
    receiptStore: { /* unused by /health */ },
    coordinator: {},
    eventBus: { clientCount: () => 0 },
    workerRegistry: {
      getWorkers: () => [{}],
    },
    config: { projectRoot: "/tmp/health-test", port: 18796 },
    startedAt: "2026-04-27T22:00:00.000Z",
    pid: 4242,
    build: STUB_BUILD,
  });
  await app.register(healthRoutes);
  return app;
}

test("GET /health surfaces pid, startedAt, and build metadata", async () => {
  // Without these fields the duplicate-server / stale-dist diagnosis
  // is impossible — the burn-in BLOCKED race went undetected exactly
  // because /health didn't expose pid or commit.
  const app = await buildApp();
  try {
    const res = await app.inject({ method: "GET", url: "/health" });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.pid, 4242);
    assert.equal(body.startedAt, "2026-04-27T22:00:00.000Z");
    assert.deepEqual(body.build, STUB_BUILD);
    // Legacy `version` field still mirrors build.version for older readers.
    assert.equal(body.version, STUB_BUILD.version);
  } finally {
    await app.close();
  }
});

test("GET /health remains backwards-compatible: existing fields are unchanged", async () => {
  const app = await buildApp();
  try {
    const res = await app.inject({ method: "GET", url: "/health" });
    const body = res.json();
    assert.equal(body.status, "healthy");
    assert.equal(body.port, 18796);
    assert.ok(typeof body.uptime_human === "string");
    assert.ok(body.workers && body.workers.builder.available === true);
    assert.equal(body.websocket.endpoint, "/ws");
  } finally {
    await app.close();
  }
});
