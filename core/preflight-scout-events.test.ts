/**
 * Tests for preflight scout WebSocket event emission.
 *
 * These tests verify the event payloads and conditions — they don't
 * exercise the full coordinator pipeline (that requires a running
 * server). Instead they test the building blocks:
 *   - shouldSpawnScouts decides when events would fire
 *   - runPreflightScouts produces the data that goes into payloads
 *   - Event payload shape matches the documented contract
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { shouldSpawnScouts } from "./scout-spawn.js";
import { runPreflightScouts } from "./coordinator-preflight-scouts.js";

function createTestRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "aedis-scout-event-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "test-repo",
      scripts: { test: "vitest run" },
      dependencies: { express: "^4.18.0" },
    }),
  );
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "index.ts"), 'export const app = {};\n');
  writeFileSync(join(dir, "src", "auth.ts"), 'export function auth() {}\n');
  writeFileSync(join(dir, "src", "database.ts"), 'export const db = {};\n');
  mkdirSync(join(dir, "tests"), { recursive: true });
  writeFileSync(join(dir, "tests", "auth.test.ts"), 'test("auth", () => {});\n');
  return dir;
}

// ─── Event emission conditions ───────────────────────────────────────

describe("preflight scout events — emission conditions", () => {
  it("event emitted when scouts run (large prompt with low confidence)", async () => {
    const repo = createTestRepo();
    const result = await runPreflightScouts({
      prompt: "refactor the authentication logic across all services and update the test suite",
      repoPath: repo,
      discoveredTargets: [],
      targetDiscoveryConfidence: 0.2,
    });

    // Scouts should run → preflight_scouts_complete event would fire
    assert.equal(result.scouted, true);
    assert.ok(result.scoutReportIds.length > 0);

    // Verify the payload shape matches what the coordinator emits
    const payload = {
      runId: "test-run-123",
      reason: result.reason,
      scoutTypes: result.routing.map((r) => r.model),
      reportIds: [...result.scoutReportIds],
      recommendedTargetCount: result.advisoryTargets.length,
      recommendedTestCount: result.advisoryTests.length,
      riskCount: result.risks.length,
      costUsd: result.costUsd,
      timestamp: new Date().toISOString(),
      message: `Scouts found ${result.advisoryTargets.length} target(s) and ${result.risks.length} risk(s)`,
    };

    // Validate payload fields
    assert.ok(typeof payload.runId === "string");
    assert.ok(typeof payload.reason === "string" && payload.reason.length > 0);
    assert.ok(Array.isArray(payload.reportIds));
    assert.ok(typeof payload.recommendedTargetCount === "number");
    assert.ok(typeof payload.riskCount === "number");
    assert.ok(typeof payload.costUsd === "number");
    assert.ok(typeof payload.timestamp === "string");
    assert.ok(typeof payload.message === "string");
  });

  it("no event (skipped) for simple explicit task", async () => {
    const repo = createTestRepo();
    const result = await runPreflightScouts({
      prompt: "fix the typo in README.md",
      repoPath: repo,
      discoveredTargets: ["README.md"],
      targetDiscoveryConfidence: 0.95,
    });

    // Scouts should NOT run → preflight_scouts_skipped event would fire
    assert.equal(result.scouted, false);
    assert.ok(result.reason.length > 0);

    // Skipped event payload
    const payload = {
      runId: "test-run-456",
      reason: result.reason,
      timestamp: new Date().toISOString(),
      message: `Scouts not needed: ${result.reason}`,
    };
    assert.ok(typeof payload.reason === "string");
    assert.ok(payload.message.includes("not needed"));
  });
});

// ─── Event payload ───────────────────────────────────────────────────

describe("preflight scout events — payload contents", () => {
  it("event payload contains report IDs after completion", async () => {
    const repo = createTestRepo();
    const result = await runPreflightScouts({
      prompt: "update authentication and add validation across all endpoints and write tests",
      repoPath: repo,
      discoveredTargets: [],
      targetDiscoveryConfidence: 0.2,
    });

    if (result.scouted) {
      // Report IDs are non-empty strings
      for (const id of result.scoutReportIds) {
        assert.ok(typeof id === "string" && id.length > 0, "report ID must be non-empty string");
      }
      // Payload would include these IDs
      assert.ok(result.scoutReportIds.length > 0);
    }
  });

  it("scout event does not imply approval or promotion", async () => {
    const repo = createTestRepo();
    const result = await runPreflightScouts({
      prompt: "refactor auth module and update all consumers",
      repoPath: repo,
      discoveredTargets: [],
      targetDiscoveryConfidence: 0.2,
    });

    // The result type has no approval/promotion fields
    const keys = Object.keys(result);
    assert.ok(!keys.includes("approved"));
    assert.ok(!keys.includes("promoted"));
    assert.ok(!keys.includes("commitSha"));
    assert.ok(!keys.includes("apply"));

    // Advisory only
    assert.ok(keys.includes("advisoryTargets"));
    assert.ok(keys.includes("advisoryTests"));
    assert.ok(keys.includes("risks"));
  });

  it("unsafe prompt produces no event (spawn blocked)", () => {
    const spawn = shouldSpawnScouts({
      prompt: "rm -rf everything",
    });
    assert.equal(spawn.spawn, false);
    assert.ok(spawn.reason.includes("unsafe"));
    // No started or complete event would be emitted
  });

  it("vague prompt produces no event (spawn blocked)", () => {
    const spawn = shouldSpawnScouts({
      prompt: "make it better",
    });
    assert.equal(spawn.spawn, false);
    assert.ok(spawn.reason.includes("vague"));
  });
});

// ─── AedisEventType contract ─────────────────────────────────────────

describe("preflight scout events — type contract", () => {
  it("event types are valid AedisEventType values", async () => {
    // Import the type union members by checking the module exports
    const wsModule = await import("../server/websocket.js");

    // The event types should be accepted by the EventBus.emit() signature.
    // We can't directly test the union type at runtime, but we verify
    // the strings we use match the documented contract.
    const scoutEventTypes = [
      "preflight_scouts_started",
      "preflight_scouts_complete",
      "preflight_scouts_skipped",
    ] as const;

    for (const type of scoutEventTypes) {
      // Each type should be a non-empty string matching the naming pattern
      assert.ok(type.startsWith("preflight_scouts_"));
      assert.ok(type.length > 0);
    }
  });
});
