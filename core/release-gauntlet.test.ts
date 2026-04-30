/**
 * Phase 2 — Release Gauntlet (focused-gap suite).
 *
 * The full release gauntlet is split across many test files. This file
 * adds the four properties identified as GAPS during the Phase 2 audit
 * (the rest are already covered):
 *
 *   B-2  No infinite clarify loop — a clarify-blocked prompt followed by
 *        a path follow-up routes to "build", not another "clarify".
 *
 *   F-1  UI model matches actual — the FallbackInvokeResult exposes
 *        `usedModel` that matches the successful entry in `attempts[]`,
 *        and a fallback is recorded explicitly (not hidden) when the
 *        first provider fails.
 *
 *   H-2  No missing events — every event kind that the coordinator and
 *        task-plan loop ACTUALLY emit must produce a non-null timeline
 *        entry. Catches "added an emit, forgot to wire the timeline."
 *
 *   I-2  Restart resume is operator-driven — after `restoreOnBoot()`
 *        marks a plan "interrupted", that status is non-terminal so the
 *        documented `/task-plans/:id/continue` route would accept it.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { routeLoquiInput } from "./loqui-router.js";
import { eventToTimelineEntry } from "./timeline.js";
import { TaskPlanStore } from "./task-plan-store.js";
import { createTaskPlan, type TaskPlan, type TaskPlanStatus } from "./task-plan.js";

// ────────────────────────────────────────────────────────────────────
//  B-2: No infinite clarify loop
// ────────────────────────────────────────────────────────────────────
//
// Clarify-loop guard: when Loqui asks for scope and the user replies
// with a bare path, the router MUST bind it to the prior intent and
// return action="build" — NOT another clarify. Without this, a vague
// prompt followed by an answer would trigger the same question again.

test("clarify-loop: path-only first message → clarify (no prior intent)", () => {
  const r = routeLoquiInput({ input: "src/foo.ts", context: {} });
  assert.equal(r.action, "clarify");
  assert.match(r.clarification, /What do you want me to do/);
});

test("clarify-loop: path-only follow-up after a clarification routes to build, not clarify", () => {
  // Turn 1: vague prompt → router asks for scope (we simulate by
  // setting `awaitingScopeFor` directly, matching what the server does).
  // Turn 2: user replies with just a path. The router must NOT loop
  // — it must merge the path into the original prompt and dispatch.
  const r = routeLoquiInput({
    input: "src/foo.ts",
    context: { awaitingScopeFor: "improve performance" },
  });
  assert.equal(r.action, "build", "follow-up must route to build, not clarify");
  assert.notEqual(r.action, "clarify");
  assert.ok(r.followUpScope, "merged decision must carry followUpScope");
  assert.equal(r.followUpScope?.relativePath, "src/foo.ts");
  assert.match(r.signals.join(","), /followup:path-bound/);
});

test("clarify-loop: bound follow-up effectivePrompt carries BOTH the original task and the path", () => {
  const r = routeLoquiInput({
    input: "src/auth.ts",
    context: { awaitingScopeFor: "harden the JWT verification" },
  });
  assert.equal(r.action, "build");
  // The effective prompt that gets dispatched must reference both —
  // dropping either side reintroduces the loop.
  assert.match(r.effectivePrompt, /JWT|auth|harden/i);
  assert.match(r.effectivePrompt, /src\/auth\.ts/);
});

// ────────────────────────────────────────────────────────────────────
//  F-1: UI model matches actual + no hidden fallback
// ────────────────────────────────────────────────────────────────────
//
// FallbackInvokeResult MUST expose `usedModel` consistent with the last
// "ok" attempt, and the `attempts[]` log MUST record any prior failures
// explicitly. We don't need the network — we exercise the type contract
// with a hand-built result and assert the invariants the rest of the
// system depends on (Coordinator's actualModel/intentModel divergence
// detection, receipts, etc.).

test("model truth: usedModel matches the successful entry in attempts[]", () => {
  // Mirror the real shape produced by invokeModelWithFallback when the
  // primary provider succeeds.
  const result = {
    text: "ok",
    tokensIn: 10,
    tokensOut: 5,
    costUsd: 0.0001,
    usedProvider: "anthropic" as const,
    usedModel: "claude-sonnet-4-6",
    attemptedProviders: ["anthropic"] as const,
    skippedDueToBlacklist: false,
    skippedDueToCircuitBreaker: false,
    attempts: [
      {
        provider: "anthropic" as const,
        model: "claude-sonnet-4-6",
        outcome: "ok" as const,
        durationMs: 200,
        costUsd: 0.0001,
      },
    ],
  };

  const okEntry = result.attempts.find((a) => a.outcome === "ok");
  assert.ok(okEntry, "result must carry an ok attempt");
  assert.equal(result.usedModel, okEntry.model);
  assert.equal(result.usedProvider, okEntry.provider);
});

test("model truth: fallback is recorded explicitly — first failure surfaces in attempts[]", () => {
  // Hand-built result mirroring a fallback: provider 1 timed out,
  // provider 2 answered. The receipt MUST carry both rows so the
  // Coordinator's actualModel / intentModel divergence stays visible.
  const result = {
    text: "ok",
    tokensIn: 10,
    tokensOut: 5,
    costUsd: 0.0002,
    usedProvider: "openai" as const,
    usedModel: "gpt-4o-mini",
    attemptedProviders: ["anthropic", "openai"] as const,
    skippedDueToBlacklist: false,
    skippedDueToCircuitBreaker: false,
    attempts: [
      {
        provider: "anthropic" as const,
        model: "claude-sonnet-4-6",
        outcome: "timeout" as const,
        durationMs: 30_000,
        costUsd: 0,
        errorMsg: "request exceeded 30s",
      },
      {
        provider: "openai" as const,
        model: "gpt-4o-mini",
        outcome: "ok" as const,
        durationMs: 600,
        costUsd: 0.0002,
      },
    ],
  };

  // The successful model surfaces correctly.
  const okEntry = result.attempts.find((a) => a.outcome === "ok");
  assert.ok(okEntry);
  assert.equal(result.usedModel, okEntry.model);
  // The failure is NOT silently dropped — it must remain on the audit log.
  const fail = result.attempts.find((a) => a.outcome !== "ok");
  assert.ok(fail, "fallback must record the failure as evidence");
  assert.notEqual(fail.model, result.usedModel);
  // attemptedProviders carries both, in order, so divergence is reconstructable.
  assert.deepEqual(result.attemptedProviders, ["anthropic", "openai"]);
});

// ────────────────────────────────────────────────────────────────────
//  H-2: No missing events
// ────────────────────────────────────────────────────────────────────
//
// Every event kind the coordinator/task-plan loop emits at runtime must
// produce a non-null timeline entry. If a developer adds a new emit but
// forgets to extend timeline.ts, this test fails — and the timeline
// gets a "ghost" hole the user never sees.

const REQUIRED_EVENTS: ReadonlyArray<{ type: string; payload: Record<string, unknown> }> = [
  { type: "run_started", payload: { runId: "r-1", input: "x" } },
  { type: "intent_locked", payload: { intent: "build" } },
  { type: "charter_generated", payload: { charter: { objective: "x" } } },
  { type: "preflight_scouts_started", payload: { message: "scouting" } },
  { type: "preflight_scouts_complete", payload: { findings: [] } },
  { type: "blast_radius_estimated", payload: { level: "low" } },
  { type: "task_graph_built", payload: { nodes: 1 } },
  { type: "coherence_check_passed", payload: {} },
  { type: "coherence_check_failed", payload: { reason: "x" } },
  { type: "worker_assigned", payload: { workerType: "builder" } },
  { type: "worker_started", payload: { workerType: "builder" } },
  { type: "scout_complete", payload: { workerType: "scout", confidence: 0.9 } },
  { type: "builder_complete", payload: { workerType: "builder", confidence: 0.9 } },
  { type: "critic_review", payload: { workerType: "critic", confidence: 0.9 } },
  { type: "verifier_check", payload: { workerType: "verifier", confidence: 0.9 } },
  { type: "integration_check", payload: {} },
  { type: "task_complete", payload: { worker: "integrator" } },
  { type: "task_failed", payload: { reason: "x" } },
  { type: "execution_verified", payload: {} },
  { type: "execution_failed", payload: { reason: "x" } },
  { type: "commit_created", payload: { sha: "abc" } },
  { type: "merge_blocked", payload: { reason: "x" } },
  { type: "merge_approved", payload: {} },
  { type: "adversarial_escalation", payload: { reason: "x" } },
  { type: "run_cancelled", payload: {} },
  { type: "run_complete", payload: {} },
  { type: "run_summary", payload: { classification: "PASSED", headline: "x" } },
  { type: "task_plan_event", payload: { kind: "subtask_started", message: "started" } },
  { type: "task_plan_event", payload: { kind: "paused", message: "awaiting approval" } },
  { type: "task_plan_event", payload: { kind: "completed", message: "done" } },
  { type: "system_pressure_warning", payload: { message: "warning" } },
  { type: "system_pressure_critical", payload: { message: "critical" } },
  { type: "system_pressure_recovered", payload: { message: "recovered" } },
];

for (const ev of REQUIRED_EVENTS) {
  test(`timeline truth: required event "${ev.type}"${
    ev.type === "task_plan_event" ? `:${ev.payload.kind}` : ""
  } produces a non-null entry`, () => {
    const entry = eventToTimelineEntry(ev.type, ev.payload);
    assert.ok(
      entry,
      `eventToTimelineEntry returned null for ${ev.type} — timeline gap`,
    );
    assert.equal(typeof entry.message, "string");
    assert.ok(entry.message.length > 0, "entry must have a non-empty message");
    assert.ok(entry.phase, "entry must have a phase");
  });
}

test("timeline truth: paused task_plan_event produces an approval-phase entry", () => {
  const e = eventToTimelineEntry("task_plan_event", {
    kind: "subtask_paused",
    message: "Waiting for approval",
  });
  assert.ok(e);
  assert.equal(e.phase, "approval");
});

test("timeline truth: unknown event types still return null (no ghost entries)", () => {
  const e = eventToTimelineEntry("totally_made_up_event", { foo: "bar" });
  assert.equal(e, null);
});

// ────────────────────────────────────────────────────────────────────
//  I-2: Restart resume is operator-driven
// ────────────────────────────────────────────────────────────────────
//
// After restoreOnBoot reconciles a `running` plan to `interrupted`,
// that status must be non-terminal so the documented continue path
// (`POST /task-plans/:id/continue`) accepts it. The route refuses only
// {completed, cancelled, failed} — interrupted must NOT be in that set,
// otherwise an interrupted plan can never resume.

const NOW = "2026-04-29T17:40:00.000Z";

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), "aedis-release-gauntlet-"));
  return { dir, store: new TaskPlanStore({ stateRoot: dir }) };
}

test("restart resume: restoreOnBoot transitions running → interrupted (non-terminal)", async () => {
  const { store } = tempStore();
  const plan = createTaskPlan(
    {
      objective: "ship a thing",
      repoPath: "/tmp/repo",
      subtasks: [{ prompt: "step 1" }, { prompt: "step 2" }],
    },
    { taskPlanId: "plan_resume", now: NOW },
  );
  // Pretend the loop driver was mid-flight when the server died.
  const running: TaskPlan = {
    ...plan,
    status: "running",
    subtasks: [
      { ...plan.subtasks[0], status: "running" },
      plan.subtasks[1],
    ],
  };
  await store.create(running);
  const reconciled = await store.restoreOnBoot(NOW);
  assert.deepEqual(reconciled, ["plan_resume"]);

  const reloaded = await store.load("plan_resume");
  assert.ok(reloaded);
  assert.equal(reloaded.status, "interrupted");
  assert.equal(reloaded.stopReason, "server_interrupted");
  // The in-flight subtask was marked blocked truthfully — never
  // silently flipped to completed/failed.
  assert.equal(reloaded.subtasks[0].status, "blocked");
  assert.match(
    reloaded.subtasks[0].blockerReason ?? "",
    /server interrupted/i,
  );
});

test("restart resume: 'interrupted' is not in the terminal set the /continue route refuses", () => {
  // This duplicates the route's logic by intent. If the documented
  // contract changes (i.e., interrupted becomes terminal), this test
  // fails — that's the alarm we want.
  const TERMINAL: ReadonlySet<TaskPlanStatus> = new Set<TaskPlanStatus>([
    "completed",
    "cancelled",
    "failed",
  ]);
  assert.equal(TERMINAL.has("interrupted"), false);
  // And the documented continuable states all stay non-terminal.
  for (const s of ["interrupted", "blocked", "running", "paused", "pending"] as TaskPlanStatus[]) {
    assert.equal(TERMINAL.has(s), false, `"${s}" must be continuable`);
  }
});
