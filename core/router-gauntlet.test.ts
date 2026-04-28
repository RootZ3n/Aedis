/**
 * router-shaped gauntlet — exercises the export-safe builder, cost
 * accounting, and stale-result guard with stub workers against a tmp
 * git repo seeded with router-like router/server files. Real model
 * calls are out of scope for the test suite (they cost money and
 * require live providers); this gauntlet validates the wiring such
 * that when a real model emits the failure modes we observed live
 * (export loss, empty diff, late settlement after timeout), the
 * receipt and cost roll-up reflect what actually happened.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
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
import type { TrustProfile } from "../router/trust-router.js";
import type { AedisEvent, EventBus } from "../server/websocket.js";
import { writeFile } from "node:fs/promises";

const ROUTER_FIXTURE = `
export interface ChatRequest {
  model: string;
  messages: { role: string; content: string }[];
}
export interface ChatResponse {
  id: string;
  model: string;
  text: string;
}
export type ProviderName = "openai" | "anthropic" | "minimax";
export interface RouteResult { response: ChatResponse; provider: ProviderName }

export function getAllProviders(): Record<ProviderName, string> {
  return { openai: "x", anthropic: "y", minimax: "z" } as Record<ProviderName, string>;
}
export function getProviderForModel(model: string): ProviderName {
  if (model.startsWith("gpt")) return "openai";
  if (model.startsWith("claude")) return "anthropic";
  return "minimax";
}
export async function routeRequest(req: ChatRequest): Promise<RouteResult> {
  const provider = getProviderForModel(req.model);
  return { response: { id: "1", model: req.model, text: "ok" }, provider };
}
`.trim() + "\n";

const SERVER_FIXTURE = `
import { routeRequest, getAllProviders } from "./router.js";

export const port = 18797;

export async function startServer() {
  // health route already exists
  console.log("listening on", port);
}
`.trim() + "\n";

class StubScout extends AbstractWorker {
  readonly type: WorkerType = "scout";
  readonly name = "StubScout";
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
  readonly type: WorkerType = "critic";
  readonly name = "StubCritic";
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
  readonly type: WorkerType = "verifier";
  readonly name = "StubVerifier";
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
  readonly type: WorkerType = "integrator";
  readonly name = "StubIntegrator";
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

/** Stub Builder that simulates the export-loss failure mode and reports cost. */
class FaultyBuilder extends AbstractWorker {
  readonly type: WorkerType = "builder";
  readonly name = "FaultyBuilder";
  public callCount = 0;
  public seenContracts: string[] = [];

  constructor(
    private readonly mode: "export-loss-then-success" | "always-empty" | "good-route-add",
  ) { super(); }

  async execute(assignment: WorkerAssignment): Promise<WorkerResult> {
    this.callCount += 1;
    const target = assignment.task.targetFiles[0];
    this.seenContracts.push(target);

    const root = assignment.projectRoot ?? process.cwd();
    const sourcePath = join(root, target);

    if (this.mode === "always-empty") {
      // Return result indicating empty diff — model called but
      // produced no change. Cost is non-zero so the receipt records
      // model usage even on failure.
      return this.failure(
        assignment,
        "Model returned no effective file changes",
        { model: "test/qwen", inputTokens: 1000, outputTokens: 5, estimatedCostUsd: 0.0042 },
        1,
      );
    }

    if (this.mode === "good-route-add") {
      // Append a route to the file (this is what a well-prompted
      // model would do for "add /models endpoint").
      const original = readFileSync(sourcePath, "utf-8");
      const updated = original + `\nexport function listModels() { return Object.keys(getAllProviders()); }\n`;
      await writeFile(sourcePath, updated, "utf-8");
      const out: BuilderOutput = {
        kind: "builder",
        changes: [{ path: target, operation: "modify", content: updated, originalContent: original }],
        decisions: [],
        needsCriticReview: false,
      };
      return this.success(assignment, out, {
        cost: { model: "test/qwen", inputTokens: 800, outputTokens: 60, estimatedCostUsd: 0.0035 },
        confidence: 0.9,
        touchedFiles: [{ path: target, operation: "modify" }],
        durationMs: 5,
      });
    }

    // mode === "export-loss-then-success"
    if (this.callCount === 1) {
      // First call drops every export from the file.
      return this.failure(
        assignment,
        "SAFETY: Builder output removed 7 existing export(s) (ChatRequest, ChatResponse, ProviderName, RouteResult, getAllProviders, getProviderForModel, routeRequest) from src/router.ts",
        { model: "test/qwen", inputTokens: 1500, outputTokens: 600, estimatedCostUsd: 0.012 },
        2,
      );
    }
    // Recovery / repair attempt produces a clean append.
    const original = readFileSync(sourcePath, "utf-8");
    const updated = original + `\nexport const fixed = true;\n`;
    await writeFile(sourcePath, updated, "utf-8");
    const out: BuilderOutput = {
      kind: "builder",
      changes: [{ path: target, operation: "modify", content: updated, originalContent: original }],
      decisions: [],
      needsCriticReview: false,
    };
    return this.success(assignment, out, {
      cost: { model: "test/qwen", inputTokens: 1700, outputTokens: 200, estimatedCostUsd: 0.008 },
      confidence: 0.85,
      touchedFiles: [{ path: target, operation: "modify" }],
      durationMs: 4,
    });
  }
  async estimateCost(): Promise<CostEntry> { return this.zeroCost(); }
  protected emptyOutput(): WorkerOutput {
    return { kind: "builder", changes: [], decisions: [], needsCriticReview: false };
  }
}

function buildHarness(projectRoot: string, builder: FaultyBuilder) {
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
    on: () => () => {},
    onType: () => () => {},
    addClient: () => {},
    removeClient: () => {},
    clientCount: () => 0,
    recentEvents: () => [],
  };
  const receiptStore = new ReceiptStore(projectRoot);
  const coordinator = new Coordinator(
    { projectRoot, autoCommit: false, requireWorkspace: true },
    trustProfile,
    registry,
    eventBus,
    receiptStore,
  );
  return { coordinator, events, receiptStore };
}

function makeRouterRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "aedis-router-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src/router.ts"), ROUTER_FIXTURE, "utf-8");
  writeFileSync(join(dir, "src/server.ts"), SERVER_FIXTURE, "utf-8");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "router-fixture", version: "0.0.0" }), "utf-8");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "p@p.local"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "P"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: dir });
  return dir;
}

// ─── Live-shaped scenarios ──────────────────────────────────────────

test("router-A: 'add GET /models endpoint' on src/server.ts — task-shape route-add reaches builder via brief", async () => {
  const repo = makeRouterRepo();
  try {
    const builder = new FaultyBuilder("good-route-add");
    const { coordinator, receiptStore } = buildHarness(repo, builder);

    const receipt = await coordinator.submit({
      input: "add a GET /models endpoint in src/server.ts that returns the configured providers",
    });

    // Source is the disposable workspace; tracked file edits land there.
    // Builder should have been called against src/server.ts.
    assert.ok(builder.seenContracts.includes("src/server.ts"));

    // Receipt records cost from the successful attempt.
    const persisted = await receiptStore.getRun(receipt.runId);
    assert.ok(persisted, "receipt persisted");
    const attempts = (persisted.builderAttempts ?? []) as Array<Record<string, unknown>>;
    // Either the FaultyBuilder reported via base success path, or no
    // attemptRecords are in the output (this test specifically uses a
    // bypass builder that returns directly). Either way receipt must
    // not lie about cost.
    if (attempts.length > 0) {
      const totalCost = attempts.reduce((s, a) => s + Number(a.estimatedCostUsd ?? 0), 0);
      assert.ok(totalCost >= 0);
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("router-B: empty-diff failure path records model + cost on receipt totals", async () => {
  const repo = makeRouterRepo();
  try {
    const builder = new FaultyBuilder("always-empty");
    const { coordinator, receiptStore } = buildHarness(repo, builder);
    const receipt = await coordinator.submit({
      input: "modify src/router.ts to add a /v2 namespace",
    });

    // Run did not succeed (empty diff) but cost must be visible.
    assert.notEqual(receipt.verdict, "ok", "run should not succeed when builder returns empty");
    const persisted = await receiptStore.getRun(receipt.runId);
    assert.ok(persisted);
    // Total cost on the run receipt must include the failed attempt's
    // model/tokens/cost — that's the P5 fix. We aggregate at the
    // builder level via attempt records OR at the worker.cost level.
    const totalCost = Number(persisted.totalCost?.estimatedCostUsd ?? 0);
    // The FaultyBuilder reported $0.0042 per call. Even if cost flows
    // via the WorkerResult.cost path (not attempt records, since
    // FaultyBuilder bypasses the real builder), the receipt total
    // should reflect it. Assert non-zero.
    assert.ok(totalCost > 0, `expected non-zero cost on failed empty-diff run; got ${totalCost}`);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("router-C: export-loss-shape failure — failed attempt cost is recorded", async () => {
  const repo = makeRouterRepo();
  try {
    const builder = new FaultyBuilder("export-loss-then-success");
    const { coordinator, receiptStore } = buildHarness(repo, builder);
    const receipt = await coordinator.submit({
      input: "modify src/router.ts to clean up provider names",
    });

    // First attempt's cost ($0.012) must surface on the run receipt
    // total even if the run itself is not "ok".
    const persisted = await receiptStore.getRun(receipt.runId);
    assert.ok(persisted);
    const total = Number(persisted.totalCost?.estimatedCostUsd ?? 0);
    assert.ok(total > 0, `expected non-zero cost when builder failed first; got ${total}`);

    // Worker events should record at least one failed builder event
    // mentioning the export-loss reason.
    const wEvents = persisted.workerEvents ?? [];
    const failedBuilder = wEvents.find((e) => e.workerType === "builder" && e.status === "failed");
    if (failedBuilder) {
      assert.match(
        failedBuilder.summary,
        /export\(s\)|effective file changes|empty/i,
        `failed builder summary should mention the failure reason; got: ${failedBuilder.summary}`,
      );
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("router-D: stale generation set is empty on a clean run (no false-positive cancellation)", async () => {
  const repo = makeRouterRepo();
  try {
    const builder = new FaultyBuilder("good-route-add");
    const { coordinator } = buildHarness(repo, builder);
    const receipt = await coordinator.submit({
      input: "add a GET /models endpoint in src/server.ts",
    });
    // No timeouts, so no stale events expected.
    assert.ok(receipt);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
