import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { Coordinator } from "../core/coordinator.js";
import { ReceiptStore } from "../core/receipt-store.js";
import { WorkerRegistry, AbstractWorker } from "../workers/base.js";
import type { WorkerAssignment, WorkerResult, WorkerType, WorkerOutput, BuilderOutput } from "../workers/base.js";
import type { CostEntry } from "../core/runstate.js";
import type { ToolHook } from "../core/verification-pipeline.js";
import type { TrustProfile } from "../router/trust-router.js";
import type { AedisEvent, EventBus } from "../server/websocket.js";

const PORTUM = process.env["PORTUM_REPO"] ?? process.env["AEDIS_PORTUM_REPO"] ?? "";

class SentinelBuilder extends AbstractWorker {
  readonly type: WorkerType = "builder";
  readonly name = "SentinelBuilder";
  called = false;
  async execute(): Promise<WorkerResult> {
    this.called = true;
    throw new Error("Builder fallback invoked for supported deterministic scenario");
  }
  async estimateCost(): Promise<CostEntry> { return this.zeroCost(); }
  protected emptyOutput(): WorkerOutput { return { kind: "builder", changes: [], decisions: [], needsCriticReview: false }; }
}

class NoOpBuilder extends AbstractWorker {
  readonly type: WorkerType = "builder";
  readonly name = "NoOpBuilder";
  called = false;
  async execute(a: WorkerAssignment): Promise<WorkerResult> {
    this.called = true;
    const output: BuilderOutput = { kind: "builder", changes: [], decisions: [], needsCriticReview: false };
    return this.success(a, output, { cost: this.zeroCost(), confidence: 0.2, touchedFiles: [], durationMs: 1 });
  }
  async estimateCost(): Promise<CostEntry> { return this.zeroCost(); }
  protected emptyOutput(): WorkerOutput { return { kind: "builder", changes: [], decisions: [], needsCriticReview: false }; }
}

class StubScout extends AbstractWorker {
  readonly type: WorkerType = "scout";
  readonly name = "StubScout";
  async execute(a: WorkerAssignment): Promise<WorkerResult> {
    return this.success(a, {
      kind: "scout",
      dependencies: [],
      patterns: [],
      riskAssessment: { level: "low", factors: [], mitigations: [] },
      suggestedApproach: "fixture",
    }, { cost: this.zeroCost(), confidence: 0.9, touchedFiles: [], durationMs: 1 });
  }
  async estimateCost(): Promise<CostEntry> { return this.zeroCost(); }
  protected emptyOutput(): WorkerOutput {
    return { kind: "scout", dependencies: [], patterns: [], riskAssessment: { level: "low", factors: [], mitigations: [] }, suggestedApproach: "" };
  }
}

class StubCritic extends AbstractWorker {
  readonly type: WorkerType = "critic";
  readonly name = "StubCritic";
  async execute(a: WorkerAssignment): Promise<WorkerResult> {
    return this.success(a, {
      kind: "critic",
      verdict: "approve",
      comments: [],
      suggestedChanges: [],
      intentAlignment: 0.95,
    }, { cost: this.zeroCost(), confidence: 0.9, touchedFiles: [], durationMs: 1 });
  }
  async estimateCost(): Promise<CostEntry> { return this.zeroCost(); }
  protected emptyOutput(): WorkerOutput {
    return { kind: "critic", verdict: "approve", comments: [], suggestedChanges: [], intentAlignment: 1 };
  }
}

class StubVerifier extends AbstractWorker {
  readonly type: WorkerType = "verifier";
  readonly name = "StubVerifier";
  async execute(a: WorkerAssignment): Promise<WorkerResult> {
    return this.success(a, {
      kind: "verifier",
      testResults: [],
      typeCheckPassed: true,
      lintPassed: true,
      buildPassed: true,
      passed: true,
    }, { cost: this.zeroCost(), confidence: 0.9, touchedFiles: [], durationMs: 1 });
  }
  async estimateCost(): Promise<CostEntry> { return this.zeroCost(); }
  protected emptyOutput(): WorkerOutput {
    return { kind: "verifier", testResults: [], typeCheckPassed: true, lintPassed: true, buildPassed: true, passed: true };
  }
}

class StubIntegrator extends AbstractWorker {
  readonly type: WorkerType = "integrator";
  readonly name = "StubIntegrator";
  async execute(a: WorkerAssignment): Promise<WorkerResult> {
    const finalChanges = [...(a.changes ?? [])];
    return this.success(a, {
      kind: "integrator",
      finalChanges,
      conflictsResolved: [],
      coherenceCheck: { passed: true, checks: [] },
      readyToApply: true,
    }, { cost: this.zeroCost(), confidence: 0.9, touchedFiles: finalChanges.map((c) => ({ path: c.path, operation: c.operation })), durationMs: 1 });
  }
  async estimateCost(): Promise<CostEntry> { return this.zeroCost(); }
  protected emptyOutput(): WorkerOutput {
    return { kind: "integrator", finalChanges: [], conflictsResolved: [], coherenceCheck: { passed: true, checks: [] }, readyToApply: false };
  }
}

function hook(name: string, kind: "typecheck" | "tests"): ToolHook {
  return {
    name,
    kind,
    stage: kind === "typecheck" ? "typecheck" : "custom-hook",
    async execute() {
      return { passed: true, issues: [], stdout: "ok", exitCode: 0, durationMs: 1 };
    },
  };
}

function clonePortum(): string {
  const dir = mkdtempSync(join(tmpdir(), "portum-lifecycle-"));
  execFileSync("git", ["clone", "--local", "--no-hardlinks", "--quiet", PORTUM, dir], { stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "aedis@example.test"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Aedis Validation"], { cwd: dir });
  return dir;
}

function writeFixture(repo: string, variant: "basic" | "nest" | "ambiguous"): void {
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src/server.ts"), `import Fastify from "fastify";

const fastify = Fastify({ logger: true });

fastify.get("/", async () => ({ ok: true }));

export async function startServer() {
  await fastify.listen({ port: 0 });
}
`, "utf-8");
  writeFileSync(join(repo, "src/types.ts"), `export interface User {
  id: string;
}
`, "utf-8");
  writeFileSync(join(repo, "src/user.service.ts"), `export class UserService {
}
`, "utf-8");
  if (variant === "nest" || variant === "ambiguous") {
    writeFileSync(join(repo, "src/user.controller.ts"), `import { Controller, Get } from "@nestjs/common";
import { UserService } from "./user.service";

@Controller("/users")
export class UserController {
  constructor(private readonly userService: UserService) {}
}
`, "utf-8");
    writeFileSync(join(repo, "src/create-user.dto.ts"), `export interface CreateUserDto {
  name: string;
}
`, "utf-8");
  }
  if (variant === "ambiguous") {
    writeFileSync(join(repo, "src/duplicate-user.service.ts"), `export class UserService {
}
`, "utf-8");
  }
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["commit", "-qm", `validation fixture ${variant}`], { cwd: repo });
}

function build(repo: string, builder: AbstractWorker, autoPromote = true) {
  const registry = new WorkerRegistry();
  registry.register(new StubScout());
  registry.register(builder);
  registry.register(new StubCritic());
  registry.register(new StubVerifier());
  registry.register(new StubIntegrator());
  const trustProfile: TrustProfile = { scores: new Map(), tierThresholds: { fast: 0, standard: 0, premium: 0 } };
  const events: AedisEvent[] = [];
  const eventBus: EventBus = {
    emit(e) { events.push(e); },
    on: () => () => {},
    onType: () => () => {},
    addClient: () => {},
    removeClient: () => {},
    clientCount: () => 0,
    recentEvents: () => [],
  };
  const receiptStore = new ReceiptStore(repo);
  const coordinator = new Coordinator({
    projectRoot: repo,
    autoCommit: true,
    requireWorkspace: true,
    autoPromoteOnSuccess: autoPromote,
    verificationConfig: {
      requiredChecks: ["typecheck", "tests"],
      hooks: [hook("fixture typecheck", "typecheck"), hook("fixture tests", "tests")],
    },
  }, trustProfile, registry, eventBus, receiptStore);
  return { coordinator, receiptStore, events };
}

const scenarios = [
  { id: "A", variant: "basic" as const, prompt: "Add GET /health endpoint in src/server.ts.", expectBuilder: false },
  { id: "B", variant: "basic" as const, prompt: "Add email:string to User interface in src/types.ts.", expectBuilder: false },
  { id: "C", variant: "basic" as const, prompt: "Add private logger:Logger to UserService in src/user.service.ts.", expectBuilder: false },
  { id: "D", variant: "nest" as const, prompt: "Add POST /users endpoint that calls UserService.createUser with CreateUserDto in src/user.controller.ts, src/user.service.ts, src/create-user.dto.ts.", expectBuilder: false },
  { id: "E", variant: "ambiguous" as const, prompt: "Add POST /users endpoint that calls UserService.createUser with CreateUserDto in src/user.controller.ts, src/user.service.ts, src/duplicate-user.service.ts, src/create-user.dto.ts.", expectBuilder: true },
] as const;

async function main() {
  if (!PORTUM) {
    console.error("Set PORTUM_REPO=/path/to/portum before running this validation script.");
    process.exit(1);
  }
  const portumHead = execFileSync("git", ["-C", PORTUM, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
  const reports = [];
  const only = process.env.SCENARIO;
  for (const sc of scenarios) {
    if (only && sc.id !== only) continue;
    const repo = clonePortum();
    try {
      writeFixture(repo, sc.variant);
      const baseline = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf-8" }).trim();
      const builder = sc.expectBuilder ? new NoOpBuilder() : new SentinelBuilder();
      const { coordinator, receiptStore } = build(repo, builder, !sc.expectBuilder);
      const t0 = Date.now();
      const receipt = await coordinator.submit({ input: sc.prompt, projectRoot: repo });
      const durationMs = Date.now() - t0;
      const after = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf-8" }).trim();
      const persisted = await receiptStore.getRun(receipt.runId);
      const detCheckpoint = persisted?.checkpoints.find((c) => c.summary.startsWith("deterministic transform "));
      const attempts = persisted?.builderAttempts ?? [];
      const deterministicAttempts = attempts.filter((a) => (a as Record<string, unknown>).provider === "deterministic");
      reports.push({
        id: sc.id,
        prompt: sc.prompt,
        clone: repo,
        portumHead,
        baseline,
        after,
        selectedFiles: receipt.humanSummary?.filesTouched?.map((f) => f.path) ?? receipt.executionEvidence.map((e) => e.path).filter(Boolean),
        transformAttempted: detCheckpoint?.summary ?? "none",
        builderCalled: builder.called,
        verifier: receipt.verificationReceipt?.summary ?? "not-run",
        gate: receipt.executionGateReason,
        verdict: receipt.verdict,
        promoted: after !== baseline,
        receiptCost: receipt.totalCost.estimatedCostUsd,
        durationMs,
        deterministicAttempts: deterministicAttempts.map((a) => ({
          transformType: (a as Record<string, unknown>).transformType,
          file: (a as Record<string, unknown>).file,
        })),
        targetRoles: receipt.targetRoles ?? persisted?.finalReceipt?.targetRoles ?? [],
        mergeDecision: receipt.mergeDecision ?? persisted?.finalReceipt?.mergeDecision ?? null,
        cleanup: persisted?.finalReceipt?.workspaceCleanup ?? null,
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }
  console.log(JSON.stringify(reports, null, 2));
}

main().catch((err) => { console.error(err); process.exit(1); });
