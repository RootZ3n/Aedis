/**
 * Phase D — model dispatch separation. Tests pin three contracts:
 *
 *   1. `createBuilderForLane` produces a transient BuilderWorker
 *      whose `pinnedModel` actually flows into the model selection
 *      path (`estimateCost` is the observable hook — it returns the
 *      model the worker would dispatch).
 *   2. The pin is single-shot: `getDeclaredFallbackChain` returns
 *      empty when pinned, so a lane invocation can't silently hop
 *      to another model from `.aedis/model-config.json`.
 *   3. `maybeRunFallbackShadow` calls the factory for the shadow
 *      lane and passes the resulting builder via `opts.builder` —
 *      verified by spying on `runShadowBuilder`.
 *
 * No network calls. No registry mutation. No cross-run leakage.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import {
  createBuilderForLane,
  describeSupportedProviderModels,
  isSupportedProvider,
  isSupportedProviderModel,
} from "./lane-builder-factory.js";
import { BuilderWorker } from "../workers/builder.js";
import { Coordinator } from "./coordinator.js";
import { ReceiptStore } from "./receipt-store.js";
import { WorkerRegistry, AbstractWorker } from "../workers/base.js";
import type {
  WorkerAssignment,
  WorkerResult,
  WorkerType,
  WorkerOutput,
  BuilderOutput,
} from "../workers/base.js";
import type { CostEntry, RunState, RunTask } from "./runstate.js";
import type { TrustProfile } from "../router/trust-router.js";
import type { AedisEvent, EventBus } from "../server/websocket.js";
import type { Provider } from "./model-invoker.js";
import type { Candidate } from "./candidate.js";

// ─── createBuilderForLane: input validation ─────────────────────────

test("createBuilderForLane returns a BuilderWorker for valid (provider, model)", () => {
  const builder = createBuilderForLane({
    projectRoot: "/tmp/lane-d",
    provider: "ollama",
    model: "qwen3.5:9b",
  });
  assert.ok(builder, "factory must return a Builder for a supported provider");
  assert.equal(builder!.type, "builder");
});

test("createBuilderForLane rejects unsupported providers (returns null)", () => {
  const builder = createBuilderForLane({
    projectRoot: "/tmp/lane-d",
    provider: "swarm-chaos-engine",
    model: "qwen3.5:9b",
  });
  assert.equal(builder, null);
});

test("createBuilderForLane rejects empty model and empty projectRoot", () => {
  assert.equal(
    createBuilderForLane({ projectRoot: "/tmp", provider: "ollama", model: "" }),
    null,
  );
  assert.equal(
    createBuilderForLane({ projectRoot: "/tmp", provider: "ollama", model: "   " }),
    null,
  );
  assert.equal(
    createBuilderForLane({ projectRoot: "", provider: "ollama", model: "qwen3.5:9b" }),
    null,
  );
});

test("isSupportedProvider type-guards string against the Provider union", () => {
  for (const p of [
    "ollama", "openrouter", "anthropic", "openai", "minimax",
    "modelstudio", "zai", "glm-5.1-openrouter", "glm-5.1-direct",
    "local",
  ] as Provider[]) {
    assert.equal(isSupportedProvider(p), true, `expected ${p} to be supported`);
  }
  assert.equal(isSupportedProvider("nonexistent"), false);
  assert.equal(isSupportedProvider(""), false);
});

test("isSupportedProviderModel validates public-RC provider/model pairs", () => {
  assert.equal(isSupportedProviderModel("ollama", "qwen3.5:9b"), true);
  assert.equal(isSupportedProviderModel("openrouter", "xiaomi/mimo-v2.5"), true);
  assert.equal(isSupportedProviderModel("ollama", "definitely-not-supported"), false);
  assert.equal(isSupportedProviderModel("swarm-chaos-engine", "qwen3.5:9b"), false);
  assert.match(describeSupportedProviderModels("ollama"), /qwen3\.5:9b/);
});

// ─── Pinned model flows into the model dispatch path ────────────────

function fakeAssignment(projectRoot: string): WorkerAssignment {
  // estimateCost only reads context lengths + tier + sourceRepo +
  // task.description — everything else can be a placeholder.
  const task: RunTask = {
    id: "t-1",
    parentTaskId: null,
    workerType: "builder",
    description: "describe a small change",
    targetFiles: ["core/widget.ts"],
    status: "active",
    assignedTo: null,
    result: null,
    startedAt: new Date().toISOString(),
    completedAt: null,
    costAccrued: null,
  };
  return {
    task,
    intent: { id: "i-1", runId: "r-1" } as any,
    context: { layers: [{ name: "stub", files: [{ path: "x", content: "" }] }] } as any,
    upstreamResults: [],
    tier: "standard",
    tokenBudget: 1024,
    runState: undefined,
    changes: [],
    workerResults: [],
    projectRoot,
    sourceRepo: projectRoot,
    recentContext: { relevantFiles: [], recentTaskSummaries: [], language: null, memoryNotes: [], suggestedNextSteps: [] } as any,
    implementationBrief: undefined,
    signal: new AbortController().signal,
  } as WorkerAssignment;
}

test("pinnedModel flows into estimateCost's model field", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aedis-laneD-"));
  try {
    // No .aedis/ files at all — proves the pin doesn't depend on disk
    // config and that pinning skips the loader.
    const builder = createBuilderForLane({
      projectRoot: dir,
      provider: "ollama",
      model: "qwen3.5:9b",
    });
    assert.ok(builder);
    const cost = await builder!.estimateCost(fakeAssignment(dir));
    assert.equal(cost.model, "qwen3.5:9b", "estimateCost must surface the pinned model");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pinnedModel ignores .aedis/model-config.json — pin wins, no disk read for model selection", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aedis-laneD-"));
  try {
    // Write a model-config that picks a DIFFERENT model. The factory
    // pin should still win. (Catches the bug where getActiveModelConfig
    // reads the disk before checking the pin.)
    mkdirSync(join(dir, ".aedis"), { recursive: true });
    writeFileSync(
      join(dir, ".aedis/model-config.json"),
      JSON.stringify({
        builder: { model: "deepseek-v4-flash", provider: "openrouter" },
      }),
    );
    const builder = createBuilderForLane({
      projectRoot: dir,
      provider: "ollama",
      model: "qwen3.5:9b",
    });
    const cost = await builder!.estimateCost(fakeAssignment(dir));
    assert.equal(cost.model, "qwen3.5:9b", "pinned model must override disk config");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getDeclaredFallbackChain returns [] when pinned (single-shot lane invariant)", () => {
  const dir = mkdtempSync(join(tmpdir(), "aedis-laneD-"));
  try {
    // Even with a chain on disk, the pinned builder must not extend it.
    mkdirSync(join(dir, ".aedis"), { recursive: true });
    writeFileSync(
      join(dir, ".aedis/model-config.json"),
      JSON.stringify({
        builder: {
          model: "deepseek-v4-flash",
          provider: "openrouter",
          chain: [{ provider: "anthropic", model: "claude-sonnet-4-6" }],
        },
      }),
    );
    const builder = createBuilderForLane({
      projectRoot: dir,
      provider: "ollama",
      model: "qwen3.5:9b",
    });
    // Cast: getDeclaredFallbackChain is private. Reading via index
    // sidesteps the visibility modifier so the lane invariant can be
    // pinned without making the method public for production use.
    const chain = (builder as any).getDeclaredFallbackChain(dir, "standard");
    assert.deepEqual(chain, [], "pinned builder must report empty fallback chain");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Different invocations produce independent instances ────────────

test("createBuilderForLane returns a fresh instance per call (no shared state)", () => {
  const a = createBuilderForLane({ projectRoot: "/tmp/a", provider: "ollama", model: "m1" });
  const b = createBuilderForLane({ projectRoot: "/tmp/a", provider: "ollama", model: "m2" });
  assert.ok(a && b);
  assert.notEqual(a, b, "two factory calls must produce two distinct instances");
});

test("two pinned builders with different models do not interfere", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aedis-laneD-"));
  try {
    const local = createBuilderForLane({
      projectRoot: dir, provider: "ollama", model: "qwen3.5:9b",
    });
    const cloud = createBuilderForLane({
      projectRoot: dir, provider: "openrouter", model: "xiaomi/mimo-v2.5",
    });
    const localCost = await local!.estimateCost(fakeAssignment(dir));
    const cloudCost = await cloud!.estimateCost(fakeAssignment(dir));
    assert.equal(localCost.model, "qwen3.5:9b");
    assert.equal(cloudCost.model, "xiaomi/mimo-v2.5");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Registry untouched ─────────────────────────────────────────────

test("createBuilderForLane does NOT touch the WorkerRegistry", () => {
  const registry = new WorkerRegistry();
  // Empty registry — factory must work without it being initialized.
  const before = registry.getWorkers("builder").length;
  const builder = createBuilderForLane({
    projectRoot: "/tmp", provider: "ollama", model: "qwen3.5:9b",
  });
  assert.ok(builder);
  const after = registry.getWorkers("builder").length;
  assert.equal(after, before, "registry must not gain a worker");
});

// ─── Integration: maybeRunFallbackShadow calls the factory for shadow ──

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
    }, {
      cost: this.zeroCost(), confidence: 0.9,
      touchedFiles: finalChanges.map((c) => ({ path: c.path, operation: c.operation })),
      durationMs: 1,
    });
  }
  async estimateCost(): Promise<CostEntry> { return this.zeroCost(); }
  protected emptyOutput(): WorkerOutput {
    return { kind: "integrator", finalChanges: [], conflictsResolved: [], coherenceCheck: { passed: true, checks: [] }, readyToApply: false };
  }
}

class RegisteredBuilder extends AbstractWorker {
  readonly type: WorkerType = "builder";
  readonly name = "RegisteredBuilder";
  public executions = 0;
  async execute(a: WorkerAssignment): Promise<WorkerResult> {
    this.executions += 1;
    const { writeFile, readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const root = a.projectRoot ?? process.cwd();
    const path = "core/widget.ts";
    const abs = resolve(root, path);
    const originalContent = await readFile(abs, "utf-8").catch(() => "");
    await writeFile(abs, "export const widget = 99;\n", "utf-8");
    const output: BuilderOutput = {
      kind: "builder",
      changes: [{
        path, operation: "modify",
        content: "export const widget = 99;\n",
        originalContent,
      }],
      decisions: [], needsCriticReview: false,
    };
    return this.success(a, output, {
      cost: this.zeroCost(), confidence: 0.9,
      touchedFiles: [{ path, operation: "modify" }], durationMs: 1,
    });
  }
  async estimateCost(): Promise<CostEntry> { return this.zeroCost(); }
  protected emptyOutput(): WorkerOutput {
    return { kind: "builder", changes: [], decisions: [], needsCriticReview: false };
  }
}

function makeRepoWithLaneConfig(payload: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "aedis-laneD-int-"));
  mkdirSync(join(dir, "core"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "tmp", version: "0.0.0" }), "utf-8");
  writeFileSync(join(dir, "core/widget.ts"), "export const widget = 1;\n", "utf-8");
  mkdirSync(join(dir, ".aedis"), { recursive: true });
  writeFileSync(join(dir, ".aedis/lane-config.json"), JSON.stringify(payload, null, 2), "utf-8");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "lane@aedis.local"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Lane"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: dir });
  return dir;
}

function buildHarness(projectRoot: string, opts: {
  typecheckPasses: boolean;
  /**
   * Override the lane builder factory. Defaults to a stub-returning
   * factory that records calls and yields the registered Builder so
   * tests never reach the network.
   */
  laneBuilderFactory?: typeof createBuilderForLane;
}) {
  const registry = new WorkerRegistry();
  registry.register(new StubScout());
  const registered = new RegisteredBuilder();
  registry.register(registered);
  registry.register(new StubCritic());
  registry.register(new StubVerifier());
  registry.register(new StubIntegrator());

  const trustProfile: TrustProfile = {
    scores: new Map(),
    tierThresholds: { fast: 0, standard: 0, premium: 0 },
  };
  const events: AedisEvent[] = [];
  const eventBus: EventBus = {
    emit(ev) { events.push(ev); }, on: () => () => {},
    onType: () => () => {}, addClient: () => {},
    removeClient: () => {}, clientCount: () => 0, recentEvents: () => [],
  };
  const receiptStore = new ReceiptStore(projectRoot);
  const coordinator = new Coordinator(
    {
      projectRoot, autoCommit: true, requireWorkspace: true,
      requireApproval: false, autoPromoteOnSuccess: false,
      // Default: factory returns null so the registered RegisteredBuilder
      // takes the shadow lane. Tests that want to verify factory wiring
      // pass an explicit override.
      laneBuilderFactory: opts.laneBuilderFactory ?? (() => null),
      verificationConfig: {
        requiredChecks: [],
        hooks: [{
          name: "stub-typecheck", stage: "typecheck", kind: "typecheck",
          execute: async () => opts.typecheckPasses
            ? { passed: true, issues: [], stdout: "", stderr: "", exitCode: 0, durationMs: 0 }
            : {
                passed: false,
                issues: [{
                  stage: "typecheck" as const, severity: "blocker" as const,
                  message: "synthetic typecheck failure to disqualify primary",
                }],
                stdout: "", stderr: "", exitCode: 1, durationMs: 0,
              },
        }],
      },
    },
    trustProfile, registry, eventBus, receiptStore,
  );
  return { coordinator, events, receiptStore, registered };
}

test("integration: maybeRunFallbackShadow calls the lane factory with config.shadow inputs", async () => {
  const dir = makeRepoWithLaneConfig({
    mode: "local_then_cloud",
    allowFallback: true,
    primary: { lane: "local", provider: "ollama", model: "qwen3.5:9b" },
    shadow: { lane: "cloud", provider: "openrouter", model: "xiaomi/mimo-v2.5" },
  });
  try {
    // Stub factory: records every call and returns the registered
    // RegisteredBuilder so the shadow lane runs the same harness
    // stub the rest of the suite already trusts. No network.
    const calls: Array<{ provider: string; model: string }> = [];
    let returnedBuilder: AbstractWorker | null = null;
    const stubFactory: typeof createBuilderForLane = (input) => {
      calls.push({ provider: input.provider, model: input.model });
      // Borrow the harness's RegisteredBuilder by typing the return
      // — the Coordinator only needs an object that implements
      // BaseWorker, and runShadowBuilder won't introspect further.
      return returnedBuilder as unknown as BuilderWorker;
    };

    const harness = buildHarness(dir, {
      typecheckPasses: false,
      laneBuilderFactory: stubFactory,
    });
    returnedBuilder = harness.registered;

    await harness.coordinator.submit({ input: "modify widget in core" });

    // Phase D: factory is called for BOTH primary (dispatchNode) and shadow
    // (maybeRunFallbackShadow). Primary call uses laneConfig.primary,
    // shadow call uses laneConfig.shadow.
    assert.equal(calls.length, 2, "factory must be called for primary + shadow");
    const primaryCall = calls.find((c) => c.provider === "ollama");
    const shadowCall = calls.find((c) => c.provider === "openrouter");
    assert.ok(primaryCall, "factory must be called with primary provider");
    assert.deepEqual(shadowCall, {
      provider: "openrouter",
      model: "xiaomi/mimo-v2.5",
    }, "factory must receive lane-config.shadow.{provider,model}");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("integration: factory is NOT invoked when primary qualifies (shadow lane skipped)", async () => {
  const dir = makeRepoWithLaneConfig({
    mode: "local_then_cloud",
    allowFallback: true,
    primary: { lane: "local", provider: "ollama", model: "qwen3.5:9b" },
    shadow: { lane: "cloud", provider: "openrouter", model: "xiaomi/mimo-v2.5" },
  });
  try {
    let invoked = 0;
    let returnedBuilder: AbstractWorker | null = null;
    const stubFactory: typeof createBuilderForLane = () => {
      invoked += 1;
      return returnedBuilder as unknown as BuilderWorker;
    };
    const { coordinator, registered } = buildHarness(dir, {
      typecheckPasses: true,
      laneBuilderFactory: stubFactory,
    });
    returnedBuilder = registered;
    await coordinator.submit({ input: "modify widget in core" });
    // Phase D: factory IS called for the primary lane (dispatchNode pin),
    // but NOT for the shadow lane (primary qualified → shadow skipped).
    assert.equal(invoked, 1, "factory must be invoked once for primary lane only (shadow skipped)");
    assert.equal(registered.executions, 1, "only primary lane runs");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("integration: factory not invoked under primary_only (laneConfig fast-path)", async () => {
  const dir = makeRepoWithLaneConfig({
    mode: "primary_only",
    primary: { lane: "cloud", provider: "openrouter", model: "xiaomi/mimo-v2.5" },
  });
  try {
    let invoked = 0;
    const stubFactory: typeof createBuilderForLane = () => {
      invoked += 1;
      return null;
    };
    const { coordinator } = buildHarness(dir, {
      typecheckPasses: false,
      laneBuilderFactory: stubFactory,
    });
    await coordinator.submit({ input: "modify widget in core" });
    assert.equal(invoked, 0, "primary_only must never call the lane factory");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("integration: factory returning null falls back to registered Builder + manifest still records intended labels", async () => {
  const dir = makeRepoWithLaneConfig({
    mode: "local_then_cloud",
    allowFallback: true,
    primary: { lane: "local", provider: "ollama", model: "qwen3.5:9b" },
    shadow: { lane: "cloud", provider: "openrouter", model: "xiaomi/mimo-v2.5" },
  });
  try {
    const harness = buildHarness(dir, {
      typecheckPasses: false,
      laneBuilderFactory: () => null,
    });
    await harness.coordinator.submit({ input: "modify widget in core" });
    // Both lanes used the same registered RegisteredBuilder when the
    // factory returned null — so executions === 2 (primary + shadow).
    assert.equal(harness.registered.executions, 2, "registered builder runs primary + shadow when factory disabled");

    // The candidate manifest still records the intended lane labels
    // even though both lanes used the same model. Phase D's safety
    // contract: lane attribution is always honest about INTENT, even
    // when DISPATCH had to fall back.
    const persisted = await harness.receiptStore.listRuns(1);
    assert.equal(persisted.length, 1);
    const detail = await harness.receiptStore.getRun(persisted[0].runId);
    const final = (detail as any).finalReceipt;
    assert.equal(final.providerLaneTruth.status, "fallback_used");
    assert.match(final.humanSummary.headline, /explicitly allowed provider\/model\/lane fallback/);
    assert.ok(final.candidates);
    const shadow = final.candidates.find((c: any) => c.role === "shadow");
    assert.ok(shadow, "shadow candidate still recorded");
    assert.equal(shadow.lane, "cloud");
    assert.equal(shadow.provider, "openrouter");
    assert.equal(shadow.model, "xiaomi/mimo-v2.5");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function submitUnsupportedLaneConfig(payload: unknown) {
  const dir = makeRepoWithLaneConfig(payload);
  const harness = buildHarness(dir, {
    typecheckPasses: false,
    laneBuilderFactory: () => {
      throw new Error("lane factory must not run for unsupported config");
    },
  });
  const receipt = await harness.coordinator.submit({ input: "modify widget in core" });
  const persisted = await harness.receiptStore.listRuns(1);
  const detail = await harness.receiptStore.getRun(persisted[0].runId);
  return { dir, harness, receipt, detail };
}

test("fail-closed: unsupported provider does not run the default builder", async () => {
  const { dir, harness, receipt, detail } = await submitUnsupportedLaneConfig({
    mode: "local_then_cloud",
    primary: { lane: "local", provider: "swarm-chaos-engine", model: "qwen3.5:9b" },
    shadow: { lane: "cloud", provider: "openrouter", model: "xiaomi/mimo-v2.5" },
  });
  try {
    assert.equal(receipt.verdict, "failed");
    assert.equal(harness.registered.executions, 0, "registry default builder must not run");
    assert.equal(detail?.status, "UNSUPPORTED_CONFIG");
    assert.equal(receipt.providerLaneTruth?.status, "not_run");
    assert.equal(receipt.providerLaneTruth?.intendedProvider, "swarm-chaos-engine");
    assert.equal(receipt.providerLaneTruth?.actualProvider, null);
    assert.equal(receipt.providerLaneTruth?.actualModel, null);
    assert.match(receipt.humanSummary?.headline ?? "", /did not run a builder/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fail-closed: unsupported model preserves intent and records actual as not_run", async () => {
  const { dir, harness, receipt, detail } = await submitUnsupportedLaneConfig({
    mode: "local_then_cloud",
    primary: { lane: "local", provider: "ollama", model: "not-a-public-rc-model" },
    shadow: { lane: "cloud", provider: "openrouter", model: "xiaomi/mimo-v2.5" },
  });
  try {
    assert.equal(receipt.verdict, "failed");
    assert.equal(harness.registered.executions, 0);
    assert.equal(detail?.status, "UNSUPPORTED_CONFIG");
    assert.equal(receipt.providerLaneTruth?.intendedProvider, "ollama");
    assert.equal(receipt.providerLaneTruth?.intendedModel, "not-a-public-rc-model");
    assert.equal(receipt.providerLaneTruth?.intendedLane, "local");
    assert.equal(receipt.providerLaneTruth?.actualProvider, null);
    assert.equal(receipt.providerLaneTruth?.actualModel, null);
    assert.match(receipt.providerLaneTruth?.reason ?? "", /Unsupported primary model/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fail-closed: unsupported lane config fails before execution", async () => {
  const { dir, harness, receipt, detail } = await submitUnsupportedLaneConfig({
    mode: "local_then_cloud",
    primary: { lane: "edge", provider: "ollama", model: "qwen3.5:9b" },
    shadow: { lane: "cloud", provider: "openrouter", model: "xiaomi/mimo-v2.5" },
  });
  try {
    assert.equal(receipt.verdict, "failed");
    assert.equal(harness.registered.executions, 0);
    assert.equal(detail?.status, "UNSUPPORTED_CONFIG");
    assert.equal(receipt.providerLaneTruth?.status, "not_run");
    assert.equal(receipt.providerLaneTruth?.actualLane, null);
    assert.match(receipt.providerLaneTruth?.reason ?? "", /failed validation|Unsupported lane config/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Phase D: per-lane model dispatch — primary + shadow use distinct builders ──

test("integration: primary lane uses factory-pinned builder when laneConfig.primary is set (local_then_cloud)", async () => {
  const dir = makeRepoWithLaneConfig({
    mode: "local_then_cloud",
    allowFallback: true,
    primary: { lane: "local", provider: "ollama", model: "qwen3.5:9b" },
    shadow: { lane: "cloud", provider: "openrouter", model: "xiaomi/mimo-v2.5" },
  });
  try {
    const calls: Array<{ provider: string; model: string; role: string }> = [];
    let callCount = 0;
    let returnedBuilder: AbstractWorker | null = null;
    const stubFactory: typeof createBuilderForLane = (input) => {
      callCount += 1;
      // First call = primary (dispatchNode), second = shadow (maybeRunFallbackShadow)
      const role = callCount === 1 ? "primary" : "shadow";
      calls.push({ provider: input.provider, model: input.model, role });
      // Return the registered stub so no real provider is called; this test
      // verifies the factory is CALLED with correct args, not that it
      // produces a working builder (that's covered by other tests).
      return returnedBuilder as unknown as BuilderWorker;
    };
    const harness = buildHarness(dir, {
      typecheckPasses: false,
      laneBuilderFactory: stubFactory,
    });
    returnedBuilder = harness.registered;
    await harness.coordinator.submit({ input: "modify widget in core" });

    // Factory must be called for BOTH primary and shadow lanes.
    assert.ok(calls.length >= 2, `factory must be called for primary + shadow; got ${calls.length} calls`);
    const primaryCall = calls.find((c) => c.role === "primary");
    const shadowCall = calls.find((c) => c.role === "shadow");
    assert.ok(primaryCall, "factory must be called for primary lane");
    assert.ok(shadowCall, "factory must be called for shadow lane");
    assert.deepEqual(
      { provider: primaryCall!.provider, model: primaryCall!.model },
      { provider: "ollama", model: "qwen3.5:9b" },
      "primary factory call must use laneConfig.primary",
    );
    assert.deepEqual(
      { provider: shadowCall!.provider, model: shadowCall!.model },
      { provider: "openrouter", model: "xiaomi/mimo-v2.5" },
      "shadow factory call must use laneConfig.shadow",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("integration: primary_only mode does NOT call factory for primary builder", async () => {
  const dir = makeRepoWithLaneConfig({
    mode: "primary_only",
    primary: { lane: "cloud", provider: "openrouter", model: "xiaomi/mimo-v2.5" },
  });
  try {
    let invoked = 0;
    const stubFactory: typeof createBuilderForLane = () => {
      invoked += 1;
      return null;
    };
    const { coordinator } = buildHarness(dir, {
      typecheckPasses: true,
      laneBuilderFactory: stubFactory,
    });
    await coordinator.submit({ input: "modify widget in core" });
    assert.equal(invoked, 0, "primary_only must not call the lane factory for either lane");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("integration: two distinct pinned builders for primary and shadow with different models", async () => {
  const dir = makeRepoWithLaneConfig({
    mode: "local_then_cloud",
    allowFallback: true,
    primary: { lane: "local", provider: "ollama", model: "qwen3.5:9b" },
    shadow: { lane: "cloud", provider: "openrouter", model: "xiaomi/mimo-v2.5" },
  });
  try {
    // Track which builder instances are created and which model they carry.
    const instances: Array<{ provider: string; model: string; instance: object }> = [];
    let returnedBuilder: AbstractWorker | null = null;
    const stubFactory: typeof createBuilderForLane = (input) => {
      // Return the registered stub but record the call to
      // prove distinct instantiation was attempted with different models.
      instances.push({ provider: input.provider, model: input.model, instance: {} });
      return returnedBuilder as unknown as BuilderWorker;
    };
    const harness = buildHarness(dir, {
      typecheckPasses: false,
      laneBuilderFactory: stubFactory,
    });
    returnedBuilder = harness.registered;
    await harness.coordinator.submit({ input: "modify widget in core" });

    // Must have at least 2 factory calls with DIFFERENT models.
    assert.ok(instances.length >= 2, `expected >= 2 factory calls; got ${instances.length}`);
    const models = new Set(instances.map((i) => `${i.provider}/${i.model}`));
    assert.ok(
      models.size >= 2,
      `factory must be called with at least 2 distinct provider/model combos; got ${JSON.stringify([...models])}`,
    );
    assert.ok(models.has("ollama/qwen3.5:9b"), "primary model missing");
    assert.ok(models.has("openrouter/xiaomi/mimo-v2.5"), "shadow model missing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("integration: registry is not mutated when factory creates lane builders", async () => {
  const dir = makeRepoWithLaneConfig({
    mode: "local_then_cloud",
    allowFallback: true,
    primary: { lane: "local", provider: "ollama", model: "qwen3.5:9b" },
    shadow: { lane: "cloud", provider: "openrouter", model: "xiaomi/mimo-v2.5" },
  });
  try {
    const registry = new WorkerRegistry();
    registry.register(new StubScout());
    const registered = new RegisteredBuilder();
    registry.register(registered);
    registry.register(new StubCritic());
    registry.register(new StubVerifier());
    registry.register(new StubIntegrator());
    const builderCountBefore = registry.getWorkers("builder").length;

    const stubFactory: typeof createBuilderForLane = () => null;
    const trustProfile: TrustProfile = {
      scores: new Map(),
      tierThresholds: { fast: 0, standard: 0, premium: 0 },
    };
    const eventBus: EventBus = {
      emit() {}, on: () => () => {},
      onType: () => () => {}, addClient: () => {},
      removeClient: () => {}, clientCount: () => 0, recentEvents: () => [],
    };
    const receiptStore = new ReceiptStore(dir);
    const coordinator = new Coordinator(
      {
        projectRoot: dir, autoCommit: true, requireWorkspace: true,
        requireApproval: false, autoPromoteOnSuccess: false,
        laneBuilderFactory: stubFactory,
        verificationConfig: {
          requiredChecks: [],
          hooks: [{
            name: "stub-typecheck", stage: "typecheck", kind: "typecheck",
            execute: async () => ({ passed: false, issues: [{ stage: "typecheck" as const, severity: "blocker" as const, message: "fail" }], stdout: "", stderr: "", exitCode: 1, durationMs: 0 }),
          }],
        },
      },
      trustProfile, registry, eventBus, receiptStore,
    );
    await coordinator.submit({ input: "modify widget in core" });

    const builderCountAfter = registry.getWorkers("builder").length;
    assert.equal(builderCountAfter, builderCountBefore, "registry must not gain builders from lane dispatch");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("integration: candidate receipt contains provider/model/lane for both primary and shadow", async () => {
  const dir = makeRepoWithLaneConfig({
    mode: "local_then_cloud",
    allowFallback: true,
    primary: { lane: "local", provider: "ollama", model: "qwen3.5:9b" },
    shadow: { lane: "cloud", provider: "openrouter", model: "xiaomi/mimo-v2.5" },
  });
  try {
    const harness = buildHarness(dir, {
      typecheckPasses: false,
      laneBuilderFactory: () => null,
    });
    await harness.coordinator.submit({ input: "modify widget in core" });

    const persisted = await harness.receiptStore.listRuns(1);
    assert.equal(persisted.length, 1);
    const detail = await harness.receiptStore.getRun(persisted[0].runId);
    const final = (detail as any).finalReceipt;
    assert.ok(final.candidates, "receipt must contain candidates array");

    const primary = final.candidates.find((c: any) => c.role === "primary");
    const shadow = final.candidates.find((c: any) => c.role === "shadow");
    assert.ok(primary, "primary candidate in receipt");
    assert.ok(shadow, "shadow candidate in receipt");

    // Primary must carry lane metadata from laneConfig.primary.
    assert.equal(primary.lane, "local");
    assert.equal(primary.provider, "ollama");
    assert.equal(primary.model, "qwen3.5:9b");

    // Shadow must carry lane metadata from laneConfig.shadow.
    assert.equal(shadow.lane, "cloud");
    assert.equal(shadow.provider, "openrouter");
    assert.equal(shadow.model, "xiaomi/mimo-v2.5");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("integration: primary fails, shadow succeeds — selection picks shadow with correct model attribution", async () => {
  const dir = makeRepoWithLaneConfig({
    mode: "local_then_cloud",
    allowFallback: true,
    primary: { lane: "local", provider: "ollama", model: "qwen3.5:9b" },
    shadow: { lane: "cloud", provider: "openrouter", model: "xiaomi/mimo-v2.5" },
  });
  try {
    const harness = buildHarness(dir, {
      typecheckPasses: false,
      laneBuilderFactory: () => null,
    });
    await harness.coordinator.submit({ input: "modify widget in core" });

    const persisted = await harness.receiptStore.listRuns(1);
    const detail = await harness.receiptStore.getRun(persisted[0].runId);
    const final = (detail as any).finalReceipt;

    // When primary disqualifies (typecheck fails) and shadow qualifies,
    // the selected candidate should be the shadow.
    if (final.selectedCandidateWorkspaceId) {
      // If selection ran, the shadow should win.
      const selected = final.candidates?.find(
        (c: any) => c.workspaceId === final.selectedCandidateWorkspaceId,
      );
      if (selected) {
        assert.equal(selected.role, "shadow");
        assert.equal(selected.provider, "openrouter");
        assert.equal(selected.model, "xiaomi/mimo-v2.5");
      }
    }
    // Either way, both candidates must exist with distinct models.
    const models = (final.candidates ?? []).map((c: any) => c.model).filter(Boolean);
    assert.ok(models.includes("qwen3.5:9b"), "primary model in candidates");
    assert.ok(models.includes("xiaomi/mimo-v2.5"), "shadow model in candidates");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("integration: cost-surfacing log fires on shadow dispatch", async () => {
  const dir = makeRepoWithLaneConfig({
    mode: "local_then_cloud",
    allowFallback: true,
    primary: { lane: "local", provider: "ollama", model: "qwen3.5:9b" },
    shadow: { lane: "cloud", provider: "openrouter", model: "xiaomi/mimo-v2.5" },
  });
  try {
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    try {
      const { coordinator } = buildHarness(dir, {
        typecheckPasses: false,
        laneBuilderFactory: () => null,
      });
      await coordinator.submit({ input: "modify widget in core" });
    } finally {
      console.log = origLog;
    }
    const surfaced = lines.find((l) =>
      /SHADOW LANE/.test(l) && /openrouter\/xiaomi\/mimo-v2\.5/.test(l),
    );
    assert.ok(surfaced, `cost-surfacing log line must mention SHADOW LANE + provider/model; got: ${JSON.stringify(lines.filter((l) => /SHADOW/.test(l)))}`);
    assert.match(surfaced, /SECOND model call/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Lane attribution honesty: intentModel vs actualModel ───────────
//
// Phase D (model purity): the receipt records BOTH the model the lane
// asked for (`intentModel`) and the model the run's cost says actually
// answered (`actualModel`). The two diverge when a fallback fired —
// previously this was hidden behind opaque lane attribution. Pin both
// the convergent case and the divergent case here.

class CostfulBuilder extends AbstractWorker {
  readonly type: WorkerType = "builder";
  readonly name = "CostfulBuilder";
  constructor(public readonly costModel: string) { super(); }
  async execute(a: WorkerAssignment): Promise<WorkerResult> {
    const { writeFile, readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const root = a.projectRoot ?? process.cwd();
    const path = "core/widget.ts";
    const abs = resolve(root, path);
    const originalContent = await readFile(abs, "utf-8").catch(() => "");
    await writeFile(abs, "export const widget = 7;\n", "utf-8");
    const output: BuilderOutput = {
      kind: "builder",
      changes: [{
        path, operation: "modify",
        content: "export const widget = 7;\n",
        originalContent,
      }],
      decisions: [], needsCriticReview: false,
    };
    return this.success(a, output, {
      cost: {
        model: this.costModel,
        inputTokens: 100, outputTokens: 50, estimatedCostUsd: 0,
      },
      confidence: 0.9,
      touchedFiles: [{ path, operation: "modify" }],
      durationMs: 1,
    });
  }
  async estimateCost(): Promise<CostEntry> { return this.zeroCost(); }
  protected emptyOutput(): WorkerOutput {
    return { kind: "builder", changes: [], decisions: [], needsCriticReview: false };
  }
}

test("receipt records actualModel from WorkerResult.cost.model when shadow runs", async () => {
  const dir = makeRepoWithLaneConfig({
    mode: "local_then_cloud",
    allowFallback: true,
    primary: { lane: "local", provider: "ollama", model: "qwen3.5:9b" },
    shadow: { lane: "cloud", provider: "openrouter", model: "xiaomi/mimo-v2.5" },
  });
  try {
    // Lane-pinned shadow builder reports cost.model="actually-this-one".
    // intentModel must stay "xiaomi/mimo-v2.5" (the lane ask);
    // actualModel must reflect cost.model.
    const sneakyBuilder = new CostfulBuilder("actually-this-one");
    const stubFactory: typeof createBuilderForLane = () =>
      sneakyBuilder as unknown as BuilderWorker;
    const harness = buildHarness(dir, {
      typecheckPasses: false,
      laneBuilderFactory: stubFactory,
    });
    await harness.coordinator.submit({ input: "modify widget in core" });

    const persisted = await harness.receiptStore.listRuns(1);
    const detail = await harness.receiptStore.getRun(persisted[0].runId);
    const final = (detail as any).finalReceipt;
    const shadow = final.candidates.find((c: any) => c.role === "shadow");
    assert.ok(shadow, "shadow candidate must exist");
    assert.equal(shadow.intentModel, "xiaomi/mimo-v2.5",
      "intentModel must be the lane-config requested model");
    assert.equal(shadow.actualModel, "actually-this-one",
      "actualModel must mirror WorkerResult.cost.model — receipts cannot lie about which model answered");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("receipt actualModel === intentModel when no fallback fired (convergent case)", async () => {
  const dir = makeRepoWithLaneConfig({
    mode: "local_then_cloud",
    allowFallback: true,
    primary: { lane: "local", provider: "ollama", model: "qwen3.5:9b" },
    shadow: { lane: "cloud", provider: "openrouter", model: "xiaomi/mimo-v2.5" },
  });
  try {
    // The dispatched model matches the lane's pin — common case,
    // intent and actual converge, but BOTH fields should still appear.
    const honestBuilder = new CostfulBuilder("xiaomi/mimo-v2.5");
    const stubFactory: typeof createBuilderForLane = () =>
      honestBuilder as unknown as BuilderWorker;
    const harness = buildHarness(dir, {
      typecheckPasses: false,
      laneBuilderFactory: stubFactory,
    });
    await harness.coordinator.submit({ input: "modify widget in core" });

    const persisted = await harness.receiptStore.listRuns(1);
    const detail = await harness.receiptStore.getRun(persisted[0].runId);
    const final = (detail as any).finalReceipt;
    const shadow = final.candidates.find((c: any) => c.role === "shadow");
    assert.equal(shadow.intentModel, "xiaomi/mimo-v2.5");
    assert.equal(shadow.actualModel, "xiaomi/mimo-v2.5");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Lane rescue — hard-assert proof ────────────────────────────────
//
// Stronger pin than the earlier "primary fails, shadow succeeds —
// selection picks shadow with correct model attribution" test. That
// one used `if (final.selectedCandidateWorkspaceId)` guards which
// would silently degrade to a no-op if selection ever stopped firing.
// These tests hard-assert the rescue contract end-to-end:
//
//   - selectedCandidateWorkspaceId === shadow.workspaceId
//   - selected candidate has role="shadow"
//   - both candidates appear in the manifest with distinct lanes
//   - primary's disqualification is recorded (so the operator can see
//     WHY the rescue fired)

test("lane-rescue: primary verification fails → shadow is HARD-selected", async () => {
  const dir = makeRepoWithLaneConfig({
    mode: "local_then_cloud",
    allowFallback: true,
    primary: { lane: "local", provider: "ollama", model: "qwen3.5:9b" },
    shadow: { lane: "cloud", provider: "openrouter", model: "xiaomi/mimo-v2.5" },
  });
  try {
    // Primary fails verification (typecheckPasses: false). Shadow
    // re-uses the same RegisteredBuilder via factory→null fallback —
    // shadow's runShadowBuilder doesn't run verification, so its
    // candidate qualifies and selection MUST pick it.
    const harness = buildHarness(dir, {
      typecheckPasses: false,
      laneBuilderFactory: () => null,
    });
    await harness.coordinator.submit({ input: "modify widget in core" });

    const persisted = await harness.receiptStore.listRuns(1);
    const detail = await harness.receiptStore.getRun(persisted[0].runId);
    const final = (detail as any).finalReceipt;
    assert.ok(final, "finalReceipt must exist");
    assert.equal(final.laneMode, "local_then_cloud");

    // Hard contract: selectedCandidateWorkspaceId is set.
    assert.ok(
      final.selectedCandidateWorkspaceId,
      "selectedCandidateWorkspaceId MUST be set when shadow rescues primary",
    );

    // The selected candidate has role=shadow.
    const selected = final.candidates.find(
      (c: any) => c.workspaceId === final.selectedCandidateWorkspaceId,
    );
    assert.ok(selected, "selected candidate must be in the manifest");
    assert.equal(selected.role, "shadow", "rescue MUST select the shadow lane, not primary");
    assert.equal(selected.lane, "cloud");
    assert.equal(selected.provider, "openrouter");
    assert.equal(selected.model, "xiaomi/mimo-v2.5");

    // Manifest records BOTH candidates with distinct lanes.
    assert.equal(final.candidates.length, 2, "manifest must record both lanes");
    const primary = final.candidates.find((c: any) => c.role === "primary");
    const shadow = final.candidates.find((c: any) => c.role === "shadow");
    assert.ok(primary, "primary candidate present");
    assert.ok(shadow, "shadow candidate present");
    assert.equal(primary.lane, "local");
    assert.equal(shadow.lane, "cloud");

    // Primary's disqualification reason is preserved so the operator
    // can audit why the rescue fired.
    assert.ok(primary.disqualification, "primary must carry a disqualification reason");
    assert.match(primary.disqualification, /failed|verifierVerdict|tests|typecheck/i);

    // Shadow has no disqualification (it's the qualified one).
    assert.equal(shadow.disqualification, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lane-rescue: receipt records intent vs actual model on the rescued shadow", async () => {
  // Phase D contract pinned earlier: intentModel = lane ask;
  // actualModel = WorkerResult.cost.model. When the rescue's selected
  // candidate is the shadow, both fields must survive into the
  // persisted receipt — operator-facing audit trail must NOT lose the
  // distinction even when selection swapped lanes.
  const dir = makeRepoWithLaneConfig({
    mode: "local_then_cloud",
    allowFallback: true,
    primary: { lane: "local", provider: "ollama", model: "qwen3.5:9b" },
    shadow: { lane: "cloud", provider: "openrouter", model: "xiaomi/mimo-v2.5" },
  });
  try {
    const harness = buildHarness(dir, {
      typecheckPasses: false,
      laneBuilderFactory: () => null,
    });
    await harness.coordinator.submit({ input: "modify widget in core" });
    const persisted = await harness.receiptStore.listRuns(1);
    const final = (await harness.receiptStore.getRun(persisted[0].runId) as any)
      .finalReceipt;
    const shadow = final.candidates.find((c: any) => c.role === "shadow");
    // intentModel mirrors the lane-config ask.
    assert.equal(shadow.intentModel, "xiaomi/mimo-v2.5");
    // actualModel reflects what the WorkerResult.cost.model was.
    // RegisteredBuilder uses zeroCost() with model:"", so actualModel
    // is undefined here — the assertion is that the FIELD HONESTLY
    // omits a value rather than lying with the intent.
    assert.equal(shadow.actualModel, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Lane purity & cost attribution ─────────────────────────────────
//
// Three contracts the integrity pass pins explicitly:
//   1. Lane-pinned builder fails as the pinned model — no fallback,
//      no silent substitution. Already structurally enforced by the
//      factory (pinnedModel + fallbackModel: null) but kept loud here.
//   2. providerUsed / modelUsed populated on lane-pinned candidates
//      with the values from the worker result (and matching intent).
//   3. Shadow's cost is accrued into run.totalCost so the run total
//      equals the sum of candidate costs (no $0 hole, no double-count).

test("lane purity: pinned builder reports an empty fallback chain (no auto-substitution)", () => {
  const dir = mkdtempSync(join(tmpdir(), "aedis-laneD-purity-"));
  try {
    const builder = createBuilderForLane({
      projectRoot: dir,
      provider: "openrouter",
      model: "xiaomi/mimo-v2.5",
    });
    assert.ok(builder);
    // Cast through index access — getDeclaredFallbackChain is private.
    // The empty chain is the structural guarantee that the only model
    // a pinned dispatch will EVER hit is the one the lane requested.
    const chain = (builder as any).getDeclaredFallbackChain(dir, "standard");
    assert.deepEqual(
      chain,
      [],
      "lane-pinned builder must report an empty fallback chain — no model substitution possible",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("attribution: lane-pinned shadow records modelUsed + providerUsed when actual matches intent", async () => {
  // Lane purity → actualModel === intentModel always. providerUsed
  // therefore equals the lane's intent provider. Test pins both fields
  // appearing on the persisted manifest entry.
  const dir = makeRepoWithLaneConfig({
    mode: "local_then_cloud",
    primary: { lane: "local", provider: "ollama", model: "qwen3.5:9b" },
    shadow: { lane: "cloud", provider: "openrouter", model: "xiaomi/mimo-v2.5" },
  });
  try {
    const honest = new CostfulBuilder("xiaomi/mimo-v2.5");
    const stubFactory: typeof createBuilderForLane = () =>
      honest as unknown as BuilderWorker;
    const harness = buildHarness(dir, {
      typecheckPasses: false,
      laneBuilderFactory: stubFactory,
    });
    await harness.coordinator.submit({ input: "modify widget in core" });

    const persisted = await harness.receiptStore.listRuns(1);
    const detail = await harness.receiptStore.getRun(persisted[0].runId);
    const final = (detail as any).finalReceipt;
    const shadow = final.candidates.find((c: any) => c.role === "shadow");
    assert.ok(shadow);
    assert.equal(shadow.intentModel, "xiaomi/mimo-v2.5");
    assert.equal(shadow.actualModel, "xiaomi/mimo-v2.5");
    assert.equal(shadow.modelUsed, "xiaomi/mimo-v2.5", "modelUsed must be populated alongside actualModel");
    assert.equal(
      shadow.providerUsed,
      "openrouter",
      "lane purity guarantees providerUsed == intent provider for pinned shadow",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("attribution: when actualModel diverges from intentModel, providerUsed is omitted (no guessing)", async () => {
  // Lane purity normally prevents this case, but the test factory can
  // sneak a divergent cost.model through. The contract: providerUsed
  // must NOT be set in this case — we don't know which provider
  // actually answered, and guessing would lie.
  const dir = makeRepoWithLaneConfig({
    mode: "local_then_cloud",
    primary: { lane: "local", provider: "ollama", model: "qwen3.5:9b" },
    shadow: { lane: "cloud", provider: "openrouter", model: "xiaomi/mimo-v2.5" },
  });
  try {
    const sneaky = new CostfulBuilder("actually-something-else");
    const stubFactory: typeof createBuilderForLane = () =>
      sneaky as unknown as BuilderWorker;
    const harness = buildHarness(dir, {
      typecheckPasses: false,
      laneBuilderFactory: stubFactory,
    });
    await harness.coordinator.submit({ input: "modify widget in core" });

    const persisted = await harness.receiptStore.listRuns(1);
    const detail = await harness.receiptStore.getRun(persisted[0].runId);
    const final = (detail as any).finalReceipt;
    const shadow = final.candidates.find((c: any) => c.role === "shadow");
    assert.equal(shadow.intentModel, "xiaomi/mimo-v2.5");
    assert.equal(shadow.actualModel, "actually-something-else");
    assert.equal(shadow.modelUsed, "actually-something-else");
    assert.equal(
      shadow.providerUsed,
      undefined,
      "providerUsed must be omitted when actualModel != intentModel",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cost attribution: shadow cost is accrued into run.totalCost (sum of candidates == run total)", async () => {
  // Pre-fix, runShadowBuilder set candidate.costUsd from result.cost
  // but did NOT call accrueCost — so the run total was the primary
  // path's spend only and the sum of candidates exceeded the run total
  // by exactly the shadow's cost. Fix accrues into run.totalCost so
  // the two reconcile; this test pins that they agree.
  const dir = makeRepoWithLaneConfig({
    mode: "local_then_cloud",
    primary: { lane: "local", provider: "ollama", model: "qwen3.5:9b" },
    shadow: { lane: "cloud", provider: "openrouter", model: "xiaomi/mimo-v2.5" },
  });
  try {
    // CostfulBuilder reports a non-zero cost in the WorkerResult so
    // the accrual path has something to actually accrue.
    const shadowBuilder = new CostfulBuilder("xiaomi/mimo-v2.5");
    // Override estimatedCostUsd so the shadow has a measurable spend.
    const originalExecute = shadowBuilder.execute.bind(shadowBuilder);
    (shadowBuilder as any).execute = async (a: WorkerAssignment) => {
      const r = await originalExecute(a);
      return {
        ...r,
        cost: { ...r.cost, estimatedCostUsd: 0.0123 },
      };
    };
    const stubFactory: typeof createBuilderForLane = () =>
      shadowBuilder as unknown as BuilderWorker;
    const harness = buildHarness(dir, {
      typecheckPasses: false,
      laneBuilderFactory: stubFactory,
    });
    await harness.coordinator.submit({ input: "modify widget in core" });

    const persisted = await harness.receiptStore.listRuns(1);
    const detail = await harness.receiptStore.getRun(persisted[0].runId);
    const final = (detail as any).finalReceipt;
    const candidates = final.candidates ?? [];
    assert.ok(candidates.length >= 2, `expected primary + shadow candidates; got ${candidates.length}`);
    const sum = candidates.reduce((acc: number, c: any) => acc + (c.costUsd ?? 0), 0);
    const runTotal = final.totalCost?.estimatedCostUsd ?? 0;
    // Sum of candidates must equal run total — within a tiny epsilon
    // for floating-point math. Pre-fix this assertion failed by
    // exactly the shadow's cost (sum > total).
    assert.ok(
      Math.abs(sum - runTotal) < 1e-6,
      `sum of candidate costs ($${sum.toFixed(6)}) must equal run total ($${runTotal.toFixed(6)})`,
    );
    // And the run total must include the shadow's spend (ie. > 0
    // even though primary was a stub builder with zeroCost()).
    assert.ok(
      runTotal >= 0.0123,
      `run total must include shadow spend; expected >= 0.0123, got $${runTotal.toFixed(6)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cost attribution: shadow with zero cost is a no-op on run.totalCost (no false accrual)", async () => {
  // Defense: when the shadow worker returns zeroCost(), the run total
  // must NOT change. Catches the case where the accrual code added a
  // phantom row.
  const dir = makeRepoWithLaneConfig({
    mode: "local_then_cloud",
    primary: { lane: "local", provider: "ollama", model: "qwen3.5:9b" },
    shadow: { lane: "cloud", provider: "openrouter", model: "xiaomi/mimo-v2.5" },
  });
  try {
    const harness = buildHarness(dir, {
      typecheckPasses: false,
      laneBuilderFactory: () => null,
    });
    await harness.coordinator.submit({ input: "modify widget in core" });

    const persisted = await harness.receiptStore.listRuns(1);
    const detail = await harness.receiptStore.getRun(persisted[0].runId);
    const final = (detail as any).finalReceipt;
    const sum = (final.candidates ?? []).reduce(
      (acc: number, c: any) => acc + (c.costUsd ?? 0),
      0,
    );
    const runTotal = final.totalCost?.estimatedCostUsd ?? 0;
    assert.ok(
      Math.abs(sum - runTotal) < 1e-6,
      `zero-cost shadow must not break the sum-equals-total invariant`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
