import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

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
import type { CostEntry } from "./runstate.js";
import type { ToolHook } from "./verification-pipeline.js";
import type { TrustProfile } from "../router/trust-router.js";
import type { AedisEvent, EventBus } from "../server/websocket.js";

const SERVER_TS = `
import Fastify from "fastify";

const fastify = Fastify({ logger: true });

fastify.get("/", async () => ({ ok: true }));

export async function startServer() {
  await fastify.listen({ port: 0 });
}
`.trimStart();

const TYPES_TS = `
export interface User {
  id: string;
}
`.trimStart();

class SentinelBuilder extends AbstractWorker {
  readonly type: WorkerType = "builder";
  readonly name = "SentinelBuilder";
  called = false;

  async execute(): Promise<WorkerResult> {
    this.called = true;
    throw new Error("SentinelBuilder must not run for supported deterministic transforms");
  }

  async estimateCost(): Promise<CostEntry> {
    return this.zeroCost();
  }

  protected emptyOutput(): WorkerOutput {
    return { kind: "builder", changes: [], decisions: [], needsCriticReview: false };
  }
}

class NoOpFallbackBuilder extends AbstractWorker {
  readonly type: WorkerType = "builder";
  readonly name = "NoOpFallbackBuilder";
  called = false;

  async execute(assignment: WorkerAssignment): Promise<WorkerResult> {
    this.called = true;
    const output: BuilderOutput = {
      kind: "builder",
      changes: [],
      decisions: [{ description: "Fallback builder produced no changes", rationale: "test stub", alternatives: [] }],
      needsCriticReview: false,
    };
    return this.success(assignment, output, {
      cost: this.zeroCost(),
      confidence: 0.2,
      touchedFiles: [],
      durationMs: 1,
    });
  }

  async estimateCost(): Promise<CostEntry> {
    return this.zeroCost();
  }

  protected emptyOutput(): WorkerOutput {
    return { kind: "builder", changes: [], decisions: [], needsCriticReview: false };
  }
}

class StubScout extends AbstractWorker {
  readonly type: WorkerType = "scout";
  readonly name = "StubScout";

  async execute(assignment: WorkerAssignment): Promise<WorkerResult> {
    return this.success(assignment, {
      kind: "scout",
      dependencies: [],
      patterns: [],
      riskAssessment: { level: "low", factors: [], mitigations: [] },
      suggestedApproach: "deterministic lifecycle fixture",
    }, { cost: this.zeroCost(), confidence: 0.9, touchedFiles: [], durationMs: 1 });
  }

  async estimateCost(): Promise<CostEntry> {
    return this.zeroCost();
  }

  protected emptyOutput(): WorkerOutput {
    return {
      kind: "scout",
      dependencies: [],
      patterns: [],
      riskAssessment: { level: "low", factors: [], mitigations: [] },
      suggestedApproach: "",
    };
  }
}

class StubCritic extends AbstractWorker {
  readonly type: WorkerType = "critic";
  readonly name = "StubCritic";

  async execute(assignment: WorkerAssignment): Promise<WorkerResult> {
    return this.success(assignment, {
      kind: "critic",
      verdict: "approve",
      comments: [],
      suggestedChanges: [],
      intentAlignment: 0.95,
    }, { cost: this.zeroCost(), confidence: 0.9, touchedFiles: [], durationMs: 1 });
  }

  async estimateCost(): Promise<CostEntry> {
    return this.zeroCost();
  }

  protected emptyOutput(): WorkerOutput {
    return { kind: "critic", verdict: "approve", comments: [], suggestedChanges: [], intentAlignment: 1 };
  }
}

class StubVerifier extends AbstractWorker {
  readonly type: WorkerType = "verifier";
  readonly name = "StubVerifier";

  async execute(assignment: WorkerAssignment): Promise<WorkerResult> {
    return this.success(assignment, {
      kind: "verifier",
      testResults: [],
      typeCheckPassed: true,
      lintPassed: true,
      buildPassed: true,
      passed: true,
    }, { cost: this.zeroCost(), confidence: 0.9, touchedFiles: [], durationMs: 1 });
  }

  async estimateCost(): Promise<CostEntry> {
    return this.zeroCost();
  }

  protected emptyOutput(): WorkerOutput {
    return { kind: "verifier", testResults: [], typeCheckPassed: true, lintPassed: true, buildPassed: true, passed: true };
  }
}

class StubIntegrator extends AbstractWorker {
  readonly type: WorkerType = "integrator";
  readonly name = "StubIntegrator";

  async execute(assignment: WorkerAssignment): Promise<WorkerResult> {
    const finalChanges = [...(assignment.changes ?? [])];
    return this.success(assignment, {
      kind: "integrator",
      finalChanges,
      conflictsResolved: [],
      coherenceCheck: { passed: true, checks: [] },
      readyToApply: true,
    }, {
      cost: this.zeroCost(),
      confidence: 0.9,
      touchedFiles: finalChanges.map((c) => ({ path: c.path, operation: c.operation })),
      durationMs: 1,
    });
  }

  async estimateCost(): Promise<CostEntry> {
    return this.zeroCost();
  }

  protected emptyOutput(): WorkerOutput {
    return { kind: "integrator", finalChanges: [], conflictsResolved: [], coherenceCheck: { passed: true, checks: [] }, readyToApply: false };
  }
}

function passHook(name: string, kind: "typecheck" | "tests"): ToolHook {
  return {
    name,
    kind,
    stage: kind === "typecheck" ? "typecheck" : "custom-hook",
    async execute() {
      return { passed: true, issues: [], stdout: "ok", exitCode: 0, durationMs: 1 };
    },
  };
}

function failHook(name: string, kind: "typecheck" | "tests"): ToolHook {
  return {
    name,
    kind,
    stage: kind === "typecheck" ? "typecheck" : "custom-hook",
    async execute() {
      return {
        passed: false,
        issues: [{ stage: kind === "typecheck" ? "typecheck" : "custom-hook", severity: "error", message: `${name} failed` }],
        stderr: `${name} failed`,
        exitCode: 1,
        durationMs: 1,
      };
    },
  };
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "aedis-det-lifecycle-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src/server.ts"), SERVER_TS, "utf-8");
  writeFileSync(join(dir, "src/types.ts"), TYPES_TS, "utf-8");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "det-lifecycle", version: "0.0.0" }), "utf-8");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "aedis@example.test"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Aedis Test"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: dir });
  return dir;
}

function makeNestRepo(): string {
  const dir = makeRepo();
  writeFileSync(join(dir, "src/user.controller.ts"), `import { Controller, Get } from "@nestjs/common";
import { UserService } from "./user.service";

@Controller("/users")
export class UserController {
  constructor(private readonly userService: UserService) {}
}
`, "utf-8");
  writeFileSync(join(dir, "src/user.service.ts"), `export class UserService {
}
`, "utf-8");
  writeFileSync(join(dir, "src/create-user.dto.ts"), `export interface CreateUserDto {
  name: string;
}
`, "utf-8");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "nest fixture"], { cwd: dir });
  return dir;
}

function buildHarness(
  projectRoot: string,
  opts: {
    builder?: AbstractWorker;
    hooks?: ToolHook[];
    autoPromoteOnSuccess?: boolean;
  } = {},
): {
  coordinator: Coordinator;
  receiptStore: ReceiptStore;
  events: AedisEvent[];
  builder: AbstractWorker;
} {
  const builder = opts.builder ?? new SentinelBuilder();
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
    emit(event) {
      events.push(event);
    },
    on: () => () => {},
    onType: () => () => {},
    addClient: () => {},
    removeClient: () => {},
    clientCount: () => 0,
    recentEvents: () => [],
  };
  const receiptStore = new ReceiptStore(projectRoot);
  const coordinator = new Coordinator(
    {
      projectRoot,
      autoCommit: true,
      requireWorkspace: true,
      autoPromoteOnSuccess: opts.autoPromoteOnSuccess ?? false,
      verificationConfig: {
        requiredChecks: ["typecheck", "tests"],
        hooks: opts.hooks ?? [passHook("fixture typecheck", "typecheck"), passHook("fixture tests", "tests")],
      },
    },
    trustProfile,
    registry,
    eventBus,
    receiptStore,
  );
  return { coordinator, receiptStore, events, builder };
}

test("deterministic lifecycle: applied transform flows through verifier, gate, receipt, and cleanup", async () => {
  const repo = makeRepo();
  try {
    const { coordinator, receiptStore, events, builder } = buildHarness(repo);
    const receipt = await coordinator.submit({
      input: "add a GET /ready endpoint in src/server.ts that returns ok",
      projectRoot: repo,
    });

    assert.equal((builder as SentinelBuilder).called, false, "Builder fallback must not run");
    assert.equal(receipt.totalCost.estimatedCostUsd, 0);
    assert.equal(receipt.executionVerified, true, receipt.executionGateReason);
    assert.ok(receipt.verificationReceipt, "verification receipt must exist");
    assert.equal(receipt.verificationReceipt?.checks.find((c) => c.kind === "typecheck")?.executed, true);
    assert.equal(receipt.verificationReceipt?.checks.find((c) => c.kind === "tests")?.executed, true);
    assert.ok(events.some((e) => e.type === "execution_verified"));

    const runId = receipt.runId;
    const persisted = await receiptStore.getRun(runId);
    assert.ok(persisted, "persistent run receipt must exist");
    assert.ok(persisted!.builderAttempts.some((a) => (a as Record<string, unknown>).provider === "deterministic"));
    assert.ok(persisted!.checkpoints.some((c) => c.summary.startsWith("deterministic transform applied")));
    assert.equal(persisted!.workspace?.cleanedUp, true);
    assert.equal(persisted!.finalReceipt?.workspaceCleanup?.success, true);

    const model = receipt.totalCost.model;
    assert.match(model, /^deterministic\/route-insert/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("deterministic lifecycle: verified deterministic success can auto-promote to source repo", async () => {
  const repo = makeRepo();
  try {
    const before = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf-8" }).trim();
    const { coordinator } = buildHarness(repo, { autoPromoteOnSuccess: true });
    const receipt = await coordinator.submit({
      input: "add email:string to User interface in src/types.ts",
      projectRoot: repo,
    });
    const after = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf-8" }).trim();
    const types = readFileSync(join(repo, "src/types.ts"), "utf-8");

    assert.equal(receipt.executionVerified, true, receipt.executionGateReason);
    assert.notEqual(after, before, "auto-promote should commit deterministic changes to the source repo");
    assert.match(types, /email:\s*string;/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("deterministic lifecycle: referenced DTO can remain unchanged in multi-file scaffold", async () => {
  const repo = makeNestRepo();
  try {
    const before = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf-8" }).trim();
    const dtoBefore = readFileSync(join(repo, "src/create-user.dto.ts"), "utf-8");
    const { coordinator, builder } = buildHarness(repo, { autoPromoteOnSuccess: true });

    const receipt = await coordinator.submit({
      input: "Add POST /users endpoint that calls UserService.createUser with CreateUserDto in src/user.controller.ts, src/user.service.ts, src/create-user.dto.ts.",
      projectRoot: repo,
    });

    const after = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf-8" }).trim();
    const controller = readFileSync(join(repo, "src/user.controller.ts"), "utf-8");
    const service = readFileSync(join(repo, "src/user.service.ts"), "utf-8");
    const dtoAfter = readFileSync(join(repo, "src/create-user.dto.ts"), "utf-8");

    assert.equal((builder as SentinelBuilder).called, false, "Builder fallback must not run");
    assert.equal(receipt.executionVerified, true, receipt.executionGateReason);
    assert.notEqual(after, before, "multi-file deterministic scaffold should auto-promote");
    assert.match(controller, /@Post\("\/users"\)/);
    assert.match(controller, /createUser\(.*CreateUserDto/s);
    assert.match(service, /async createUser\(dto: CreateUserDto\)/);
    assert.equal(dtoAfter, dtoBefore, "DTO reference file must not be mutated");

    const dtoRole = receipt.targetRoles?.find((role) => role.file === "src/create-user.dto.ts");
    assert.equal(dtoRole?.role, "type-reference");
    assert.equal(dtoRole?.mutationExpected, false);
    assert.equal(dtoRole?.actualChanged, false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("deterministic lifecycle: verifier failure blocks auto-promote", async () => {
  const repo = makeRepo();
  try {
    const before = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf-8" }).trim();
    const { coordinator } = buildHarness(repo, {
      autoPromoteOnSuccess: true,
      hooks: [failHook("fixture typecheck", "typecheck"), passHook("fixture tests", "tests")],
    });
    const receipt = await coordinator.submit({
      input: "add email:string to User interface in src/types.ts",
      projectRoot: repo,
    });
    const after = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf-8" }).trim();
    const types = readFileSync(join(repo, "src/types.ts"), "utf-8");

    assert.notEqual(receipt.verdict, "success");
    assert.equal(receipt.verificationReceipt?.verdict, "fail");
    assert.equal(after, before, "failed verification must not auto-promote to source");
    assert.doesNotMatch(types, /email:\s*string;/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("deterministic lifecycle: skipped deterministic path is visible and falls through without silent no-op", async () => {
  const repo = makeRepo();
  try {
    writeFileSync(join(repo, "src/server.ts"), SERVER_TS.replace("fastify.get(\"/\",", "fastify.get(\"/health\",") , "utf-8");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "duplicate route fixture"], { cwd: repo });

    const fallbackBuilder = new NoOpFallbackBuilder();
    const { coordinator, receiptStore } = buildHarness(repo, { builder: fallbackBuilder });
    const receipt = await coordinator.submit({
      input: "add a GET /health endpoint in src/server.ts",
      projectRoot: repo,
    });

    assert.equal(fallbackBuilder.called, true, "unsupported deterministic path must call fallback Builder");
    assert.notEqual(receipt.verdict, "success", "fallback no-op must fail visibly");
    assert.equal(receipt.executionVerified, false);

    const persisted = await receiptStore.getRun(receipt.runId);
    assert.ok(persisted?.checkpoints.some((c) => c.summary.startsWith("deterministic transform skipped")));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
