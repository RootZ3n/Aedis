import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Coordinator } from "./coordinator.js";
import { CharterGenerator } from "./charter.js";
import { createIntent } from "./intent.js";
import { createRunState } from "./runstate.js";

// These tests pin down the Phase 4.5 "bugfix test-file stripper" regression
// from Case 1 (run 1efad650). The user explicitly asked for a test in
// core/run-summary.test.ts, charter target extraction picked it up, and the
// stripper deleted the test deliverable before any merge gate could see it.
// User-named test files must never be silently stripped from deliverables.

// ─── userExplicitlyAskedForTests — phrasing coverage ─────────────────

const phrasesThatShouldCount: Array<readonly [string, string]> = [
  ["plural 'tests'", "Add tests for foo"],
  ["legacy 'add tests'", "add tests for the parser"],
  ["singular 'add a test'", "add a test for src/parser.ts"],
  ["singular 'add one test'", "add one test in core/x.test.ts"],
  ["focused singular", "Add one focused test in core/run-summary.test.ts asserting the ratio"],
  ["update + singular", "update the test in core/foo.test.ts to cover edge case"],
  ["write + unit + singular", "write a unit test for the helper"],
  ["create + singular", "create a focused test that fails first"],
  ["plain .test.ts path mention", "Reproduce the issue via core/run-summary.test.ts"],
  [".spec.ts path mention", "Add coverage in src/parser.spec.ts"],
  [".test.tsx path mention", "Edit ui/Button.test.tsx"],
];

for (const [label, prompt] of phrasesThatShouldCount) {
  test(`userExplicitlyAskedForTests: ${label}`, () => {
    const coord = new (Coordinator as any)({ projectRoot: process.cwd() });
    assert.equal(
      coord.userExplicitlyAskedForTests(prompt),
      true,
      `expected true for "${prompt}"`,
    );
  });
}

const phrasesThatShouldNotCount: Array<readonly [string, string]> = [
  ["pure bugfix, no test mention", "Fix the off-by-one in core/parser.ts"],
  ["mentions testing concept but not asking", "This file currently has no test coverage discussion."],
  ["incidental 'tested' word", "Verify the change is tested by the suite"],
];

for (const [label, prompt] of phrasesThatShouldNotCount) {
  test(`userExplicitlyAskedForTests negative: ${label}`, () => {
    const coord = new (Coordinator as any)({ projectRoot: process.cwd() });
    // "tested by the suite" matches \btests?\b but only as part of "tested" —
    // the regex uses \btests?\b which requires word boundary AFTER. "tested"
    // has 'ed' after, so \btests\b doesn't match. Confirm the prompt isn't a
    // false positive.
    const actual = coord.userExplicitlyAskedForTests(prompt);
    assert.equal(actual, false, `expected false for "${prompt}", got ${actual}`);
  });
}

// ─── prepareDeliverablesForGraph — user-named test preservation ──────

function buildActive(opts: {
  projectRoot: string;
  userRequest: string;
  deliverables: Array<{ description: string; type: "modify" | "create"; targetFiles: string[] }>;
}): any {
  const charter = {
    objective: "test",
    successCriteria: [],
    deliverables: opts.deliverables,
    qualityBar: "minimal" as const,
  };
  const intent = createIntent({
    runId: "test-run",
    userRequest: opts.userRequest,
    charter,
    constraints: [],
  });
  // Minimal ChangeSet placeholder. The reviseIntent path inside
  // prepareDeliverablesForGraph reads `invariants` and `sharedInvariants`
  // off this object when filtering changes the deliverable set; the test
  // doesn't care about their contents, only that they exist.
  const changeSet = {
    intent,
    filesInScope: [],
    dependencyRelationships: {},
    invariants: [],
    sharedInvariants: [],
    acceptanceCriteria: [],
    coherenceVerdict: { coherent: true, reason: "test fixture" },
  };
  return {
    intent,
    run: createRunState(intent.id, "test-run"),
    projectRoot: opts.projectRoot,
    sourceRepo: opts.projectRoot,
    normalizedInput: opts.userRequest,
    rejectedCandidates: [],
    userNamedStrippedTargets: [],
    analysis: null,
    waveVerifications: [],
    changes: [],
    workerResults: [],
    cancelled: false,
    cancelledGenerations: new Set<string>(),
    pendingDispatches: new Map(),
    runAbortController: new AbortController(),
    weakOutputRetries: 0,
    memorySuggestions: [],
    workspace: null,
    projectMemory: { recentTaskSummaries: [], substrate: null },
    gatedContext: { relevantFiles: [], recentTaskSummaries: [], language: null, memoryNotes: [], suggestedNextSteps: [] },
    changeSet,
    plan: undefined,
    scopeClassification: null,
    blastRadius: null,
  };
}

function setupRunSummaryFixture(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "aedis-deliv-"));
  mkdirSync(join(dir, "core"), { recursive: true });
  writeFileSync(join(dir, "core/run-summary.ts"), "// stub source\n", "utf-8");
  writeFileSync(join(dir, "core/run-summary.test.ts"), "// stub test\n", "utf-8");
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("prepareDeliverablesForGraph: bugfix prompt keeps user-named test deliverable", () => {
  const { dir, cleanup } = setupRunSummaryFixture();
  try {
    const coord = new (Coordinator as any)({ projectRoot: dir });
    const gen = new CharterGenerator();
    // Real Case 1 prompt shape, trimmed.
    const prompt =
      "Fix the wrong coverage ratio in core/run-summary.ts. " +
      "Add one focused test in core/run-summary.test.ts asserting the rendered numerator differs from the denominator.";
    const analysis = gen.analyzeRequest(prompt);
    // Sanity: charter extraction sees both files.
    assert.ok(analysis.targets.includes("core/run-summary.ts"));
    assert.ok(analysis.targets.includes("core/run-summary.test.ts"));
    const active = buildActive({
      projectRoot: dir,
      userRequest: prompt,
      deliverables: [
        { description: "Modify core/run-summary.ts", type: "modify", targetFiles: ["core/run-summary.ts"] },
        { description: "Modify core/run-summary.test.ts", type: "modify", targetFiles: ["core/run-summary.test.ts"] },
      ],
    });
    active.analysis = analysis;
    const result = coord.prepareDeliverablesForGraph(active, analysis);
    const allTargets = result.flatMap((d: any) => d.targetFiles);
    assert.ok(
      allTargets.includes("core/run-summary.test.ts"),
      `user-named test must survive Phase 4.5; got [${allTargets.join(", ")}]`,
    );
    assert.ok(
      allTargets.includes("core/run-summary.ts"),
      `source target must survive; got [${allTargets.join(", ")}]`,
    );
    assert.equal(
      active.userNamedStrippedTargets.length,
      0,
      `tripwire must stay empty when user-named target was honored; got ${JSON.stringify(active.userNamedStrippedTargets)}`,
    );
  } finally {
    cleanup();
  }
});

test("prepareDeliverablesForGraph: bugfix prompt with direct .test.ts path keeps the test deliverable", () => {
  const { dir, cleanup } = setupRunSummaryFixture();
  try {
    const coord = new (Coordinator as any)({ projectRoot: dir });
    // Phrasing where the only signal of a test ask is the path itself.
    const prompt =
      "The bug is in core/run-summary.ts and the regression should be pinned in core/run-summary.test.ts.";
    const gen = new CharterGenerator();
    const analysis = gen.analyzeRequest(prompt);
    const active = buildActive({
      projectRoot: dir,
      userRequest: prompt,
      deliverables: [
        { description: "Modify core/run-summary.ts", type: "modify", targetFiles: ["core/run-summary.ts"] },
        { description: "Modify core/run-summary.test.ts", type: "modify", targetFiles: ["core/run-summary.test.ts"] },
      ],
    });
    active.analysis = analysis;
    const result = coord.prepareDeliverablesForGraph(active, analysis);
    const allTargets = result.flatMap((d: any) => d.targetFiles);
    assert.ok(
      allTargets.includes("core/run-summary.test.ts"),
      `direct .test.ts path must register as explicit; got [${allTargets.join(", ")}]`,
    );
  } finally {
    cleanup();
  }
});

test("prepareDeliverablesForGraph: 'add a test' phrasing keeps the test deliverable on a bugfix prompt", () => {
  const { dir, cleanup } = setupRunSummaryFixture();
  try {
    const coord = new (Coordinator as any)({ projectRoot: dir });
    const prompt = "Fix the wrong ratio in core/run-summary.ts. Add a test in core/run-summary.test.ts.";
    const gen = new CharterGenerator();
    const analysis = gen.analyzeRequest(prompt);
    const active = buildActive({
      projectRoot: dir,
      userRequest: prompt,
      deliverables: [
        { description: "Modify core/run-summary.ts", type: "modify", targetFiles: ["core/run-summary.ts"] },
        { description: "Modify core/run-summary.test.ts", type: "modify", targetFiles: ["core/run-summary.test.ts"] },
      ],
    });
    active.analysis = analysis;
    const result = coord.prepareDeliverablesForGraph(active, analysis);
    const allTargets = result.flatMap((d: any) => d.targetFiles);
    assert.ok(allTargets.includes("core/run-summary.test.ts"));
  } finally {
    cleanup();
  }
});

test("prepareDeliverablesForGraph: bugfix still strips auto-injected test pair when user did NOT name it", () => {
  // The strip is intentional behavior for narrow bugfixes — it prevents the
  // builder from spending its shot on a phantom test pair when the user is
  // asking for a source fix only. The test asserts the strip path still
  // works for auto-injected (i.e. NOT explicitly mentioned) test files.
  const { dir, cleanup } = setupRunSummaryFixture();
  try {
    const coord = new (Coordinator as any)({ projectRoot: dir });
    // Prompt names ONLY the source file — no test mention at all.
    const prompt = "Fix the off-by-one in core/run-summary.ts.";
    const gen = new CharterGenerator();
    const analysis = gen.analyzeRequest(prompt);
    // Sanity: analysis.targets should NOT include the test file.
    assert.ok(
      !analysis.targets.includes("core/run-summary.test.ts"),
      `prompt without a test mention should not extract the .test.ts target; got ${analysis.targets.join(", ")}`,
    );
    // Hand-craft a charter with an *auto-injected* test deliverable, the way
    // Phase 4 of prepareDeliverablesForGraph would.
    const active = buildActive({
      projectRoot: dir,
      userRequest: prompt,
      deliverables: [
        { description: "Modify core/run-summary.ts", type: "modify", targetFiles: ["core/run-summary.ts"] },
        { description: "Test pairs for changed implementation files", type: "modify", targetFiles: ["core/run-summary.test.ts"] },
      ],
    });
    active.analysis = analysis;
    const result = coord.prepareDeliverablesForGraph(active, analysis);
    const allTargets = result.flatMap((d: any) => d.targetFiles);
    assert.ok(
      allTargets.includes("core/run-summary.ts"),
      `source target must survive`,
    );
    assert.ok(
      !allTargets.includes("core/run-summary.test.ts"),
      `auto-injected test pair must still be stripped on a bugfix; got [${allTargets.join(", ")}]`,
    );
    // The test was NOT user-named, so the tripwire must not fire either.
    assert.equal(active.userNamedStrippedTargets.length, 0);
  } finally {
    cleanup();
  }
});

// ─── Defense-in-depth: tripwire fires when a user-named target is dropped ──

test("userTargetFindings: emits a critical merge finding when userNamedStrippedTargets is non-empty", () => {
  const coord = new (Coordinator as any)({ projectRoot: process.cwd() });
  const findings = coord.userTargetFindings({
    userNamedStrippedTargets: ["core/run-summary.test.ts"],
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "critical");
  assert.equal(findings[0].source, "coordinator");
  assert.equal(findings[0].code, "user-target-stripped");
  assert.match(findings[0].message, /core\/run-summary\.test\.ts/);
});

test("userTargetFindings: empty tripwire produces no findings", () => {
  const coord = new (Coordinator as any)({ projectRoot: process.cwd() });
  const findings = coord.userTargetFindings({ userNamedStrippedTargets: [] });
  assert.equal(findings.length, 0);
});
