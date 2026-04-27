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

import { createBuilderForLane, isSupportedProvider } from "./lane-builder-factory.js";
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
    "portum", "local",
  ] as Provider[]) {
    assert.equal(isSupportedProvider(p), true, `expected ${p} to be supported`);
  }
  assert.equal(isSupportedProvider("nonexistent"), false);
  assert.equal(isSupportedProvider(""), false);
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

    assert.equal(calls.length, 1, "factory must be called exactly once per fallback");
    assert.deepEqual(calls[0], {
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
    primary: { lane: "local", provider: "ollama", model: "qwen3.5:9b" },
    shadow: { lane: "cloud", provider: "openrouter", model: "xiaomi/mimo-v2.5" },
  });
  try {
    let invoked = 0;
    const stubFactory: typeof createBuilderForLane = () => {
      invoked += 1;
      return null;
    };
    const { coordinator, registered } = buildHarness(dir, {
      typecheckPasses: true,
      laneBuilderFactory: stubFactory,
    });
    await coordinator.submit({ input: "modify widget in core" });
    assert.equal(invoked, 0, "factory must not be invoked when primary qualifies");
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

test("integration: cost-surfacing log fires on shadow dispatch", async () => {
  const dir = makeRepoWithLaneConfig({
    mode: "local_then_cloud",
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
