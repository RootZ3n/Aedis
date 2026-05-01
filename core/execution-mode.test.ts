import test from "node:test";
import assert from "node:assert/strict";

import { classifyExecutionMode, type ClassifyExecutionModeInput } from "./execution-mode.js";
import type { ImpactClassification } from "./impact-classifier.js";

const LOW_IMPACT: ImpactClassification = { level: "low", reasons: [] };
const MED_IMPACT: ImpactClassification = { level: "medium", reasons: [] };
const HIGH_IMPACT: ImpactClassification = { level: "high", reasons: ["task & file"] };

function input(overrides: Partial<ClassifyExecutionModeInput> = {}): ClassifyExecutionModeInput {
  return {
    prompt: "fix typo in README",
    charterTargets: ["README.md"],
    riskSignals: [],
    scopeEstimate: "simple",
    impact: LOW_IMPACT,
    ambiguous: false,
    ...overrides,
  };
}

// ─── Fast-path eligibility ───────────────────────────────────────────

test("README typo qualifies for fast_review", () => {
  const r = classifyExecutionMode(input({
    prompt: "Fix typo 'recieve' to 'receive' in README",
    charterTargets: ["README.md"],
  }));
  assert.equal(r.mode, "fast_review");
  assert.equal(r.classification.allowedFastPath, true);
  assert.equal(r.classification.targetType, "doc");
  assert.equal(r.classification.taskCategory, "docs");
  assert.deepEqual(r.skippedStages, ["critic-llm-review", "rehearsal-loop", "integrator"]);
});

test("comment-only edit on a TS file qualifies for fast_review", () => {
  const r = classifyExecutionMode(input({
    prompt: "Add a comment explaining the early-return guard",
    charterTargets: ["src/widget.ts"],
  }));
  assert.equal(r.mode, "fast_review");
  assert.equal(r.classification.taskCategory, "comment");
  assert.equal(r.classification.targetType, "code");
});

test("docs sentence add qualifies for fast_review", () => {
  const r = classifyExecutionMode(input({
    prompt: "Add a sentence to the README about the new --quiet flag",
    charterTargets: ["docs/README.md"],
  }));
  assert.equal(r.mode, "fast_review");
});

// ─── Standard fall-through ───────────────────────────────────────────

test("unrelated bugfix on a TS file falls through to standard_review", () => {
  const r = classifyExecutionMode(input({
    prompt: "Fix off-by-one in widget pagination",
    charterTargets: ["src/widget.ts"],
  }));
  assert.equal(r.mode, "standard_review");
  assert.equal(r.classification.allowedFastPath, false);
  assert.match(r.reason, /Standard review/);
});

test("ambiguous prompt with single doc target falls to standard, not fast", () => {
  const r = classifyExecutionMode(input({
    prompt: "improve",
    charterTargets: ["README.md"],
    ambiguous: true,
  }));
  assert.notEqual(r.mode, "fast_review");
});

// ─── Strict-review forcing ───────────────────────────────────────────

test("multi-file change forces strict_review", () => {
  const r = classifyExecutionMode(input({
    prompt: "fix typo across docs",
    charterTargets: ["README.md", "docs/CONTRIBUTING.md"],
  }));
  assert.equal(r.mode, "strict_review");
  assert.match(r.reason, /multi-file/);
});

test("HIGH impact forces strict_review", () => {
  const r = classifyExecutionMode(input({
    prompt: "fix auth bypass in oauth handler",
    charterTargets: ["src/auth/oauth.ts"],
    impact: HIGH_IMPACT,
  }));
  assert.equal(r.mode, "strict_review");
});

test("package.json target NEVER takes fast_review", () => {
  const r = classifyExecutionMode(input({
    prompt: "fix typo in description field of package.json",
    charterTargets: ["package.json"],
  }));
  assert.equal(r.mode, "strict_review");
  assert.match(r.reason, /sensitive-path/);
});

test("tsconfig.json target NEVER takes fast_review", () => {
  const r = classifyExecutionMode(input({
    prompt: "add a comment in tsconfig",
    charterTargets: ["tsconfig.json"],
  }));
  assert.equal(r.mode, "strict_review");
});

test("auth path NEVER takes fast_review", () => {
  const r = classifyExecutionMode(input({
    prompt: "add a comment to login.ts",
    charterTargets: ["src/auth/login.ts"],
  }));
  assert.equal(r.mode, "strict_review");
});

test(".env file NEVER takes fast_review", () => {
  const r = classifyExecutionMode(input({
    prompt: "fix typo in env example",
    charterTargets: [".env.example"],
  }));
  assert.equal(r.mode, "strict_review");
});

test("test file NEVER takes fast_review", () => {
  const r = classifyExecutionMode(input({
    prompt: "fix comment in test",
    charterTargets: ["src/widget.test.ts"],
  }));
  assert.equal(r.mode, "strict_review");
});

test("migrations directory NEVER takes fast_review", () => {
  const r = classifyExecutionMode(input({
    prompt: "fix comment in migration",
    charterTargets: ["db/migrations/001_init.sql"],
  }));
  assert.equal(r.mode, "strict_review");
});

test(".github workflows NEVER take fast_review", () => {
  const r = classifyExecutionMode(input({
    prompt: "fix typo in CI yaml",
    charterTargets: [".github/workflows/ci.yml"],
  }));
  assert.equal(r.mode, "strict_review");
});

test("dist/build generated paths NEVER take fast_review", () => {
  const r = classifyExecutionMode(input({
    prompt: "fix comment",
    charterTargets: ["dist/index.js"],
  }));
  assert.equal(r.mode, "strict_review");
});

// ─── Prompt-side denylist ────────────────────────────────────────────

test("prompt mentioning auth forces strict_review even on a doc target", () => {
  const r = classifyExecutionMode(input({
    prompt: "rewrite the auth section in README",
    charterTargets: ["README.md"],
  }));
  assert.equal(r.mode, "strict_review");
});

test("prompt mentioning add-test forces strict_review", () => {
  const r = classifyExecutionMode(input({
    prompt: "add a test for the widget edge case",
    charterTargets: ["src/widget.ts"],
  }));
  assert.equal(r.mode, "strict_review");
});

test("prompt mentioning install-dependency forces strict_review", () => {
  const r = classifyExecutionMode(input({
    prompt: "install lodash dependency",
    charterTargets: ["src/util.ts"],
  }));
  assert.equal(r.mode, "strict_review");
});

// ─── Risk signal handling ────────────────────────────────────────────

test("risk-signals present block fast_review but do not solo-escalate to strict", () => {
  // Public-interface or destructive-shell risk signals prevent fast
  // review (they're not "trivial") but they shouldn't push every
  // routine code edit into strict — that would cause approval fatigue.
  // Sensitive paths, multi-file, ambiguity, or high impact remain
  // the strict triggers; risk-signals merely block fast.
  const r = classifyExecutionMode(input({
    prompt: "fix typo in README",
    charterTargets: ["README.md"],
    riskSignals: ["destructive-shell"],
  }));
  assert.notEqual(r.mode, "fast_review");
  assert.equal(r.mode, "standard_review");
});

// ─── Scope estimate handling ─────────────────────────────────────────

test("medium scope blocks fast_review", () => {
  const r = classifyExecutionMode(input({
    prompt: "fix typo in README",
    charterTargets: ["README.md"],
    scopeEstimate: "medium",
  }));
  // Doc + medium scope: not strict-forced, but not fast-eligible either.
  // Falls through to standard_review.
  assert.equal(r.mode, "standard_review");
});

// ─── Operator override ───────────────────────────────────────────────

test("operator override always wins (fast → fast)", () => {
  const r = classifyExecutionMode(input({
    prompt: "rewrite auth flow",
    charterTargets: ["src/auth/login.ts"],
    impact: HIGH_IMPACT,
    override: "fast_review",
  }));
  assert.equal(r.mode, "fast_review");
  assert.equal(r.reasonCode, "operator-override");
});

test("operator override always wins (standard → strict)", () => {
  const r = classifyExecutionMode(input({
    prompt: "fix typo",
    charterTargets: ["README.md"],
    override: "strict_review",
  }));
  assert.equal(r.mode, "strict_review");
  assert.equal(r.reasonCode, "operator-override");
});

// ─── Default conservatism ────────────────────────────────────────────

test("unknown target type falls to standard_review", () => {
  const r = classifyExecutionMode(input({
    prompt: "fix typo",
    charterTargets: ["something.weird"],
  }));
  // Not in doc allowlist, not in never-fast denylist → not eligible for fast.
  // Doesn't hit strict_review forcing rules either.
  assert.equal(r.mode, "standard_review");
});

test("empty charterTargets falls to standard_review (cannot prove single-file)", () => {
  const r = classifyExecutionMode(input({
    prompt: "fix typo",
    charterTargets: [],
  }));
  assert.equal(r.mode, "standard_review");
});

// ─── Reason text quality ─────────────────────────────────────────────

test("strict reason lists every contributing factor", () => {
  const r = classifyExecutionMode(input({
    prompt: "fix typo",
    charterTargets: ["src/auth/login.ts", "package.json"],
    impact: HIGH_IMPACT,
  }));
  assert.equal(r.mode, "strict_review");
  // factors should include impact, multi-file, sensitive-path, etc.
  assert.ok(r.factors.some((f) => f.includes("impact:high")));
  assert.ok(r.factors.some((f) => f.includes("multi-file")));
  assert.ok(r.factors.some((f) => f.includes("sensitive-path")));
});
