import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Coordinator } from "./coordinator.js";
import { CharterGenerator } from "./charter.js";
import { createIntent } from "./intent.js";
import { createRunState } from "./runstate.js";
import { prepareTargetsForPrompt } from "./target-discovery.js";
import { createChangeSet } from "./change-set.js";

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
  ["add/update focused", "add/update a focused test for the formatter"],
  ["write + unit + singular", "write a unit test for the helper"],
  ["create + singular", "create a focused test that fails first"],
  ["implement singular", "implement a test for the retry path"],
  ["test coverage", "add test coverage for the scheduler"],
  ["spec file", "update the spec file for the parser"],
  ["write spec", "write a spec for the parser"],
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

function setupFooFixture(opts: { includeSpec?: boolean; includeTest?: boolean } = {}): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "aedis-deliv-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src/foo.ts"), "export const foo = 1;\n", "utf-8");
  if (opts.includeTest ?? true) {
    writeFileSync(join(dir, "src/foo.test.ts"), "import './foo';\n", "utf-8");
  }
  if (opts.includeSpec) {
    writeFileSync(join(dir, "src/foo.spec.ts"), "import './foo';\n", "utf-8");
  }
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function prepareTargets(opts: {
  dir: string;
  prompt: string;
  deliverables: Array<{ description: string; type: "modify" | "create"; targetFiles: string[] }>;
}): { targets: string[]; active: any } {
  const coord = new (Coordinator as any)({ projectRoot: opts.dir });
  const gen = new CharterGenerator();
  const analysis = gen.analyzeRequest(opts.prompt);
  const active = buildActive({
    projectRoot: opts.dir,
    userRequest: opts.prompt,
    deliverables: opts.deliverables,
  });
  active.analysis = analysis;
  const result = coord.prepareDeliverablesForGraph(active, analysis);
  return { targets: result.flatMap((d: any) => d.targetFiles), active };
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

test("prepareDeliverablesForGraph: 'fix src/foo.test.ts' keeps test deliverable", () => {
  const { dir, cleanup } = setupFooFixture();
  try {
    const { targets, active } = prepareTargets({
      dir,
      prompt: "fix src/foo.test.ts",
      deliverables: [
        { description: "Modify src/foo.test.ts", type: "modify", targetFiles: ["src/foo.test.ts"] },
      ],
    });
    assert.ok(targets.includes("src/foo.test.ts"), `expected test target to survive; got [${targets.join(", ")}]`);
    assert.equal(active.userNamedStrippedTargets.length, 0);
  } finally {
    cleanup();
  }
});

test("prepareDeliverablesForGraph: 'fix the failing test in src/foo.spec.ts' keeps test deliverable", () => {
  const { dir, cleanup } = setupFooFixture({ includeSpec: true });
  try {
    const { targets, active } = prepareTargets({
      dir,
      prompt: "fix the failing test in src/foo.spec.ts",
      deliverables: [
        { description: "Modify src/foo.spec.ts", type: "modify", targetFiles: ["src/foo.spec.ts"] },
      ],
    });
    assert.ok(targets.includes("src/foo.spec.ts"), `expected spec target to survive; got [${targets.join(", ")}]`);
    assert.equal(active.userNamedStrippedTargets.length, 0);
  } finally {
    cleanup();
  }
});

test("prepareDeliverablesForGraph: 'fix the bug and update src/foo.test.ts' keeps test deliverable", () => {
  const { dir, cleanup } = setupFooFixture();
  try {
    const { targets, active } = prepareTargets({
      dir,
      prompt: "fix the bug and update src/foo.test.ts",
      deliverables: [
        { description: "Modify src/foo.test.ts", type: "modify", targetFiles: ["src/foo.test.ts"] },
      ],
    });
    assert.ok(targets.includes("src/foo.test.ts"), `expected test target to survive; got [${targets.join(", ")}]`);
    assert.equal(active.userNamedStrippedTargets.length, 0);
  } finally {
    cleanup();
  }
});

test("prepareDeliverablesForGraph: 'fix src/foo.ts and src/foo.test.ts' keeps both deliverables", () => {
  const { dir, cleanup } = setupFooFixture();
  try {
    const { targets, active } = prepareTargets({
      dir,
      prompt: "fix src/foo.ts and src/foo.test.ts",
      deliverables: [
        { description: "Modify src/foo.ts", type: "modify", targetFiles: ["src/foo.ts"] },
        { description: "Modify src/foo.test.ts", type: "modify", targetFiles: ["src/foo.test.ts"] },
      ],
    });
    assert.ok(targets.includes("src/foo.ts"), `expected source target to survive; got [${targets.join(", ")}]`);
    assert.ok(targets.includes("src/foo.test.ts"), `expected test target to survive; got [${targets.join(", ")}]`);
    assert.equal(active.userNamedStrippedTargets.length, 0);
  } finally {
    cleanup();
  }
});

test("prepareDeliverablesForGraph: explicit nonexistent test file with authoring intent is kept for creation", () => {
  const { dir, cleanup } = setupFooFixture({ includeTest: false });
  try {
    const { targets, active } = prepareTargets({
      dir,
      prompt: "Fix src/foo.ts and add one focused test in src/foo.test.ts",
      deliverables: [
        { description: "Modify src/foo.ts", type: "modify", targetFiles: ["src/foo.ts"] },
        { description: "Create src/foo.test.ts", type: "create", targetFiles: ["src/foo.test.ts"] },
      ],
    });
    assert.ok(targets.includes("src/foo.ts"), `expected source target to survive; got [${targets.join(", ")}]`);
    assert.ok(targets.includes("src/foo.test.ts"), `expected nonexistent explicit test target to be kept for creation; got [${targets.join(", ")}]`);
    assert.equal(active.userNamedStrippedTargets.length, 0);
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

test("prepareDeliverablesForGraph: stripping a user-named required deliverable produces blocker signal", () => {
  const { dir, cleanup } = setupFooFixture();
  try {
    const coord = new (Coordinator as any)({ projectRoot: dir });
    const gen = new CharterGenerator();
    const prompt = "fix src/foo.ts and src/foo.test.ts";
    const analysis = gen.analyzeRequest(prompt);
    const active = buildActive({
      projectRoot: dir,
      userRequest: prompt,
      deliverables: [
        { description: "Modify src/foo.ts", type: "modify", targetFiles: ["src/foo.ts"] },
      ],
    });
    active.analysis = analysis;
    coord.prepareDeliverablesForGraph(active, analysis);
    const findings = coord.userTargetFindings(active);
    assert.deepEqual(active.userNamedStrippedTargets, ["src/foo.test.ts"]);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "critical");
    assert.equal(findings[0].code, "user-target-stripped");
    assert.match(findings[0].message, /src\/foo\.test\.ts/);
  } finally {
    cleanup();
  }
});

test("userTargetFindings: empty tripwire produces no findings", () => {
  const coord = new (Coordinator as any)({ projectRoot: process.cwd() });
  const findings = coord.userTargetFindings({ userNamedStrippedTargets: [] });
  assert.equal(findings.length, 0);
});

// ─── burn-in-09: explicit creation target survives every planning stage ─────
// The burn-in-09 prompt asks Aedis to modify core/retry-utils.ts AND create a
// new core/retry-utils.test.ts under a "do not touch any other file" scope
// lock. The test file does NOT exist on disk. Past failures dropped the test
// file at one stage or another (target-discovery rejecting a non-existent
// path, charter under-generating deliverables, scope-lock allowlist excluding
// it, change-set classifying it as optional, etc.) — leaving the run with
// only the source file changed and AWAITING_APPROVAL with filesChanged=1.
// Pin the invariant: every planning stage must keep the test file as a
// required mutation target.

const BURN_IN_09_PROMPT =
  "In core/retry-utils.ts, add a small exported function " +
  "'clampDelay(delayMs: number, maxMs: number): number' that returns " +
  "Math.min(delayMs, maxMs). Then create core/retry-utils.test.ts " +
  "with three focused tests for clampDelay: (1) returns the delay " +
  "when below max, (2) returns max when delay exceeds max, (3) returns " +
  "max when delay equals max. After making the changes, run: " +
  "npm run security:secrets, npm test, npm run build, npx tsc --noEmit. " +
  "If any command fails, inspect the output, fix the issue, and rerun " +
  "the failing command. Only modify core/retry-utils.ts and " +
  "core/retry-utils.test.ts — do not touch any other file.";

function setupBurnIn09Repo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "aedis-burn-in-09-"));
  mkdirSync(join(dir, "core"), { recursive: true });
  // Source exists; test file intentionally does NOT exist — it must be
  // created by the run.
  writeFileSync(
    join(dir, "core/retry-utils.ts"),
    "export function delay(ms: number) { return ms; }\n",
    "utf-8",
  );
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("burn-in-09: charter produces both deliverables and locks scope to both files", () => {
  const { dir, cleanup } = setupBurnIn09Repo();
  try {
    const gen = new CharterGenerator();
    const baseAnalysis = gen.analyzeRequest(BURN_IN_09_PROMPT);
    const prepared = prepareTargetsForPrompt({
      projectRoot: dir,
      prompt: BURN_IN_09_PROMPT,
      analysis: baseAnalysis,
    });
    const analysis = {
      ...baseAnalysis,
      targets:
        prepared.targets.length > 0
          ? [...prepared.targets]
          : [...baseAnalysis.targets],
    };
    const charter = gen.generateCharter(analysis);

    const deliverableTargets = charter.deliverables.flatMap((d) => [...d.targetFiles]);
    assert.ok(
      deliverableTargets.includes("core/retry-utils.ts"),
      `source must be a deliverable; got [${deliverableTargets.join(", ")}]`,
    );
    assert.ok(
      deliverableTargets.includes("core/retry-utils.test.ts"),
      `explicit creation target must be a deliverable; got [${deliverableTargets.join(", ")}]`,
    );

    assert.ok(charter.scopeLock, "scopeLock must be set when prompt locks scope");
    assert.deepEqual(
      [...(charter.scopeLock?.allowedFiles ?? [])].sort(),
      ["core/retry-utils.test.ts", "core/retry-utils.ts"],
      "scopeLock.allowedFiles must include both explicit targets",
    );
  } finally {
    cleanup();
  }
});

test("burn-in-09: prepareDeliverablesForGraph keeps the explicit creation target end-to-end", () => {
  const { dir, cleanup } = setupBurnIn09Repo();
  try {
    const gen = new CharterGenerator();
    const baseAnalysis = gen.analyzeRequest(BURN_IN_09_PROMPT);
    const prepared = prepareTargetsForPrompt({
      projectRoot: dir,
      prompt: BURN_IN_09_PROMPT,
      analysis: baseAnalysis,
    });
    const analysis = {
      ...baseAnalysis,
      targets:
        prepared.targets.length > 0
          ? [...prepared.targets]
          : [...baseAnalysis.targets],
    };
    const charter = gen.generateCharter(analysis);
    const intent = createIntent({
      runId: "burn-in-09-run",
      userRequest: BURN_IN_09_PROMPT,
      charter,
      constraints: [],
    });
    const allFiles = charter.deliverables.flatMap((d) => [...d.targetFiles]);
    const changeSet = createChangeSet(intent, allFiles, null, dir);

    const coord = new (Coordinator as any)({ projectRoot: dir });
    const active: any = {
      intent,
      run: createRunState(intent.id, "burn-in-09-run"),
      projectRoot: dir,
      sourceRepo: dir,
      normalizedInput: BURN_IN_09_PROMPT,
      rejectedCandidates: [],
      userNamedStrippedTargets: [],
      analysis,
      changeSet,
      plan: undefined,
      changes: [],
      workerResults: [],
      cancelled: false,
    };
    const result = coord.prepareDeliverablesForGraph(active, analysis);
    const allTargets = result.flatMap((d: any) => d.targetFiles);

    assert.ok(
      allTargets.includes("core/retry-utils.ts"),
      `source target must survive prepareDeliverablesForGraph; got [${allTargets.join(", ")}]`,
    );
    assert.ok(
      allTargets.includes("core/retry-utils.test.ts"),
      `explicit creation target must survive prepareDeliverablesForGraph; got [${allTargets.join(", ")}]`,
    );
    assert.equal(
      active.userNamedStrippedTargets.length,
      0,
      `tripwire must stay empty; got ${JSON.stringify(active.userNamedStrippedTargets)}`,
    );

    // groupBuilderDeliverables is the next stage — it must also preserve
    // both files (no silent dedup or filter on non-existent paths).
    const grouped = coord.groupBuilderDeliverables(active, result);
    const groupedTargets = grouped.flatMap((d: any) => d.targetFiles);
    assert.ok(
      groupedTargets.includes("core/retry-utils.test.ts"),
      `explicit creation target must survive groupBuilderDeliverables; got [${groupedTargets.join(", ")}]`,
    );
  } finally {
    cleanup();
  }
});

test("burn-in-09: changeSet flags both files as required mutations (gates missing-required retry)", () => {
  const { dir, cleanup } = setupBurnIn09Repo();
  try {
    const gen = new CharterGenerator();
    const baseAnalysis = gen.analyzeRequest(BURN_IN_09_PROMPT);
    const prepared = prepareTargetsForPrompt({
      projectRoot: dir,
      prompt: BURN_IN_09_PROMPT,
      analysis: baseAnalysis,
    });
    const analysis = {
      ...baseAnalysis,
      targets:
        prepared.targets.length > 0
          ? [...prepared.targets]
          : [...baseAnalysis.targets],
    };
    const charter = gen.generateCharter(analysis);
    const intent = createIntent({
      runId: "burn-in-09-run",
      userRequest: BURN_IN_09_PROMPT,
      charter,
      constraints: [],
    });
    const allFiles = charter.deliverables.flatMap((d) => [...d.targetFiles]);
    const changeSet = createChangeSet(intent, allFiles, null, dir);

    const sourceEntry = changeSet.filesInScope.find(
      (f) => f.path === "core/retry-utils.ts",
    );
    const testEntry = changeSet.filesInScope.find(
      (f) => f.path === "core/retry-utils.test.ts",
    );
    assert.ok(sourceEntry, "source must appear in changeSet.filesInScope");
    assert.ok(testEntry, "test creation target must appear in changeSet.filesInScope");
    assert.equal(
      sourceEntry?.mutationExpected,
      true,
      "source must be marked mutationExpected so missing-required gate fires",
    );
    assert.equal(
      testEntry?.mutationExpected,
      true,
      "explicit creation test must be marked mutationExpected so a source-only Builder run is caught and retried before AWAITING_APPROVAL",
    );
  } finally {
    cleanup();
  }
});
