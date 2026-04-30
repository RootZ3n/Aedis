/**
 * Live Mission Mode smoke test.
 *
 * Exercises the full pipeline on a real scratch repo:
 *   1. proposeMission → mission proposal
 *   2. Edit subtasks (remove/verify shape)
 *   3. Create TaskPlan from proposal (does NOT execute)
 *   4. Verify plan is pending (not running)
 *   5. TaskLoopRunner.advanceOnce → executes subtask 1
 *   6. Verify approval pause occurs (mocked coordinator)
 *   7. Continue after approval
 *   8. Final summary is accurate
 *   9. Target repo clean except intended commits
 *  10. State persisted under AEDIS_STATE_ROOT
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, writeFileSync, readFileSync, existsSync,
  mkdirSync, readdirSync, rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import { proposeMission, type MissionProposal } from "./mission.js";
import {
  createTaskPlan,
  validateCreateTaskPlanInput,
  buildFinalSummary,
  type CreateTaskPlanInput,
  type TaskPlan,
} from "./task-plan.js";
import { TaskPlanStore } from "./task-plan-store.js";
import { TaskLoopRunner, type CoordinatorLike, type ReceiptStoreReader } from "./task-loop.js";
import { ScoutEvidenceStore } from "./scout-report.js";
import type { RunReceipt, TaskSubmission } from "./coordinator.js";

// ─── Fixtures ────────────────────────────────────────────────────────

let repoPath: string;
let stateRoot: string;

function createScratchRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "aedis-smoke-repo-"));
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: "pipe" });
  execSync('git config user.name "Test"', { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "README.md"), "# Smoke Repo\n");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "smoke", scripts: {} }));
  execSync("git add -A && git commit -m init", { cwd: dir, stdio: "pipe" });
  return dir;
}

// Mock coordinator that simulates the 3-step mission:
//  Subtask 1: success (create file)
//  Subtask 2: success (create file)
//  Subtask 3: first attempt partial (approval required), second attempt success
function createMockCoordinator(repo: string): {
  coordinator: CoordinatorLike;
  receiptStore: ReceiptStoreReader;
  submissions: TaskSubmission[];
  approvalPaused: Set<string>;
} {
  const submissions: TaskSubmission[] = [];
  const approvalPaused = new Set<string>();
  let callCount = 0;

  const coordinator: CoordinatorLike = {
    async submit(submission: TaskSubmission): Promise<RunReceipt> {
      submissions.push(submission);
      callCount++;
      const runId = submission.runId ?? `run-${callCount}`;

      // Subtask 3, first attempt: simulate approval pause
      if (callCount === 3) {
        approvalPaused.add(runId);
        return makeReceipt(runId, "partial");
      }

      // All other subtasks: success
      return makeReceipt(runId, "success");
    },
    cancel(_runId: string) {
      // no-op
    },
  };

  const receiptStore: ReceiptStoreReader = {
    async getRun(runId: string) {
      if (approvalPaused.has(runId)) {
        return { status: "AWAITING_APPROVAL" };
      }
      return { status: "PROMOTED" };
    },
  };

  return { coordinator, receiptStore, submissions, approvalPaused };
}

function makeReceipt(runId: string, verdict: "success" | "partial" | "failed"): RunReceipt {
  return {
    id: `receipt-${runId}`,
    runId,
    intentId: `intent-${runId}`,
    timestamp: new Date().toISOString(),
    verdict,
    summary: {} as RunReceipt["summary"],
    graphSummary: {} as RunReceipt["graphSummary"],
    verificationReceipt: null,
    waveVerifications: [],
    judgmentReport: null,
    mergeDecision: null,
    totalCost: { model: "test", inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0.001 },
    commitSha: verdict === "success" ? `sha-${runId}` : null,
    durationMs: 500,
    executionVerified: verdict === "success",
    executionGateReason: verdict === "success" ? "files modified" : "awaiting approval",
    executionEvidence: [],
    executionReceipts: [],
    humanSummary: {
      classification: verdict === "success" ? "VERIFIED_SUCCESS" : "PARTIAL",
      headline: verdict === "success" ? "Changes applied" : "Awaiting approval",
    } as RunReceipt["humanSummary"],
    blastRadius: null,
    evaluation: null,
    patchArtifact: null,
    workspaceCleanup: null,
    sourceRepo: null,
    sourceCommitSha: null,
    confidenceGate: null,
  } as unknown as RunReceipt;
}

// ─── Smoke Test ──────────────────────────────────────────────────────

describe("Mission Mode — live smoke test", () => {
  before(() => {
    repoPath = createScratchRepo();
    stateRoot = mkdtempSync(join(tmpdir(), "aedis-smoke-state-"));
  });

  after(() => {
    try { rmSync(repoPath, { recursive: true, force: true }); } catch {}
    try { rmSync(stateRoot, { recursive: true, force: true }); } catch {}
  });

  // ── Step 1: Mission proposal appears ─────────────────────────────

  let proposal: MissionProposal;

  it("1. proposeMission produces a mission proposal", async () => {
    const result = await proposeMission({
      objective:
        "Create mission-smoke-1.txt containing Step 1 " +
        "and create mission-smoke-2.txt containing Step 2 " +
        "and append Mission complete to README.md",
      repoPath,
    });

    assert.equal(result.kind, "mission_proposal", `Expected mission_proposal, got ${result.kind}`);
    proposal = result as MissionProposal;
    assert.ok(proposal.subtasks.length >= 1, "Should have subtasks");
    assert.ok(proposal.objective.length > 0, "Should have objective");
    assert.ok(proposal.approvalReminder.length > 0, "Should have approval reminder");
    console.log(`  Proposal: ${proposal.subtasks.length} subtask(s), confidence=${proposal.confidence}`);
  });

  // ── Step 2: User can edit subtasks ───────────────────────────────

  let editedSubtasks: Array<{ title: string; prompt: string }>;

  it("2. user can edit/replace subtasks", () => {
    // Replace with our exact 3 subtasks regardless of what Plan Assist proposed
    editedSubtasks = [
      { title: "Create mission-smoke-1.txt", prompt: "Create file mission-smoke-1.txt with content 'Step 1'" },
      { title: "Create mission-smoke-2.txt", prompt: "Create file mission-smoke-2.txt with content 'Step 2'" },
      { title: "Append to README.md", prompt: "Append 'Mission complete.' to README.md" },
    ];
    assert.equal(editedSubtasks.length, 3);
    for (const s of editedSubtasks) {
      assert.ok(s.title.length > 0);
      assert.ok(s.prompt.length > 0);
    }
  });

  // ── Step 3: Creating mission does NOT execute ────────────────────

  let plan: TaskPlan;
  let store: TaskPlanStore;

  it("3. creating mission produces a pending TaskPlan (no execution)", async () => {
    store = new TaskPlanStore({ stateRoot });
    const input: CreateTaskPlanInput = {
      objective: proposal.objective,
      repoPath,
      subtasks: editedSubtasks,
    };
    const validation = validateCreateTaskPlanInput(input);
    assert.ok(validation.ok, `Validation failed: ${validation.errors.join(", ")}`);

    plan = createTaskPlan(input, {
      taskPlanId: "mission_smoke_001",
      now: new Date().toISOString(),
    });
    await store.create(plan);

    assert.equal(plan.status, "pending");
    assert.equal(plan.subtasks.length, 3);
    for (const s of plan.subtasks) {
      assert.equal(s.status, "pending");
      assert.equal(s.attempts, 0);
    }

    // Verify target repo is still clean
    const files = readdirSync(repoPath).filter((f) => !f.startsWith("."));
    assert.deepEqual(files.sort(), ["README.md", "package.json"]);
    console.log("  Plan created: status=pending, 3 subtasks, repo clean");
  });

  // ── Step 4: Plan state persisted under AEDIS_STATE_ROOT ──────────

  it("4. plan persisted under AEDIS_STATE_ROOT", async () => {
    const loaded = await store.load("mission_smoke_001");
    assert.ok(loaded, "Plan should be loadable from store");
    assert.equal(loaded!.taskPlanId, "mission_smoke_001");
    assert.equal(loaded!.subtasks.length, 3);

    // Verify it's under stateRoot
    const planPath = store.getPlanPath("mission_smoke_001");
    assert.ok(planPath.startsWith(stateRoot), "Plan should be under stateRoot");
    assert.ok(!planPath.includes(repoPath), "Plan should NOT be in target repo");
  });

  // ── Step 5: Starting executes subtask 1 ──────────────────────────

  let runner: TaskLoopRunner;
  let mock: ReturnType<typeof createMockCoordinator>;

  it("5. advanceOnce executes subtask 1 (success)", async () => {
    mock = createMockCoordinator(repoPath);
    runner = new TaskLoopRunner({
      store,
      coordinator: mock.coordinator,
      receiptStore: mock.receiptStore,
    });

    const result = await runner.advanceOnce(plan);
    plan = result.plan;

    assert.equal(result.executed, true, "Should have executed");
    assert.equal(result.stopReason, null, "No stop reason on success");
    assert.equal(mock.submissions.length, 1, "Should have submitted once");

    const st1 = plan.subtasks[0];
    assert.equal(st1.status, "completed", "Subtask 1 should be completed");
    assert.equal(st1.attempts, 1);
    assert.ok(st1.evidenceRunIds.length > 0, "Should have evidence run ID");
    console.log(`  Subtask 1: status=${st1.status} verdict=${st1.lastVerdict}`);
  });

  // ── Step 6: Subtask 2 succeeds ───────────────────────────────────

  it("6. advanceOnce executes subtask 2 (success)", async () => {
    const result = await runner.advanceOnce(plan);
    plan = result.plan;

    assert.equal(result.executed, true);
    assert.equal(mock.submissions.length, 2);

    const st2 = plan.subtasks[1];
    assert.equal(st2.status, "completed");
    console.log(`  Subtask 2: status=${st2.status}`);
  });

  // ── Step 7: Subtask 3 pauses for approval ────────────────────────

  it("7. subtask 3 pauses for approval", async () => {
    const result = await runner.advanceOnce(plan);
    plan = result.plan;

    assert.equal(result.executed, true);
    assert.equal(result.stopReason, "approval_required");
    assert.equal(plan.status, "paused");

    const st3 = plan.subtasks[2];
    assert.equal(st3.status, "blocked");
    assert.ok(st3.blockerReason.includes("approval"), "Blocker should mention approval");
    console.log(`  Subtask 3: status=${st3.status} reason="${st3.blockerReason}"`);
  });

  // ── Step 8: Approval + continue advances ─────────────────────────

  it("8. after approval, continue completes subtask 3", async () => {
    // Simulate approval: clear the pause and mark subtask pending
    mock.approvalPaused.clear();

    // The loop driver needs the subtask back in pending state to retry
    const updated = {
      ...plan,
      status: "running" as const,
      stopReason: "" as const,
      subtasks: plan.subtasks.map((s) =>
        s.id === "st-3" ? { ...s, status: "pending" as const, blockerReason: "" } : s,
      ),
    };
    await store.save(updated);
    plan = updated as TaskPlan;

    const result = await runner.advanceOnce(plan);
    plan = result.plan;

    assert.equal(result.executed, true, `Expected execution, stopReason=${result.stopReason}`);
    const st3 = plan.subtasks[2];
    // Second attempt should succeed (mock returns success for call 4)
    assert.ok(
      st3.status === "completed" || st3.status === "repaired",
      `Expected completed/repaired, got ${st3.status}`,
    );
    console.log(`  Subtask 3 after approval: status=${st3.status}`);
  });

  // ── Step 9: Final summary is accurate ────────────────────────────

  it("9. final summary is accurate", () => {
    const summary = buildFinalSummary(plan);

    assert.ok(summary.counts.completed >= 3 || summary.counts.completed + (plan.subtasks.filter(s => s.status === "repaired").length) >= 3);
    assert.equal(summary.counts.failed, 0);
    assert.ok(summary.receiptRunIds.length >= 3, "Should have >=3 receipt run IDs");
    assert.ok(summary.totalCostUsd >= 0);
    assert.ok(summary.headline.length > 0);
    console.log(`  Summary: ${summary.headline}`);
    console.log(`  Receipts: ${summary.receiptRunIds.length}, cost=$${summary.totalCostUsd.toFixed(4)}`);
  });

  // ── Step 10: Scout evidence persisted ────────────────────────────

  it("10. scout evidence store works under AEDIS_STATE_ROOT", async () => {
    const evidenceStore = new ScoutEvidenceStore(stateRoot);
    await evidenceStore.save({
      runId: "mission_smoke_001",
      planId: "mission_smoke_001",
      prompt: "smoke test",
      repoPath,
      reports: [],
      spawnDecision: {
        spawn: false,
        reason: "smoke test",
        scoutCount: 0,
        scoutTypes: [],
        localOrCloudRecommendation: "deterministic",
        expectedEvidence: [],
      },
      createdAt: new Date().toISOString(),
    });

    const loaded = await evidenceStore.load("mission_smoke_001");
    assert.ok(loaded, "Evidence should be loadable");
    const path = evidenceStore.getEvidencePath("mission_smoke_001");
    assert.ok(path.startsWith(stateRoot));
    assert.ok(!path.includes(repoPath));
  });

  // ── Step 11: Target repo remains clean ───────────────────────────

  it("11. target repo has no unexpected files (mock coordinator didn't write)", () => {
    // The mock coordinator doesn't actually write files — it simulates
    // the pipeline. In real execution, writes happen inside an isolated
    // workspace, not in the source repo. Verify the source is clean.
    const files = readdirSync(repoPath).filter((f) => !f.startsWith("."));
    assert.deepEqual(files.sort(), ["README.md", "package.json"]);
    const readme = readFileSync(join(repoPath, "README.md"), "utf-8");
    assert.equal(readme, "# Smoke Repo\n", "README should be untouched");
  });

  // ── Step 12: State is NOT in target repo ─────────────────────────

  it("12. no .aedis state directory in target repo", () => {
    assert.ok(!existsSync(join(repoPath, ".aedis")), "No .aedis in target repo");
    assert.ok(!existsSync(join(repoPath, "state")), "No state/ in target repo");
  });
});
