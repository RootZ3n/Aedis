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

async function buildApp(policy?: unknown) {
  const fastify = (await import("fastify")).default;
  const app = fastify();
  (app as any).decorate("ctx", {
    receiptStore: { /* unused by /health */ },
    coordinator: {},
    eventBus: { clientCount: () => 0 },
    workerRegistry: {
      getWorkers: () => [{}],
    },
    config: { projectRoot: "/tmp/health-test", stateRoot: "/tmp/aedis-health-state", port: 18796 },
    startedAt: "2026-04-27T22:00:00.000Z",
    pid: 4242,
    build: STUB_BUILD,
    getRuntimePolicy: () => policy ?? {
      autoPromote: false,
      approvalRequired: true,
      destructiveOps: "blocked",
      laneMode: "unset",
      shadowPromoteAllowed: false,
      requireWorkspace: true,
    },
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

test("GET /health surfaces runtime state root without secrets", async () => {
  const app = await buildApp();
  try {
    const res = await app.inject({ method: "GET", url: "/health" });
    const body = res.json();
    assert.equal(body.state.root, "/tmp/aedis-health-state");
    assert.equal(body.state.receipts, "/tmp/aedis-health-state/state/receipts");
    assert.equal(body.state.projectRoot, "/tmp/health-test");
    assert.equal(body.state.isolatedFromProject, true);
    assert.equal(JSON.stringify(body).includes("super-secret"), false);
  } finally {
    await app.close();
  }
});

test("GET /health surfaces provider contract for default cloud-required mode", async () => {
  const prev = process.env.AEDIS_MODEL_PROFILE;
  delete process.env.AEDIS_MODEL_PROFILE;
  const app = await buildApp();
  try {
    const res = await app.inject({ method: "GET", url: "/health" });
    const body = res.json();
    assert.equal(body.providerContract.profile, "default");
    assert.equal(body.providerContract.cloudRequired, true);
    assert.deepEqual(body.providerContract.requiredCloudKeys, ["OPENROUTER_API_KEY", "ZAI_API_KEY"]);
    assert.equal(body.providerContract.localSmokeEnv, "AEDIS_MODEL_PROFILE=local-smoke");
    assert.equal(JSON.stringify(body).includes("SECRET"), false);
  } finally {
    if (prev !== undefined) process.env.AEDIS_MODEL_PROFILE = prev;
    await app.close();
  }
});

test("GET /health surfaces provider contract for local smoke mode", async () => {
  const prev = process.env.AEDIS_MODEL_PROFILE;
  process.env.AEDIS_MODEL_PROFILE = "local-smoke";
  const app = await buildApp();
  try {
    const res = await app.inject({ method: "GET", url: "/health" });
    const body = res.json();
    assert.equal(body.providerContract.profile, "local-smoke");
    assert.equal(body.providerContract.cloudRequired, false);
    assert.deepEqual(body.providerContract.requiredCloudKeys, []);
    assert.equal(body.providerContract.localSmokeModel, "qwen3.5:9b");
  } finally {
    if (prev === undefined) delete process.env.AEDIS_MODEL_PROFILE;
    else process.env.AEDIS_MODEL_PROFILE = prev;
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

test("GET /health surfaces the runtime safety policy block (safe defaults)", async () => {
  // The policy panel is the operator-facing summary of what the
  // running server is allowed to do. Without it on /health, the TUI
  // and `aedis doctor` have no source of truth. Pin the safe shape.
  const app = await buildApp();
  try {
    const res = await app.inject({ method: "GET", url: "/health" });
    const body = res.json();
    assert.ok(body.policy, "/health response must include a policy block");
    assert.equal(body.policy.autoPromote, false);
    assert.equal(body.policy.approvalRequired, true);
    assert.equal(body.policy.destructiveOps, "blocked");
    assert.equal(body.policy.shadowPromoteAllowed, false);
    assert.equal(body.policy.requireWorkspace, true);
  } finally {
    await app.close();
  }
});

test("GET /health: policy reflects an unsafe override when one is supplied", async () => {
  // When the operator explicitly disables a guard, /health must show
  // it — silent unsafe behavior is the bug we're guarding against.
  const app = await buildApp({
    autoPromote: true,
    approvalRequired: false,
    destructiveOps: "allowed",
    laneMode: "primary_only",
    shadowPromoteAllowed: false,
    requireWorkspace: true,
  });
  try {
    const res = await app.inject({ method: "GET", url: "/health" });
    const body = res.json();
    assert.equal(body.policy.autoPromote, true);
    assert.equal(body.policy.approvalRequired, false);
    assert.equal(body.policy.destructiveOps, "allowed");
    assert.equal(body.policy.laneMode, "primary_only");
    assert.equal(body.policy.shadowPromoteAllowed, false, "structural invariant survives unsafe overrides");
  } finally {
    await app.close();
  }
});
