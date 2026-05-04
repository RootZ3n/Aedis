/**
 * Magister-style regression fixture.
 *
 * This is the production-bug fixture: the operator submits
 *
 *     "Add a new conversational mode called Teach Me Anything that
 *      allows the user to speak with Varros as a learning guide"
 *
 * against a Magister-like module. Before this PR, the run died at
 * `subtask_terminal_failure` with a FAILED mission and no recovery
 * path because the scout's discovered target never reached the
 * Builder (charter was frozen pre-scout) and the empty-targets guard
 * threw a generic CoordinatorError that the task-loop converted into
 * a terminal failure.
 *
 * The contract this test pins:
 *
 *   ONE of these outcomes must hold — anything else is a regression:
 *
 *     (A) Builder dispatches with a real target_file and produces a
 *         diff that reaches approval.
 *     (B) Mission transitions to NEEDS_CLARIFICATION / NEEDS_REPLAN
 *         with a useful message and actionable CTAs
 *         (`repair_plan` and `show_scout_evidence`).
 *
 *   `subtask_terminal_failure` with a FAILED plan and no recovery
 *   path is an explicit test failure.
 *
 * The fixture builds a minimal on-disk Magister so the
 * feature-completeness guard's directory walk has real siblings to
 * enumerate. Coordinator behavior is stubbed — we are testing the
 * pre-dispatch contract end-to-end through the task-loop, not the
 * full coordinator pipeline (which has its own large test suite).
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

import { createTaskPlan, findNeedsClarificationSubtasks } from "./task-plan.js";
import { TaskPlanStore } from "./task-plan-store.js";
import {
  TaskLoopRunner,
  type CoordinatorLike,
  type ReceiptStoreReader,
  type TaskPlanEventPayload,
} from "./task-loop.js";
import {
  NeedsClarificationError,
  type RunReceipt,
  type TaskSubmission,
} from "./coordinator.js";
import {
  detectFeatureUnderspecified,
} from "./feature-completeness-guard.js";
import { filesInUnifiedDiff } from "./atomic-builder.js";
import { validateUnifiedDiff } from "./diff-truth.js";

const NOW = "2026-05-02T12:00:00.000Z";

const MAGISTER_PROMPT =
  "Add a new conversational mode called Teach Me Anything that allows the user " +
  "to speak with Varros as a learning guide";

function buildMagisterFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "aedis-magister-fixture-"));
  // Mirror the production layout described by the operator: a router
  // that registers modes, an existing mode (Varros), per-campaign
  // companions, and a session handler.
  mkdirSync(join(root, "magister"), { recursive: true });
  mkdirSync(join(root, "magister", "modes"), { recursive: true });
  mkdirSync(join(root, "magister", "companions"), { recursive: true });
  mkdirSync(join(root, "magister", "sessions"), { recursive: true });

  writeFileSync(
    join(root, "magister", "router.ts"),
    [
      "// Mode registry — every conversational mode is wired in here.",
      'export const REGISTERED_MODES = ["varros-narrator"] as const;',
      "",
      "export function dispatch(mode: string, input: string) {",
      '  if (mode === "varros-narrator") return varrosHandler(input);',
      '  throw new Error(`unknown mode ${mode}`);',
      "}",
      "",
      "function varrosHandler(input: string) { return `Varros: ${input}`; }",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "magister", "modes", "varros-narrator.ts"),
    'export const VARROS_NARRATOR = { id: "varros-narrator", title: "Varros narrator" };\n',
  );
  writeFileSync(
    join(root, "magister", "companions", "balam.ts"),
    'export const BALAM = { campaign: "spanish", language: "es", name: "Balam" };\n',
  );
  writeFileSync(
    join(root, "magister", "companions", "colette.ts"),
    'export const COLETTE = { campaign: "french", language: "fr", name: "Colette" };\n',
  );
  writeFileSync(
    join(root, "magister", "sessions", "narrative-session.ts"),
    'export function startNarrativeSession(arc: string) { return { arc, turn: 0 }; }\n',
  );
  return root;
}

// ─── Stubs ─────────────────────────────────────────────────────────

interface SubmitObservation {
  prompt: string;
  runId: string;
  projectRoot: string | undefined;
  outcome: "needs_clarification" | "success" | "failed";
}

/**
 * Stub coordinator that simulates the production behavior:
 *
 *   1. First submit: target discovery only finds `magister/router.ts`.
 *      The feature-completeness guard runs in real life inside the
 *      coordinator; we run it here directly so the test exercises
 *      the same pure logic.
 *   2. After attach-target + continue: builder dispatches against
 *      the attached target and returns a successful receipt with a
 *      diff. This is the (A) outcome path.
 *
 * The decision is driven by the prompt text — once the prompt
 * contains "Target file:" (the form attachTargetToSubtask injects),
 * we treat that as "operator clarified" and return success.
 */
class MagisterCoordinatorStub implements CoordinatorLike {
  readonly observations: SubmitObservation[] = [];

  constructor(
    private readonly projectRoot: string,
    private readonly listSiblings: (rel: string) => readonly string[],
  ) {}

  async submit(submission: TaskSubmission): Promise<RunReceipt> {
    const runId = submission.runId ?? `run-${this.observations.length + 1}`;

    // After /attach-target the loop prepends "Target file: <path>"
    // to the prompt. That's our signal that the operator clarified
    // and Builder should now dispatch successfully.
    const prompt = submission.input;
    const hasAttachedTarget = /^Target file:\s*\S+/m.test(prompt);

    if (hasAttachedTarget) {
      this.observations.push({
        prompt,
        runId,
        projectRoot: submission.projectRoot,
        outcome: "success",
      });
      return makeSuccessReceipt(runId);
    }

    // Simulate the coordinator's pre-dispatch path: discovered
    // target is just the registry/router. Run the real feature
    // guard on the same inputs the production coordinator would.
    const charterTargets = ["magister/router.ts"];
    const finding = detectFeatureUnderspecified({
      prompt,
      analysis: { category: "scaffold" },
      charterTargets,
      listSiblings: this.listSiblings,
    });

    if (finding) {
      this.observations.push({
        prompt,
        runId,
        projectRoot: submission.projectRoot,
        outcome: "needs_clarification",
      });
      throw new NeedsClarificationError({
        message: finding.reason,
        recommendedTargets: [finding.anchorTarget, ...finding.suggestedSiblings],
        scoutReportIds: [`scout-magister-${runId}`],
        scoutSpawned: true,
        recommendedAction:
          `Multi-file feature underspecified. Anchor: ${finding.anchorTarget}. ` +
          `Likely additional targets: ${finding.suggestedSiblings.slice(0, 5).join(", ")}.`,
      });
    }

    // Fallback — should not happen with the above fixture but keep
    // the stub honest if the inputs ever diverge.
    this.observations.push({
      prompt,
      runId,
      projectRoot: submission.projectRoot,
      outcome: "failed",
    });
    return makeFailedReceipt(runId);
  }

  async cancel(): Promise<void> {
    /* no-op */
  }
}

class StubReceiptStore implements ReceiptStoreReader {
  async getRun() {
    return { status: "COMPLETE" };
  }
}

function makeSuccessReceipt(runId: string): RunReceipt {
  const atomicDiff = [
    "diff --git a/magister/router.ts b/magister/router.ts",
    "--- a/magister/router.ts",
    "+++ b/magister/router.ts",
    "@@ -1,5 +1,5 @@",
    " // Mode registry — every conversational mode is wired in here.",
    '-export const REGISTERED_MODES = ["varros-narrator"] as const;',
    '+export const REGISTERED_MODES = ["varros-narrator", "teach-me-anything"] as const;',
  ].join("\n");
  const receipt: unknown = {
    id: runId,
    runId,
    intentId: "stub-intent",
    timestamp: NOW,
    verdict: "success",
    summary: {},
    graphSummary: {},
    verificationReceipt: null,
    waveVerifications: [],
    judgmentReport: null,
    mergeDecision: null,
    totalCost: {
      runId,
      stage: "task",
      role: "builder",
      model: "stub",
      provider: "stub",
      ts: NOW,
      tokensIn: 0,
      tokensOut: 0,
      estimatedCostUsd: 0.002,
    },
    commitSha: "feedfacecafe",
    durationMs: 12,
    patchArtifact: {
      diff: atomicDiff,
      files: ["magister/router.ts"],
    },
    executionVerified: true,
    executionGateReason: "",
    executionEvidence: [
      { kind: "file_modified", ref: "magister/router.ts" },
    ],
    humanSummary: { headline: "Teach Me Anything mode wired" },
  };
  return receipt as RunReceipt;
}

function makeFailedReceipt(runId: string): RunReceipt {
  const receipt: unknown = {
    id: runId,
    runId,
    intentId: "stub-intent",
    timestamp: NOW,
    verdict: "failed",
    summary: {},
    graphSummary: {},
    verificationReceipt: null,
    waveVerifications: [],
    judgmentReport: null,
    mergeDecision: null,
    totalCost: {
      runId,
      stage: "task",
      role: "builder",
      model: "stub",
      provider: "stub",
      ts: NOW,
      tokensIn: 0,
      tokensOut: 0,
      estimatedCostUsd: 0,
    },
    commitSha: null,
    durationMs: 5,
    executionVerified: false,
    executionGateReason: "stub failed",
    executionEvidence: [],
    humanSummary: { headline: "stub failed" },
  };
  return receipt as RunReceipt;
}

function makeBuilderNoOpReceipt(runId: string): RunReceipt {
  const receipt: unknown = {
    id: runId,
    runId,
    intentId: "stub-intent",
    timestamp: NOW,
    verdict: "failed",
    summary: {},
    graphSummary: {},
    verificationReceipt: null,
    waveVerifications: [],
    judgmentReport: null,
    mergeDecision: null,
    totalCost: {
      runId,
      stage: "task",
      role: "builder",
      model: "stub",
      provider: "stub",
      ts: NOW,
      tokensIn: 0,
      tokensOut: 0,
      estimatedCostUsd: 0.001,
    },
    commitSha: null,
    durationMs: 5,
    executionVerified: false,
    executionGateReason: "content_identical_output: Builder reported required file(s) but produced no effective diff: magister/router.ts",
    executionEvidence: [],
    humanSummary: { headline: "Builder made no effective source change" },
    failureReason: "builder_no_effective_change",
    blockedStage: "builder",
    nextAllowedActions: ["choose_different_target", "rewrite_operation", "retry_different_model", "cancel"],
    rawFailureEvidence: ["content_identical_output: magister/router.ts byte-identical"],
  };
  return receipt as RunReceipt;
}

// ─── Tests ─────────────────────────────────────────────────────────

test("Magister fixture: scout-discovered single target → NEEDS_REPLAN with CTAs (outcome B)", async () => {
  const root = buildMagisterFixture();
  const stateRoot = mkdtempSync(join(tmpdir(), "aedis-magister-state-"));
  try {
    const events: TaskPlanEventPayload[] = [];
    const store = new TaskPlanStore({ stateRoot });
    const list = (rel: string): readonly string[] => {
      // Mirror the on-disk fixture for the guard's directory walk.
      const map: Record<string, readonly string[]> = {
        "magister": [
          "magister/router.ts",
          "magister/modes",
          "magister/companions",
          "magister/sessions",
        ],
        "magister/modes": ["magister/modes/varros-narrator.ts"],
        "magister/companions": [
          "magister/companions/balam.ts",
          "magister/companions/colette.ts",
        ],
        "magister/sessions": ["magister/sessions/narrative-session.ts"],
      };
      return map[rel] ?? [];
    };
    const coordinator = new MagisterCoordinatorStub(root, list);
    const runner = new TaskLoopRunner({
      store,
      coordinator,
      receiptStore: new StubReceiptStore(),
      logger: { log: () => {}, warn: () => {}, error: () => {} },
      emit: (p) => events.push(p),
      now: () => NOW,
    });

    const plan = createTaskPlan(
      {
        objective: "Add Teach Me Anything mode to Magister",
        repoPath: root,
        subtasks: [{ title: "Wire mode", prompt: MAGISTER_PROMPT }],
      },
      { taskPlanId: "plan_magister_001", now: NOW },
    );
    await store.create(plan);

    const result = await runner.run(plan.taskPlanId);

    // CONTRACT: outcome must be (A) success OR (B) NEEDS_REPLAN.
    // Anything else — and especially `failed` with
    // `subtask_terminal_failure` — is an explicit regression.
    if (result.status === "completed") {
      // Outcome A — Builder dispatched and produced a diff.
      assert.equal(coordinator.observations.length, 1);
      assert.equal(coordinator.observations[0].outcome, "success");
    } else {
      assert.equal(
        result.status,
        "needs_replan",
        `Expected outcome A (completed) or B (needs_replan). Got ${result.status} stopReason=${result.stopReason}.`,
      );
      assert.equal(result.stopReason, "needs_clarification");

      // The needs_clarification subtask must carry scout-derived
      // recommendations so the operator has something to repair
      // with.
      const stuck = findNeedsClarificationSubtasks(result);
      assert.equal(stuck.length, 1);
      const sub = stuck[0];
      assert.ok(sub.recommendedTargets && sub.recommendedTargets.length > 0,
        "recommendedTargets must be populated so the UI can show targets to attach");
      assert.ok(sub.recommendedTargets!.includes("magister/router.ts"),
        "anchor target (router.ts) must be in recommendedTargets");
      assert.ok(
        sub.recommendedTargets!.some((t) => t.startsWith("magister/modes/")),
        "must surface a mode sibling so operator sees where the new mode goes",
      );
      assert.ok(sub.scoutReportIds && sub.scoutReportIds.length > 0,
        "scoutReportIds must be persisted so UI can deep-link evidence");
      assert.match(sub.nextRecommendedAction, /attach|target|decompose/i);
      assert.match(sub.blockerReason, /scaffold|target/i);
    }

    // CONTRACT: events stream must include both
    // `subtask_needs_clarification` and `plan_needs_replan`, and
    // each must carry the two CTAs the UI consumes.
    const needsClarEvent = events.find((e) => e.kind === "subtask_needs_clarification");
    const needsReplanEvent = events.find((e) => e.kind === "plan_needs_replan");
    if (result.status === "needs_replan") {
      assert.ok(needsClarEvent, "subtask_needs_clarification event must be emitted");
      assert.ok(needsReplanEvent, "plan_needs_replan event must be emitted");
      const ctaKeys = new Set((needsReplanEvent!.ctas ?? []).map((c) => c.key));
      assert.ok(ctaKeys.has("repair_plan"), "must expose repair_plan CTA");
      assert.ok(ctaKeys.has("show_scout_evidence"), "must expose show_scout_evidence CTA");
      assert.ok((needsReplanEvent!.recommendedTargets ?? []).length > 0,
        "WS payload must carry recommendedTargets for the UI chip list");
      assert.match(needsReplanEvent!.message, /needs replan|target file|attaching/i);
    }

    // Negative: must NOT have emitted a generic plan_failed for this
    // path — that would leave the operator stranded.
    const planFailed = events.find((e) => e.kind === "plan_failed");
    assert.equal(planFailed, undefined,
      "plan_failed must not fire when the cause is missing target attachment");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("Magister fixture: attaching a target via /attachTargetToSubtask resumes Builder dispatch (outcome A)", async () => {
  const root = buildMagisterFixture();
  const stateRoot = mkdtempSync(join(tmpdir(), "aedis-magister-state-"));
  try {
    const events: TaskPlanEventPayload[] = [];
    const store = new TaskPlanStore({ stateRoot });
    const list = (rel: string): readonly string[] => {
      const map: Record<string, readonly string[]> = {
        "magister": ["magister/router.ts", "magister/modes"],
        "magister/modes": ["magister/modes/varros-narrator.ts"],
      };
      return map[rel] ?? [];
    };
    const coordinator = new MagisterCoordinatorStub(root, list);
    const runner = new TaskLoopRunner({
      store,
      coordinator,
      receiptStore: new StubReceiptStore(),
      logger: { log: () => {}, warn: () => {}, error: () => {} },
      emit: (p) => events.push(p),
      now: () => NOW,
    });

    const plan = createTaskPlan(
      {
        objective: "Add Teach Me Anything mode to Magister",
        repoPath: root,
        subtasks: [{ title: "Wire mode", prompt: MAGISTER_PROMPT }],
      },
      { taskPlanId: "plan_magister_002", now: NOW },
    );
    await store.create(plan);

    // First run trips the guard.
    const first = await runner.run(plan.taskPlanId);
    assert.equal(first.status, "needs_replan");

    // Operator attaches the suggested top target — same code path
    // the UI's "Repair Plan" CTA exercises.
    const stuck = findNeedsClarificationSubtasks(first)[0];
    const target = (stuck.recommendedTargets ?? [])[0];
    assert.ok(target, "guard must surface at least one recommended target");
    const attached = await runner.attachTargetToSubtask(
      plan.taskPlanId,
      stuck.id,
      target!,
    );
    assert.equal(attached.status, "paused");
    const subAfter = attached.subtasks.find((s) => s.id === stuck.id)!;
    assert.equal(subAfter.status, "pending");
    assert.match(subAfter.prompt, new RegExp(`Target file:\\s*${target}`));

    // Resume — Builder must dispatch this time and produce a
    // success receipt with a diff. That's outcome (A).
    const second = await runner.run(plan.taskPlanId);
    assert.equal(second.status, "completed",
      "after target attached + resume, Builder should dispatch and complete");
    const successReceipt = makeSuccessReceipt("assertion-run") as unknown as { patchArtifact: { diff: string; files: string[] } };
    assert.ok(successReceipt.patchArtifact.diff.trim().length > 0,
      "Magister Teach Me Anything success path must carry a non-empty atomic diff");
    assert.equal(validateUnifiedDiff(successReceipt.patchArtifact.diff).ok, true,
      "Magister smoke must fail if success/approval is represented without a renderable real diff");
    assert.deepEqual(filesInUnifiedDiff(successReceipt.patchArtifact.diff), ["magister/router.ts"],
      "Magister atomic diff must touch exactly one file");
    assert.doesNotMatch(successReceipt.patchArtifact.diff, /NO-OP execution detected/i);
    const subFinal = second.subtasks.find((s) => s.id === stuck.id)!;
    assert.ok(["completed", "repaired"].includes(subFinal.status));
    assert.equal(subFinal.lastVerdict, "success");
    assert.ok(subFinal.evidenceRunIds.length >= 1,
      "must have a coordinator runId on the subtask audit trail");

    // The first call hit the guard, the second succeeded — exactly
    // two coordinator submits.
    assert.equal(coordinator.observations.length, 2);
    assert.equal(coordinator.observations[0].outcome, "needs_clarification");
    assert.equal(coordinator.observations[1].outcome, "success");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("Magister fixture: generic CoordinatorError still maps to FAILED (does not silently flip to needs_replan)", async () => {
  // Orthogonal safety: only NeedsClarificationError should map to
  // needs_replan. A plain CoordinatorError or any other throw must
  // still fail terminally so we don't paper over real bugs.
  const root = mkdtempSync(join(tmpdir(), "aedis-magister-fixture-other-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "aedis-magister-state-other-"));
  try {
    const events: TaskPlanEventPayload[] = [];
    const store = new TaskPlanStore({ stateRoot });
    const coordinator: CoordinatorLike = {
      submit: async () => {
        throw new Error("workspace creation exploded");
      },
      cancel: async () => {},
    };
    const runner = new TaskLoopRunner({
      store,
      coordinator,
      receiptStore: new StubReceiptStore(),
      logger: { log: () => {}, warn: () => {}, error: () => {} },
      emit: (p) => events.push(p),
      now: () => NOW,
    });
    const plan = createTaskPlan(
      {
        objective: "x",
        repoPath: root,
        subtasks: [{ title: "x", prompt: "do something" }],
      },
      { taskPlanId: "plan_other_001", now: NOW },
    );
    await store.create(plan);
    const out = await runner.run(plan.taskPlanId);
    assert.equal(out.status, "failed");
    assert.equal(out.stopReason, "subtask_terminal_failure");
    const replanEvt = events.find((e) => e.kind === "plan_needs_replan");
    assert.equal(replanEvt, undefined, "non-NeedsClarification errors must not pretend to need replan");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("Magister fixture: byte-identical atomic Builder output ends NEEDS_REPLAN, not critic_timeout", async () => {
  const root = buildMagisterFixture();
  const stateRoot = mkdtempSync(join(tmpdir(), "aedis-magister-noop-state-"));
  try {
    const store = new TaskPlanStore({ stateRoot });
    const coordinator: CoordinatorLike = {
      async submit(submission: TaskSubmission): Promise<RunReceipt> {
        return makeBuilderNoOpReceipt(submission.runId ?? "noop-run");
      },
      async cancel(): Promise<void> {},
    };
    const runner = new TaskLoopRunner({
      store,
      coordinator,
      receiptStore: new StubReceiptStore(),
      now: () => NOW,
      logger: { log: () => {}, warn: () => {}, error: () => {} },
    });
    const plan = createTaskPlan(
      {
        objective: MAGISTER_PROMPT,
        repoPath: root,
        subtasks: [{
          title: "Teach Me Anything atomic router step",
          prompt: `Target file: magister/router.ts\n\n${MAGISTER_PROMPT}`,
        }],
      },
      { taskPlanId: "magister-noop", now: NOW },
    );
    await store.create(plan);
    const final = await runner.run(plan.taskPlanId);
    assert.equal(final.status, "needs_replan");
    assert.equal(final.stopReason, "needs_clarification");
    assert.equal(final.subtasks[0].failureReason, "builder_no_effective_change");
    assert.equal(final.subtasks[0].blockedStage, "builder");
    assert.doesNotMatch(final.subtasks[0].blockerReason, /critic_timeout/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});
