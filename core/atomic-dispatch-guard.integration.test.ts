import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { Coordinator, NeedsClarificationError } from "./coordinator.js";
import { ReceiptStore } from "./receipt-store.js";
import { WorkerRegistry } from "../workers/base.js";
import type { TrustProfile } from "../router/trust-router.js";
import type { EventBus } from "../server/websocket.js";
import type { TaskGraphState, TaskNode } from "./task-graph.js";
import type { RequestAnalysis } from "./charter.js";

function makeMagisterRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "aedis-atomic-dispatch-"));
  mkdirSync(join(dir, "magister"), { recursive: true });
  mkdirSync(join(dir, "magister", "modes"), { recursive: true });
  mkdirSync(join(dir, "web", "app", "components"), { recursive: true });
  writeFileSync(
    join(dir, "magister", "router.ts"),
    "export const modes: string[] = [];\n",
    "utf-8",
  );
  writeFileSync(
    join(dir, "magister", "modes", "narrator.ts"),
    "export const narrator = { id: 'narrator' };\n",
    "utf-8",
  );
  writeFileSync(
    join(dir, "web", "app", "components", "MarkdownMessage.tsx"),
    "export const MarkdownMessage = () => null;\n",
    "utf-8",
  );
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "atomic-dispatch", version: "0.0.0" }),
    "utf-8",
  );
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "g@g.local"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "G"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: dir });
  return dir;
}

function makeEventBus(): EventBus {
  return {
    emit: () => {},
    on: () => () => {},
    onType: () => () => {},
    addClient: () => {},
    removeClient: () => {},
    clientCount: () => 0,
    recentEvents: () => [],
  };
}

interface CapturedBuilderDispatch {
  readonly targetFiles: readonly string[];
  readonly atomicFile: string | null;
  readonly label: string;
}

async function captureBuilderDispatch(
  projectRoot: string,
  prompt: string,
): Promise<{ dispatches: CapturedBuilderDispatch[]; error: unknown }> {
  const trustProfile: TrustProfile = {
    scores: new Map(),
    tierThresholds: { fast: 0, standard: 0, premium: 0 },
  };
  const receiptStore = new ReceiptStore(projectRoot);
  const coordinator = new Coordinator(
    { projectRoot, autoCommit: false, requireWorkspace: true },
    trustProfile,
    new WorkerRegistry(),
    makeEventBus(),
    receiptStore,
  );

  // Capture Builder graph nodes the moment buildTaskGraph finishes —
  // before runPreBuildCoherence throws on missing workers and the
  // catch path discards the graph state.
  const dispatches: CapturedBuilderDispatch[] = [];
  const originalBuild = (coordinator as unknown as {
    buildTaskGraph: (active: { graph: TaskGraphState }, analysis: unknown) => void;
  }).buildTaskGraph.bind(coordinator);
  (coordinator as unknown as {
    buildTaskGraph: (active: { graph: TaskGraphState }, analysis: unknown) => void;
  }).buildTaskGraph = function patched(active, analysis) {
    originalBuild(active, analysis);
    for (const node of active.graph.nodes) {
      if (node.workerType !== "builder") continue;
      const meta = node.metadata as { atomicBuilder?: { file: string } } | undefined;
      dispatches.push({
        targetFiles: [...node.targetFiles],
        atomicFile: meta?.atomicBuilder?.file ?? null,
        label: node.label,
      });
    }
  };

  let error: unknown = null;
  try {
    await coordinator.submit({ input: prompt });
  } catch (err) {
    error = err;
  }
  return { dispatches, error };
}

test("Magister fixture: 'register TEACH_ME_ANYTHING in the mode router' dispatches Builder against magister/router.ts", async () => {
  const projectRoot = makeMagisterRepo();
  try {
    const { dispatches, error } = await captureBuilderDispatch(
      projectRoot,
      "Add the first atomic step for a new Teach Me Anything mode — " +
        "register TEACH_ME_ANYTHING identifier in the mode router",
    );

    // The pipeline should produce at least one Builder dispatch — the
    // run will fail downstream on missing workers, but the graph build
    // (which is what we're verifying) must complete.
    assert.ok(
      dispatches.length > 0,
      `expected at least one Builder dispatch; got 0. error=${error instanceof Error ? error.message : String(error)}`,
    );

    // No Builder dispatch may target a web/ component — the bug being
    // fixed had Builder editing web/app/components/MarkdownMessage.tsx
    // for a magister/ task.
    for (const d of dispatches) {
      for (const file of d.targetFiles) {
        assert.ok(
          !file.toLowerCase().startsWith("web/"),
          `Builder dispatch must not target a web/ file; got ${file} (label=${d.label})`,
        );
      }
      if (d.atomicFile) {
        assert.ok(
          !d.atomicFile.toLowerCase().startsWith("web/"),
          `atomicBuilder.file must not be a web/ path; got ${d.atomicFile}`,
        );
      }
    }

    // At least one Builder dispatch must land inside magister/.
    const magisterDispatch = dispatches.find((d) =>
      d.targetFiles.some((f) => f.toLowerCase().startsWith("magister/")),
    );
    assert.ok(
      magisterDispatch,
      `expected at least one Builder dispatch under magister/; got: ${dispatches.map((d) => d.targetFiles.join("|")).join(", ")}`,
    );

    // Print the actual chosen target — answers the user's "show me the
    // target file" requirement when this test is run with --test-reporter=spec.
    const chosen = magisterDispatch.atomicFile ?? magisterDispatch.targetFiles[0];
    console.log(`# Builder dispatch target for Magister fixture: ${chosen}`);
    assert.ok(
      chosen && chosen.toLowerCase().startsWith("magister/"),
      `chosen target must start with magister/; got ${chosen}`,
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("Rehearsal retry dispatch: validateBuilderDispatch fires the same anchor guard on every Builder dispatch", async () => {
  // Repro for the rehearsal-loop hole: the resolveAtomicDispatchTarget
  // guard ran at graph build, but a rehearsal retry re-dispatches the
  // same Builder node without re-validating. validateBuilderDispatch
  // closes that hole — feeding it a node whose targetFiles are not in
  // the discovery pipeline must throw NeedsClarificationError, just
  // like the initial dispatch would.
  const projectRoot = makeMagisterRepo();
  // Create the phantom file on disk so the existence check passes —
  // this isolates the test to the discovery-pipeline check, which is
  // what rehearsal-retry needs to enforce.
  mkdirSync(join(projectRoot, "web", "app", "api", "proxy"), { recursive: true });
  writeFileSync(
    join(projectRoot, "web", "app", "api", "proxy", "route.ts"),
    "export const GET = () => null;\n",
    "utf-8",
  );
  try {
    const trustProfile: TrustProfile = {
      scores: new Map(),
      tierThresholds: { fast: 0, standard: 0, premium: 0 },
    };
    const receiptStore = new ReceiptStore(projectRoot);
    const coordinator = new Coordinator(
      { projectRoot, autoCommit: false, requireWorkspace: true },
      trustProfile,
      new WorkerRegistry(),
      makeEventBus(),
      receiptStore,
    );

    const fakeAnalysis: RequestAnalysis = {
      raw: "Register TEACH_ME_ANYTHING in the mode router",
      category: "feature",
      targets: ["magister/router.ts"],
      scopeEstimate: "small",
      ambiguities: [],
      riskSignals: [],
      lockScope: false,
    } as RequestAnalysis;
    const fakeActive = {
      projectRoot,
      analysis: fakeAnalysis,
      preflightScoutResult: {
        scouted: true,
        reason: "fixture",
        advisoryTargets: ["magister/modes/narrator.ts"],
        advisoryTests: [],
        risks: [],
        scoutReportIds: ["fixture-scout-2"],
        routing: [],
        costUsd: 0,
      },
    };
    // Synthesize a builder node whose targetFiles drifted to a path
    // the discovery pipeline never sanctioned — exactly the rehearsal
    // failure mode (Builder ends up at web/.../route.ts on retry).
    // The file exists on disk (created above) so this isolates the
    // test to the "not in discovery pipeline" rejection path.
    const driftedNode = {
      id: "builder-drift-1",
      workerType: "builder",
      label: "Atomic build: register mode",
      targetFiles: ["web/app/api/proxy/route.ts"],
      status: "ready",
      runTaskId: null,
      metadata: { deliverableType: "modify" },
    } as unknown as TaskNode;

    const validate = (coordinator as unknown as {
      validateBuilderDispatch: (a: unknown, n: TaskNode) => void;
    }).validateBuilderDispatch.bind(coordinator);

    assert.throws(
      () => validate(fakeActive, driftedNode),
      (err: unknown) => {
        if (!(err instanceof NeedsClarificationError)) return false;
        assert.match(
          err.message,
          /not discovered by Scout\/charter/i,
          `expected anchor-guard reason in message; got: ${err.message}`,
        );
        return true;
      },
    );

    // Sanity: a node whose target IS in the discovery pipeline must
    // pass the guard silently — proving the guard is selective, not
    // a blanket reject on every dispatch.
    const goodNode = {
      ...driftedNode,
      id: "builder-good-1",
      targetFiles: ["magister/router.ts"],
    } as unknown as TaskNode;
    assert.doesNotThrow(() => validate(fakeActive, goodNode));

    // Coordinator-injected planner targets, such as existing test
    // pairs, are also valid evidence. This is intentionally narrower
    // than accepting every deliverable target: the path must be present
    // in plannerAuthorizedTargets, which prepareDeliverablesForGraph
    // only populates from deterministic planner rules.
    writeFileSync(
      join(projectRoot, "magister", "router.test.ts"),
      "import './router';\n",
      "utf-8",
    );
    const plannerTargetNode = {
      ...driftedNode,
      id: "builder-planner-target-1",
      targetFiles: ["magister/router.test.ts"],
    } as unknown as TaskNode;
    assert.doesNotThrow(() =>
      validate(
        { ...fakeActive, plannerAuthorizedTargets: ["magister/router.test.ts"] },
        plannerTargetNode,
      ),
    );

    // And a non-builder node must be a no-op even if its targets are
    // bogus — the guard scopes to workerType==="builder".
    const criticNode = {
      ...driftedNode,
      id: "critic-1",
      workerType: "critic",
    } as unknown as TaskNode;
    assert.doesNotThrow(() => validate(fakeActive, criticNode));
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("Builder stage timeout: builderStageTimeoutSec defaults to 300, decoupled from maxStageTimeoutSec", () => {
  // The bug: 180s was the only stage timeout for every worker type;
  // Sonnet-on-complex-tasks routinely exceeded it on the second
  // Builder attempt (rehearsal retry). builderStageTimeoutSec gives
  // Builder its own knob. Default must be 300s; Critic/Verifier stay
  // on the existing maxStageTimeoutSec default.
  const projectRoot = mkdtempSync(join(tmpdir(), "aedis-builder-timeout-"));
  try {
    writeFileSync(join(projectRoot, "package.json"), "{\"name\":\"x\"}");
    const trustProfile: TrustProfile = {
      scores: new Map(),
      tierThresholds: { fast: 0, standard: 0, premium: 0 },
    };
    const receiptStore = new ReceiptStore(projectRoot);
    const coordinator = new Coordinator(
      { projectRoot, autoCommit: false, requireWorkspace: true },
      trustProfile,
      new WorkerRegistry(),
      makeEventBus(),
      receiptStore,
    );

    const cfg = (coordinator as unknown as {
      config: { builderStageTimeoutSec: number; maxStageTimeoutSec: number };
    }).config;
    assert.equal(cfg.builderStageTimeoutSec, 300, "default builderStageTimeoutSec must be 300");
    assert.equal(cfg.maxStageTimeoutSec, 180, "non-Builder stage timeout default must remain 180");
    assert.notEqual(
      cfg.builderStageTimeoutSec,
      cfg.maxStageTimeoutSec,
      "builder timeout must be independent of generic stage timeout",
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("Builder stage timeout: explicit override via CoordinatorConfig is honored", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "aedis-builder-timeout-cfg-"));
  try {
    writeFileSync(join(projectRoot, "package.json"), "{\"name\":\"x\"}");
    const trustProfile: TrustProfile = {
      scores: new Map(),
      tierThresholds: { fast: 0, standard: 0, premium: 0 },
    };
    const receiptStore = new ReceiptStore(projectRoot);
    const coordinator = new Coordinator(
      {
        projectRoot,
        autoCommit: false,
        requireWorkspace: true,
        builderStageTimeoutSec: 420,
      },
      trustProfile,
      new WorkerRegistry(),
      makeEventBus(),
      receiptStore,
    );
    const cfg = (coordinator as unknown as {
      config: { builderStageTimeoutSec: number };
    }).config;
    assert.equal(cfg.builderStageTimeoutSec, 420);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("Phantom Builder dispatch: deliverable target absent from discovery → NeedsClarificationError via the wired guard", async () => {
  // Drives `resolveAtomicDispatchTarget` (private) through a tiny
  // synthetic ActiveRun so the test can pin charter targets and scout
  // advisory to known values without fighting the deterministic
  // scout's broad keyword scoring. Proves: (1) the helper is wired;
  // (2) on a phantom target it throws NeedsClarificationError with a
  // useful message and recommended replacements.
  const projectRoot = makeMagisterRepo();
  try {
    const trustProfile: TrustProfile = {
      scores: new Map(),
      tierThresholds: { fast: 0, standard: 0, premium: 0 },
    };
    const receiptStore = new ReceiptStore(projectRoot);
    const coordinator = new Coordinator(
      { projectRoot, autoCommit: false, requireWorkspace: true },
      trustProfile,
      new WorkerRegistry(),
      makeEventBus(),
      receiptStore,
    );

    const fakeActive = {
      projectRoot,
      preflightScoutResult: {
        scouted: true,
        reason: "fixture",
        advisoryTargets: ["magister/modes/narrator.ts"],
        advisoryTests: [],
        risks: [],
        scoutReportIds: ["fixture-scout-1"],
        routing: [],
        costUsd: 0,
      },
    };
    const fakeAnalysis = {
      raw: "Modify magister/router.ts to register TEACH_ME_ANYTHING",
      category: "feature" as const,
      targets: ["magister/router.ts"],
      scopeEstimate: "small" as const,
      ambiguities: [],
      riskSignals: [],
      lockScope: false,
      keywords: [],
    };
    const phantomDeliverable = {
      description: "Modify web/app/components/MarkdownMessage.tsx",
      targetFiles: ["web/app/components/MarkdownMessage.tsx"] as const,
      type: "modify" as const,
    };

    assert.throws(
      () =>
        (coordinator as unknown as {
          resolveAtomicDispatchTarget: (a: unknown, an: unknown, d: unknown) => string;
        }).resolveAtomicDispatchTarget(fakeActive, fakeAnalysis, phantomDeliverable),
      (err: unknown) => {
        if (!(err instanceof NeedsClarificationError)) return false;
        assert.match(
          err.message,
          /not discovered by Scout\/charter/i,
          `expected guard reason in message; got: ${err.message}`,
        );
        assert.ok(
          err.recommendedTargets.includes("magister/router.ts") ||
            err.recommendedTargets.includes("magister/modes/narrator.ts"),
          `expected recommended targets to include magister/router.ts or magister/modes/narrator.ts; got: ${err.recommendedTargets.join(", ")}`,
        );
        assert.match(err.recommendedAction, /Replace the target/i);
        return true;
      },
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
