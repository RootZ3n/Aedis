import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shouldSpawnScouts, type ScoutSpawnInput } from "./scout-spawn.js";

// ─── Spawn Decision Tests ────────────────────────────────────────────

describe("shouldSpawnScouts", () => {
  // ── NO-SPAWN cases ───────────────────────────────────────────────

  it("simple explicit task → no scout", () => {
    const result = shouldSpawnScouts({
      prompt: "Create README with project description",
      knownTargetFiles: ["README.md"],
    });
    assert.equal(result.spawn, false);
    assert.ok(result.reason.includes("simple"));
  });

  it("exact file + change provided with known target → no scout", () => {
    const result = shouldSpawnScouts({
      prompt: "Fix the typo in line 42",
      knownTargetFiles: ["src/main.ts"],
    });
    assert.equal(result.spawn, false);
  });

  it("vague 'make repo better' → no scout", () => {
    const result = shouldSpawnScouts({
      prompt: "make it better",
    });
    assert.equal(result.spawn, false);
    assert.ok(result.reason.includes("vague"));
  });

  it("unsafe prompt → block, no scout", () => {
    const result = shouldSpawnScouts({
      prompt: "rm -rf the entire repo and start over",
    });
    assert.equal(result.spawn, false);
    assert.ok(result.reason.includes("unsafe"));
  });

  it("budget exhausted → no scout", () => {
    const result = shouldSpawnScouts({
      prompt: "find where auth is handled and refactor it",
      remainingBudgetUsd: 0.001,
    });
    assert.equal(result.spawn, false);
    assert.ok(result.reason.includes("Budget"));
  });

  // ── SPAWN cases ──────────────────────────────────────────────────

  it("large multi-file prompt → spawn scouts", () => {
    const result = shouldSpawnScouts({
      prompt:
        "Refactor the authentication module across all services. " +
        "The auth logic is currently duplicated in the user service, " +
        "the admin service, and the API gateway. We need to consolidate " +
        "it into a shared library that all three services import. " +
        "Also update the tests and ensure the CI pipeline still passes.",
    });
    assert.equal(result.spawn, true);
    assert.ok(result.scoutCount > 0);
    assert.ok(result.scoutTypes.includes("target_discovery"));
  });

  it("'find where auth is handled' → spawn target discovery scout", () => {
    const result = shouldSpawnScouts({
      prompt: "find where auth is handled in this codebase",
    });
    assert.equal(result.spawn, true);
    assert.ok(result.scoutTypes.includes("target_discovery"));
    assert.ok(result.reason.includes("investigative"));
  });

  it("unknown target files → spawn scouts", () => {
    const result = shouldSpawnScouts({
      prompt: "add input validation to the login form",
      knownTargetFiles: [],
    });
    assert.equal(result.spawn, true);
    assert.ok(result.scoutTypes.includes("target_discovery"));
  });

  it("task plan creation → spawn scouts", () => {
    const result = shouldSpawnScouts({
      prompt: "add instructor mode",
      isTaskPlanCreation: true,
    });
    assert.equal(result.spawn, true);
    assert.ok(result.scoutTypes.includes("repo_map"));
    assert.ok(result.scoutTypes.includes("target_discovery"));
  });

  it("medium Loqui confidence + build intent → spawn scouts", () => {
    const result = shouldSpawnScouts({
      prompt: "update the database layer",
      intentConfidence: 0.5,
      intent: "build",
      knownTargetFiles: [],
    });
    assert.equal(result.spawn, true);
    assert.ok(result.reason.includes("medium Loqui confidence"));
  });

  it("test-related prompt includes test_discovery type", () => {
    const result = shouldSpawnScouts({
      prompt: "find all test files for the auth module and check coverage",
      knownTargetFiles: [],
    });
    assert.equal(result.spawn, true);
    assert.ok(result.scoutTypes.includes("test_discovery"));
  });

  it("risk-related prompt includes risk type", () => {
    const result = shouldSpawnScouts({
      prompt: "audit the config files for sensitive data and migration risks",
      knownTargetFiles: [],
    });
    assert.equal(result.spawn, true);
    assert.ok(result.scoutTypes.includes("risk"));
  });

  // ── Routing recommendations ──────────────────────────────────────

  it("local-smoke → deterministic recommendation", () => {
    const result = shouldSpawnScouts({
      prompt: "find where the database connection is configured across modules",
      modelProfile: "local-smoke",
      knownTargetFiles: [],
    });
    assert.equal(result.spawn, true);
    assert.equal(result.localOrCloudRecommendation, "deterministic");
  });

  it("no cloud keys → local recommendation", () => {
    const result = shouldSpawnScouts({
      prompt: "find where the database connection is configured across modules",
      cloudKeysAvailable: false,
      knownTargetFiles: [],
    });
    assert.equal(result.spawn, true);
    assert.ok(
      result.localOrCloudRecommendation === "local" ||
      result.localOrCloudRecommendation === "deterministic",
    );
  });

  // ── Expected evidence ────────────────────────────────────────────

  it("spawn decision includes expected evidence descriptions", () => {
    const result = shouldSpawnScouts({
      prompt: "find all the places where user authentication is checked",
      knownTargetFiles: [],
    });
    assert.equal(result.spawn, true);
    assert.ok(result.expectedEvidence.length > 0);
    assert.ok(result.expectedEvidence.some((e) => e.includes("candidate files")));
  });
});
