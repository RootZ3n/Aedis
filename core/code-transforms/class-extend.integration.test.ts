/**
 * Integration tests for the class-extend deterministic path.
 *
 * Each test fires a real `coordinator.submit({ input: … })` against a
 * tmp git repo with a SentinelBuilder that throws if invoked. Asserts:
 *   - the deterministic layer applies the edit (or correctly refuses
 *     and falls through, depending on the scenario)
 *   - the LLM Builder is never called for supported prompts
 *   - source repo byte-identical (mutations in workspace only)
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

const SERVICES_TS = `
export class UserService {
  constructor() {}

  getUser() {
    return null;
  }
}

export class UtilClass {
  doThing() {}
}

// A class with member decorators — deterministic must REFUSE and
// fall through to the LLM Builder.
export class DecoratedController {
  @Inject() service: UserService;

  @Get()
  list() {}
}
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

function makeServicesRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "aedis-class-int-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src/services.ts"), SERVICES_TS, "utf-8");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "cs", version: "0.0.0" }), "utf-8");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "c@c.local"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "C"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: dir });
  return dir;
}

test("integration: 'add private logger:Logger to UserService' applies deterministically", async () => {
  const repo = makeServicesRepo();
  try {
    const { coordinator, builder, events, receiptStore } = buildHarness(repo);
    await coordinator.submit({
      input: "add private logger:Logger to UserService in src/services.ts",
    });
    assert.equal(builder.called, false, "LLM Builder must not be called for class-field-add");

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
    }

    // Source untouched
    assert.equal(readFileSync(join(repo, "src/services.ts"), "utf-8"), SERVICES_TS);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("integration: 'add async createUser(user:User):Promise<void> method to UserService' applies deterministically", async () => {
  const repo = makeServicesRepo();
  try {
    const { coordinator, builder } = buildHarness(repo);
    await coordinator.submit({
      input: "add async createUser(user:User):Promise<void> method to UserService in src/services.ts",
    });
    assert.equal(builder.called, false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("integration: 'add static of(value:string):UtilClass method to UtilClass' applies", async () => {
  const repo = makeServicesRepo();
  try {
    const { coordinator, builder } = buildHarness(repo);
    await coordinator.submit({
      input: "add static of(value:string):UtilClass method to UtilClass in src/services.ts",
    });
    assert.equal(builder.called, false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("integration: 'add private logger:Logger to DecoratedController' NOW applies deterministically", async () => {
  // Decorated members are supported. The Sentinel must NOT be called
  // for a decorated controller — the new field lands above the
  // first decorated method's decorator block.
  const repo = makeServicesRepo();
  try {
    const { coordinator, builder } = buildHarness(repo);
    await coordinator.submit({
      input: "add private logger:Logger to DecoratedController in src/services.ts",
    });
    assert.equal(builder.called, false, "decorated controller must apply via deterministic transform");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
