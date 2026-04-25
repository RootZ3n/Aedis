/**
 * Integration tests for decorated-class deterministic flow:
 *   - decorated field add via Coordinator.submit (LLM Builder NOT called)
 *   - decorated method add ditto
 *   - constructor-param add ditto
 *   - malformed-decorator class falls through to LLM Builder
 *
 * Each test boots a SentinelBuilder that throws on call. Anything
 * that bypasses the deterministic layer fails the test.
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

const NEST_FIXTURE = `
export class UserController {
  @Inject() service: UserService;

  constructor(
    private readonly repo: UserRepository,
  ) {}

  @Get("/user")
  @UseGuards(AuthGuard)
  getUser() {
    return null;
  }
}

export class UserService {
}

export interface CreateUserDto {
  name: string;
}

// Malformed decorator: unbalanced @Inject(  parens
export class BrokenController {
  @Inject(
  service: UserService;

  doStuff() {}
}
`.trimStart();

class SentinelBuilder extends AbstractWorker {
  readonly type: WorkerType = "builder";
  readonly name = "SentinelBuilder";
  public called = false;
  async execute(): Promise<WorkerResult> {
    this.called = true;
    throw new Error("SentinelBuilder: must NOT be invoked when deterministic transform applies");
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

function makeNestRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "aedis-nest-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src/controllers.ts"), NEST_FIXTURE, "utf-8");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "n", version: "0.0.0" }), "utf-8");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "n@n.local"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "N"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: dir });
  return dir;
}

test("integration: decorated controller field — Builder NOT invoked", async () => {
  const repo = makeNestRepo();
  try {
    const { coordinator, builder } = buildHarness(repo);
    await coordinator.submit({
      input: "add private logger:Logger to UserController in src/controllers.ts",
    });
    assert.equal(builder.called, false);
    assert.equal(readFileSync(join(repo, "src/controllers.ts"), "utf-8"), NEST_FIXTURE);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("integration: decorated controller method — Builder NOT invoked", async () => {
  const repo = makeNestRepo();
  try {
    const { coordinator, builder } = buildHarness(repo);
    await coordinator.submit({
      input: "add async createUser(user:User):Promise<void> method to UserController in src/controllers.ts",
    });
    assert.equal(builder.called, false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("integration: decorated controller route method — Builder NOT invoked", async () => {
  const repo = makeNestRepo();
  try {
    const { coordinator, builder } = buildHarness(repo);
    await coordinator.submit({
      input: "add GET /users method getUsers to UserController in src/controllers.ts",
    });
    assert.equal(builder.called, false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("integration: multi-file controller/service/DTO scaffold — Builder NOT invoked", async () => {
  const repo = makeNestRepo();
  try {
    const { coordinator, builder } = buildHarness(repo);
    await coordinator.submit({
      input: "Add POST /users endpoint that calls UserService.createUser with CreateUserDto in src/controllers.ts",
    });
    assert.equal(builder.called, false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("integration: unsupported multi-file scaffold falls through to Builder", async () => {
  const repo = makeNestRepo();
  try {
    const { coordinator, builder } = buildHarness(repo);
    await coordinator.submit({
      input: "Add POST /users endpoint that calls MissingService.createUser with CreateUserDto in src/controllers.ts",
    });
    assert.equal(builder.called, true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("integration: constructor DI param — Builder NOT invoked", async () => {
  const repo = makeNestRepo();
  try {
    const { coordinator, builder } = buildHarness(repo);
    await coordinator.submit({
      input: "add private readonly logger: Logger to constructor of UserController in src/controllers.ts",
    });
    assert.equal(builder.called, false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("integration: malformed decorator class falls through to LLM Builder", async () => {
  // The fixture's BrokenController has an unbalanced @Inject( decorator.
  // Deterministic must refuse; SentinelBuilder gets called (and throws).
  const repo = makeNestRepo();
  try {
    const { coordinator, builder } = buildHarness(repo);
    await coordinator.submit({
      input: "add private logger:Logger to BrokenController in src/controllers.ts",
    });
    assert.equal(builder.called, true, "malformed-decorator class must fall through to LLM Builder");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
