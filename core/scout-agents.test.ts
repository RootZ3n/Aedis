import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  runRepoMapScout,
  runTargetDiscoveryScout,
  runTestDiscoveryScout,
  runRiskScout,
  runDocsScout,
  runScouts,
} from "./scout-agents.js";

function createTestRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "aedis-scout-test-"));
  // Create a minimal repo structure
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
  writeFileSync(join(dir, "docs", "README.md"), "# Test Repo\n\nThis is a test repo for auth module.\n");
  writeFileSync(join(dir, "docs", "api.md"), "# API Docs\n\n## Authentication\nUse `/login` endpoint.\n");
  writeFileSync(join(dir, ".env.example"), "DB_PASSWORD=changeme\nAPI_KEY=xxx\n");

  return dir;
}

// ─── RepoMapScout ────────────────────────────────────────────────────

describe("runRepoMapScout", () => {
  it("detects package manager and framework", async () => {
    const repo = createTestRepo();
    const report = await runRepoMapScout(repo);
    assert.equal(report.type, "repo_map");
    assert.ok(report.findings.some((f) => f.title.includes("npm/node")));
    assert.ok(report.findings.some((f) => f.title.includes("Express")));
  });

  it("detects test command", async () => {
    const repo = createTestRepo();
    const report = await runRepoMapScout(repo);
    assert.ok(report.findings.some((f) => f.title.includes("Test command")));
  });

  it("lists repository structure", async () => {
    const repo = createTestRepo();
    const report = await runRepoMapScout(repo);
    assert.ok(report.findings.some((f) => f.title.includes("Repository structure")));
    assert.ok(report.summary.includes("files"));
  });

  it("returns deterministic localOrCloud", async () => {
    const repo = createTestRepo();
    const report = await runRepoMapScout(repo);
    assert.equal(report.localOrCloud, "deterministic");
    assert.equal(report.costUsd, 0);
  });
});

// ─── TargetDiscoveryScout ────────────────────────────────────────────

describe("runTargetDiscoveryScout", () => {
  it("finds relevant files for auth prompt", async () => {
    const repo = createTestRepo();
    const report = await runTargetDiscoveryScout(repo, "fix authentication logic");
    assert.equal(report.type, "target_discovery");
    assert.ok(report.recommendedTargets.length > 0);
    assert.ok(report.recommendedTargets.some((t) => t.includes("auth")));
  });

  it("ranks by keyword relevance", async () => {
    const repo = createTestRepo();
    const report = await runTargetDiscoveryScout(repo, "update the login route handler");
    assert.ok(report.findings.length > 0);
    // login.ts should rank high
    assert.ok(report.recommendedTargets.some((t) => t.includes("login")));
  });

  it("finds explicit file references in prompt", async () => {
    const repo = createTestRepo();
    const report = await runTargetDiscoveryScout(repo, "modify src/database.ts to add connection pooling");
    assert.ok(report.recommendedTargets.includes("src/database.ts"));
  });
});

// ─── TestDiscoveryScout ──────────────────────────────────────────────

describe("runTestDiscoveryScout", () => {
  it("finds test files for target", async () => {
    const repo = createTestRepo();
    const report = await runTestDiscoveryScout(repo, ["src/auth.ts"]);
    assert.equal(report.type, "test_discovery");
    assert.ok(report.recommendedTests.length > 0);
    assert.ok(report.recommendedTests.some((t) => t.includes("auth.test")));
  });

  it("detects test runner", async () => {
    const repo = createTestRepo();
    const report = await runTestDiscoveryScout(repo, ["src/auth.ts"]);
    assert.ok(report.findings.some((f) => f.title.includes("Test commands")));
  });
});

// ─── RiskScout ───────────────────────────────────────────────────────

describe("runRiskScout", () => {
  it("flags config files", async () => {
    const repo = createTestRepo();
    const report = await runRiskScout(repo, ["src/config.json"]);
    assert.equal(report.type, "risk");
    assert.ok(report.risks.some((r) => r.includes("configuration")));
  });

  it("detects secrets-adjacent files", async () => {
    const repo = createTestRepo();
    const report = await runRiskScout(repo, ["src/auth.ts"]);
    assert.ok(report.findings.some((f) => f.title.includes("Secrets-adjacent")));
  });

  it("detects nearby risk files not in targets", async () => {
    const repo = createTestRepo();
    const report = await runRiskScout(repo, ["src/index.ts"]);
    // .env.example should be found as nearby risk
    assert.ok(report.findings.some((f) => f.title.includes("Nearby risk")));
  });
});

// ─── DocsScout ───────────────────────────────────────────────────────

describe("runDocsScout", () => {
  it("finds README and relevant docs", async () => {
    const repo = createTestRepo();
    const report = await runDocsScout(repo, "authentication setup");
    assert.equal(report.type, "docs");
    assert.ok(report.recommendedTargets.length > 0);
    // api.md mentions "Authentication"
    assert.ok(report.recommendedTargets.some((t) => t.includes(".md")));
  });
});

// ─── Orchestrator ────────────────────────────────────────────────────

describe("runScouts", () => {
  it("runs multiple scout types", async () => {
    const repo = createTestRepo();
    const reports = await runScouts({
      repoPath: repo,
      prompt: "fix authentication logic",
      scoutTypes: ["repo_map", "target_discovery"],
    });
    assert.equal(reports.length, 2);
    assert.ok(reports.some((r) => r.type === "repo_map"));
    assert.ok(reports.some((r) => r.type === "target_discovery"));
  });

  it("handles scout failure gracefully", async () => {
    // Use non-existent repo — walkDir will return empty, not throw
    const reports = await runScouts({
      repoPath: "/nonexistent-repo-12345",
      prompt: "find auth",
      scoutTypes: ["repo_map"],
    });
    assert.equal(reports.length, 1);
    // Should still produce a report (empty findings, not a crash)
    assert.equal(reports[0].type, "repo_map");
  });
});
