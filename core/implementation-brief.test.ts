import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildImplementationBrief,
  buildImplementationBriefOrFallback,
  buildMinimalImplementationBrief,
  briefWithRetryHint,
  briefWithRejectedCandidates,
  briefToReceiptJson,
  formatBriefForBuilder,
  capabilityFloorForBrief,
  classifyWeakOutput,
} from "./implementation-brief.js";
import type { ScopeClassification } from "./scope-classifier.js";
import type { Plan } from "./multi-file-planner.js";
import type { ChangeSet } from "./change-set.js";
import type { IntentObject } from "./intent.js";
import type { RequestAnalysis } from "./charter.js";

function makeIntent(): IntentObject {
  return Object.freeze({
    id: "intent-1",
    runId: "run-1",
    version: 1,
    parentId: null,
    createdAt: "2026-04-24T00:00:00Z",
    userRequest: "fix fibonacci to handle n<=1 in core/utils.ts",
    charter: Object.freeze({
      objective: "Fix: fix fibonacci edge case",
      successCriteria: Object.freeze(["tests pass"]),
      deliverables: Object.freeze([
        Object.freeze({ description: "Modify core/utils.ts", targetFiles: Object.freeze(["core/utils.ts"]), type: "modify" as const }),
      ]),
      qualityBar: "standard",
    }),
    constraints: Object.freeze([]),
    acceptedAssumptions: Object.freeze([]),
    exclusions: Object.freeze([]),
    revisionReason: null,
  }) as unknown as IntentObject;
}

function makeAnalysis(partial: Partial<RequestAnalysis> = {}): RequestAnalysis {
  return {
    raw: "fix fibonacci",
    category: "bugfix",
    targets: ["core/utils.ts"],
    scopeEstimate: "small",
    riskSignals: [],
    ambiguities: [],
    ...partial,
  };
}

function makeScope(type: ScopeClassification["type"] = "single-file", blastRadius = 1): ScopeClassification {
  return {
    type,
    blastRadius,
    recommendDecompose: type !== "single-file",
    reason: "test",
    governance: {
      decompositionRequired: false,
      approvalRequired: false,
      escalationRecommended: false,
      wavesRequired: false,
    },
  };
}

function makeChangeSet(): ChangeSet {
  return Object.freeze({
    filesInScope: Object.freeze([Object.freeze({ path: "core/utils.ts", role: "primary" })]),
    invariants: Object.freeze([]),
    sharedInvariants: Object.freeze([]),
    coherenceVerdict: Object.freeze({ coherent: true, issues: Object.freeze([]) }),
    acceptanceCriteria: Object.freeze([]),
  }) as unknown as ChangeSet;
}

describe("ImplementationBrief", () => {
  it("builds a single-file brief with synthetic 1-stage when no plan", () => {
    const brief = buildImplementationBrief({
      intent: makeIntent(),
      analysis: makeAnalysis(),
      charter: makeIntent().charter,
      scope: makeScope("single-file"),
      changeSet: makeChangeSet(),
      plan: undefined,
      rawUserPrompt: "fix fibonacci to handle n<=1 in core/utils.ts",
      normalizedPrompt: "fix fibonacci edge case",
      dispatchableFiles: ["core/utils.ts"],
    });

    assert.equal(brief.taskType, "bugfix");
    assert.equal(brief.scope, "single-file");
    assert.equal(brief.scopeType, "single-file");
    assert.equal(brief.riskLevel, "low");
    assert.equal(brief.stages.length, 1);
    assert.equal(brief.selectedFiles.length, 1);
    assert.equal(brief.selectedFiles[0].path, "core/utils.ts");
    assert.equal(brief.selectedFiles[0].role, "primary");
    assert.equal(brief.attempt, 1);
    assert.equal(brief.retryHint, null);
    assert.ok(brief.nonGoals.some((g) => /rewrite the file/.test(g)));
  });

  it("escalates risk level on security-sensitive tasks", () => {
    const brief = buildImplementationBrief({
      intent: makeIntent(),
      analysis: makeAnalysis({ riskSignals: ["security-sensitive"] }),
      charter: makeIntent().charter,
      scope: makeScope("single-file"),
      changeSet: makeChangeSet(),
      plan: undefined,
      rawUserPrompt: "",
      normalizedPrompt: "",
      dispatchableFiles: ["core/utils.ts"],
    });
    assert.equal(brief.riskLevel, "high");
    assert.deepEqual([...brief.riskFactors], ["security-sensitive"]);
  });

  it("marks needsClarification=true when there are no selected files", () => {
    const brief = buildImplementationBrief({
      intent: makeIntent(),
      analysis: makeAnalysis({ targets: [] }),
      charter: makeIntent().charter,
      scope: makeScope("single-file"),
      changeSet: makeChangeSet(),
      plan: undefined,
      rawUserPrompt: "",
      normalizedPrompt: "",
      dispatchableFiles: [],
    });
    assert.equal(brief.needsClarification, true);
    assert.equal(brief.selectedFiles.length, 0);
  });

  it("derives stages from a multi-file plan", () => {
    const plan: Plan = {
      prompt: "refactor auth",
      changeSet: ["types/auth.d.ts", "services/login.ts", "tests/auth.test.ts"],
      waves: [
        { id: 1, name: "schema/types", files: ["types/auth.d.ts"], dependsOn: [], verificationCheckpoint: "check types", status: "pending", checkpointResult: null },
        { id: 2, name: "consumers", files: ["services/login.ts"], dependsOn: [1], verificationCheckpoint: "check consumers", status: "pending", checkpointResult: null },
        { id: 3, name: "tests/docs", files: ["tests/auth.test.ts"], dependsOn: [1, 2], verificationCheckpoint: "check tests", status: "pending", checkpointResult: null },
        { id: 4, name: "integration", files: [], dependsOn: [1, 2, 3], verificationCheckpoint: "check integration", status: "skipped", checkpointResult: null },
      ],
      dependencyEdges: [],
    };

    const brief = buildImplementationBrief({
      intent: makeIntent(),
      analysis: makeAnalysis({ category: "refactor" }),
      charter: makeIntent().charter,
      scope: makeScope("multi-file", 8),
      changeSet: makeChangeSet(),
      plan,
      rawUserPrompt: "refactor auth",
      normalizedPrompt: "refactor auth",
      dispatchableFiles: ["types/auth.d.ts", "services/login.ts", "tests/auth.test.ts"],
    });

    assert.equal(brief.stages.length, 4);
    assert.equal(brief.stages[0].name, "schema/types");
    assert.equal(brief.stages[1].dependsOn[0], 1);
    const schemaFile = brief.selectedFiles.find((f) => f.path === "types/auth.d.ts");
    assert.ok(schemaFile);
    assert.equal(schemaFile!.role, "schema");
    assert.equal(schemaFile!.waveId, 1);
  });

  it("classifyWeakOutput maps known error strings", () => {
    assert.equal(classifyWeakOutput({ builderError: "Model returned no effective file changes" }).reason, "empty-diff");
    assert.equal(classifyWeakOutput({ builderError: "SAFETY: Refusing to write raw diff text" }).reason, "raw-diff-output");
    assert.equal(classifyWeakOutput({ builderError: "builder output looks like conversational prose" }).reason, "prose-or-corruption");
    assert.equal(classifyWeakOutput({ builderError: "Preserved exports were removed from file" }).reason, "export-loss");
    assert.equal(classifyWeakOutput({ criticVerdict: "reject", criticIssues: ["scope drift"] }).reason, "critic-reject");
    assert.equal(classifyWeakOutput({ verifierFailed: true, verifierMessage: "tests failed" }).reason, "verifier-failure");
    assert.equal(classifyWeakOutput({ changeCount: 0 }).reason, "empty-diff");
  });

  it("briefWithRetryHint bumps attempt and injects the hint", () => {
    const first = buildImplementationBrief({
      intent: makeIntent(),
      analysis: makeAnalysis(),
      charter: makeIntent().charter,
      scope: makeScope(),
      changeSet: makeChangeSet(),
      plan: undefined,
      rawUserPrompt: "",
      normalizedPrompt: "",
      dispatchableFiles: ["core/utils.ts"],
    });
    const second = briefWithRetryHint(first, "must make a concrete edit this time");
    assert.equal(second.attempt, 2);
    assert.match(second.retryHint ?? "", /concrete edit/);
    // Unchanged fields
    assert.equal(second.taskType, first.taskType);
    assert.deepEqual(second.selectedFiles, first.selectedFiles);
  });

  it("formatBriefForBuilder includes retry banner on retries", () => {
    const first = buildImplementationBrief({
      intent: makeIntent(),
      analysis: makeAnalysis(),
      charter: makeIntent().charter,
      scope: makeScope(),
      changeSet: makeChangeSet(),
      plan: undefined,
      rawUserPrompt: "",
      normalizedPrompt: "",
      dispatchableFiles: ["core/utils.ts"],
    });
    const second = briefWithRetryHint(first, "be more specific this time");
    const block = formatBriefForBuilder(second);
    assert.match(block, /RETRY ATTEMPT 2/);
    assert.match(block, /be more specific this time/);
    assert.match(block, /Selected files/);
    assert.match(block, /core\/utils\.ts/);
  });

  it("capabilityFloorForBrief recommends premium for broad scopes", () => {
    const broad = buildImplementationBrief({
      intent: makeIntent(),
      analysis: makeAnalysis({ category: "refactor" }),
      charter: makeIntent().charter,
      scope: makeScope("architectural", 20),
      changeSet: makeChangeSet(),
      plan: undefined,
      rawUserPrompt: "",
      normalizedPrompt: "",
      dispatchableFiles: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts", "g.ts", "h.ts"],
    });
    assert.equal(capabilityFloorForBrief(broad).floor, "premium");

    const simple = buildImplementationBrief({
      intent: makeIntent(),
      analysis: makeAnalysis(),
      charter: makeIntent().charter,
      scope: makeScope("single-file"),
      changeSet: makeChangeSet(),
      plan: undefined,
      rawUserPrompt: "",
      normalizedPrompt: "",
      dispatchableFiles: ["core/utils.ts"],
    });
    assert.equal(capabilityFloorForBrief(simple).floor, "fast");
  });

  it("briefToReceiptJson produces plain-object payload", () => {
    const brief = buildImplementationBrief({
      intent: makeIntent(),
      analysis: makeAnalysis(),
      charter: makeIntent().charter,
      scope: makeScope(),
      changeSet: makeChangeSet(),
      plan: undefined,
      rawUserPrompt: "raw",
      normalizedPrompt: "norm",
      dispatchableFiles: ["core/utils.ts"],
      rejectedCandidates: [{ path: "core/other.ts", reason: "out of scope" }],
    });
    const json = briefToReceiptJson(brief);
    assert.equal(json.runId, "run-1");
    assert.equal(json.taskType, "bugfix");
    assert.equal((json.selectedFiles as unknown[]).length, 1);
    assert.equal((json.rejectedCandidates as { path: string }[])[0].path, "core/other.ts");
    // Round-trips through JSON without throwing
    const round = JSON.parse(JSON.stringify(json));
    assert.equal(round.taskType, "bugfix");
  });

  it("buildImplementationBriefOrFallback returns a minimal brief when the main builder throws", () => {
    const brief = buildImplementationBriefOrFallback({
      intent: makeIntent(),
      analysis: makeAnalysis(),
      charter: { ...(makeIntent().charter as any), objective: null } as any,
      scope: makeScope(),
      changeSet: makeChangeSet(),
      plan: undefined,
      rawUserPrompt: "fix fibonacci",
      normalizedPrompt: "fix fibonacci",
      dispatchableFiles: ["core/utils.ts"],
      rejectedCandidates: [{ path: "src/generated.ts", reason: "generated file" }],
    });

    assert.equal(brief.selectedFiles[0].path, "core/utils.ts");
    assert.match(brief.fallbackPlan, /Planning\/brief generation degraded earlier/);
    assert.ok(brief.openQuestions.some((line) => /Fallback brief reason/i.test(line)));
    assert.equal(brief.rejectedCandidates[0].path, "src/generated.ts");
  });

  it("buildMinimalImplementationBrief carries the planner error into the fallback plan", () => {
    const brief = buildMinimalImplementationBrief({
      intent: makeIntent(),
      rawUserPrompt: "fix fibonacci",
      normalizedPrompt: "fix fibonacci",
      error: "planner exploded",
      analysis: makeAnalysis(),
      scope: makeScope(),
      dispatchableFiles: ["core/utils.ts"],
    });

    assert.equal(brief.selectedFiles[0].path, "core/utils.ts");
    assert.match(brief.fallbackPlan, /planner exploded/);
    assert.ok(brief.openQuestions.some((line) => /planner exploded/.test(line)));
  });

  it("briefWithRejectedCandidates merges new rejection evidence", () => {
    const first = buildImplementationBrief({
      intent: makeIntent(),
      analysis: makeAnalysis(),
      charter: makeIntent().charter,
      scope: makeScope(),
      changeSet: makeChangeSet(),
      plan: undefined,
      rawUserPrompt: "raw",
      normalizedPrompt: "norm",
      dispatchableFiles: ["core/utils.ts"],
    });
    const merged = briefWithRejectedCandidates(first, [
      { path: "deps/generated.ts", reason: "generated file" },
      { path: "deps/generated.ts", reason: "generated file" },
      { path: "deps/heavy.ts", reason: "budget: dropped from context" },
    ]);

    assert.equal(merged.rejectedCandidates.length, 2);
    assert.equal(merged.rejectedCandidates[0].path, "deps/generated.ts");
    assert.equal(merged.rejectedCandidates[1].path, "deps/heavy.ts");
  });
});
