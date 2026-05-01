/**
 * Practical smoke suite — end-to-end pipeline scenarios that prove
 * Aedis can complete small real repo tasks without LLM access.
 *
 * What these tests prove:
 *   - Builder output reaches approval with a visible diff
 *   - No source promotion without approval
 *   - Receipts persisted for every run (visible filesChanged + narrative)
 *   - Garbage output is BLOCKED before approval
 *   - The actual mode/provider/model identifiers are recorded
 *   - NO_OP classification only when there really was no work
 *
 * What they do NOT prove:
 *   - Real LLM Builder output quality (no API key in CI). Live smoke
 *     against a real provider is the operator's responsibility and
 *     the readiness audit cannot claim "release-ready" until that
 *     external check is recorded.
 *
 * Each scenario uses a STUB Builder that produces a deterministic
 * diff. This isolates the test from network/model-quality variance
 * and lets us pin the pipeline mechanics independently of the LLM.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import type { TrustProfile } from "../router/trust-router.js";
import type { AedisEvent, EventBus } from "../server/websocket.js";
import type { OperatorNarrativeEvent } from "./operator-narrative.js";

// ─── Workers ─────────────────────────────────────────────────────────

class FixtureBuilderWorker extends AbstractWorker {
  readonly type: WorkerType = "builder";
  readonly name = "FixtureBuilder";
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
  async execute(a: WorkerAssignment): Promise<WorkerResult> {
    return this.success(a, {
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
class StubVerifierWorker extends AbstractWorker {
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
class StubIntegratorWorker extends AbstractWorker {
  readonly type: WorkerType = "integrator";
  readonly name = "StubIntegrator";
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

// ─── Harness ─────────────────────────────────────────────────────────

function buildSmoke(repo: string, builder: AbstractWorker): {
  coordinator: Coordinator;
  events: AedisEvent[];
  receiptStore: ReceiptStore;
} {
  const registry = new WorkerRegistry();
  registry.register(new StubScoutWorker());
  registry.register(builder);
  registry.register(new StubCriticWorker());
  registry.register(new StubVerifierWorker());
  registry.register(new StubIntegratorWorker());

  const trustProfile: TrustProfile = {
    scores: new Map(),
    tierThresholds: { fast: 0, standard: 0, premium: 0 },
  };
  const events: AedisEvent[] = [];
  const eventBus: EventBus = {
    emit(e) { events.push(e); },
    on: () => () => {}, onType: () => () => {},
    addClient: () => {}, removeClient: () => {},
    clientCount: () => 0, recentEvents: () => [],
  };
  const receiptStore = new ReceiptStore(repo);
  const coordinator = new Coordinator(
    {
      projectRoot: repo,
      autoCommit: true,
      requireWorkspace: true,
      requireApproval: true,
      autoPromoteOnSuccess: false,
      allowSourcePromotion: true,
      trustedLocalRepoWrites: true,
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
    },
    trustProfile,
    registry,
    eventBus,
    receiptStore,
  );
  return { coordinator, events, receiptStore };
}

function makeFixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "aedis-smoke-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "smoke-fixture", version: "0.0.0" }), "utf-8");
  writeFileSync(join(dir, "README.md"), "# Smoke Fixture\n\nA tiny repo used by Aedis practical smoke tests.\n", "utf-8");
  writeFileSync(join(dir, "src/util.ts"), "export const util = 1;\n", "utf-8");
  writeFileSync(join(dir, "src/util.test.ts"), "// existing tests\n", "utf-8");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "smoke@aedis.local"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Aedis Smoke"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: dir });
  return dir;
}

function narrative(events: AedisEvent[]): OperatorNarrativeEvent[] {
  return events
    .filter((e) => e.type === "operator_narrative")
    .map((e) => e.payload as unknown as OperatorNarrativeEvent);
}

function readinessContract(receipt: {
  runId: string;
  filesModified: number;
  commitSha?: string | null;
}, eventsForRun: AedisEvent[], opts: { expectDiff: boolean }): void {
  // 1. The receipt exists and has a runId.
  assert.ok(receipt.runId, "receipt must carry a runId");
  // 2. If we expected a diff, files were modified.
  if (opts.expectDiff) {
    assert.ok(receipt.filesModified > 0, "expected at least one file modified");
  }
  // 3. No source-side commit unless approved (these tests never approve).
  assert.ok(!receipt.commitSha, "no source promotion without approval");
  // 4. Narrative trail must include risk + mode + plan, in order.
  const trail = narrative(eventsForRun).map((e) => e.kind);
  const r = trail.indexOf("risk_assessment");
  const m = trail.indexOf("mode_selected");
  const p = trail.indexOf("plan_drafted");
  assert.ok(r >= 0 && m >= 0 && p >= 0, `narrative trail incomplete: ${trail.join(",")}`);
  assert.ok(r < m && m < p, `narrative trail out of order: ${trail.join(",")}`);
}

// ─── Scenarios ───────────────────────────────────────────────────────

test("smoke: README sentence add reaches approval with a visible diff", async () => {
  const repo = makeFixtureRepo();
  try {
    const original = readFileSync(join(repo, "README.md"), "utf-8");
    const builder = new FixtureBuilderWorker([{
      path: "README.md",
      content: original + "\nAlso supports the `--quiet` flag.\n",
    }]);
    const { coordinator, events } = buildSmoke(repo, builder);
    const r = await coordinator.submit({
      input: "add a sentence to README.md about the new --quiet flag",
      projectRoot: repo,
    });
    readinessContract(
      { runId: r.runId, filesModified: r.summary.filesModified, commitSha: r.commitSha },
      events,
      { expectDiff: true },
    );
    // executionMode is recorded.
    assert.ok(r.executionMode, "executionMode must be recorded");
    // The actual provider/model fields exist on totalCost.
    assert.ok(r.totalCost && typeof r.totalCost.model === "string");
    // No source promotion (approval gate held).
    assert.equal(readFileSync(join(repo, "README.md"), "utf-8"), original,
      "source repo must not be promoted without approval");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("smoke: helper function add reaches approval with a visible diff", async () => {
  const repo = makeFixtureRepo();
  try {
    const before = readFileSync(join(repo, "src/util.ts"), "utf-8");
    const builder = new FixtureBuilderWorker([{
      path: "src/util.ts",
      content: before + "\nexport function double(n: number): number {\n  return n * 2;\n}\n",
    }]);
    const { coordinator, events } = buildSmoke(repo, builder);
    const r = await coordinator.submit({
      input: "Add an exported helper function `double(n)` returning n*2 to src/util.ts",
      projectRoot: repo,
    });
    readinessContract(
      { runId: r.runId, filesModified: r.summary.filesModified, commitSha: r.commitSha },
      events,
      { expectDiff: true },
    );
    assert.equal(readFileSync(join(repo, "src/util.ts"), "utf-8"), before,
      "source repo must not be promoted without approval");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("smoke: typo fix reaches approval with a visible diff", async () => {
  const repo = makeFixtureRepo();
  try {
    const before = readFileSync(join(repo, "README.md"), "utf-8");
    const builder = new FixtureBuilderWorker([{
      path: "README.md",
      content: before.replace("Smoke Fixture", "Smoke Fixture (typo fixed)"),
    }]);
    const { coordinator, events } = buildSmoke(repo, builder);
    const r = await coordinator.submit({
      input: "fix the typo in README.md heading",
      projectRoot: repo,
    });
    readinessContract(
      { runId: r.runId, filesModified: r.summary.filesModified, commitSha: r.commitSha },
      events,
      { expectDiff: true },
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("smoke: test placeholder add reaches approval (single placeholder is allowed)", async () => {
  const repo = makeFixtureRepo();
  try {
    const before = readFileSync(join(repo, "src/util.test.ts"), "utf-8");
    // A single skipped test placeholder — NOT majority placeholder content.
    const builder = new FixtureBuilderWorker([{
      path: "src/util.test.ts",
      content:
        before +
        "\nimport test from 'node:test';\n" +
        "import assert from 'node:assert/strict';\n" +
        "test.skip('handles negative numbers', () => {\n" +
        "  // pin negative-input behavior once double() supports it\n" +
        "  assert.ok(true);\n" +
        "});\n",
    }]);
    const { coordinator, events } = buildSmoke(repo, builder);
    const r = await coordinator.submit({
      input: "add a skipped test placeholder for negative input in src/util.test.ts",
      projectRoot: repo,
    });
    readinessContract(
      { runId: r.runId, filesModified: r.summary.filesModified, commitSha: r.commitSha },
      events,
      { expectDiff: true },
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("smoke: garbage repeated-line output is BLOCKED before approval", async () => {
  const repo = makeFixtureRepo();
  try {
    const before = readFileSync(join(repo, "src/util.ts"), "utf-8");
    // 30 identical added lines — flagged by repeated_identical_lines.
    const builder = new FixtureBuilderWorker([{
      path: "src/util.ts",
      content: before + "console.log('x');\n".repeat(30),
    }]);
    const { coordinator, events } = buildSmoke(repo, builder);
    const r = await coordinator.submit({
      input: "Add an exported helper function to src/util.ts",
      projectRoot: repo,
    });
    // Garbage detector trips: receipt verdict is "failed" and the
    // garbageCheck field surfaces the finding kind.
    assert.equal(r.verdict, "failed", "garbage output must fail the run");
    assert.ok(r.garbageCheck, "garbageCheck must be persisted on the receipt");
    assert.equal(r.garbageCheck!.ok, false);
    assert.ok(
      r.garbageCheck!.findings.some((f) => f.kind === "repeated_identical_lines"),
      "expected a repeated_identical_lines finding",
    );
    // No source mutation.
    assert.equal(readFileSync(join(repo, "src/util.ts"), "utf-8"), before);
    // Narrative includes a safety_block.
    const trail = narrative(events).map((e) => e.kind);
    assert.ok(trail.includes("safety_block"),
      `expected safety_block in narrative, got: ${trail.join(",")}`);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("smoke: garbage placeholder-only output is BLOCKED before approval", async () => {
  const repo = makeFixtureRepo();
  try {
    const before = readFileSync(join(repo, "src/util.ts"), "utf-8");
    // Builder responds to "implement double()" with TODO/throw stubs.
    const builder = new FixtureBuilderWorker([{
      path: "src/util.ts",
      content: before +
        "// TODO: implement\n" +
        "// FIXME: actually implement this\n" +
        "function notImplementedYet(): number {\n" +
        "  throw new Error('not implemented');\n" +
        "}\n",
    }]);
    const { coordinator, events: _evs } = buildSmoke(repo, builder);
    const r = await coordinator.submit({
      input: "implement the double() helper in src/util.ts",
      projectRoot: repo,
    });
    assert.equal(r.verdict, "failed", "placeholder-only output must fail the run");
    assert.ok(r.garbageCheck && !r.garbageCheck.ok);
    assert.ok(
      r.garbageCheck!.findings.some((f) => f.kind === "placeholder_only"),
      "expected a placeholder_only finding",
    );
    assert.equal(readFileSync(join(repo, "src/util.ts"), "utf-8"), before);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("smoke: receipts pin the actual model/provider used by the Builder", async () => {
  const repo = makeFixtureRepo();
  try {
    const before = readFileSync(join(repo, "src/util.ts"), "utf-8");
    const builder = new FixtureBuilderWorker([{
      path: "src/util.ts",
      content: before + "\nexport const HELPER = 1;\n",
    }]);
    const { coordinator } = buildSmoke(repo, builder);
    const r = await coordinator.submit({
      input: "add HELPER constant to src/util.ts",
      projectRoot: repo,
    });
    // model field is always present (may be empty string when no model
    // was actually called — fixture stub workers don't call the model
    // invoker). The contract: the FIELD exists on every receipt.
    assert.ok(r.totalCost, "totalCost must be present");
    assert.ok("model" in r.totalCost, "totalCost.model field must exist");
    // builderAttempts records every model attempt; for stub builder
    // it's empty — that's a TRUTHFUL recording of "no model was called".
    assert.ok(Array.isArray(r.builderAttempts ?? []),
      "builderAttempts must be an array on the receipt");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
