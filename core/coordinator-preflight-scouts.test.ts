import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runPreflightScouts } from "./coordinator-preflight-scouts.js";
import { ScoutEvidenceStore } from "./scout-report.js";

function createTestRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "aedis-coord-scout-"));
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
  writeFileSync(join(dir, "src", "index.ts"), 'import express from "express";\n');
  writeFileSync(join(dir, "src", "auth.ts"), 'export function authenticate(token: string) { return true; }\n');
  writeFileSync(join(dir, "src", "routes", "login.ts"), 'import { authenticate } from "../auth";\n');
  writeFileSync(join(dir, "src", "database.ts"), 'export const db = { connect: () => {} };\n');
  writeFileSync(join(dir, "src", "config.json"), '{"port": 3000}');
  writeFileSync(join(dir, "tests", "auth.test.ts"), 'test("auth", () => {});\n');
  writeFileSync(join(dir, ".env.example"), "SECRET=changeme\n");
  return dir;
}

// ─── Spawn triggers ──────────────────────────────────────────────────

describe("coordinator preflight scouts — spawn triggers", () => {
  it("low-confidence target discovery triggers preflight scouts", async () => {
    const repo = createTestRepo();
    const result = await runPreflightScouts({
      prompt: "refactor the authentication logic across all services and add comprehensive tests",
      repoPath: repo,
      discoveredTargets: [],
      targetDiscoveryConfidence: 0.2,
    });
    assert.equal(result.scouted, true);
    assert.ok(result.advisoryTargets.length > 0 || result.scoutReportIds.length > 0);
  });

  it("simple explicit task does not spawn scouts", async () => {
    const repo = createTestRepo();
    const result = await runPreflightScouts({
      prompt: "fix the typo in README.md",
      repoPath: repo,
      discoveredTargets: ["README.md"],
      targetDiscoveryConfidence: 0.95,
    });
    assert.equal(result.scouted, false);
  });

  it("unsafe prompt does not spawn scouts", async () => {
    const repo = createTestRepo();
    const result = await runPreflightScouts({
      prompt: "rm -rf everything and start over",
      repoPath: repo,
      discoveredTargets: [],
      targetDiscoveryConfidence: 0.1,
    });
    assert.equal(result.scouted, false);
  });

  it("vague prompt does not spawn scouts", async () => {
    const repo = createTestRepo();
    const result = await runPreflightScouts({
      prompt: "make it better",
      repoPath: repo,
      discoveredTargets: [],
      targetDiscoveryConfidence: 0.1,
    });
    assert.equal(result.scouted, false);
  });

  it("high-confidence targets skip scouts", async () => {
    const repo = createTestRepo();
    const result = await runPreflightScouts({
      prompt: "update src/auth.ts to add token refresh",
      repoPath: repo,
      discoveredTargets: ["src/auth.ts"],
      targetDiscoveryConfidence: 0.9,
    });
    assert.equal(result.scouted, false);
  });
});

// ─── Advisory behavior ───────────────────────────────────────────────

describe("coordinator preflight scouts — advisory behavior", () => {
  it("scout recommended target is advisory (path still needs validation)", async () => {
    const repo = createTestRepo();
    const result = await runPreflightScouts({
      prompt: "update the authentication module and add login validation",
      repoPath: repo,
      discoveredTargets: [],
      targetDiscoveryConfidence: 0.3,
    });
    if (result.scouted) {
      // Advisory targets are suggestions, not guaranteed valid paths
      assert.ok(Array.isArray(result.advisoryTargets));
      // The coordinator must still validate each path before use
      // (this is a structural assertion — the test verifies the shape,
      // the coordinator's path validation is tested separately)
    }
  });

  it("scope violation still blocks despite scout recommendation", async () => {
    // Even if scouts recommend a target, the coordinator's scope
    // violation detection runs after and can still block.
    // This test verifies the scout result doesn't carry any
    // "bypass" or "force" flags.
    const repo = createTestRepo();
    const result = await runPreflightScouts({
      prompt: "refactor authentication across all services",
      repoPath: repo,
      discoveredTargets: [],
      targetDiscoveryConfidence: 0.2,
    });
    if (result.scouted) {
      // No bypass flags in the result
      assert.ok(!("bypass" in result));
      assert.ok(!("force" in result));
      assert.ok(!("skipValidation" in result));
      // The result is purely advisory
      assert.ok(result.reason.length > 0);
    }
  });
});

// ─── Evidence persistence ────────────────────────────────────────────

describe("coordinator preflight scouts — evidence persistence", () => {
  it("scout evidence is persisted under AEDIS_STATE_ROOT", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "aedis-scout-persist-"));
    const store = new ScoutEvidenceStore(stateRoot);

    // Simulate what the coordinator does after scouts run
    const repo = createTestRepo();
    const result = await runPreflightScouts({
      prompt: "update authentication and add tests across all modules",
      repoPath: repo,
      discoveredTargets: [],
      targetDiscoveryConfidence: 0.2,
    });

    if (result.scouted) {
      await store.save({
        runId: "test-run-persist",
        prompt: "test",
        repoPath: repo,
        reports: result.scoutReportIds.map((id) => ({
          scoutId: id,
          type: "target_discovery" as const,
          modelProvider: "local",
          modelName: "local",
          localOrCloud: "deterministic" as const,
          confidence: 0,
          summary: "test",
          findings: [],
          recommendedTargets: result.advisoryTargets as string[],
          recommendedTests: result.advisoryTests as string[],
          risks: result.risks as string[],
          costUsd: 0,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        })),
        spawnDecision: {
          spawn: true,
          reason: result.reason,
          scoutCount: result.scoutReportIds.length,
          scoutTypes: ["target_discovery"],
          localOrCloudRecommendation: "deterministic",
          expectedEvidence: [],
        },
        createdAt: new Date().toISOString(),
      });

      const loaded = await store.load("test-run-persist");
      assert.ok(loaded);
      assert.ok(loaded!.reports.length > 0);
      // Verify it's under state root
      const path = store.getEvidencePath("test-run-persist");
      assert.ok(path.startsWith(stateRoot));
      assert.ok(!path.includes(repo));
    }
  });
});

// ─── Receipt inclusion ───────────────────────────────────────────────

describe("coordinator preflight scouts — receipt inclusion", () => {
  it("receipt includes scoutReportIds when scouts ran", async () => {
    const repo = createTestRepo();
    const result = await runPreflightScouts({
      prompt: "refactor authentication module and add comprehensive test coverage",
      repoPath: repo,
      discoveredTargets: [],
      targetDiscoveryConfidence: 0.2,
    });

    if (result.scouted) {
      assert.ok(result.scoutReportIds.length > 0);
      for (const id of result.scoutReportIds) {
        assert.ok(typeof id === "string" && id.length > 0);
      }
    }
  });
});

// ─── Cloud routing constraints ───────────────────────────────────────

describe("coordinator preflight scouts — cloud constraints", () => {
  it("local-smoke never uses cloud", async () => {
    const repo = createTestRepo();
    const result = await runPreflightScouts({
      prompt: "refactor authentication across all services and add tests",
      repoPath: repo,
      discoveredTargets: [],
      targetDiscoveryConfidence: 0.2,
      modelProfile: "local-smoke",
    });

    if (result.scouted) {
      for (const r of result.routing) {
        assert.notEqual(r.route, "cloud", "local-smoke must never use cloud");
      }
    }
  });

  it("missing cloud keys prevents cloud", async () => {
    const repo = createTestRepo();
    const result = await runPreflightScouts({
      prompt: "refactor authentication across all services and add tests",
      repoPath: repo,
      discoveredTargets: [],
      targetDiscoveryConfidence: 0.2,
      cloudKeysAvailable: false,
    });

    if (result.scouted) {
      for (const r of result.routing) {
        assert.notEqual(r.route, "cloud", "missing keys must prevent cloud");
      }
    }
  });
});

// ─── Safety invariants ───────────────────────────────────────────────

describe("coordinator preflight scouts — safety invariants", () => {
  it("scout cannot mutate source repo", async () => {
    const repo = createTestRepo();
    const authBefore = readFileSync(join(repo, "src", "auth.ts"), "utf-8");
    const filesBefore = readdirSync(join(repo, "src")).sort();

    await runPreflightScouts({
      prompt: "refactor authentication and update login endpoint and add tests",
      repoPath: repo,
      discoveredTargets: [],
      targetDiscoveryConfidence: 0.2,
    });

    const authAfter = readFileSync(join(repo, "src", "auth.ts"), "utf-8");
    const filesAfter = readdirSync(join(repo, "src")).sort();
    assert.equal(authAfter, authBefore, "source files must not be modified");
    assert.deepEqual(filesAfter, filesBefore, "no new files in source repo");
  });

  it("scout cannot bypass approval (result has no approval/promote fields)", async () => {
    const repo = createTestRepo();
    const result = await runPreflightScouts({
      prompt: "refactor authentication across all services",
      repoPath: repo,
      discoveredTargets: [],
      targetDiscoveryConfidence: 0.2,
    });

    // The result type has no approve/promote/commit capabilities
    assert.ok(!("approve" in result));
    assert.ok(!("promote" in result));
    assert.ok(!("commit" in result));
    assert.ok(!("apply" in result));
  });
});
