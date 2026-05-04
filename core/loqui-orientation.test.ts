import test from "node:test";
import assert from "node:assert/strict";

import {
  buildOrientation,
  isOrientationRequest,
  shouldShowOrientation,
  type OrientationStateSnapshot,
} from "./loqui-orientation.js";

// ─── Fixtures ───────────────────────────────────────────────────────

function snapshotDefault(
  overrides: Partial<OrientationStateSnapshot> = {},
): OrientationStateSnapshot {
  return {
    modelProfile: "default",
    providers: [
      { name: "ollama", label: "Ollama", apiKeyPresent: true, requiresKey: false },
      { name: "openrouter", label: "OpenRouter", apiKeyPresent: true, requiresKey: true },
    ],
    planCount: 0,
    highlightedPlan: null,
    hasActiveTask: false,
    stateRootIsolated: true,
    ...overrides,
  };
}

// ─── Trigger predicate ─────────────────────────────────────────────

test("shouldShowOrientation: first load with no active task → true", () => {
  assert.equal(
    shouldShowOrientation({
      alreadyShownThisSession: false,
      dismissedThisSession: false,
      hasActiveTask: false,
      explicitlyRequested: false,
    }),
    true,
  );
});

test("shouldShowOrientation: never shown during an active task", () => {
  assert.equal(
    shouldShowOrientation({
      alreadyShownThisSession: false,
      dismissedThisSession: false,
      hasActiveTask: true,
      explicitlyRequested: false,
    }),
    false,
    "active task must not be interrupted",
  );
  // Even an explicit request is suppressed while a task is running.
  assert.equal(
    shouldShowOrientation({
      alreadyShownThisSession: false,
      dismissedThisSession: false,
      hasActiveTask: true,
      explicitlyRequested: true,
    }),
    false,
    "explicit request loses to running work",
  );
});

test("shouldShowOrientation: dismissed sticks until explicit request", () => {
  assert.equal(
    shouldShowOrientation({
      alreadyShownThisSession: false,
      dismissedThisSession: true,
      hasActiveTask: false,
      explicitlyRequested: false,
    }),
    false,
  );
  assert.equal(
    shouldShowOrientation({
      alreadyShownThisSession: true,
      dismissedThisSession: true,
      hasActiveTask: false,
      explicitlyRequested: true,
    }),
    true,
    "user explicitly asking 'what does Aedis do?' overrides dismissal",
  );
});

test("shouldShowOrientation: spam guard — already shown this session → false", () => {
  assert.equal(
    shouldShowOrientation({
      alreadyShownThisSession: true,
      dismissedThisSession: false,
      hasActiveTask: false,
      explicitlyRequested: false,
    }),
    false,
  );
});

test("isOrientationRequest: matches plain-language help phrasing", () => {
  for (const phrase of [
    "what does Aedis do?",
    "What is Aedis for?",
    "how do I use aedis",
    "help me get started",
    "help",
    "orientation",
    "onboarding",
    "getting started",
    "what can this do?",
  ]) {
    assert.equal(isOrientationRequest(phrase), true, `should match: ${phrase}`);
  }
});

test("isOrientationRequest: rejects non-orientation text", () => {
  for (const phrase of [
    "build a registry",
    "fix the auth bug",
    "explain why the test is failing",
    "",
    "   ",
    "what files handle auth?",
  ]) {
    assert.equal(isOrientationRequest(phrase), false, `should NOT match: ${phrase}`);
  }
});

// ─── Structure invariants ──────────────────────────────────────────

test("buildOrientation: response always has the four sections", () => {
  const res = buildOrientation(snapshotDefault());
  const { sections } = res;
  for (const key of [
    "whatAedisIs",
    "whatAedisWillDo",
    "whatAedisWillNotDo",
    "whatYouCanDoNext",
  ] as const) {
    assert.ok(Array.isArray(sections[key]), `${key} must be an array`);
    assert.ok(sections[key].length > 0, `${key} must be non-empty`);
    for (const line of sections[key]) {
      assert.equal(typeof line, "string");
      assert.ok(line.trim().length > 0, "lines must be non-empty");
    }
  }
});

test("buildOrientation: every action id is one of the documented ids", () => {
  const allowed = new Set([
    "create-task-plan",
    "view-active-plan",
    "run-local-smoke",
    "open-provider-setup",
  ]);
  for (const snapshot of [
    snapshotDefault(),
    snapshotDefault({ modelProfile: "local-smoke" }),
    snapshotDefault({
      providers: [
        { name: "openrouter", label: "OpenRouter", apiKeyPresent: false, requiresKey: true },
      ],
    }),
    snapshotDefault({
      planCount: 1,
      highlightedPlan: { taskPlanId: "plan_pending_1234567890", status: "pending", objective: "do x" },
    }),
    snapshotDefault({
      planCount: 1,
      highlightedPlan: { taskPlanId: "plan_paused_1234567890", status: "paused", objective: "do x" },
    }),
    snapshotDefault({ hasActiveTask: true }),
  ]) {
    const res = buildOrientation(snapshot);
    for (const a of res.actions) {
      assert.ok(allowed.has(a.id), `action id ${a.id} must be one of the documented ids`);
      assert.ok(a.label.length > 0, "action label required");
      assert.ok(a.hint.length > 0, "action hint required");
    }
  }
});

// ─── Variant dispatch ──────────────────────────────────────────────

test("buildOrientation: fresh user with no plans → variant=no-plans, suggests Create Plan", () => {
  const res = buildOrientation(snapshotDefault());
  assert.equal(res.variant, "no-plans");
  const ids = res.actions.map((a) => a.id);
  assert.ok(ids.includes("create-task-plan"));
});

test("buildOrientation: returning user (terminal plans only, no other issues) → variant=fresh", () => {
  // planCount > 0 but highlightedPlan === null (every plan is
  // completed/failed/cancelled). All other state is healthy. This is
  // the genuine "fallback" branch — falls through every state-driven
  // variant down to the generic first-load tip sheet.
  const res = buildOrientation(snapshotDefault({ planCount: 3, highlightedPlan: null }));
  assert.equal(res.variant, "fresh");
  const ids = res.actions.map((a) => a.id);
  assert.ok(ids.includes("create-task-plan"));
  assert.ok(ids.includes("run-local-smoke"));
});

test("buildOrientation: local-smoke profile → variant=local-smoke, mentions Ollama", () => {
  const res = buildOrientation(snapshotDefault({ modelProfile: "local-smoke" }));
  assert.equal(res.variant, "local-smoke");
  const joined = res.sections.whatAedisWillDo.join(" ").toLowerCase();
  assert.match(joined, /ollama|local/);
  // No-cloud claim should appear in the will-NOT-do list.
  const willNot = res.sections.whatAedisWillNotDo.join(" ").toLowerCase();
  assert.match(willNot, /cloud|openrouter|anthropic/);
});

test("buildOrientation: missing provider key → variant=missing-providers, names the missing provider", () => {
  const res = buildOrientation(
    snapshotDefault({
      providers: [
        { name: "ollama", label: "Ollama", apiKeyPresent: true, requiresKey: false },
        { name: "openrouter", label: "OpenRouter", apiKeyPresent: false, requiresKey: true },
      ],
    }),
  );
  assert.equal(res.variant, "missing-providers");
  assert.match(res.reason, /OpenRouter/);
  const ids = res.actions.map((a) => a.id);
  assert.ok(ids.includes("open-provider-setup"));
  assert.ok(
    ids.includes("run-local-smoke"),
    "missing-providers branch should offer local-smoke as the no-keys escape hatch",
  );
});

test("buildOrientation: missing key under local-smoke is NOT a 'missing providers' branch", () => {
  // local-smoke explicitly forces local providers, so a missing
  // OpenRouter key should not deflect the variant — local-smoke wins.
  const res = buildOrientation(
    snapshotDefault({
      modelProfile: "local-smoke",
      providers: [
        { name: "openrouter", label: "OpenRouter", apiKeyPresent: false, requiresKey: true },
      ],
    }),
  );
  assert.equal(res.variant, "local-smoke");
});

test("buildOrientation: no plans → variant=no-plans, suggests Create Plan", () => {
  const res = buildOrientation(snapshotDefault({ planCount: 0 }));
  assert.equal(res.variant, "no-plans");
  const ids = res.actions.map((a) => a.id);
  assert.ok(ids.includes("create-task-plan"));
});

test("buildOrientation: pending plan → variant=plan-pending, mentions automatic start", () => {
  const res = buildOrientation(
    snapshotDefault({
      planCount: 1,
      highlightedPlan: {
        taskPlanId: "plan_abc1234567",
        status: "pending",
        objective: "Add registry",
      },
    }),
  );
  assert.equal(res.variant, "plan-pending");
  const next = res.sections.whatYouCanDoNext.join(" ");
  assert.match(next, /starts safe work automatically/);
});

test("buildOrientation: paused plan → variant=plan-paused, mentions approval and Continue", () => {
  const res = buildOrientation(
    snapshotDefault({
      planCount: 1,
      highlightedPlan: {
        taskPlanId: "plan_paused_xyz",
        status: "paused",
        objective: "Add registry",
      },
    }),
  );
  assert.equal(res.variant, "plan-paused");
  const next = res.sections.whatYouCanDoNext.join(" ");
  assert.match(next, /approve|approval/i);
  assert.match(next, /Continue/);
});

test("buildOrientation: running plan → variant=plan-running, mentions Cancel", () => {
  const res = buildOrientation(
    snapshotDefault({
      planCount: 1,
      highlightedPlan: {
        taskPlanId: "plan_running",
        status: "running",
        objective: "Add registry",
      },
    }),
  );
  assert.equal(res.variant, "plan-running");
  const next = res.sections.whatYouCanDoNext.join(" ");
  assert.match(next, /Cancel/);
});

test("buildOrientation: active task overrides everything else (no spam during work)", () => {
  // Even when a paused plan is on disk, an active task wins. Orientation
  // must default to informational mode and never suggest a Create or
  // Start action while work is in flight.
  const res = buildOrientation(
    snapshotDefault({
      hasActiveTask: true,
      planCount: 2,
      highlightedPlan: {
        taskPlanId: "plan_paused_abc",
        status: "paused",
        objective: "...",
      },
    }),
  );
  assert.equal(res.variant, "active-task");
  const ids = res.actions.map((a) => a.id);
  assert.ok(!ids.includes("create-task-plan"), "no create-plan during active task");
  assert.ok(!ids.includes("run-local-smoke"), "no smoke-run during active task");
});

test("buildOrientation: stateRootIsolated → adds isolation reassurance line", () => {
  const isolated = buildOrientation(snapshotDefault({ stateRootIsolated: true }));
  const colocated = buildOrientation(snapshotDefault({ stateRootIsolated: false }));
  const isolatedJoined = isolated.sections.whatAedisWillDo.join(" ");
  const colocatedJoined = colocated.sections.whatAedisWillDo.join(" ");
  assert.match(isolatedJoined, /runtime files|outside your project/i);
  assert.doesNotMatch(colocatedJoined, /outside your project/i);
});

test("buildOrientation: deterministic for the same snapshot", () => {
  const a = buildOrientation(snapshotDefault());
  const b = buildOrientation(snapshotDefault());
  assert.deepEqual(a, b);
});
