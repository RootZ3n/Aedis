import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ScoutEvidenceStore, type ScoutEvidence, type ScoutReport } from "./scout-report.js";

function makeReport(type: "repo_map" | "target_discovery"): ScoutReport {
  return {
    scoutId: `scout-${type}-test`,
    type,
    modelProvider: "local",
    modelName: "local",
    localOrCloud: "deterministic",
    confidence: 0.8,
    summary: `Test ${type} report`,
    findings: [
      {
        title: "Test finding",
        evidence: "Found something",
        files: ["src/main.ts"],
        confidence: 0.9,
      },
    ],
    recommendedTargets: ["src/main.ts"],
    recommendedTests: ["tests/main.test.ts"],
    risks: [],
    costUsd: 0,
    startedAt: "2026-04-29T00:00:00.000Z",
    completedAt: "2026-04-29T00:00:01.000Z",
  };
}

describe("ScoutEvidenceStore", () => {
  it("save + load round-trip", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "aedis-scout-store-"));
    const store = new ScoutEvidenceStore(stateRoot);

    const evidence: ScoutEvidence = {
      runId: "run-test-001",
      prompt: "fix auth",
      repoPath: "/tmp/test-repo",
      reports: [makeReport("repo_map"), makeReport("target_discovery")],
      spawnDecision: {
        spawn: true,
        reason: "test",
        scoutCount: 2,
        scoutTypes: ["repo_map", "target_discovery"],
        localOrCloudRecommendation: "deterministic",
        expectedEvidence: ["structure", "targets"],
      },
      createdAt: "2026-04-29T00:00:00.000Z",
    };

    await store.save(evidence);

    // File exists under state root
    const path = store.getEvidencePath("run-test-001");
    assert.ok(existsSync(path), "Evidence file should exist");

    // Load returns same data
    const loaded = await store.load("run-test-001");
    assert.ok(loaded);
    assert.equal(loaded.runId, "run-test-001");
    assert.equal(loaded.reports.length, 2);
    assert.equal(loaded.reports[0].type, "repo_map");
    assert.equal(loaded.reports[1].type, "target_discovery");
    assert.equal(loaded.spawnDecision.spawn, true);
  });

  it("scout report saved under AEDIS_STATE_ROOT, not target repo", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "aedis-scout-store-"));
    const store = new ScoutEvidenceStore(stateRoot);

    await store.save({
      runId: "run-test-002",
      prompt: "test",
      repoPath: "/mnt/ai/some-target-repo",
      reports: [],
      spawnDecision: {
        spawn: false,
        reason: "test",
        scoutCount: 0,
        scoutTypes: [],
        localOrCloudRecommendation: "deterministic",
        expectedEvidence: [],
      },
      createdAt: "2026-04-29T00:00:00.000Z",
    });

    // Evidence is in stateRoot, not in target repo
    const path = store.getEvidencePath("run-test-002");
    assert.ok(path.startsWith(stateRoot));
    assert.ok(!path.includes("/mnt/ai/some-target-repo"));
  });

  it("load returns null for nonexistent run", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "aedis-scout-store-"));
    const store = new ScoutEvidenceStore(stateRoot);
    const result = await store.load("nonexistent");
    assert.equal(result, null);
  });

  it("list returns saved IDs", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "aedis-scout-store-"));
    const store = new ScoutEvidenceStore(stateRoot);

    await store.save({
      runId: "run-a",
      prompt: "a",
      repoPath: "/tmp/a",
      reports: [],
      spawnDecision: {
        spawn: false,
        reason: "test",
        scoutCount: 0,
        scoutTypes: [],
        localOrCloudRecommendation: "deterministic",
        expectedEvidence: [],
      },
      createdAt: "2026-04-29T00:00:00.000Z",
    });
    await store.save({
      runId: "run-b",
      prompt: "b",
      repoPath: "/tmp/b",
      reports: [],
      spawnDecision: {
        spawn: false,
        reason: "test",
        scoutCount: 0,
        scoutTypes: [],
        localOrCloudRecommendation: "deterministic",
        expectedEvidence: [],
      },
      createdAt: "2026-04-29T00:00:00.000Z",
    });

    const ids = await store.list();
    assert.ok(ids.includes("run-a"));
    assert.ok(ids.includes("run-b"));
  });

  it("scout report includes model/provider/cost/confidence", async () => {
    const report = makeReport("repo_map");
    assert.equal(report.modelProvider, "local");
    assert.equal(report.modelName, "local");
    assert.equal(report.costUsd, 0);
    assert.equal(report.confidence, 0.8);
    assert.ok(report.startedAt);
    assert.ok(report.completedAt);
  });

  it("target repo remains clean (evidence only under stateRoot)", () => {
    // This is a structural assertion: ScoutEvidenceStore always writes
    // under stateRoot/state/scout-evidence/, never under repoPath.
    const stateRoot = mkdtempSync(join(tmpdir(), "aedis-scout-store-"));
    const store = new ScoutEvidenceStore(stateRoot);
    const path = store.getEvidencePath("any-run-id");
    assert.ok(path.startsWith(join(stateRoot, "state", "scout-evidence")));
  });
});
