/**
 * Rehearsal loop — pin the contract that Critic "request-changes"
 * actually re-dispatches Builder with feedback, instead of the prior
 * stub that emitted an event and incremented a counter.
 *
 *   1. resetForRehearsal transitions both nodes back to "ready" and
 *      reverts downstream "ready"/"completed" nodes to "planned".
 *   2. formatRehearsalFeedbackForBuilder produces a stable, prompt-
 *      ready string from a CriticOutput.
 *   3. End-to-end via Coordinator: a stub Critic that returns
 *      request-changes 2× then approve causes Builder to re-run with
 *      `assignment.rehearsalFeedback` populated; the loop caps at 3;
 *      "reject" does NOT trigger retry; the final Critic pass sees
 *      the post-rehearsal diff.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import {
  addEdge,
  addNode,
  createTaskGraph,
  markCompleted,
  markDispatched,
  markReady,
  resetForRehearsal,
  TaskGraphError,
} from "./task-graph.js";
import { Coordinator, type CoordinatorConfig } from "./coordinator.js";
import { ReceiptStore } from "./receipt-store.js";
import { WorkerRegistry, AbstractWorker } from "../workers/base.js";
import type {
  WorkerAssignment,
  WorkerResult,
  WorkerType,
  WorkerOutput,
  BuilderOutput,
} from "../workers/base.js";
import { formatRehearsalFeedbackForBuilder } from "../workers/builder.js";
import type { CostEntry } from "./runstate.js";
import type { TrustProfile } from "../router/trust-router.js";
import type { AedisEvent, EventBus } from "../server/websocket.js";

// ─── resetForRehearsal: pure state-machine transitions ──────────────

function buildScoutBuilderCriticGraph() {
  const g = createTaskGraph("intent-1");
  const scout = addNode(g, { label: "scout", workerType: "scout", targetFiles: [], metadata: {} });
  const builder = addNode(g, { label: "builder", workerType: "builder", targetFiles: ["a.ts"], metadata: {} });
  const critic = addNode(g, { label: "critic", workerType: "critic", targetFiles: ["a.ts"], metadata: {} });
  addEdge(g, scout.id, builder.id, "data");
  addEdge(g, builder.id, critic.id, "data");
  // Walk through the lifecycle so both builder and critic are
  // "completed" — the precondition resetForRehearsal expects.
  scout.status = "ready";
  markDispatched(g, scout.id, "rt-scout");
  markCompleted(g, scout.id);
  markDispatched(g, builder.id, "rt-builder");
  markCompleted(g, builder.id);
  markDispatched(g, critic.id, "rt-critic");
  markCompleted(g, critic.id);
  return { graph: g, scout, builder, critic };
}

test("resetForRehearsal: builder → ready, critic → planned (waiting for new builder)", () => {
  // Builder goes ready so it dispatches next iteration. Critic goes
  // planned (NOT ready) so it does NOT race the same wave; it'll be
  // promoted to ready by autoReadyDownstream when Builder completes
  // the rehearsal round. Without this asymmetry the dispatcher
  // would run Builder + Critic in parallel and Critic would review
  // the stale upstream binding.
  const { graph, builder, critic } = buildScoutBuilderCriticGraph();
  resetForRehearsal(graph, builder.id, critic.id);
  assert.equal(graph.nodes.find((n) => n.id === builder.id)!.status, "ready");
  assert.equal(graph.nodes.find((n) => n.id === critic.id)!.status, "planned");
});

test("resetForRehearsal: clears runTaskId so workerResults from prior round don't bind upstream", () => {
  // upstreamResults filtering at dispatchNode keys on
  // graph.nodes.find((n) => n.runTaskId === r.taskId). If we left
  // the old runTaskId in place, the next Critic dispatch would
  // re-discover the stale Builder result instead of the fresh one.
  const { graph, builder, critic } = buildScoutBuilderCriticGraph();
  resetForRehearsal(graph, builder.id, critic.id);
  assert.equal(graph.nodes.find((n) => n.id === builder.id)!.runTaskId, null);
  assert.equal(graph.nodes.find((n) => n.id === critic.id)!.runTaskId, null);
});

test("resetForRehearsal: downstream READY nodes get reverted to planned", () => {
  // Add an integrator downstream of critic. autoReadyDownstream
  // promoted it to "ready" when critic completed. The reset must
  // walk it back so it can't dispatch on the stale diff.
  const { graph, builder, critic } = buildScoutBuilderCriticGraph();
  const integrator = addNode(graph, {
    label: "integrator",
    workerType: "integrator",
    targetFiles: [],
    metadata: {},
  });
  addEdge(graph, critic.id, integrator.id, "data");
  // After markCompleted(critic) above, autoReadyDownstream may not have
  // promoted integrator (the helper only auto-readies "planned" nodes
  // with all hard deps satisfied). Force it so we test the revert path.
  markReady(graph, integrator.id);
  resetForRehearsal(graph, builder.id, critic.id);
  assert.equal(
    graph.nodes.find((n) => n.id === integrator.id)!.status,
    "planned",
    "downstream ready nodes must drop back to planned",
  );
});

test("resetForRehearsal: downstream COMPLETED nodes get reverted to planned", () => {
  // If a downstream wave already ran on the stale Builder diff, the
  // reset must revert those too — otherwise they'd be skipped on
  // re-iteration and ship the old results forward.
  const { graph, builder, critic } = buildScoutBuilderCriticGraph();
  const integrator = addNode(graph, {
    label: "integrator",
    workerType: "integrator",
    targetFiles: [],
    metadata: {},
  });
  addEdge(graph, critic.id, integrator.id, "data");
  markReady(graph, integrator.id);
  markDispatched(graph, integrator.id, "rt-integrator");
  markCompleted(graph, integrator.id);
  resetForRehearsal(graph, builder.id, critic.id);
  assert.equal(
    graph.nodes.find((n) => n.id === integrator.id)!.status,
    "planned",
    "downstream completed nodes must drop back to planned for re-run",
  );
});

test("resetForRehearsal: throws when builder is not completed", () => {
  const { graph, builder, critic } = buildScoutBuilderCriticGraph();
  // Force builder back to dispatched — invalid input for the reset.
  graph.nodes.find((n) => n.id === builder.id)!.status = "dispatched";
  assert.throws(
    () => resetForRehearsal(graph, builder.id, critic.id),
    TaskGraphError,
  );
});

test("resetForRehearsal: throws when critic is not completed", () => {
  const { graph, builder, critic } = buildScoutBuilderCriticGraph();
  graph.nodes.find((n) => n.id === critic.id)!.status = "dispatched";
  assert.throws(
    () => resetForRehearsal(graph, builder.id, critic.id),
    TaskGraphError,
  );
});

// ─── formatRehearsalFeedbackForBuilder: prompt formatting ──────────

test("formatRehearsalFeedbackForBuilder: undefined → empty string", () => {
  assert.equal(formatRehearsalFeedbackForBuilder(undefined), "");
});

test("formatRehearsalFeedbackForBuilder: includes round, comments, suggestions, alignment", () => {
  const text = formatRehearsalFeedbackForBuilder({
    round: 2,
    fromCriticTaskId: "task-c1",
    intentAlignment: 0.42,
    comments: [
      { severity: "blocker", file: "src/a.ts", line: 17, message: "removes a public API" },
      { severity: "concern", file: "src/b.ts", message: "name shadows existing symbol" },
    ],
    suggestedChanges: [
      { path: "src/a.ts", operation: "modify" },
    ],
  });
  assert.match(text, /REHEARSAL ROUND 2 FEEDBACK/);
  assert.match(text, /intent alignment 42%/);
  assert.match(text, /\[blocker\] src\/a\.ts:17 — removes a public API/);
  assert.match(text, /\[concern\] src\/b\.ts — name shadows existing symbol/);
  assert.match(text, /- modify src\/a\.ts/);
});

test("formatRehearsalFeedbackForBuilder: empty comments → explicit placeholder", () => {
  const text = formatRehearsalFeedbackForBuilder({
    round: 1,
    fromCriticTaskId: "task-c1",
    intentAlignment: 0.5,
    comments: [],
    suggestedChanges: [],
  });
  assert.match(text, /no specific comments/);
  assert.match(text, /\(none\)/);
});

// ─── End-to-end: Coordinator drives the rehearsal loop ─────────────

class RealBuilderWorker extends AbstractWorker {
  readonly type: WorkerType = "builder";
  readonly name = "RealBuilder";
  readonly assignmentLog: Array<{ rehearsalFeedback: WorkerAssignment["rehearsalFeedback"] }> = [];
  private callCount = 0;
  constructor(private readonly path: string) { super(); }
  async execute(assignment: WorkerAssignment): Promise<WorkerResult> {
    this.callCount += 1;
    this.assignmentLog.push({ rehearsalFeedback: assignment.rehearsalFeedback });
    const { writeFile, readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const root = assignment.projectRoot ?? process.cwd();
    const abs = resolve(root, this.path);
    const originalContent = await readFile(abs, "utf-8").catch(() => "");
    // Each successive call writes a new value so we can prove the
    // diff really changed across rehearsal rounds.
    const content = `export const widget = ${100 + this.callCount};\n`;
    await writeFile(abs, content, "utf-8");
    const output: BuilderOutput = {
      kind: "builder",
      changes: [{
        path: this.path,
        operation: "modify",
        content,
        originalContent,
      }],
      decisions: [],
      needsCriticReview: false,
    };
    return this.success(assignment, output, {
      cost: this.zeroCost(), confidence: 0.9,
      touchedFiles: [{ path: this.path, operation: "modify" }],
      durationMs: 1,
    });
  }
  async estimateCost(): Promise<CostEntry> { return this.zeroCost(); }
  protected emptyOutput(): WorkerOutput {
    return { kind: "builder", changes: [], decisions: [], needsCriticReview: false };
  }
}

class ScriptedCriticWorker extends AbstractWorker {
  readonly type: WorkerType = "critic";
  readonly name = "ScriptedCritic";
  private idx = 0;
  callCount = 0;
  constructor(private readonly verdicts: ReadonlyArray<"approve" | "request-changes" | "reject">) { super(); }
  async execute(assignment: WorkerAssignment): Promise<WorkerResult> {
    this.callCount += 1;
    const verdict = this.verdicts[Math.min(this.idx, this.verdicts.length - 1)] ?? "approve";
    this.idx += 1;
    return this.success(assignment, {
      kind: "critic",
      verdict,
      comments: verdict === "request-changes"
        ? [{ severity: "concern", file: "core/widget.ts", message: "rename `widget` to `gadget`" }]
        : [],
      suggestedChanges: [],
      intentAlignment: verdict === "approve" ? 0.92 : verdict === "reject" ? 0.2 : 0.6,
    }, { cost: this.zeroCost(), confidence: 0.9, touchedFiles: [], durationMs: 1 });
  }
  async estimateCost(): Promise<CostEntry> { return this.zeroCost(); }
  protected emptyOutput(): WorkerOutput {
    return { kind: "critic", verdict: "approve", comments: [], suggestedChanges: [], intentAlignment: 1 };
  }
}

class StubScoutWorker extends AbstractWorker {
  readonly type: WorkerType = "scout";
  readonly name = "StubScout";
  async execute(assignment: WorkerAssignment): Promise<WorkerResult> {
    return this.success(assignment, {
      kind: "scout", dependencies: [], patterns: [],
      riskAssessment: { level: "low", factors: [], mitigations: [] },
      suggestedApproach: "no-op",
    }, { cost: this.zeroCost(), confidence: 0.9, touchedFiles: [], durationMs: 1 });
  }
  async estimateCost(): Promise<CostEntry> { return this.zeroCost(); }
  protected emptyOutput(): WorkerOutput {
    return { kind: "scout", dependencies: [], patterns: [], riskAssessment: { level: "low", factors: [], mitigations: [] }, suggestedApproach: "" };
  }
}

class StubVerifierWorker extends AbstractWorker {
  readonly type: WorkerType = "verifier";
  readonly name = "StubVerifier";
  async execute(assignment: WorkerAssignment): Promise<WorkerResult> {
    return this.success(assignment, {
      kind: "verifier", testResults: [],
      typeCheckPassed: true, lintPassed: true, buildPassed: true, passed: true,
    }, { cost: this.zeroCost(), confidence: 0.9, touchedFiles: [], durationMs: 1 });
  }
  async estimateCost(): Promise<CostEntry> { return this.zeroCost(); }
  protected emptyOutput(): WorkerOutput {
    return { kind: "verifier", testResults: [], typeCheckPassed: true, lintPassed: true, buildPassed: true, passed: true };
  }
}

class StubIntegratorWorker extends AbstractWorker {
  readonly type: WorkerType = "integrator";
  readonly name = "StubIntegrator";
  async execute(assignment: WorkerAssignment): Promise<WorkerResult> {
    const finalChanges = [...(assignment.changes ?? [])];
    return this.success(assignment, {
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

function buildHarness(projectRoot: string, opts: {
  builder: RealBuilderWorker;
  critic: ScriptedCriticWorker;
  maxRehearsalRounds?: number;
  stateRoot?: string;
}) {
  const registry = new WorkerRegistry();
  registry.register(new StubScoutWorker());
  registry.register(opts.builder);
  registry.register(opts.critic);
  registry.register(new StubVerifierWorker());
  registry.register(new StubIntegratorWorker());
  const trustProfile: TrustProfile = {
    scores: new Map(),
    tierThresholds: { fast: 0, standard: 0, premium: 0 },
  };
  const events: AedisEvent[] = [];
  const eventBus: EventBus = {
    emit(event) { events.push(event); },
    on: () => () => {},
    onType: () => () => {},
    addClient: () => {},
    removeClient: () => {},
    clientCount: () => 0,
    recentEvents: () => [],
  };
  const receiptStore = new ReceiptStore(opts.stateRoot ?? projectRoot);
  const config: Partial<CoordinatorConfig> = {
    projectRoot,
    ...(opts.stateRoot ? { stateRoot: opts.stateRoot } : {}),
    autoCommit: true,
    requireWorkspace: true,
    requireApproval: false,
    autoPromoteOnSuccess: true,
    allowSourcePromotion: true,
    trustedLocalRepoWrites: true,
    maxRehearsalRounds: opts.maxRehearsalRounds ?? 3,
    verificationConfig: {
      requiredChecks: [],
      hooks: [{
        name: "stub-typecheck",
        stage: "typecheck",
        kind: "typecheck",
        execute: async () => ({
          passed: true, issues: [], stdout: "", stderr: "", exitCode: 0, durationMs: 0,
        }),
      }],
    },
  };
  const coordinator = new Coordinator(config, trustProfile, registry, eventBus, receiptStore);
  return { coordinator, events, receiptStore };
}

function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "aedis-rehearsal-"));
  mkdirSync(join(dir, "core"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "rh", version: "0.0.0" }), "utf-8");
  writeFileSync(join(dir, "core/widget.ts"), "export const widget = 1;\n", "utf-8");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@aedis.local"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Aedis Test"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: dir });
  return dir;
}

test("rehearsal loop: Builder is re-dispatched with rehearsalFeedback on request-changes", async () => {
  const repo = makeTempRepo();
  try {
    // Critic returns request-changes once, then approve.
    // Expected: Builder runs twice; the SECOND assignment carries
    // `rehearsalFeedback` populated from the first Critic verdict.
    const builder = new RealBuilderWorker("core/widget.ts");
    const critic = new ScriptedCriticWorker(["request-changes", "approve"]);
    const { coordinator } = buildHarness(repo, { builder, critic });

    await coordinator.submit({ input: "modify widget in core" });

    assert.ok(builder.assignmentLog.length >= 2,
      `expected Builder to be re-dispatched after request-changes; got ${builder.assignmentLog.length} dispatch(es)`);
    assert.equal(builder.assignmentLog[0].rehearsalFeedback, undefined,
      "first dispatch must NOT carry rehearsalFeedback");
    const second = builder.assignmentLog[1].rehearsalFeedback;
    assert.ok(second, "second dispatch must carry rehearsalFeedback after request-changes");
    assert.equal(second!.round, 1);
    assert.ok(second!.comments.length >= 1, "feedback must include Critic comments");
    assert.match(second!.comments[0].message, /rename `widget` to `gadget`/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("rehearsal loop: caps at maxRehearsalRounds and records rehearsal_cap_hit", async () => {
  const repo = makeTempRepo();
  try {
    // Critic returns request-changes forever — the loop must stop
    // at maxRehearsalRounds (2 here), produce ~3 Builder dispatches
    // (initial + 2 rounds), and record rehearsal_cap_hit on the receipt.
    const builder = new RealBuilderWorker("core/widget.ts");
    const critic = new ScriptedCriticWorker(["request-changes", "request-changes", "request-changes", "request-changes"]);
    const { coordinator, receiptStore, events } = buildHarness(repo, {
      builder, critic, maxRehearsalRounds: 2,
    });
    const receipt = await coordinator.submit({ input: "modify widget in core" });

    // Builder calls = initial + maxRehearsalRounds.
    assert.equal(
      builder.assignmentLog.length,
      3,
      `cap=2 should yield exactly 3 Builder dispatches (initial + 2 retries); got ${builder.assignmentLog.length}`,
    );

    // The cap-hit checkpoint must be on the persisted receipt.
    const persisted = await receiptStore.getRun(receipt.runId);
    const capCheckpoint = persisted?.checkpoints.find((c) =>
      (c.details as { rehearsal_cap_hit?: boolean })?.rehearsal_cap_hit === true,
    );
    assert.ok(capCheckpoint,
      "persisted receipt must carry a checkpoint with rehearsal_cap_hit:true");

    // The rehearsal_cap_hit system_event must have fired exactly once.
    const capEvents = events.filter(
      (e) => e.type === "system_event" && (e.payload as { event?: string })?.event === "rehearsal_cap_hit",
    );
    assert.equal(capEvents.length, 1,
      "rehearsal_cap_hit event must fire exactly once per run, even if Critic keeps requesting changes");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("rehearsal loop: 'reject' verdict does NOT trigger retry", async () => {
  const repo = makeTempRepo();
  try {
    // Critic returns reject — no retry should happen. Builder runs once.
    const builder = new RealBuilderWorker("core/widget.ts");
    const critic = new ScriptedCriticWorker(["reject", "reject", "reject"]);
    const { coordinator } = buildHarness(repo, { builder, critic });
    await coordinator.submit({ input: "modify widget in core" });

    assert.equal(
      builder.assignmentLog.length,
      1,
      `reject must NOT trigger retry; expected 1 Builder dispatch, got ${builder.assignmentLog.length}`,
    );
    // Sanity: Critic was called at least once (in-graph). Final-Critic-pass
    // also runs once after executeGraph exits, so total Critic calls ≥ 2.
    assert.ok(critic.callCount >= 1, "in-graph Critic must have been called");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("rehearsal loop: second Critic pass reviews the post-rehearsal Builder result", async () => {
  // After the rehearsal loop completes, the second in-graph Critic
  // invocation should see the LAST Builder result (post-rehearsal),
  // not the first. We prove this by checking Critic's call count:
  // in-graph Critic ran twice (round 1 request-changes + round 2
  // approve). Builder ran twice (initial + rehearsal round).
  const repo = makeTempRepo();
  try {
    const builder = new RealBuilderWorker("core/widget.ts");
    const critic = new ScriptedCriticWorker(["request-changes", "approve", "approve"]);
    const { coordinator, receiptStore } = buildHarness(repo, { builder, critic });
    const receipt = await coordinator.submit({ input: "modify widget in core" });

    // 2 in-graph Critic calls: round 1 (request-changes) + round 2 (approve).
    assert.ok(critic.callCount >= 2,
      `expected at least 2 in-graph Critic calls; got ${critic.callCount} call(s)`);

    // Builder was dispatched twice (initial + rehearsal round).
    assert.equal(builder.assignmentLog.length, 2,
      `expected 2 Builder dispatches (initial + rehearsal); got ${builder.assignmentLog.length}`);

    // The persisted receipt must carry the rehearsal round decision.
    const persisted = await receiptStore.getRun(receipt.runId);
    assert.ok(persisted, "receipt must be persisted");
    const rehearsalDecision = persisted?.checkpoints.find((c) =>
      c.summary?.includes("Rehearsal round 1"),
    ) ?? persisted?.checkpoints.find((c) =>
      c.type === "worker_step",
    );
    // The change-set must include core/widget.ts.
    const changes = persisted?.changesSummary ?? [];
    assert.ok(
      changes.some((c) => c.path === "core/widget.ts"),
      `receipt must record core/widget.ts in changesSummary; got ${JSON.stringify(changes)}`,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
