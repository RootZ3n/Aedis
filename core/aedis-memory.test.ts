import test from "node:test";
import assert from "node:assert/strict";
import type { ProjectMemory } from "./project-memory.js";
import type { RunReceipt } from "./coordinator.js";
import type { RunState } from "./runstate.js";
import type { VerificationReceipt } from "./verification-pipeline.js";
import type { MergeDecision } from "./merge-gate.js";
import type { RepairResult } from "./repair-pass.js";
import type { FileChange, WorkerResult } from "../workers/base.js";
import { AedisMemoryAdapter, toGatedContext, type AedisMemoryRuntime, type MemoryEntryRecord } from "./aedis-memory.js";

test("persistRunMemory writes project, run, outcome, and file entries", async () => {
  const runtime = createFakeRuntime();
  const adapter = new AedisMemoryAdapter(runtime);

  const suggestions = await adapter.persistRunMemory(samplePersistInput({
    receipt: sampleReceipt("failed"),
    verificationReceipt: sampleVerification("fail"),
    mergeDecision: sampleMergeDecision("block"),
  }));

  const spaces = runtime.entries.map((entry) => entry.space);
  assert.ok(spaces.includes("aedis/runs"));
  assert.ok(spaces.some((space) => space.startsWith("aedis/project/")));
  assert.ok(spaces.includes("aedis/failures"));
  assert.ok(spaces.includes("aedis/files"));
  assert.ok(suggestions.suggestions.length > 0);
});

test("buildExecutionContext favors same repo and file area while surfacing landmines and safe approaches", async () => {
  const runtime = createFakeRuntime();
  runtime.entries.push(
    entry({
      id: "failure-1",
      space: "aedis/failures",
      kind: "aedis-failure",
      title: "Regression in core/coordinator.ts",
      summary: "Previous refactor broke checkpoint execution.",
      repoId: "/repo/aedis",
      filePaths: ["core/coordinator.ts"],
      tags: ["failure-pattern"],
    }),
    entry({
      id: "failure-2",
      space: "aedis/failures",
      kind: "aedis-failure",
      title: "Another regression in core/coordinator.ts",
      summary: "Recovery logic failed after touching coordinator dispatch.",
      repoId: "/repo/aedis",
      filePaths: ["core/coordinator.ts"],
      tags: ["failure-pattern"],
    }),
    entry({
      id: "success-1",
      space: "aedis/success",
      kind: "aedis-success",
      title: "Scoped fix for core/coordinator.ts",
      summary: "Keeping the patch inside dispatchNode and re-running typecheck worked.",
      repoId: "/repo/aedis",
      filePaths: ["core/coordinator.ts"],
      tags: ["success-pattern"],
    }),
    entry({
      id: "unrelated",
      space: "aedis/failures",
      kind: "aedis-failure",
      title: "Other repo issue",
      summary: "Should stay out of the current context.",
      repoId: "/repo/other",
      filePaths: ["docs/notes.md"],
      tags: ["failure-pattern"],
    }),
  );

  const adapter = new AedisMemoryAdapter(runtime);
  const context = await adapter.buildExecutionContext({
    projectRoot: "/repo/aedis",
    prompt: "fix coordinator dispatch",
    projectMemory: sampleProjectMemory(),
    scopeClassification: { type: "multi-file", blastRadius: 7, recommendDecompose: true, reason: "multi-file" },
    targetFiles: ["core/coordinator.ts"],
  });

  assert.ok(context.relevantFiles.includes("core/coordinator.ts"));
  assert.ok(context.landmines.some((line) => line.includes("core/coordinator.ts")));
  assert.ok(context.safeApproaches.some((line) => line.includes("dispatchNode") || line.includes("typecheck")));
  assert.ok(context.inclusionLog.every((line) => !line.includes("docs/notes.md")));

  const gated = toGatedContext(context, "typescript");
  assert.equal(gated.strictVerification, true);
});

test("persist → retrieve round trip surfaces prior failures and successes on the same file", async () => {
  const runtime = createFakeRuntime();
  const adapter = new AedisMemoryAdapter(runtime);

  // A prior failed run on core/coordinator.ts…
  await adapter.persistRunMemory(samplePersistInput({
    receipt: sampleReceipt("failed"),
    verificationReceipt: sampleVerification("fail"),
    mergeDecision: sampleMergeDecision("block"),
  }));
  // …and a second failed run on the same file (two is the landmine threshold).
  await adapter.persistRunMemory({
    ...samplePersistInput({
      receipt: { ...sampleReceipt("failed"), runId: "run-2", id: "receipt-2", intentId: "intent-2" },
      verificationReceipt: { ...sampleVerification("fail"), runId: "run-2", id: "verify-2" },
      mergeDecision: sampleMergeDecision("block"),
    }),
  });
  // …and finally a successful run in the same area to validate success recall.
  await adapter.persistRunMemory({
    ...samplePersistInput({
      receipt: { ...sampleReceipt("success"), runId: "run-3", id: "receipt-3", intentId: "intent-3" },
      verificationReceipt: { ...sampleVerification("pass"), runId: "run-3", id: "verify-3" },
      mergeDecision: sampleMergeDecision("apply"),
    }),
  });

  const context = await adapter.buildExecutionContext({
    projectRoot: "/repo/aedis",
    prompt: "regression in coordinator dispatch",
    projectMemory: sampleProjectMemory(),
    scopeClassification: { type: "single-file", blastRadius: 2, recommendDecompose: false, reason: "single-file" },
    targetFiles: ["core/coordinator.ts"],
  });

  assert.ok(context.relevantFiles.includes("core/coordinator.ts"));
  assert.ok(
    context.landmines.some((line) => line.includes("core/coordinator.ts") && line.includes("failed")),
    `expected landmine on core/coordinator.ts, got: ${JSON.stringify(context.landmines)}`,
  );
  assert.ok(
    context.safeApproaches.some((line) => line.toLowerCase().includes("success") || line.toLowerCase().includes("scope")),
    `expected a success pattern to surface, got: ${JSON.stringify(context.safeApproaches)}`,
  );
  assert.equal(context.strictVerification, true, "landmines should force strict verification");
});

test("buildExecutionContext stays narrow and does not over-inject unrelated history", async () => {
  const runtime = createFakeRuntime();
  for (let i = 0; i < 12; i += 1) {
    runtime.entries.push(entry({
      id: `entry-${i}`,
      space: i % 2 === 0 ? "aedis/runs" : "aedis/project/repo-aedis",
      kind: "aedis-task",
      title: `Task ${i}`,
      summary: `Summary ${i}`,
      repoId: "/repo/aedis",
      filePaths: [i < 6 ? "core/coordinator.ts" : `other/file-${i}.ts`],
      tags: ["aedis-task"],
    }));
  }
  const adapter = new AedisMemoryAdapter(runtime);
  const context = await adapter.buildExecutionContext({
    projectRoot: "/repo/aedis",
    prompt: "fix coordinator dispatch",
    projectMemory: sampleProjectMemory(),
    targetFiles: ["core/coordinator.ts"],
  });

  assert.ok(context.recentTaskSummaries.length <= 4);
  assert.ok(context.relevantFiles.length <= 10);
  assert.ok(context.memoryNotes.length <= 4);
});

function createFakeRuntime(): AedisMemoryRuntime & { entries: MemoryEntryRecord[] } {
  const entries: MemoryEntryRecord[] = [];
  return {
    entries,
    ingest: {
      async remember(input) {
        const entry: MemoryEntryRecord = {
          ...input,
          createdAt: input.createdAt ?? new Date().toISOString(),
        };
        entries.push(entry);
        return entry;
      },
    },
    retrieval: {
      async retrieve(query) {
        return filterEntries(entries, query).map((entry) => ({ entry, score: 1, reasons: ["fake"] }));
      },
    },
    contextGate: {
      async buildContextPack(request) {
        // Rank: failure space first (landmine recall beats everything),
        // then success (safe-pattern recall), then files, then project,
        // then runs. This mirrors the real substrate's prioritization of
        // diagnostic-over-chronicle signals when a query names file paths.
        const priority = (space: string): number => {
          if (space === "aedis/failures") return 0;
          if (space === "aedis/success") return 1;
          if (space === "aedis/files") return 2;
          if (space.startsWith("aedis/project/")) return 3;
          if (space === "aedis/runs") return 4;
          return 5;
        };
        const filtered = filterEntries(entries, request)
          .slice()
          .sort((a, b) => priority(a.space) - priority(b.space))
          .slice(0, Number(request["maxEntries"] ?? 6));
        return {
          entries: filtered.map((entry) => ({ entry, score: 1, reasons: [`repo:${entry.repoId ?? ""}`] })),
          totalChars: 0,
          rationale: filtered.map((entry) => `picked:${entry.id}`),
        };
      },
    },
  };
}

function filterEntries(entries: MemoryEntryRecord[], query: Record<string, unknown>): MemoryEntryRecord[] {
  const repoId = typeof query["repoId"] === "string" ? query["repoId"] : null;
  const spaces = Array.isArray(query["spaces"]) ? query["spaces"].filter((value): value is string => typeof value === "string") : [];
  const filePaths = Array.isArray(query["filePaths"]) ? query["filePaths"].filter((value): value is string => typeof value === "string") : [];

  return entries.filter((entry) => {
    if (repoId && entry.repoId !== repoId) return false;
    if (spaces.length > 0 && !spaces.includes(entry.space)) return false;
    if (filePaths.length > 0) {
      const entryFiles = entry.filePaths ?? [];
      if (!entryFiles.some((file) => filePaths.includes(file))) return false;
    }
    return true;
  });
}

function samplePersistInput(overrides?: Partial<{
  receipt: RunReceipt;
  verificationReceipt: VerificationReceipt | null;
  mergeDecision: MergeDecision | null;
}>): {
  projectRoot: string;
  rawInput: string;
  normalizedPrompt: string;
  projectMemory: ProjectMemory;
  run: RunState;
  receipt: RunReceipt;
  changes: readonly FileChange[];
  workerResults: readonly WorkerResult[];
  verificationReceipt: VerificationReceipt | null;
  mergeDecision: MergeDecision | null;
  repairResult: RepairResult | null;
  commitSha: string | null;
  scopeClassification: { type: "multi-file"; blastRadius: number; recommendDecompose: boolean; reason: string };
} {
  return {
    projectRoot: "/repo/aedis",
    rawInput: "fix coordinator dispatch",
    normalizedPrompt: "in core/coordinator.ts, fix coordinator dispatch",
    projectMemory: sampleProjectMemory(),
    run: sampleRunState(),
    receipt: overrides?.receipt ?? sampleReceipt("success"),
    changes: [{ path: "core/coordinator.ts", operation: "modify", diff: "@@" }],
    workerResults: [sampleWorkerResult()],
    verificationReceipt: overrides?.verificationReceipt ?? sampleVerification("pass"),
    mergeDecision: overrides?.mergeDecision ?? sampleMergeDecision("apply"),
    repairResult: { repairsAttempted: 1, repairsApplied: 1, issues: [] },
    commitSha: "abc123def456",
    scopeClassification: { type: "multi-file", blastRadius: 7, recommendDecompose: true, reason: "multi-file" },
  };
}

function sampleProjectMemory(): ProjectMemory {
  return {
    projectRoot: "/repo/aedis",
    language: "typescript",
    recentFiles: ["core/coordinator.ts", "core/context-gate.ts"],
    recentTasks: [],
    fileClusters: [{ files: ["core/coordinator.ts", "core/context-gate.ts"], changedTogether: 3, lastSeen: "2026-04-11T17:00:00.000Z" }],
    updatedAt: "2026-04-11T17:00:00.000Z",
    schemaVersion: 1,
  };
}

function sampleReceipt(verdict: RunReceipt["verdict"]): RunReceipt {
  return {
    id: "receipt-1",
    runId: "run-1",
    intentId: "intent-1",
    timestamp: "2026-04-11T17:10:00.000Z",
    verdict,
    summary: {
      runId: "run-1",
      intentId: "intent-1",
      phase: verdict === "failed" ? "failed" : "complete",
      taskCounts: { total: 3, pending: 0, active: 0, completed: 2, failed: verdict === "failed" ? 1 : 0, skipped: 0 },
      totalCost: { model: "test", inputTokens: 10, outputTokens: 20, estimatedCostUsd: 0.12 },
      filesModified: 1,
      assumptions: 0,
      decisions: 1,
      issues: { info: 0, warning: 1, error: verdict === "failed" ? 1 : 0, critical: 0 },
      duration: 1000,
    },
    graphSummary: {
      totalNodes: 3,
      planned: 0,
      ready: 0,
      dispatched: 0,
      completed: 2,
      failed: verdict === "failed" ? 1 : 0,
      skipped: 0,
      blocked: 0,
      edgeCount: 2,
      mergeGroupCount: 0,
      checkpointCount: 0,
      escalationCount: 0,
    },
    verificationReceipt: null,
    waveVerifications: [],
    judgmentReport: null,
    mergeDecision: null,
    totalCost: { model: "test", inputTokens: 10, outputTokens: 20, estimatedCostUsd: 0.12 },
    commitSha: verdict === "success" ? "abc123" : null,
    durationMs: 1000,
    executionVerified: verdict === "success",
    executionGateReason: verdict === "success" ? "test fixture: verified" : "test fixture: not verified",
    executionEvidence: [],
    executionReceipts: [],
  };
}

function sampleVerification(verdict: VerificationReceipt["verdict"]): VerificationReceipt {
  return {
    id: "verify-1",
    runId: "run-1",
    intentId: "intent-1",
    timestamp: "2026-04-11T17:10:00.000Z",
    verdict,
    confidenceScore: verdict === "pass" ? 0.9 : 0.4,
    stages: [],
    judgmentReport: null,
    allIssues: [],
    blockers: [],
    summary: `verification ${verdict}`,
    totalDurationMs: 100,
  };
}

function sampleMergeDecision(action: MergeDecision["action"]): MergeDecision {
  return {
    action,
    findings: [],
    critical: [],
    advisory: [],
    primaryBlockReason: action === "block" ? "Typecheck failed in coordinator" : "",
    summary: action === "block" ? "blocked" : "apply",
  };
}

function sampleRunState(): RunState {
  return {
    id: "run-1",
    intentId: "intent-1",
    startedAt: "2026-04-11T17:00:00.000Z",
    phase: "complete",
    tasks: [],
    assumptions: [],
    filesTouched: [{ filePath: "core/coordinator.ts", operation: "modify", taskId: "task-1", timestamp: "2026-04-11T17:05:00.000Z" }],
    decisions: [],
    coherenceChecks: [],
    totalCost: { model: "test", inputTokens: 10, outputTokens: 20, estimatedCostUsd: 0.12 },
    completedAt: "2026-04-11T17:10:00.000Z",
    failureReason: null,
  };
}

function sampleWorkerResult(): WorkerResult {
  return {
    workerType: "builder",
    taskId: "task-1",
    success: false,
    output: { kind: "builder", changes: [{ path: "core/coordinator.ts", operation: "modify", diff: "@@" }], decisions: [], needsCriticReview: true },
    issues: [{ severity: "error", message: "Checkpoint wiring broke." }],
    cost: { model: "test", inputTokens: 10, outputTokens: 20, estimatedCostUsd: 0.12 },
    confidence: 0.4,
    touchedFiles: [{ path: "core/coordinator.ts", operation: "modify" }],
    assumptions: [],
    durationMs: 10,
  };
}

function entry(overrides: Partial<MemoryEntryRecord>): MemoryEntryRecord {
  return {
    id: overrides.id ?? "entry",
    space: overrides.space ?? "aedis/runs",
    kind: overrides.kind ?? "aedis-task",
    title: overrides.title ?? "entry",
    summary: overrides.summary,
    raw: overrides.raw,
    tags: overrides.tags ?? [],
    createdAt: overrides.createdAt ?? "2026-04-11T17:00:00.000Z",
    updatedAt: overrides.updatedAt,
    sourceSystem: overrides.sourceSystem ?? "aedis",
    repoId: overrides.repoId,
    filePaths: overrides.filePaths,
    evidenceRefs: overrides.evidenceRefs,
    relatedIds: overrides.relatedIds,
    relationships: overrides.relationships,
    confidence: overrides.confidence,
    metadata: overrides.metadata,
  };
}
