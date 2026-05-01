/**
 * Coordinator: trust-this-session auto-approval.
 *
 * Pins the contract:
 *   - When trustThisSession=true, a run that would otherwise pause at
 *     AWAITING_APPROVAL completes during submit() — no external
 *     approveRun() call is required.
 *   - DiffApprovalReceipt records decidedBy="system" and
 *     reason="trust_this_session" so the audit trail can never
 *     mistake auto-approvals for human ones.
 *   - Default behaviour (trustThisSession=false) is unchanged: the
 *     run still pauses for human approval.
 *   - The CLI flag parser detects only the literal --trust-this-session
 *     argv entry; no env-var or settings.json fallback exists.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

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
import type { CostEntry } from "./runstate.js";
import type { TrustProfile } from "../router/trust-router.js";
import type { AedisEvent, EventBus } from "../server/websocket.js";
import { parseTrustThisSession } from "../server/index.js";

// ─── Stubs (minimal, mirror coordinator-approval-promote.test.ts) ──

class RealBuilderWorker extends AbstractWorker {
  readonly type: WorkerType = "builder";
  readonly name = "RealBuilder";
  constructor(private readonly writes: readonly { path: string; content: string }[]) { super(); }
  async execute(assignment: WorkerAssignment): Promise<WorkerResult> {
    const { writeFile, readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const root = assignment.projectRoot ?? process.cwd();
    const changes = [];
    for (const w of this.writes) {
      const abs = resolve(root, w.path);
      const existed = existsSync(abs);
      const originalContent = await readFile(abs, "utf-8").catch(() => "");
      await writeFile(abs, w.content, "utf-8");
      changes.push({
        path: w.path,
        operation: existed ? "modify" as const : "create" as const,
        content: w.content,
        originalContent,
      });
    }
    const output: BuilderOutput = { kind: "builder", changes, decisions: [], needsCriticReview: false };
    return this.success(assignment, output, {
      cost: this.zeroCost(), confidence: 0.9,
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

function buildHarness(projectRoot: string, opts: {
  trustThisSession: boolean;
  builder?: AbstractWorker;
  stateRoot?: string;
}) {
  const registry = new WorkerRegistry();
  registry.register(new StubScoutWorker());
  registry.register(opts.builder ?? new RealBuilderWorker([
    { path: "core/widget.ts", content: "export const widget = 999;\n" },
  ]));
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

  const config: Partial<CoordinatorConfig> = {
    projectRoot,
    ...(opts.stateRoot ? { stateRoot: opts.stateRoot } : {}),
    autoCommit: true,
    requireWorkspace: true,
    requireApproval: true,
    autoPromoteOnSuccess: false,
    allowSourcePromotion: true,
    trustedLocalRepoWrites: true,
    trustThisSession: opts.trustThisSession,
    verificationConfig: {
      requiredChecks: [],
      hooks: [{
        name: "stub-typecheck",
        stage: "typecheck",
        kind: "typecheck",
        execute: async () => ({
          passed: true,
          issues: [],
          stdout: "",
          stderr: "",
          exitCode: 0,
          durationMs: 0,
        }),
      }],
    },
  };

  const coordinator = new Coordinator(config, trustProfile, registry, eventBus, receiptStore);
  return { coordinator, events, receiptStore };
}

function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "aedis-trust-session-"));
  mkdirSync(join(dir, "core"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "trust-tmp", version: "0.0.0" }), "utf-8");
  writeFileSync(join(dir, "core/widget.ts"), "export const widget = 1;\n", "utf-8");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@aedis.local"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Aedis Test"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: dir });
  return dir;
}

// ─── parseTrustThisSession ─────────────────────────────────────────

test("parseTrustThisSession: detects --trust-this-session in argv", () => {
  assert.equal(parseTrustThisSession(["node", "server.js", "--trust-this-session"]), true);
  assert.equal(parseTrustThisSession(["node", "server.js"]), false);
  assert.equal(parseTrustThisSession([]), false);
});

test("parseTrustThisSession: no env-var or settings fallback (literal flag only)", () => {
  // Setting an env var must NOT flip the flag — the whole point of
  // session-scope is that nothing on disk or in env can persist it.
  const prev = process.env["AEDIS_TRUST_THIS_SESSION"];
  process.env["AEDIS_TRUST_THIS_SESSION"] = "true";
  try {
    assert.equal(parseTrustThisSession(["node", "server.js"]), false);
  } finally {
    if (prev === undefined) delete process.env["AEDIS_TRUST_THIS_SESSION"];
    else process.env["AEDIS_TRUST_THIS_SESSION"] = prev;
  }
});

// ─── auto-approval flow ─────────────────────────────────────────────

test("trust-this-session: run completes during submit() without external approveRun call", async () => {
  const repo = makeTempRepo();
  try {
    const { coordinator, receiptStore } = buildHarness(repo, { trustThisSession: true });

    // submit() must return a post-approval receipt — NOT the
    // AWAITING_APPROVAL stale snapshot. With trustThisSession=true
    // the run auto-approves before submit() resolves.
    const receipt = await coordinator.submit({ input: "modify widget in core" });
    const persisted = await receiptStore.getRun(receipt.runId);

    assert.ok(persisted, "receipt must be persisted");
    assert.notEqual(
      persisted!.status,
      "AWAITING_APPROVAL",
      "trust-this-session must clear AWAITING_APPROVAL before submit() returns",
    );
    assert.equal(
      coordinator.getPendingApprovals().length,
      0,
      "trust-this-session must drain pendingApproval — no stranded runs",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("trust-this-session: DiffApprovalReceipt records decidedBy=system, reason=trust_this_session", async () => {
  const repo = makeTempRepo();
  try {
    const { coordinator, receiptStore } = buildHarness(repo, { trustThisSession: true });
    const receipt = await coordinator.submit({ input: "modify widget in core" });
    const persisted = await receiptStore.getRun(receipt.runId);

    const diffApproval = persisted!.finalReceipt?.diffApproval;
    assert.ok(diffApproval, "finalReceipt.diffApproval must be present after auto-approval");
    assert.equal(diffApproval!.status, "approved");
    assert.equal(
      diffApproval!.decidedBy,
      "system",
      "auto-approvals must NOT impersonate a human",
    );
    assert.equal(
      diffApproval!.reason,
      "trust_this_session",
      "reason field must record the auto-approval mode for audit",
    );
    assert.ok(diffApproval!.decidedAt, "decidedAt must be stamped on auto-approvals");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("trust-this-session=false (default): run still pauses at AWAITING_APPROVAL", async () => {
  // Regression guard: my changes must not break the default path.
  const repo = makeTempRepo();
  try {
    const { coordinator, receiptStore } = buildHarness(repo, { trustThisSession: false });
    const receipt = await coordinator.submit({ input: "modify widget in core" });
    const persisted = await receiptStore.getRun(receipt.runId);

    assert.equal(
      persisted!.status,
      "AWAITING_APPROVAL",
      "with trustThisSession=false the run must still pause for human approval",
    );
    assert.equal(
      coordinator.getPendingApprovals().length,
      1,
      "default path must register a pending approval entry",
    );
    // Cancel so the harness teardown doesn't leave stranded workspaces.
    coordinator.cancel(receipt.runId);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
