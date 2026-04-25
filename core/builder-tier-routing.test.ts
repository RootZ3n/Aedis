import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BuilderWorker } from "../workers/builder.js";

test("BuilderWorker resolves the configured premium tier model for builder assignments", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "aedis-builder-tier-"));
  try {
    mkdirSync(join(projectRoot, ".aedis"), { recursive: true });
    writeFileSync(
      join(projectRoot, ".aedis", "model-config.json"),
      JSON.stringify({
        builder: { model: "cheap-fast", provider: "openrouter" },
        escalation: { model: "premium-fallback", provider: "anthropic" },
        builderTiers: {
          standard: { model: "standard-main", provider: "openrouter" },
          premium: { model: "premium-main", provider: "anthropic" },
        },
      }),
      "utf-8",
    );

    const worker = new BuilderWorker({ projectRoot });
    const assignment = {
      task: {
        id: "task-1",
        parentTaskId: null,
        workerType: "builder",
        description: "Modify src/file.ts",
        targetFiles: ["src/file.ts"],
        status: "pending",
        assignedTo: null,
        result: null,
        startedAt: null,
        completedAt: null,
        costAccrued: null,
      },
      intent: {
        id: "intent-1",
        runId: "run-1",
        version: 1,
        parentId: null,
        createdAt: new Date().toISOString(),
        userRequest: "modify src/file.ts",
        charter: {
          objective: "Implement: modify src/file.ts",
          successCriteria: [],
          deliverables: [],
          qualityBar: "standard",
        },
        constraints: [],
        acceptedAssumptions: [],
        exclusions: [],
        revisionReason: null,
      },
      context: {
        layers: [],
        totalTokens: 0,
        budgetUsed: 0,
        budgetTotal: 32000,
        truncated: false,
        fileCount: 0,
        rejectedCandidates: [],
      },
      upstreamResults: [],
      tier: "premium",
      tokenBudget: 1200,
      projectRoot,
      sourceRepo: projectRoot,
    } as const;

    const premiumCost = await worker.estimateCost(assignment as any);
    assert.equal(premiumCost.model, "premium-main");

    const standardCost = await worker.estimateCost({ ...(assignment as any), tier: "standard" });
    assert.equal(standardCost.model, "standard-main");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
