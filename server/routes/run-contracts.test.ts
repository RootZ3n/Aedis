import test from "node:test";
import assert from "node:assert/strict";

import {
  buildRunDetailResponse,
  buildRunIntegrationResponse,
  buildRunListEntry,
} from "./run-contracts.js";

test("run contracts produce stable list entries", () => {
  const entry = buildRunListEntry({
    id: "run-1",
    runId: "run-1",
    status: "COMPLETE",
    classification: "VERIFIED_SUCCESS",
    prompt: "fix auth flow",
    summary: "Aedis updated auth flow",
    costUsd: 0.12,
    confidence: 0.91,
    timestamp: "2026-04-11T10:00:00.000Z",
    completedAt: "2026-04-11T10:01:00.000Z",
  });
  assert.equal(entry.prompt, "fix auth flow");
  assert.equal(entry.runId, "run-1");
});

test("run contracts produce stable detail responses", () => {
  const detail = buildRunDetailResponse({
    id: "run-1",
    taskId: "task-1",
    runId: "run-1",
    status: "COMPLETE",
    prompt: "fix auth flow",
    submittedAt: "2026-04-11T10:00:00.000Z",
    completedAt: "2026-04-11T10:01:00.000Z",
    receipt: null,
    filesChanged: [],
    summary: {
      classification: "VERIFIED_SUCCESS",
      headline: "done",
      narrative: "",
      verification: "pass",
    },
    confidence: { overall: 0.9 },
    errors: [],
    executionVerified: true,
    executionGateReason: null,
    blastRadius: null,
    totalCostUsd: 0.12,
    workerEvents: [],
    checkpoints: [],
  });
  assert.equal(detail.taskId, "task-1");
  assert.equal(detail.prompt, "fix auth flow");
});

test("run contracts produce stable integration responses", () => {
  const integration = buildRunIntegrationResponse({
    runId: "run-1",
    status: "COMPLETE",
    integration: {
      verdict: "approved",
      summary: "MERGE APPROVED",
      events: [],
      lastCheck: null,
    },
    workerEvents: [],
    checkpoints: [],
  });
  assert.equal(integration.integration.verdict, "approved");
  assert.equal(integration.runId, "run-1");
});
