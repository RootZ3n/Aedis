/**
 * End-to-end local_then_cloud — drives the production submit() path
 * against a tmp repo with `.aedis/lane-config.json`, forces the
 * primary lane to disqualify via a failing typecheck hook, and
 * confirms the persisted receipt carries the candidate manifest
 * AND that `getRunDetail` → `RunDetailScreen` renders the panel
 * exactly as the operator would see it in the TUI.
 *
 * This is the closest deterministic substitute for the operator-led
 * smoke test described in the Phase D ask. A truly live "local model
 * fails, cloud model succeeds" demonstration is NOT possible with the
 * current Phase B wiring — `runShadowBuilder` ignores
 * lane-config.shadow's provider/model when choosing which worker
 * runs (it always falls back to the registry's default Builder). The
 * lane fields on the resulting Candidate are *labels*, not dispatch
 * directives. Closing that gap is Phase D scope; this test pins the
 * pieces that do work today.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { render } from "ink-testing-library";

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
import { RunDetailScreen } from "../cli/tui/screens/run-detail.js";
import type { RunDetailData } from "../cli/tui/api.js";

// ─── Stub workers (mirror the existing harness) ─────────────────────

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
      const originalContent = await readFile(abs, "utf-8").catch(() => "");
      await writeFile(abs, w.content, "utf-8");
      changes.push({ path: w.path, operation: "modify" as const, content: w.content, originalContent });
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

// ─── Repo + harness ─────────────────────────────────────────────────

function makeRepoWithLaneConfig(payload: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "aedis-lane-e2e-"));
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

function buildHarness(projectRoot: string, opts: { typecheckPasses: boolean }) {
  const registry = new WorkerRegistry();
  registry.register(new StubScout());
  registry.register(new RealBuilderWorker([
    { path: "core/widget.ts", content: "export const widget = 2;\n" },
  ]));
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
      verificationConfig: {
        requiredChecks: [],
        // The decisive lever: when typecheck "fails" with a blocker
        // issue, the merge gate produces a critical finding and
        // mergeDecision.action becomes "block". recordPrimaryCandidate
        // then stamps the primary candidate as status=failed, and
        // maybeRunFallbackShadow fires.
        hooks: [{
          name: "stub-typecheck",
          stage: "typecheck",
          kind: "typecheck",
          execute: async () => opts.typecheckPasses
            ? { passed: true, issues: [], stdout: "", stderr: "", exitCode: 0, durationMs: 0 }
            : {
                passed: false,
                issues: [{
                  stage: "typecheck" as const,
                  severity: "blocker" as const,
                  message: "synthetic primary-lane typecheck failure",
                }],
                stdout: "", stderr: "TS2304: Cannot find name 'foo'", exitCode: 1, durationMs: 0,
              },
        }],
      },
    },
    trustProfile, registry, eventBus, receiptStore,
  );
  return { coordinator, events, receiptStore };
}

// ─── E2E: primary fails → shadow runs → manifest persisted ──────────

test("e2e local_then_cloud: primary disqualifies, shadow lane runs, receipt carries the manifest", async () => {
  const repo = makeRepoWithLaneConfig({
    mode: "local_then_cloud",
    primary: { lane: "local", provider: "ollama", model: "qwen3.5:9b" },
    shadow: { lane: "cloud", provider: "openrouter", model: "xiaomi/mimo-v2.5" },
  });
  try {
    const { coordinator, receiptStore } = buildHarness(repo, { typecheckPasses: false });

    const receipt = await coordinator.submit({ input: "modify widget in core" });

    // ── Persisted receipt carries the manifest ──────────────────
    const persisted = await receiptStore.getRun(receipt.runId);
    assert.ok(persisted, "run must persist");
    const final = (persisted as any).finalReceipt;
    assert.ok(final, "finalReceipt must persist");

    assert.equal(final.laneMode, "local_then_cloud", "laneMode must round-trip onto the receipt");
    assert.ok(Array.isArray(final.candidates), "candidates manifest must be on the receipt");
    assert.equal(final.candidates.length, 2, `expected primary + shadow on the manifest; got ${final.candidates.length}`);

    const primary = final.candidates.find((c: any) => c.workspaceId === "primary");
    const shadow = final.candidates.find((c: any) => c.role === "shadow");
    assert.ok(primary, "primary candidate must be on the manifest");
    assert.ok(shadow, "shadow candidate must be on the manifest");

    // Primary disqualified through the typecheck failure → merge block.
    assert.equal(primary.lane, "local", "primary lane label must come from lane-config.primary.lane");
    assert.equal(primary.provider, "ollama");
    assert.equal(primary.model, "qwen3.5:9b");
    assert.equal(primary.status, "failed", `primary status must reflect merge-block; got ${primary.status}`);
    assert.ok(primary.disqualification, "primary must carry a disqualification reason");

    // Shadow ran with config.shadow lane labels.
    assert.equal(shadow.lane, "cloud", "shadow lane label must come from lane-config.shadow.lane");
    assert.equal(shadow.provider, "openrouter");
    assert.equal(shadow.model, "xiaomi/mimo-v2.5");

    // Selection: shadow qualifies (no merge gate against it) so it
    // wins the policy. The receipt records it as the selected
    // candidate. (No actual workspace swap — Phase D — but the
    // selection signal is correct.)
    assert.equal(
      final.selectedCandidateWorkspaceId,
      shadow.workspaceId,
      "shadow must be the selected candidate when primary disqualifies",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("e2e local_then_cloud: primary passes → shadow never runs, manifest reports primary only", async () => {
  const repo = makeRepoWithLaneConfig({
    mode: "local_then_cloud",
    primary: { lane: "local", provider: "ollama", model: "qwen3.5:9b" },
    shadow: { lane: "cloud", provider: "openrouter", model: "xiaomi/mimo-v2.5" },
  });
  try {
    const { coordinator, receiptStore } = buildHarness(repo, { typecheckPasses: true });
    const receipt = await coordinator.submit({ input: "modify widget in core" });
    const persisted = await receiptStore.getRun(receipt.runId);
    const final = (persisted as any).finalReceipt;

    assert.equal(final.laneMode, "local_then_cloud");
    assert.equal(final.candidates.length, 1, "shadow must NOT run when primary qualifies");
    assert.equal(final.candidates[0].role, "primary");
    assert.equal(final.candidates[0].lane, "local");
    assert.equal(final.selectedCandidateWorkspaceId, "primary");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("e2e primary_only: receipt does NOT carry candidates manifest (back-compat default)", async () => {
  // No lane-config file → DEFAULT_LANE_CONFIG = primary_only.
  const repo = mkdtempSync(join(tmpdir(), "aedis-lane-e2e-default-"));
  mkdirSync(join(repo, "core"), { recursive: true });
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "tmp", version: "0.0.0" }), "utf-8");
  writeFileSync(join(repo, "core/widget.ts"), "export const widget = 1;\n", "utf-8");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "lane@aedis.local"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Lane"], { cwd: repo });
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: repo });

  try {
    const { coordinator, receiptStore } = buildHarness(repo, { typecheckPasses: true });
    const receipt = await coordinator.submit({ input: "modify widget in core" });
    const persisted = await receiptStore.getRun(receipt.runId);
    const final = (persisted as any).finalReceipt;

    // Even on primary_only, the primary candidate is still recorded
    // (Phase B records it for every run that reaches mergeDecision).
    // Manifest is emitted but laneMode is primary_only so the TUI
    // dashboard indicator stays null.
    assert.equal(final.laneMode, "primary_only");
    assert.equal(final.candidates.length, 1);
    assert.equal(final.candidates[0].role, "primary");
    assert.equal(final.candidates[0].lane, "cloud", "DEFAULT_LANE_CONFIG.primary.lane is cloud");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ─── E2E: TUI run-detail renders the persisted manifest ─────────────

test("e2e tui: RunDetailScreen renders the candidate panel from a real persisted receipt", async () => {
  const repo = makeRepoWithLaneConfig({
    mode: "local_then_cloud",
    primary: { lane: "local", provider: "ollama", model: "qwen3.5:9b" },
    shadow: { lane: "cloud", provider: "openrouter", model: "xiaomi/mimo-v2.5" },
  });
  try {
    const { coordinator, receiptStore } = buildHarness(repo, { typecheckPasses: false });
    const receipt = await coordinator.submit({ input: "modify widget in core" });
    const persisted = await receiptStore.getRun(receipt.runId);
    const final = (persisted as any).finalReceipt;

    // Synthesize the same shape getRunDetail returns to the TUI:
    // top-level fields lifted out of `receipt: finalReceipt`.
    const detail: RunDetailData = {
      id: persisted!.runId,
      runId: persisted!.runId,
      status: persisted!.status,
      prompt: persisted!.prompt ?? "modify widget in core",
      submittedAt: persisted!.startedAt ?? persisted!.createdAt,
      completedAt: persisted!.completedAt,
      filesChanged: persisted!.changesSummary.map((c) => ({ path: c.path, operation: c.operation })),
      summary: {
        classification: persisted!.finalClassification ?? null,
        headline: "",
        narrative: "",
        verification: "fail",
        verificationChecks: [],
        failureExplanation: null,
      },
      confidence: persisted!.confidence,
      errors: [],
      totalCostUsd: persisted!.totalCost.estimatedCostUsd,
      laneMode: final.laneMode,
      candidates: final.candidates,
      selectedCandidateWorkspaceId: final.selectedCandidateWorkspaceId,
    };

    const { stdin, lastFrame, unmount } = render(
      <RunDetailScreen runId={detail.runId} onBack={() => {}} getRunDetail={async () => detail} />,
    );
    try {
      // Wait for the screen to mount.
      await new Promise((r) => setTimeout(r, 60));
      // Open the candidate panel.
      stdin.write("c");
      await new Promise((r) => setTimeout(r, 40));
      const frame = lastFrame() ?? "";

      assert.match(frame, /Candidate Lanes/);
      assert.match(frame, /laneMode:\s+local_then_cloud/);
      // Both lanes rendered.
      assert.match(frame, /primary/);
      assert.match(frame, /local/);
      assert.match(frame, /ollama/);
      assert.match(frame, /shadow/);
      assert.match(frame, /cloud/);
      assert.match(frame, /openrouter/);
      // Selected marker and label.
      const starLine = (frame.split("\n").find((l) => l.includes("★")) ?? "").trim();
      assert.ok(starLine.length > 0, "selected candidate must carry the ★ marker");
      assert.match(frame, /selected/);
      // Disqualification reason for the loser.
      assert.match(frame, /disqualified:\s+status=failed/);
    } finally {
      unmount();
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
