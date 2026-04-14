/**
 * Coordinator end-to-end integration test.
 *
 * Drives the full submit → dispatch → verify → receipt → cleanup flow
 * against a real tmp git repo with stub workers. Unlike the
 * execution-truth regression (which focuses on the gate verdict),
 * this test is the single end-to-end assertion on the safety
 * invariants the user cares about:
 *
 *   1. The source repo is byte-identical before and after the run —
 *      all mutations stay in the disposable workspace (worktree /
 *      clone / copy).
 *   2. The run receipt is persisted in state/receipts and records the
 *      workspace reference so startup recovery can reconcile orphans.
 *   3. On normal shutdown the workspace is discarded and the
 *      persisted receipt marks `workspace.cleanedUp = true`.
 *   4. When createWorkspace throws and requireWorkspace=true (the
 *      default), the run hard-aborts with a clear reason and never
 *      touches the source repo.
 *   5. When a run crashes with the workspace still on disk, startup
 *      recovery (markIncompleteRunsCrashed) removes the orphan
 *      worktree and marks the run INTERRUPTED.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { Coordinator } from "./coordinator.js";
import { ReceiptStore } from "./receipt-store.js";
import type { PersistedWorkspaceRef } from "./receipt-store.js";
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

// ─── Shared stubs ───────────────────────────────────────────────────

class RealBuilderWorker extends AbstractWorker {
  readonly type: WorkerType = "builder";
  readonly name = "RealBuilder";

  constructor(private readonly writes: readonly { path: string; content: string }[]) {
    super();
  }

  async execute(assignment: WorkerAssignment): Promise<WorkerResult> {
    const { writeFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const root = assignment.projectRoot ?? process.cwd();
    const changes = [];
    for (const w of this.writes) {
      await writeFile(resolve(root, w.path), w.content, "utf-8");
      changes.push({ path: w.path, operation: "modify" as const, content: w.content });
    }
    const output: BuilderOutput = { kind: "builder", changes, decisions: [], needsCriticReview: false };
    return this.success(assignment, output, {
      cost: this.zeroCost(),
      confidence: 0.9,
      touchedFiles: changes.map((c) => ({ path: c.path, operation: c.operation })),
      durationMs: 1,
    });
  }
  async estimateCost(): Promise<CostEntry> { return this.zeroCost(); }
  protected emptyOutput(): WorkerOutput {
    return { kind: "builder", changes: [], decisions: [], needsCriticReview: false };
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

class StubCriticWorker extends AbstractWorker {
  readonly type: WorkerType = "critic";
  readonly name = "StubCritic";
  async execute(assignment: WorkerAssignment): Promise<WorkerResult> {
    return this.success(assignment, {
      kind: "critic", verdict: "approve", comments: [], suggestedChanges: [], intentAlignment: 0.9,
    }, { cost: this.zeroCost(), confidence: 0.9, touchedFiles: [], durationMs: 1 });
  }
  async estimateCost(): Promise<CostEntry> { return this.zeroCost(); }
  protected emptyOutput(): WorkerOutput {
    return { kind: "critic", verdict: "approve", comments: [], suggestedChanges: [], intentAlignment: 1 };
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

// ─── Harness ────────────────────────────────────────────────────────

interface Harness {
  coordinator: Coordinator;
  events: AedisEvent[];
  receiptStore: ReceiptStore;
}

function buildHarness(projectRoot: string, opts: {
  builder?: AbstractWorker;
  requireWorkspace?: boolean;
  stateRoot?: string;
} = {}): Harness {
  const registry = new WorkerRegistry();
  registry.register(new StubScoutWorker());
  registry.register(opts.builder ?? new RealBuilderWorker([]));
  registry.register(new StubCriticWorker());
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
  const coordinator = new Coordinator(
    {
      projectRoot,
      autoCommit: false,
      requireWorkspace: opts.requireWorkspace ?? true,
    },
    trustProfile,
    registry,
    eventBus,
    receiptStore,
  );
  return { coordinator, events, receiptStore };
}

function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "aedis-coord-int-"));
  mkdirSync(join(dir, "core"), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "coord-int-tmp", version: "0.0.0" }),
    "utf-8",
  );
  writeFileSync(join(dir, "core/widget.ts"), "export const widget = 1;\n", "utf-8");
  // Initialise a real git repo so the worktree strategy works.
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@aedis.local"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Aedis Test"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: dir });
  return dir;
}

function gitTreeHash(repo: string): string {
  return execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: repo })
    .toString()
    .trim();
}

function workingTreeStatus(repo: string): string {
  return execFileSync("git", ["status", "--porcelain"], { cwd: repo })
    .toString()
    .trim();
}

// ─── TESTS ──────────────────────────────────────────────────────────

test("integration: submit mutates workspace only — source tracked files are byte-identical", async () => {
  const repo = makeTempRepo();
  try {
    const builder = new RealBuilderWorker([
      { path: "core/widget.ts", content: "export const widget = 2; // modified\n" },
    ]);
    const { coordinator } = buildHarness(repo, { builder });

    const beforeTree = gitTreeHash(repo);
    const beforeWidget = readFileSync(join(repo, "core/widget.ts"), "utf-8");

    const receipt = await coordinator.submit({
      input: "modify widget.ts in core",
    });

    const afterTree = gitTreeHash(repo);
    const afterWidget = readFileSync(join(repo, "core/widget.ts"), "utf-8");

    // SOURCE REPO SAFETY — the one invariant that matters for real
    // use: the user's tracked code must not have changed. Aedis does
    // create its own `.aedis/` + `state/` metadata dirs under the
    // projectRoot — those are Aedis's own bookkeeping, not user code.
    // We assert tree-hash and content equality on the user-tracked
    // file, which is the actual safety invariant.
    assert.equal(afterTree, beforeTree, "source tree hash must not change");
    assert.equal(afterWidget, beforeWidget, "source file content must not change");
    // git diff --stat HEAD must be empty — no tracked file diffs.
    const tracked = execFileSync("git", ["diff", "--stat", "HEAD"], { cwd: repo })
      .toString()
      .trim();
    assert.equal(tracked, "", `no tracked file diffs allowed; got:\n${tracked}`);

    assert.ok(receipt, "receipt must be returned");
    assert.equal(receipt.sourceRepo, repo, "receipt records the source repo");
    assert.ok(receipt.sourceCommitSha, "receipt records the source commit sha");

    assert.ok(
      !receipt.workspaceCleanup || receipt.workspaceCleanup.success,
      "workspace cleanup should have succeeded or been absent",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("integration: receipt is persisted with workspace ref and cleanedUp=true after normal run", async () => {
  const repo = makeTempRepo();
  try {
    const builder = new RealBuilderWorker([
      { path: "core/widget.ts", content: "export const widget = 3;\n" },
    ]);
    const { coordinator, receiptStore } = buildHarness(repo, { builder });

    const receipt = await coordinator.submit({ input: "modify widget in core" });

    const persisted = await receiptStore.getRun(receipt.runId);
    assert.ok(persisted, "persisted receipt must exist in state/receipts");
    assert.ok(persisted.workspace, "persisted receipt must record workspace ref");
    assert.ok(
      persisted.workspace.workspacePath.includes("aedis-ws-"),
      "workspace path must match the Aedis marker",
    );
    assert.equal(
      persisted.workspace.sourceRepo,
      repo,
      "workspace ref must record the correct source repo",
    );
    assert.equal(
      persisted.workspace.cleanedUp,
      true,
      "normal-path cleanup must mark workspace.cleanedUp=true",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("integration: requireWorkspace=true hard-aborts when createWorkspace fails — no source mutation", async () => {
  // Point the Coordinator at a path that exists but is NOT a git
  // repo. Every createWorkspace strategy (worktree, clone, copy
  // via cp -a) should fail here because there is no `.git` dir for
  // worktree/clone and the `cp -a` still succeeds from a legitimate
  // dir. To force total failure we instead point at a non-existent
  // directory so every strategy errors.
  const bogusRoot = mkdtempSync(join(tmpdir(), "aedis-bogus-"));
  const doesNotExist = join(bogusRoot, "nope-" + Date.now());
  // Do NOT mkdir — the path must be absent so cp and git both fail.

  const stateRoot = mkdtempSync(join(tmpdir(), "aedis-state-"));
  try {
    const { coordinator, receiptStore, events } = buildHarness(doesNotExist, {
      requireWorkspace: true,
      stateRoot,
    });

    const receipt = await coordinator.submit({
      input: "in core/widget.ts, replace the widget constant",
    });

    assert.equal(receipt.verdict, "failed", "run must fail when workspace cannot be created");
    assert.ok(
      /Workspace creation failed/i.test(receipt.executionGateReason),
      `failure reason must mention workspace creation; got: ${receipt.executionGateReason}`,
    );
    assert.equal(receipt.commitSha, null, "no commit must occur on abort");
    assert.equal(receipt.patchArtifact, null, "no patch artifact on abort");

    // Source "repo" must still not exist — the abort path must never
    // have called mkdir on it.
    assert.equal(existsSync(doesNotExist), false, "source path must not be created");

    // Persisted receipt must record the abort.
    const persisted = await receiptStore.getRun(receipt.runId);
    assert.ok(persisted, "abort receipt must be persisted");
    assert.equal(
      persisted.status,
      "EXECUTION_ERROR",
      "persisted status must be EXECUTION_ERROR on abort",
    );
    assert.ok(
      persisted.errors.some((e) => /Workspace creation failed/i.test(e)),
      "persisted errors must explain the abort",
    );

    // Abort event must be emitted so UIs can react.
    assert.ok(
      events.some((e) => e.type === "merge_blocked"),
      "merge_blocked event must fire on abort",
    );
    assert.ok(
      events.some((e) => e.type === "run_complete"),
      "run_complete event must fire on abort",
    );
  } finally {
    rmSync(bogusRoot, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("integration: startup recovery removes orphan workspaces and marks run INTERRUPTED", async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), "aedis-state-"));
  const orphanDir = mkdtempSync(join(tmpdir(), "aedis-ws-orphan-"));
  try {
    const store = new ReceiptStore(stateRoot);
    // Simulate a run that crashed mid-execution: the receipt is
    // still in EXECUTING_IN_WORKSPACE and the workspace directory
    // exists on disk.
    await store.beginRun({
      runId: "run-crashed",
      intentId: "intent-crashed",
      prompt: "orphan test",
      taskSummary: "orphan test",
      startedAt: "2026-04-14T12:00:00.000Z",
      phase: "building",
    });
    const workspaceRef: PersistedWorkspaceRef = {
      workspacePath: orphanDir,
      sourceRepo: "/tmp/fake-source",
      sourceCommitSha: "deadbeef",
      method: "copy",
      createdAt: "2026-04-14T12:00:00.000Z",
      worktreeBranch: null,
      cleanedUp: false,
    };
    await store.patchRun("run-crashed", { workspace: workspaceRef });

    // Sanity: the orphan directory exists before recovery.
    assert.ok(existsSync(orphanDir), "orphan workspace must exist before recovery");

    const recovery = await store.markIncompleteRunsCrashed("simulated crash");
    assert.equal(recovery.runsRecovered, 1, "exactly one run must be recovered");
    assert.equal(recovery.orphanWorkspaces.length, 1, "the orphan workspace must be reported");
    assert.equal(recovery.orphanWorkspaces[0].removed, true, "orphan workspace must be removed");

    assert.equal(existsSync(orphanDir), false, "orphan workspace must be gone after recovery");

    const persisted = await store.getRun("run-crashed");
    assert.ok(persisted);
    assert.equal(persisted.status, "INTERRUPTED");
    assert.equal(persisted.workspace?.cleanedUp, true, "workspace ref must be marked cleanedUp");
    assert.ok(
      persisted.errors.some((e) => /Orphan workspace removed/i.test(e)),
      "errors must record the orphan cleanup",
    );
  } finally {
    rmSync(stateRoot, { recursive: true, force: true });
    rmSync(orphanDir, { recursive: true, force: true });
  }
});

test("integration: startup recovery refuses to remove non-Aedis paths", async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), "aedis-state-"));
  const bystanderDir = mkdtempSync(join(tmpdir(), "not-aedis-"));
  writeFileSync(join(bystanderDir, "important.txt"), "do not delete", "utf-8");
  try {
    const store = new ReceiptStore(stateRoot);
    await store.beginRun({
      runId: "run-path-guard",
      intentId: "intent-pg",
      prompt: "path guard",
      taskSummary: "path guard",
      startedAt: "2026-04-14T12:05:00.000Z",
      phase: "building",
    });
    await store.patchRun("run-path-guard", {
      workspace: {
        workspacePath: bystanderDir, // no "aedis-ws-" marker
        sourceRepo: "/tmp/fake",
        sourceCommitSha: "abcdef",
        method: "copy",
        createdAt: "2026-04-14T12:05:00.000Z",
        worktreeBranch: null,
        cleanedUp: false,
      },
    });

    const recovery = await store.markIncompleteRunsCrashed("refuse-removal test");
    assert.equal(recovery.orphanWorkspaces.length, 1);
    assert.equal(recovery.orphanWorkspaces[0].removed, false, "non-Aedis path must not be removed");
    assert.match(String(recovery.orphanWorkspaces[0].error), /refused/i);
    assert.ok(existsSync(bystanderDir), "bystander directory must still exist");
    assert.ok(existsSync(join(bystanderDir, "important.txt")), "bystander files untouched");
  } finally {
    rmSync(stateRoot, { recursive: true, force: true });
    rmSync(bystanderDir, { recursive: true, force: true });
  }
});
