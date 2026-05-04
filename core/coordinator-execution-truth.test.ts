/**
 * Execution Truth Enforcement v1 — coordinator integration regression.
 *
 * Drives the real Coordinator.submit() path with stub workers that
 * return success but produce zero file changes. This is the exact
 * "build capability registry" fake-success scenario the user reported.
 *
 * Before v1, this run would return verdict="success" because nothing
 * explicitly failed. After v1, the execution gate must observe zero
 * evidence and force verdict="failed" with a specific reason.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { Coordinator } from "./coordinator.js";
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

// ─── Stub workers ────────────────────────────────────────────────────

/**
 * Stub builder that always reports success with zero changes. This
 * is the exact failure mode we're closing — a builder that says "ok"
 * without actually writing anything. In the old pipeline this would
 * have flowed through to a "success" verdict. After v1, the
 * execution gate catches it.
 */
class NoOpBuilderWorker extends AbstractWorker {
  readonly type: WorkerType = "builder";
  readonly name = "NoOpBuilder";

  async execute(assignment: WorkerAssignment): Promise<WorkerResult> {
    const output: BuilderOutput = {
      kind: "builder",
      changes: [],
      decisions: [],
      needsCriticReview: false,
    };
    return this.success(assignment, output, {
      cost: this.zeroCost(),
      confidence: 0.9,
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

/**
 * Stub builder that actually writes a file to disk and reports the
 * change in its output. Used to prove the execution gate admits
 * verified runs — the counterpart to NoOpBuilderWorker.
 */
class RealBuilderWorker extends AbstractWorker {
  readonly type: WorkerType = "builder";
  readonly name = "RealBuilder";

  constructor(private readonly writes: readonly { path: string; content: string }[]) {
    super();
  }

  async execute(assignment: WorkerAssignment): Promise<WorkerResult> {
    const { readFile, writeFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const root = assignment.projectRoot ?? process.cwd();

    const changes = [];
    for (const w of this.writes) {
      const abs = resolve(root, w.path);
      const originalContent = await readFile(abs, "utf-8");
      await writeFile(abs, w.content, "utf-8");
      changes.push({ path: w.path, operation: "modify" as const, originalContent, content: w.content });
    }
    const output: BuilderOutput = {
      kind: "builder",
      changes,
      decisions: [],
      needsCriticReview: false,
    };
    return this.success(assignment, output, {
      cost: this.zeroCost(),
      confidence: 0.9,
      touchedFiles: changes.map((c) => ({ path: c.path, operation: c.operation })),
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

class StubScoutWorker extends AbstractWorker {
  readonly type: WorkerType = "scout";
  readonly name = "StubScout";

  async execute(assignment: WorkerAssignment): Promise<WorkerResult> {
    return this.success(
      assignment,
      {
        kind: "scout",
        dependencies: [],
        patterns: [],
        riskAssessment: { level: "low", factors: [], mitigations: [] },
        suggestedApproach: "no-op",
      },
      {
        cost: this.zeroCost(),
        confidence: 0.9,
        touchedFiles: [],
        durationMs: 1,
      },
    );
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

class StubCriticWorker extends AbstractWorker {
  readonly type: WorkerType = "critic";
  readonly name = "StubCritic";

  async execute(assignment: WorkerAssignment): Promise<WorkerResult> {
    return this.success(
      assignment,
      {
        kind: "critic",
        verdict: "approve",
        comments: [],
        suggestedChanges: [],
        intentAlignment: 0.9,
      },
      {
        cost: this.zeroCost(),
        confidence: 0.9,
        touchedFiles: [],
        durationMs: 1,
      },
    );
  }

  async estimateCost(): Promise<CostEntry> {
    return this.zeroCost();
  }

  protected emptyOutput(): WorkerOutput {
    return {
      kind: "critic",
      verdict: "approve",
      comments: [],
      suggestedChanges: [],
      intentAlignment: 1,
    };
  }
}

class StubVerifierWorker extends AbstractWorker {
  readonly type: WorkerType = "verifier";
  readonly name = "StubVerifier";

  async execute(assignment: WorkerAssignment): Promise<WorkerResult> {
    return this.success(
      assignment,
      {
        kind: "verifier",
        testResults: [],
        typeCheckPassed: true,
        lintPassed: true,
        buildPassed: true,
        passed: true,
      },
      {
        cost: this.zeroCost(),
        confidence: 0.9,
        touchedFiles: [],
        durationMs: 1,
      },
    );
  }

  async estimateCost(): Promise<CostEntry> {
    return this.zeroCost();
  }

  protected emptyOutput(): WorkerOutput {
    return {
      kind: "verifier",
      testResults: [],
      typeCheckPassed: true,
      lintPassed: true,
      buildPassed: true,
      passed: true,
    };
  }
}

class StubIntegratorWorker extends AbstractWorker {
  readonly type: WorkerType = "integrator";
  readonly name = "StubIntegrator";

  async execute(assignment: WorkerAssignment): Promise<WorkerResult> {
    // Forward whatever the upstream builder(s) produced so
    // collectChanges doesn't wipe active.changes when it swaps in
    // the integrator's finalChanges tally.
    const finalChanges = [...(assignment.changes ?? [])];
    return this.success(
      assignment,
      {
        kind: "integrator",
        finalChanges,
        conflictsResolved: [],
        coherenceCheck: { passed: true, checks: [] },
        readyToApply: true,
      },
      {
        cost: this.zeroCost(),
        confidence: 0.9,
        touchedFiles: finalChanges.map((c) => ({ path: c.path, operation: c.operation })),
        durationMs: 1,
      },
    );
  }

  async estimateCost(): Promise<CostEntry> {
    return this.zeroCost();
  }

  protected emptyOutput(): WorkerOutput {
    return {
      kind: "integrator",
      finalChanges: [],
      conflictsResolved: [],
      coherenceCheck: { passed: true, checks: [] },
      readyToApply: false,
    };
  }
}

// ─── Test setup helpers ──────────────────────────────────────────────

function buildCoordinatorWithStubs(
  projectRoot: string,
  opts: { builder?: AbstractWorker } = {},
): { coordinator: Coordinator; events: AedisEvent[] } {
  const registry = new WorkerRegistry();
  registry.register(new StubScoutWorker());
  registry.register(opts.builder ?? new NoOpBuilderWorker());
  registry.register(new StubCriticWorker());
  registry.register(new StubVerifierWorker());
  registry.register(new StubIntegratorWorker());

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

  const coordinator = new Coordinator(
    {
      projectRoot,
      autoCommit: false,
      verificationConfig: {
        hooks: [{
          name: "Stub Test Hook",
          stage: "custom-hook",
          kind: "tests",
          async execute() {
            return { passed: true, issues: [], exitCode: 0, durationMs: 1 };
          },
        }],
        requiredChecks: ["tests"],
        minimumConfidence: 0,
      },
    },
    trustProfile,
    registry,
    eventBus,
  );
  return { coordinator, events };
}

function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "aedis-capreg-int-"));
  mkdirSync(join(dir, "core"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "capreg-tmp", version: "0.0.0" }), "utf-8");
  // Pre-create the file the test prompt references. This short-circuits
  // the prompt-normalizer's local-model fallback (which would otherwise
  // try to shell out to ollama and add a 20s timeout to every run of
  // this test). The file content is irrelevant to what the gate checks.
  writeFileSync(join(dir, "core/capability-registry.ts"), "// placeholder\n", "utf-8");
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync(
    "git",
    ["-c", "user.email=aedis@example.invalid", "-c", "user.name=Aedis Test", "commit", "-q", "-m", "baseline"],
    { cwd: dir },
  );
  return dir;
}

// ─── The regression ────────────────────────────────────────────────

test("regression: Coordinator.submit('build capability registry') fails visibly when no files are produced", async () => {
  const dir = makeTempRepo();
  try {
    const { coordinator, events } = buildCoordinatorWithStubs(dir);

    const receipt = await coordinator.submit({
      // Path reference ensures the prompt normalizer short-circuits
      // via promptContainsExistingPath and skips the ollama fallback.
      input: "in core/capability-registry.ts, build capability registry",
      projectRoot: dir,
    });

    // The gate MUST have forced the verdict to failed. Before v1 this
    // would have returned "success" because no individual stage
    // explicitly failed.
    assert.notEqual(receipt.verdict, "success", "a zero-change run must never be success");
    assert.equal(receipt.executionVerified, false, "executionVerified must be false");
    assert.ok(receipt.executionGateReason.length > 0, "gate reason must be populated");
    assert.match(
      receipt.executionGateReason,
      /No-op execution detected|Execution errored|cancelled/,
      `gate reason should explain the failure: ${receipt.executionGateReason}`,
    );

    // The UI must have received an execution_failed event so Lumen
    // can render real state. The old pipeline only emitted
    // run_complete, which the UI used to render as "task complete".
    const executionFailed = events.find((e) => e.type === "execution_failed");
    assert.ok(executionFailed, "coordinator must emit execution_failed before run_complete");
    const executionVerified = events.find((e) => e.type === "execution_verified");
    assert.equal(executionVerified, undefined, "execution_verified must NOT be emitted for a no-op run");

    // run_complete should carry the execution gate's real verdict.
    const runComplete = events.find((e) => e.type === "run_complete");
    assert.ok(runComplete, "run_complete must still fire to close the event stream");
    const runCompletePayload = runComplete!.payload as { verdict?: string; executionVerified?: boolean; executionReason?: string };
    assert.notEqual(runCompletePayload.verdict, "success");
    assert.equal(runCompletePayload.executionVerified, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("positive case: Coordinator.submit() with a builder that actually writes files is execution-verified", async () => {
  const dir = makeTempRepo();
  try {
    const { coordinator, events } = buildCoordinatorWithStubs(dir, {
      builder: new RealBuilderWorker([
        { path: "core/capability-registry.ts", content: "export const CAPABILITIES = {} as const;\n" },
      ]),
    });

    const receipt = await coordinator.submit({
      input: "in core/capability-registry.ts, build capability registry",
      projectRoot: dir,
    });

    assert.equal(receipt.executionVerified, true, "a run that wrote a real file must be verified");
    assert.match(receipt.executionGateReason, /Execution verified/);
    assert.ok(receipt.executionEvidence.some((e) => e.kind === "file_modified"));

    const verifiedEvent = events.find((e) => e.type === "execution_verified");
    assert.ok(verifiedEvent, "execution_verified event must fire for a real run");
    const failedEvent = events.find((e) => e.type === "execution_failed");
    assert.equal(failedEvent, undefined, "execution_failed must NOT fire for a real run");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
