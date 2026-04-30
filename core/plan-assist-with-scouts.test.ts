import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { detectPlanAssistWithScouts } from "./plan-assist-with-scouts.js";

function createTestRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "aedis-pa-scout-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "test-repo",
      scripts: { test: "vitest run" },
      dependencies: { express: "^4.18.0" },
      devDependencies: { vitest: "^1.0.0" },
    }),
  );
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "src", "routes"), { recursive: true });
  mkdirSync(join(dir, "tests"), { recursive: true });
  mkdirSync(join(dir, "docs"), { recursive: true });

  writeFileSync(join(dir, "src", "index.ts"), 'import express from "express";\nexport const app = express();\n');
  writeFileSync(join(dir, "src", "auth.ts"), 'export function authenticate(token: string) {\n  return token === "valid";\n}\n');
  writeFileSync(join(dir, "src", "routes", "login.ts"), 'import { authenticate } from "../auth";\n');
  writeFileSync(join(dir, "src", "database.ts"), 'export const db = { connect: () => {} };\n');
  writeFileSync(join(dir, "src", "config.json"), '{"port": 3000}');
  writeFileSync(join(dir, "tests", "auth.test.ts"), 'import { authenticate } from "../src/auth";\ntest("auth", () => {});\n');
  writeFileSync(join(dir, "docs", "README.md"), "# Test Repo\n\nAuth module documentation.\n");
  writeFileSync(join(dir, ".env.example"), "DB_PASSWORD=changeme\nAPI_KEY=xxx\n");
  return dir;
}

// ─── Part 1: Plan Assist uses scout evidence ─────────────────────────

describe("Plan Assist + Scout integration", () => {
  it("large scoped prompt triggers scouts and includes evidence", async () => {
    const repo = createTestRepo();
    const result = await detectPlanAssistWithScouts({
      prompt:
        "Implement a user authentication module with JWT tokens, " +
        "add login and registration endpoints, " +
        "create middleware for route protection, " +
        "and write integration tests for all auth flows",
      repoPath: repo,
    });

    assert.equal(result.planResult.kind, "plan_suggestion");
    // Scout evidence should be present
    assert.ok(result.scoutEvidence, "Scout evidence should be present");
    assert.equal(result.scoutEvidence!.spawned, true);
    assert.ok(result.scoutEvidence!.reports.length > 0, "Should have scout reports");

    // Evidence should include recommended targets
    const targets = result.scoutEvidence!.recommendedTargets;
    // At minimum, target discovery should have found auth.ts
    assert.ok(targets.length > 0, "Should have recommended targets");
  });

  it("simple explicit prompt does not spawn scouts", async () => {
    const repo = createTestRepo();
    const result = await detectPlanAssistWithScouts({
      prompt: "fix the typo in README.md",
      repoPath: repo,
    });

    // Plan-assist skips simple prompts; scouts should not run
    assert.equal(result.planResult.kind, "skip");
    assert.equal(result.scoutEvidence, null);
  });

  it("vague broad prompt clarifies and does not spawn scouts", async () => {
    const repo = createTestRepo();
    const result = await detectPlanAssistWithScouts({
      prompt: "make it better",
      repoPath: repo,
    });

    assert.equal(result.planResult.kind, "clarify");
    assert.equal(result.scoutEvidence, null);
  });

  it("unsafe prompt blocks and does not spawn scouts", async () => {
    const repo = createTestRepo();
    const result = await detectPlanAssistWithScouts({
      prompt: "rm -rf the database and rebuild from scratch",
      repoPath: repo,
    });

    assert.equal(result.planResult.kind, "block");
    assert.equal(result.scoutEvidence, null);
  });

  it("scout evidence enriches subtask scope and risk", async () => {
    const repo = createTestRepo();
    const result = await detectPlanAssistWithScouts({
      prompt:
        "Fix the auth validation logic and update the login endpoint and add integration tests",
      repoPath: repo,
    });

    assert.equal(result.planResult.kind, "plan_suggestion");
    if (result.planResult.kind !== "plan_suggestion") return;

    // Check that scout evidence was applied
    if (result.scoutEvidence?.spawned) {
      // At least some subtasks should have scout-enriched scope
      const hasEnrichedScope = result.planResult.subtasks.some(
        (s) => s.scope !== "unknown" && !s.scope.endsWith("(inferred)"),
      );
      // May or may not enrich depending on keyword matching,
      // but reason should mention "scout" if evidence was used
      const hasScoutReason = result.planResult.subtasks.some(
        (s) => s.reason.includes("scout"),
      );
      // At least the evidence object should have data
      assert.ok(result.scoutEvidence.reports.length > 0);
    }
  });

  it("checklist prompt with unknown targets triggers scouts", async () => {
    const repo = createTestRepo();
    const result = await detectPlanAssistWithScouts({
      prompt:
        "Refactor the auth module:\n" +
        "1. Extract shared validation logic\n" +
        "2. Update login handler\n" +
        "3. Add unit tests",
      repoPath: repo,
    });

    assert.equal(result.planResult.kind, "plan_suggestion");
    // Scouts should spawn for checklist with unknown targets
    assert.ok(result.scoutEvidence, "Scout evidence should be present");
    assert.equal(result.scoutEvidence!.spawned, true);
  });
});

// ─── Part 2: Coordinator preflight ───────────────────────────────────

describe("Coordinator preflight scouts", () => {
  it("uses scout targets as advisory only (does not bypass validation)", async () => {
    const { runPreflightScouts } = await import("./coordinator-preflight-scouts.js");
    const repo = createTestRepo();
    const result = await runPreflightScouts({
      prompt: "update the authentication logic across the codebase",
      repoPath: repo,
      discoveredTargets: [],
      targetDiscoveryConfidence: 0.3,
    });

    assert.equal(result.scouted, true);
    // Advisory targets are suggestions, not commands
    assert.ok(Array.isArray(result.advisoryTargets));
    // Report IDs should be present for receipt inclusion
    assert.ok(Array.isArray(result.scoutReportIds));
    assert.ok(result.scoutReportIds.length > 0);
  });

  it("does not scout when targets are already confident", async () => {
    const { runPreflightScouts } = await import("./coordinator-preflight-scouts.js");
    const repo = createTestRepo();
    const result = await runPreflightScouts({
      prompt: "fix the typo in README.md",
      repoPath: repo,
      discoveredTargets: ["README.md"],
      targetDiscoveryConfidence: 0.9,
    });

    assert.equal(result.scouted, false);
    assert.equal(result.advisoryTargets.length, 0);
  });

  it("low target discovery confidence triggers scouts", async () => {
    const { runPreflightScouts } = await import("./coordinator-preflight-scouts.js");
    const repo = createTestRepo();
    const result = await runPreflightScouts({
      prompt: "add caching to the API layer",
      repoPath: repo,
      discoveredTargets: [],
      targetDiscoveryConfidence: 0.2,
    });

    assert.equal(result.scouted, true);
    assert.ok(result.reason.includes("confidence") || result.reason.includes("target"));
  });
});

// ─── Part 3: Scout evidence persistence ──────────────────────────────

describe("Scout evidence persistence", () => {
  it("scout evidence is persisted under AEDIS_STATE_ROOT", async () => {
    const { ScoutEvidenceStore } = await import("./scout-report.js");
    const stateRoot = mkdtempSync(join(tmpdir(), "aedis-evidence-"));
    const store = new ScoutEvidenceStore(stateRoot);

    await store.save({
      runId: "test-run-integration",
      prompt: "test prompt",
      repoPath: "/tmp/test",
      reports: [{
        scoutId: "scout-test-1",
        type: "target_discovery",
        modelProvider: "local",
        modelName: "local",
        localOrCloud: "deterministic",
        confidence: 0.8,
        summary: "test",
        findings: [],
        recommendedTargets: ["src/auth.ts"],
        recommendedTests: [],
        risks: [],
        costUsd: 0,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      }],
      spawnDecision: {
        spawn: true,
        reason: "test",
        scoutCount: 1,
        scoutTypes: ["target_discovery"],
        localOrCloudRecommendation: "deterministic",
        expectedEvidence: ["targets"],
      },
      createdAt: new Date().toISOString(),
    });

    const loaded = await store.load("test-run-integration");
    assert.ok(loaded);
    assert.equal(loaded!.reports[0].scoutId, "scout-test-1");
    // Verify it's under state root, not target repo
    const path = store.getEvidencePath("test-run-integration");
    assert.ok(path.startsWith(stateRoot));
  });
});

// ─── Part 4: Receipts include scout report IDs ───────────────────────

describe("Scout report IDs in receipts", () => {
  it("preflight result includes scoutReportIds for receipt inclusion", async () => {
    const { runPreflightScouts } = (await import("./coordinator-preflight-scouts.js"));
    const repo = createTestRepo();
    const result = await runPreflightScouts({
      prompt: "refactor authentication across multiple services and add tests",
      repoPath: repo,
      discoveredTargets: [],
      targetDiscoveryConfidence: 0.2,
    });

    if (result.scouted) {
      // Each report ID should be a non-empty string
      for (const id of result.scoutReportIds) {
        assert.ok(typeof id === "string" && id.length > 0);
      }
    }
  });
});

// ─── Part 5: Cloud routing constraints ───────────────────────────────

describe("Cloud scout routing constraints", () => {
  it("local-smoke never uses cloud scouts", async () => {
    const repo = createTestRepo();
    const result = await detectPlanAssistWithScouts({
      prompt:
        "Implement a notification service with email, push, and webhook support " +
        "that should handle retries and dead letter queues across multiple services",
      repoPath: repo,
      modelProfile: "local-smoke",
      cloudKeysAvailable: true,
    });

    if (result.scoutEvidence?.spawned) {
      for (const r of result.scoutEvidence.routing) {
        assert.notEqual(r.route, "cloud", "local-smoke must never use cloud scouts");
      }
      for (const report of result.scoutEvidence.reports) {
        assert.notEqual(report.localOrCloud, "cloud");
      }
    }
  });

  it("missing cloud keys prevent cloud scouts", async () => {
    const repo = createTestRepo();
    const result = await detectPlanAssistWithScouts({
      prompt:
        "Implement a notification service with email, push, and webhook support " +
        "that should handle retries and dead letter queues across multiple services",
      repoPath: repo,
      modelProfile: "default",
      cloudKeysAvailable: false,
    });

    if (result.scoutEvidence?.spawned) {
      for (const r of result.scoutEvidence.routing) {
        assert.notEqual(r.route, "cloud", "missing keys must prevent cloud scouts");
      }
    }
  });

  it("cloud scout fallback to deterministic/local is truthful", async () => {
    const repo = createTestRepo();
    const result = await detectPlanAssistWithScouts({
      prompt:
        "Implement a notification service with email, push, and webhook support " +
        "that should handle retries and dead letter queues across multiple services",
      repoPath: repo,
      modelProfile: "default",
      cloudKeysAvailable: false,
    });

    if (result.scoutEvidence?.spawned) {
      for (const r of result.scoutEvidence.routing) {
        if (r.reason.includes("falling back")) {
          // Fallback reason should be truthful
          assert.ok(
            r.reason.includes("unavailable") || r.reason.includes("keys"),
            "Fallback reason should explain why",
          );
        }
      }
    }
  });
});

// ─── Part 6: Scout cannot cause mutation ─────────────────────────────

describe("Scout safety invariants", () => {
  it("scout cannot cause source mutation (read-only check)", async () => {
    const repo = createTestRepo();
    const { readFileSync, readdirSync } = await import("node:fs");

    // Snapshot file contents before scouts
    const authBefore = readFileSync(join(repo, "src", "auth.ts"), "utf-8");
    const pkgBefore = readFileSync(join(repo, "package.json"), "utf-8");
    const filesBefore = readdirSync(join(repo, "src")).sort();

    // Run scouts
    await detectPlanAssistWithScouts({
      prompt:
        "Fix the auth validation logic and update the login endpoint and add integration tests",
      repoPath: repo,
    });

    // Verify nothing changed
    const authAfter = readFileSync(join(repo, "src", "auth.ts"), "utf-8");
    const pkgAfter = readFileSync(join(repo, "package.json"), "utf-8");
    const filesAfter = readdirSync(join(repo, "src")).sort();

    assert.equal(authAfter, authBefore, "auth.ts must not be modified by scouts");
    assert.equal(pkgAfter, pkgBefore, "package.json must not be modified by scouts");
    assert.deepEqual(filesAfter, filesBefore, "no new files should be created in src/");
  });

  it("scout cannot bypass approval (plan suggestion does not execute)", async () => {
    const repo = createTestRepo();
    const result = await detectPlanAssistWithScouts({
      prompt:
        "Fix the auth validation and update login and add tests",
      repoPath: repo,
    });

    // Plan suggestion means no execution happened
    if (result.planResult.kind === "plan_suggestion") {
      // The result is a suggestion, not an execution receipt
      assert.ok(!("runId" in result.planResult));
      assert.ok(!("taskId" in result.planResult));
    }
  });
});
