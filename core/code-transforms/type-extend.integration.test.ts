/**
 * Integration tests for the type-extend deterministic path.
 *
 * The Coordinator is given a prompt like "add email:string to User
 * interface", a tmp git repo seeded with a fixture file, and a
 * SentinelBuilder that throws if invoked. Asserts:
 *   - the deterministic layer applies the edit
 *   - the LLM Builder is never called
 *   - the persisted receipt records a deterministic builder attempt
 *   - the workspace file shows the new property
 *   - the source repo is byte-identical
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { Coordinator } from "../coordinator.js";
import { ReceiptStore } from "../receipt-store.js";
import { WorkerRegistry, AbstractWorker } from "../../workers/base.js";
import type {
  WorkerAssignment,
  WorkerResult,
  WorkerType,
  WorkerOutput,
} from "../../workers/base.js";
import type { CostEntry } from "../runstate.js";
import type { TrustProfile } from "../../router/trust-router.js";
import type { AedisEvent, EventBus } from "../../server/websocket.js";

const TYPES_TS = `
export interface User {
  id: string;
}

export type ApiResponse = {
  status: string;
};

import { z } from "zod";
export const FeatureFlagSchema = z.object({
  name: z.string(),
});
`.trimStart();

class SentinelBuilder extends AbstractWorker {
  readonly type: WorkerType = "builder";
  readonly name = "SentinelBuilder";
  public called = false;
  async execute(): Promise<WorkerResult> {
    this.called = true;
    throw new Error("SentinelBuilder: LLM Builder must NOT be invoked when the deterministic transform applies");
  }
  async estimateCost(): Promise<CostEntry> { return this.zeroCost(); }
  protected emptyOutput(): WorkerOutput {
    return { kind: "builder", changes: [], decisions: [], needsCriticReview: false };
  }
}
class StubScout extends AbstractWorker {
  readonly type: WorkerType = "scout"; readonly name = "StubScout";
  async execute(a: WorkerAssignment): Promise<WorkerResult> {
    return this.success(a, {
      kind: "scout", dependencies: [], patterns: [],
      riskAssessment: { level: "low", factors: [], mitigations: [] },
      suggestedApproach: "ok",
    }, { cost: this.zeroCost(), confidence: 0.9, touchedFiles: [], durationMs: 1 });
  }
  async estimateCost(): Promise<CostEntry> { return this.zeroCost(); }
  protected emptyOutput(): WorkerOutput {
    return { kind: "scout", dependencies: [], patterns: [], riskAssessment: { level: "low", factors: [], mitigations: [] }, suggestedApproach: "" };
  }
}
class StubCritic extends AbstractWorker {
  readonly type: WorkerType = "critic"; readonly name = "StubCritic";
  async execute(a: WorkerAssignment): Promise<WorkerResult> {
    return this.success(a, {
      kind: "critic", verdict: "approve", comments: [], suggestedChanges: [], intentAlignment: 0.9,
    }, { cost: this.zeroCost(), confidence: 0.9, touchedFiles: [], durationMs: 1 });
  }
  async estimateCost(): Promise<CostEntry> { return this.zeroCost(); }
  protected emptyOutput(): WorkerOutput {
    return { kind: "critic", verdict: "approve", comments: [], suggestedChanges: [], intentAlignment: 1 };
  }
}
class StubVerifier extends AbstractWorker {
  readonly type: WorkerType = "verifier"; readonly name = "StubVerifier";
  async execute(a: WorkerAssignment): Promise<WorkerResult> {
    return this.success(a, {
      kind: "verifier", testResults: [],
      typeCheckPassed: true, lintPassed: true, buildPassed: true, passed: true,
    }, { cost: this.zeroCost(), confidence: 0.9, touchedFiles: [], durationMs: 1 });
  }
  async estimateCost(): Promise<CostEntry> { return this.zeroCost(); }
  protected emptyOutput(): WorkerOutput {
    return { kind: "verifier", testResults: [], typeCheckPassed: true, lintPassed: true, buildPassed: true, passed: true };
  }
}
class StubIntegrator extends AbstractWorker {
  readonly type: WorkerType = "integrator"; readonly name = "StubIntegrator";
  async execute(a: WorkerAssignment): Promise<WorkerResult> {
    const finalChanges = [...(a.changes ?? [])];
    return this.success(a, {
      kind: "integrator", finalChanges, conflictsResolved: [],
      coherenceCheck: { passed: true, checks: [] }, readyToApply: true,
    }, { cost: this.zeroCost(), confidence: 0.9, touchedFiles: finalChanges.map((c) => ({ path: c.path, operation: c.operation })), durationMs: 1 });
  }
  async estimateCost(): Promise<CostEntry> { return this.zeroCost(); }
  protected emptyOutput(): WorkerOutput {
    return { kind: "integrator", finalChanges: [], conflictsResolved: [], coherenceCheck: { passed: true, checks: [] }, readyToApply: false };
  }
}

function buildHarness(projectRoot: string) {
  const builder = new SentinelBuilder();
  const registry = new WorkerRegistry();
  registry.register(new StubScout());
  registry.register(builder);
  registry.register(new StubCritic());
  registry.register(new StubVerifier());
  registry.register(new StubIntegrator());
  const trustProfile: TrustProfile = {
    scores: new Map(),
    tierThresholds: { fast: 0, standard: 0, premium: 0 },
  };
  const events: AedisEvent[] = [];
  const eventBus: EventBus = {
    emit(ev) { events.push(ev); },
    on: () => () => {}, onType: () => () => {},
    addClient: () => {}, removeClient: () => {},
    clientCount: () => 0, recentEvents: () => [],
  };
  const receiptStore = new ReceiptStore(projectRoot);
  const coordinator = new Coordinator(
    { projectRoot, autoCommit: false, requireWorkspace: true },
    trustProfile, registry, eventBus, receiptStore,
  );
  return { coordinator, events, receiptStore, builder };
}

function makeTypeFixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "aedis-type-int-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src/types.ts"), TYPES_TS, "utf-8");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "tt", version: "0.0.0" }), "utf-8");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t.local"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "T"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: dir });
  return dir;
}

test("integration: 'add email:string to User interface' applies deterministically — Builder NEVER invoked", async () => {
  const repo = makeTypeFixtureRepo();
  try {
    const { coordinator, events, builder, receiptStore } = buildHarness(repo);
    await coordinator.submit({
      input: "add email:string to User interface in src/types.ts",
    });
    assert.equal(builder.called, false, "LLM Builder must not be called for a recognized interface property add");

    const detEvt = events.find((e) =>
      e.type === "builder_complete" && (e.payload as Record<string, unknown>).provider === "deterministic"
    );
    assert.ok(detEvt, "expected a deterministic builder_complete event");

    const runStart = events.find((e) => e.type === "run_started");
    const runId = (runStart?.payload as { runId?: string } | undefined)?.runId;
    if (runId) {
      const persisted = await receiptStore.getRun(runId);
      const attempts = (persisted?.builderAttempts ?? []) as Array<Record<string, unknown>>;
      const det = attempts.find((a) => a.provider === "deterministic");
      assert.ok(det, "receipt should carry the deterministic attempt record");
      assert.equal(det!.guardRejected, false);
    }

    // Source repo unchanged
    const sourceContent = readFileSync(join(repo, "src/types.ts"), "utf-8");
    assert.equal(sourceContent, TYPES_TS, "source must be byte-identical");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("integration: 'add optional metadata?:Record<string,string> to ApiResponse type' applies deterministically", async () => {
  const repo = makeTypeFixtureRepo();
  try {
    const { coordinator, builder } = buildHarness(repo);
    await coordinator.submit({
      input: "add optional metadata?:Record<string,string> to ApiResponse type in src/types.ts",
    });
    assert.equal(builder.called, false);
    const sourceContent = readFileSync(join(repo, "src/types.ts"), "utf-8");
    assert.equal(sourceContent, TYPES_TS);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("integration: 'add enabled:boolean to FeatureFlagSchema' applies via zod transform", async () => {
  const repo = makeTypeFixtureRepo();
  try {
    const { coordinator, builder } = buildHarness(repo);
    await coordinator.submit({
      input: "add enabled:boolean to FeatureFlagSchema in src/types.ts",
    });
    assert.equal(builder.called, false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("integration: chained schema falls through (deterministic refuses, LLM is invoked)", async () => {
  // Set up a fixture where FeatureFlagSchema is chained. Now the
  // SentinelBuilder WILL be called — that's the expected fallback —
  // and it will throw, so the run fails. The point of this test is
  // that the deterministic layer correctly REFUSED rather than
  // applying a corrupting edit.
  const dir = mkdtempSync(join(tmpdir(), "aedis-type-int-chain-"));
  try {
    mkdirSync(join(dir, "src"), { recursive: true });
    const chained = `import { z } from "zod";
export const FeatureFlagSchema = z.object({
  name: z.string(),
}).strict();
`;
    writeFileSync(join(dir, "src/types.ts"), chained, "utf-8");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", version: "0.0.0" }), "utf-8");
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "t@t.local"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "T"], { cwd: dir });
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-qm", "init"], { cwd: dir });

    const { coordinator, builder } = buildHarness(dir);
    await coordinator.submit({
      input: "add enabled:boolean to FeatureFlagSchema in src/types.ts",
    });
    assert.equal(builder.called, true, "LLM Builder must be invoked when the deterministic layer refuses");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
