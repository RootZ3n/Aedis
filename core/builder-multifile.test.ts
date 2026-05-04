import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BuilderWorker } from "../workers/builder.js";

function makeAssignment(projectRoot: string) {
  return {
    task: {
      id: "task-1",
      parentTaskId: null,
      workerType: "builder",
      description: "Refactor route registration across src/server.ts and src/router.ts",
      targetFiles: ["src/server.ts", "src/router.ts"],
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
      userRequest: "Refactor route registration across src/server.ts and src/router.ts",
      charter: {
        objective: "Refactor route registration",
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
    tier: "standard",
    tokenBudget: 1200,
    projectRoot,
    sourceRepo: projectRoot,
  } as const;
}

test("BuilderWorker.canHandle throws when atomicBuilder.file is empty", () => {
  // Defense-in-depth: even if the coordinator's pre-dispatch validator
  // were bypassed, an empty atomicBuilder.file would otherwise satisfy
  // canHandle's `targetFiles[0] === atomicBuilder.file` check (both
  // empty) and silently dispatch. Builder must refuse here.
  const projectRoot = mkdtempSync(join(tmpdir(), "aedis-builder-empty-"));
  try {
    const worker = new BuilderWorker({ projectRoot });
    const assignment = {
      ...makeAssignment(projectRoot),
      task: {
        ...makeAssignment(projectRoot).task,
        targetFiles: [""],
      },
      atomicBuilder: { file: "", operation: "modify code", expectedDiffShape: "one localized hunk" },
    };
    assert.throws(
      () => worker.canHandle(assignment as any),
      /atomicBuilder\.file is empty/i,
      "canHandle must throw on empty atomic file",
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("BuilderWorker accepts multi-file assignments and builds a coordinated contract", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "aedis-builder-multi-"));
  try {
    mkdirSync(join(projectRoot, "src"), { recursive: true });
    writeFileSync(join(projectRoot, "src", "server.ts"), "export function startServer() { return true; }\n", "utf-8");
    writeFileSync(join(projectRoot, "src", "router.ts"), "export function registerRoutes() { return ['/']; }\n", "utf-8");

    const worker = new BuilderWorker({ projectRoot });
    const assignment = makeAssignment(projectRoot);
    assert.equal(worker.canHandle(assignment as any), true);

    const contract = (worker as any).buildContract(assignment, "src/router.ts") as {
      file: string;
      scopeFiles: readonly string[];
      siblingFiles: readonly string[];
      mode: string;
      interfaceRules: readonly string[];
    };

    assert.equal(contract.file, "src/router.ts");
    assert.equal(contract.mode, "coordinated-multi-file");
    assert.deepEqual([...contract.scopeFiles].sort(), ["src/router.ts", "src/server.ts"]);
    assert.deepEqual(contract.siblingFiles, ["src/server.ts"]);
    assert.ok(
      contract.interfaceRules.some((rule) => /sibling files|coordinated assignment/i.test(rule)),
      `expected coordinated interface rule, got ${contract.interfaceRules.join(" | ")}`,
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
