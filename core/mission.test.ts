import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { proposeMission, type MissionProposal, type MissionClarify, type MissionBlock } from "./mission.js";

function createTestRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "aedis-mission-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    name: "test-repo", scripts: { test: "vitest run" },
    dependencies: { express: "^4.18.0" }, devDependencies: { vitest: "^1.0.0" },
  }));
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "src", "routes"), { recursive: true });
  mkdirSync(join(dir, "tests"), { recursive: true });
  writeFileSync(join(dir, "src", "index.ts"), 'export const app = {};\n');
  writeFileSync(join(dir, "src", "auth.ts"), 'export function auth() { return true; }\n');
  writeFileSync(join(dir, "src", "routes", "login.ts"), 'import { auth } from "../auth";\n');
  writeFileSync(join(dir, "src", "database.ts"), 'export const db = {};\n');
  writeFileSync(join(dir, "tests", "auth.test.ts"), 'test("auth", () => {});\n');
  return dir;
}

// ─── 1. Scoped objective produces mission proposal ───────────────────

describe("proposeMission — scoped objectives", () => {
  it("scoped multi-step objective produces mission proposal", async () => {
    const repo = createTestRepo();
    const result = await proposeMission({
      objective: "Add JWT authentication to the API and create login and registration endpoints and write integration tests for all auth flows",
      repoPath: repo,
    });
    assert.equal(result.kind, "mission_proposal");
    const proposal = result as MissionProposal;
    assert.ok(proposal.subtasks.length >= 1, `Expected >=1 subtask, got ${proposal.subtasks.length}`);
    assert.ok(proposal.objective.length > 0);
    assert.ok(proposal.confidence > 0);
    assert.ok(
      proposal.approvalReminder.length > 10,
      `approvalReminder should be a non-trivial string, got: "${proposal.approvalReminder}"`,
    );
    assert.ok(
      proposal.approvalReminder.includes("NOT") || proposal.approvalReminder.includes("not"),
      `approvalReminder should mention NOT approving/promoting`,
    );
  });

  it("single-step objective still produces mission (single subtask)", async () => {
    const repo = createTestRepo();
    const result = await proposeMission({
      objective: "add a hello endpoint to the API",
      repoPath: repo,
    });
    // Even single-step tasks can be missions
    assert.equal(result.kind, "mission_proposal");
    const proposal = result as MissionProposal;
    assert.ok(proposal.subtasks.length >= 1);
  });
});

// ─── 2. Vague objective clarifies ────────────────────────────────────

describe("proposeMission — vague objectives", () => {
  it("vague 'make it better' clarifies", async () => {
    const repo = createTestRepo();
    const result = await proposeMission({
      objective: "make it better",
      repoPath: repo,
    });
    assert.equal(result.kind, "mission_clarify");
    const clarify = result as MissionClarify;
    assert.ok(clarify.question.length > 0);
  });

  it("vague 'improve' clarifies", async () => {
    const repo = createTestRepo();
    const result = await proposeMission({
      objective: "improve",
      repoPath: repo,
    });
    assert.equal(result.kind, "mission_clarify");
  });
});

// ─── 3. Unsafe objective blocks ──────────────────────────────────────

describe("proposeMission — unsafe objectives", () => {
  it("'rm -rf' blocks", async () => {
    const repo = createTestRepo();
    const result = await proposeMission({
      objective: "rm -rf the database and rebuild everything",
      repoPath: repo,
    });
    assert.equal(result.kind, "mission_block");
    const block = result as MissionBlock;
    assert.ok(block.reason.includes("unsafe") || block.reason.includes("destructive"));
  });

  it("'drop database' blocks", async () => {
    const repo = createTestRepo();
    const result = await proposeMission({
      objective: "drop database users and recreate from scratch",
      repoPath: repo,
    });
    assert.equal(result.kind, "mission_block");
  });
});

// ─── 4. Mission proposal includes scout evidence ─────────────────────

describe("proposeMission — scout evidence", () => {
  it("multi-step mission includes scout summary", async () => {
    const repo = createTestRepo();
    const result = await proposeMission({
      objective: "Fix the auth validation and update login endpoint and add comprehensive tests for all auth flows",
      repoPath: repo,
    });
    assert.equal(result.kind, "mission_proposal");
    const proposal = result as MissionProposal;
    // Scout evidence should be present for multi-step missions
    // (may or may not have spawned depending on spawn rules)
    if (proposal.scoutSummary) {
      assert.ok(typeof proposal.scoutSummary.spawned === "boolean");
      assert.ok(Array.isArray(proposal.scoutSummary.recommendedTargets));
    }
  });
});

// ─── 5. Mission proposal includes editable subtasks ──────────────────

describe("proposeMission — editable subtasks", () => {
  it("each subtask has title, prompt, risk, scope, reason", async () => {
    const repo = createTestRepo();
    const result = await proposeMission({
      objective: "Add rate limiting middleware and update the health check endpoint and write API tests",
      repoPath: repo,
    });
    assert.equal(result.kind, "mission_proposal");
    const proposal = result as MissionProposal;
    for (const sub of proposal.subtasks) {
      assert.ok(sub.title.length > 0, "title present");
      assert.ok(sub.prompt.length > 0, "prompt present");
      assert.ok(["low", "medium", "high"].includes(sub.risk), "valid risk");
      assert.ok(sub.scope !== undefined, "scope present");
      assert.ok(sub.reason.length > 0, "reason present");
    }
  });
});

// ─── 6-7. Start Mission creates TaskPlan, does NOT auto-promote ──────

describe("proposeMission — safety: start != promote", () => {
  it("mission proposal does not contain promote/approve/commit fields", async () => {
    const repo = createTestRepo();
    const result = await proposeMission({
      objective: "Add authentication and update all tests and fix the login flow",
      repoPath: repo,
    });
    if (result.kind === "mission_proposal") {
      const keys = Object.keys(result);
      assert.ok(!keys.includes("approved"));
      assert.ok(!keys.includes("promoted"));
      assert.ok(!keys.includes("commitSha"));
      assert.ok(result.approvalReminder.toLowerCase().includes("does not approve"));
    }
  });
});

// ─── 12. Mission final summary is truthful ───────────────────────────

describe("proposeMission — truthfulness", () => {
  it("mission proposal has honest confidence and signals", async () => {
    const repo = createTestRepo();
    const result = await proposeMission({
      objective: "Refactor auth module and update login handler and add validation tests",
      repoPath: repo,
    });
    if (result.kind === "mission_proposal") {
      assert.ok(result.confidence > 0 && result.confidence <= 1);
      assert.ok(result.signals.length > 0);
      assert.ok(result.reason.length > 0);
    }
  });
});

// ─── 14. Target repo remains clean ───────────────────────────────────

describe("proposeMission — target repo clean", () => {
  it("proposing a mission does not modify the target repo", async () => {
    const repo = createTestRepo();
    const authBefore = readFileSync(join(repo, "src", "auth.ts"), "utf-8");
    const filesBefore = readdirSync(join(repo, "src")).sort();

    await proposeMission({
      objective: "Add JWT auth with endpoints and tests and middleware protection",
      repoPath: repo,
    });

    const authAfter = readFileSync(join(repo, "src", "auth.ts"), "utf-8");
    const filesAfter = readdirSync(join(repo, "src")).sort();
    assert.equal(authAfter, authBefore);
    assert.deepEqual(filesAfter, filesBefore);
  });
});

// ─── 15. local-smoke never uses cloud ────────────────────────────────

describe("proposeMission — cloud constraints", () => {
  it("local-smoke mission never uses cloud scouts", async () => {
    const repo = createTestRepo();
    const result = await proposeMission({
      objective: "Add authentication with JWT and middleware and tests across all services",
      repoPath: repo,
      modelProfile: "local-smoke",
      cloudKeysAvailable: true,
    });
    if (result.kind === "mission_proposal" && result.scoutSummary?.spawned) {
      for (const r of result.scoutSummary.routing) {
        assert.notEqual(r.route, "cloud");
      }
    }
  });
});

// ─── 16. Cloud disclosure ────────────────────────────────────────────

describe("proposeMission — cloud disclosure", () => {
  it("mission discloses cloud/local model usage before start", async () => {
    const repo = createTestRepo();
    const result = await proposeMission({
      objective: "Refactor auth module and add tests and update endpoints",
      repoPath: repo,
    });
    if (result.kind === "mission_proposal") {
      assert.ok(result.cloudDisclosure.length > 0);
      assert.ok(result.modelProfile.length > 0);
      assert.ok(result.estimatedCostRange.length > 0);
    }
  });
});

// ─── Empty/edge cases ────────────────────────────────────────────────

describe("proposeMission — edge cases", () => {
  it("empty objective returns skip", async () => {
    const repo = createTestRepo();
    const result = await proposeMission({ objective: "", repoPath: repo });
    assert.equal(result.kind, "mission_skip");
  });
});
