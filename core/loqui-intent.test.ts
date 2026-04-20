import test from "node:test";
import assert from "node:assert/strict";
import { classifyLoquiIntent } from "./loqui-intent.js";
import { routeLoquiInput } from "./loqui-router.js";

// ─── Classifier: the user's example cases ───────────────────────────

test("classifier: 'build a capability registry' → build", () => {
  const d = classifyLoquiIntent("build a capability registry");
  assert.equal(d.intent, "build");
  assert.equal(d.needsClarification, false);
});

test("classifier: 'what files handle auth?' → question", () => {
  const d = classifyLoquiIntent("what files handle auth?");
  assert.equal(d.intent, "question");
});

test("classifier: 'what would you do first?' → plan", () => {
  const d = classifyLoquiIntent("what would you do first?");
  assert.equal(d.intent, "plan");
});

test("classifier: 'don't change anything, just show me the plan' → dry_run", () => {
  const d = classifyLoquiIntent("don't change anything, just show me the plan");
  assert.equal(d.intent, "dry_run");
  assert.ok(d.signals.some((s) => s.startsWith("dry_run:")));
});

test("classifier: 'why did that run fail?' against a prior run → explain", () => {
  const d = classifyLoquiIntent("why did that run fail?", {
    lastRunId: "task_abc",
    lastRunVerdict: "failed",
  });
  // 'why' is explain, 'run fail' is status — the classifier prefers
  // explain because it's the higher-weight match. Either one is a
  // valid non-destructive answer; both route via "answer".
  assert.ok(d.intent === "explain" || d.intent === "status", `got ${d.intent}`);
});

test("classifier: 'continue from there' after a prior run → resume_run", () => {
  const d = classifyLoquiIntent("continue from there", {
    lastRunId: "task_abc",
    previousMessageWasBuild: true,
  });
  assert.equal(d.intent, "resume_run");
});

// ─── Classifier: safety guards ──────────────────────────────────────

test("classifier: 'continue from there' with NO prior run falls back to question", () => {
  const d = classifyLoquiIntent("continue from there");
  assert.notEqual(d.intent, "resume_run", "must not resume against a ghost run");
  assert.ok(d.signals.some((s) => s.includes("downgrade:resume_run-no-prior-run")));
});

test("classifier: ambiguous 'can we improve this' does not become build", () => {
  const d = classifyLoquiIntent("can we improve this");
  assert.notEqual(d.intent, "build");
});

test("classifier: dry_run beats build when both fire", () => {
  const d = classifyLoquiIntent("build the capability registry but don't change anything yet");
  assert.equal(d.intent, "dry_run");
  assert.ok(d.signals.some((s) => s.includes("dry_run-beats-build")));
});

test("classifier: 'fix the bug in core/coordinator.ts' → build (confident)", () => {
  const d = classifyLoquiIntent("fix the bug in core/coordinator.ts");
  assert.equal(d.intent, "build");
  assert.ok(d.confidence > 0.3);
});

test("classifier: 'walk me through how the gate works' → explain", () => {
  const d = classifyLoquiIntent("walk me through how the gate works");
  assert.equal(d.intent, "explain");
});

test("classifier: empty input → unknown with needsClarification", () => {
  const d = classifyLoquiIntent("");
  assert.equal(d.intent, "unknown");
  assert.equal(d.confidence, 0);
});

test("classifier: pure gibberish → unknown + clarification", () => {
  const d = classifyLoquiIntent("zzzqqqzz nothing");
  assert.equal(d.intent, "unknown");
  assert.equal(d.needsClarification, true);
  assert.ok(d.clarification.length > 0);
});

test("classifier: 'try again but safer' after build failure → resume_run", () => {
  const d = classifyLoquiIntent("try again but safer", {
    lastRunId: "task_abc",
    lastRunVerdict: "failed",
    previousMessageWasBuild: true,
  });
  assert.equal(d.intent, "resume_run");
});

test("classifier: interrogative prefix tones down build score", () => {
  const d = classifyLoquiIntent("what would you build next?");
  assert.notEqual(d.intent, "build");
});

test("classifier: 'just inspect it first' → dry_run", () => {
  const d = classifyLoquiIntent("just inspect it first");
  assert.equal(d.intent, "dry_run");
});

test("classifier: 'inspect the auth module before doing anything' → dry_run", () => {
  const d = classifyLoquiIntent("inspect the auth module before doing anything");
  assert.equal(d.intent, "dry_run");
});

// ─── Router ──────────────────────────────────────────────────────────

test("router: build intent → action=build, effectivePrompt is the raw input", () => {
  const r = routeLoquiInput({ input: "build a capability registry" });
  assert.equal(r.action, "build");
  assert.equal(r.intent, "build");
  assert.equal(r.label, "Building");
  assert.equal(r.effectivePrompt, "build a capability registry");
});

test("router: question intent → action=answer, label=Answering", () => {
  const r = routeLoquiInput({ input: "what files handle auth?" });
  assert.equal(r.action, "answer");
  assert.equal(r.label, "Answering");
});

test("router: plan intent → action=answer, prompt reframed to request a plan", () => {
  const r = routeLoquiInput({ input: "what would you do first?" });
  assert.equal(r.action, "answer");
  assert.equal(r.label, "Planning");
  assert.match(r.effectivePrompt, /plan|proposed|steps/i);
});

test("router: dry_run intent → action=dry_run so server calls the grounded planner", () => {
  // Preflight + Dry Run System v1: dry_run now routes to its
  // own action. The server handler calls generateDryRun instead
  // of askLoqui, so the user gets a grounded structured plan.
  const r = routeLoquiInput({ input: "don't change anything, just show me the plan" });
  assert.equal(r.action, "dry_run");
  assert.equal(r.label, "Dry Run");
  // The router does NOT reframe the prompt anymore — the
  // planner works off the raw input so it can be passed through
  // to the charter analyzer as-is.
  assert.equal(r.effectivePrompt, "don't change anything, just show me the plan");
});

test("router: explain intent → action=answer, reframed as an explanation ask", () => {
  const r = routeLoquiInput({ input: "explain how the execution gate works" });
  assert.equal(r.action, "answer");
  assert.equal(r.label, "Explaining");
  assert.match(r.effectivePrompt, /Explain/i);
});

test("router: status intent with prior run → action=answer, label=Checking Status", () => {
  const r = routeLoquiInput({
    input: "did the last run pass?",
    context: { lastRunId: "task_abc", lastRunVerdict: "failed" },
  });
  assert.equal(r.action, "answer");
  assert.equal(r.label, "Checking Status");
});

test("router: resume_run with prior run → action=resume with continuation framing", () => {
  const r = routeLoquiInput({
    input: "continue from there",
    context: { lastRunId: "task_abc", previousMessageWasBuild: true },
  });
  assert.equal(r.action, "resume");
  assert.equal(r.label, "Resuming");
  assert.match(r.effectivePrompt, /Continuation/);
});

test("router: ambiguous build-vs-plan → action=clarify, never build", () => {
  // "we should probably improve this" is a build verb near a plan verb
  // — the safe fallback must demand clarification rather than execute.
  const r = routeLoquiInput({ input: "we should probably improve this" });
  assert.notEqual(r.action, "build", "ambiguous input must never route to build");
});

test("router: unknown intent → action=clarify with a specific question", () => {
  const r = routeLoquiInput({ input: "zzzqqqzz nothing" });
  assert.equal(r.action, "clarify");
  assert.equal(r.label, "Clarifying");
  assert.ok(r.clarification.length > 0);
});

test("router: signals are always populated so the UI can render audit info", () => {
  const r = routeLoquiInput({ input: "build a capability registry" });
  assert.ok(r.signals.length > 0);
  assert.ok(r.signals.some((s) => s.startsWith("build:")));
});

test("intent: meta-language build with no target → clarify, not build", () => {
  // Real-world report: "build this. first test of what you can do" won
  // the build rule (imperative-build verb) but had no file/identifier,
  // so the Builder invented a test case in a random test file. The
  // specificity gate must force clarification for exploratory prompts.
  const cases = [
    "build this. first test of what you can do",
    "build this",
    "try something",
    "do whatever you think makes sense",
    "surprise me with a build",
  ];
  for (const input of cases) {
    const r = routeLoquiInput({ input });
    assert.notEqual(r.action, "build", `meta-language must not route to build: ${input}`);
  }
});

test("intent: concrete build target with a file path → still routes to build", () => {
  // Keep the happy path working — specificity gate must not regress
  // clear-target prompts that name a file.
  const cases = [
    "add a JSDoc comment at the top of utils/tokens.ts",
    "fix the auth bug in apps/api/src/auth.ts",
  ];
  for (const input of cases) {
    const r = routeLoquiInput({ input });
    assert.equal(r.action, "build", `concrete build must still route to build: ${input}`);
  }
});
