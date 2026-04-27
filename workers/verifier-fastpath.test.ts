import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  VerificationPipeline,
  type ToolHook,
  type ToolHookResult,
} from "../core/verification-pipeline.js";
import { VerifierWorker } from "./verifier.js";
import { createRunState, type RunTask } from "../core/runstate.js";
import { createIntent } from "../core/intent.js";
import type { AssembledContext } from "../core/context-assembler.js";
import type { FileChange, WorkerAssignment, WorkerResult } from "./base.js";

// ─── Helpers ─────────────────────────────────────────────────────────

function makeHook(name: string, kind: string, result: Partial<ToolHookResult> = {}): ToolHook {
  return {
    name,
    stage: kind === "typecheck" ? "typecheck" : kind === "lint" ? "lint" : "custom-hook",
    kind: kind as any,
    execute: async () => ({
      passed: true,
      issues: [],
      stdout: "",
      stderr: "",
      exitCode: 0,
      durationMs: 1,
      ...result,
    }),
  };
}

function makeChange(path: string): FileChange {
  return {
    path,
    operation: "modify",
    diff: "@@ -1 +1 @@\n-// old\n+// new\n",
    content: "// new",
    originalContent: "// old",
  };
}

function makeAssignment(opts: { fastPath?: boolean }): WorkerAssignment {
  const runState = createRunState(randomUUID(), "planning");
  const intent = createIntent({
    runId: randomUUID(),
    userRequest: "add a comment",
    charter: {
      objective: "test",
      successCriteria: [],
      deliverables: [{ description: "test", targetFiles: ["test.ts"], type: "modify" }],
      qualityBar: "minimal",
      scopeLock: null,
    },
    constraints: [],
  });
  const task: RunTask = {
    id: randomUUID(),
    parentTaskId: null,
    workerType: "verifier",
    description: "test",
    targetFiles: ["test.ts"],
    status: "active",
    assignedTo: null,
    result: null,
    startedAt: new Date().toISOString(),
    completedAt: null,
    costAccrued: null,
  };
  const context: AssembledContext = {
    layers: [],
    totalTokens: 0,
    budgetUsed: 0,
    budgetTotal: 10000,
    truncated: false,
    fileCount: 0,
    rejectedCandidates: [],
  };
  return {
    task,
    intent,
    context,
    upstreamResults: [],
    tier: "fast" as const,
    tokenBudget: 10000,
    changes: [makeChange("test.ts")],
    projectRoot: "/tmp/test",
    sourceRepo: "/tmp/test",
    runState,
    ...(opts.fastPath ? { fastPath: true } : {}),
  };
}

// ─── Tests ───────────────────────────────────────────────────────────

test("verifier fastPath: test hook is skipped when fastPath=true", async () => {
  let testHookCalled = false;
  let typecheckHookCalled = false;

  const testHook = makeHook("Tests", "tests");
  const originalTestExecute = testHook.execute;
  testHook.execute = async (files) => {
    testHookCalled = true;
    return originalTestExecute(files);
  };

  const typecheckHook = makeHook("TypeScript Check", "typecheck");
  const originalTcExecute = typecheckHook.execute;
  typecheckHook.execute = async (files) => {
    typecheckHookCalled = true;
    return originalTcExecute(files);
  };

  const verifier = new VerifierWorker({
    testHook,
    typecheckHook,
    verificationConfig: {
      requiredChecks: ["typecheck"],
    },
  });

  const assignment = makeAssignment({ fastPath: true });
  const result = await verifier.execute(assignment);

  assert.equal(testHookCalled, false, "test hook should NOT be called on fastPath");
  assert.equal(typecheckHookCalled, true, "typecheck hook should still run on fastPath");
  assert.equal(result.success, true);
});

test("verifier non-fastPath: test hook runs normally", async () => {
  let testHookCalled = false;

  const testHook = makeHook("Tests", "tests");
  const originalExecute = testHook.execute;
  testHook.execute = async (files) => {
    testHookCalled = true;
    return originalExecute(files);
  };

  const typecheckHook = makeHook("TypeScript Check", "typecheck");

  const verifier = new VerifierWorker({
    testHook,
    typecheckHook,
    verificationConfig: {
      requiredChecks: ["typecheck"],
    },
  });

  const assignment = makeAssignment({ fastPath: false });
  const result = await verifier.execute(assignment);

  assert.equal(testHookCalled, true, "test hook should run when fastPath is not set");
  assert.equal(result.success, true);
});

test("verifier fastPath: typecheck is still enforced", async () => {
  const typecheckHook = makeHook("TypeScript Check", "typecheck", {
    passed: false,
    exitCode: 1,
    stderr: "error TS2345: Argument of type 'string' is not assignable",
  });

  const verifier = new VerifierWorker({
    typecheckHook,
    verificationConfig: {
      requiredChecks: ["typecheck"],
    },
  });

  const assignment = makeAssignment({ fastPath: true });
  const result = await verifier.execute(assignment);

  // The verifier should still enforce typecheck failures
  const output = result.output as any;
  assert.equal(output.typeCheckPassed, false, "typecheck failure must still be caught on fastPath");
});

test("verifier fastPath: scope lock is still enforced via heuristic checks", async () => {
  // Scope lock enforcement comes from the critic's heuristic checks
  // and the integration judge — the verifier doesn't bypass it.
  // This test just confirms the verifier runs its full pipeline
  // (minus tests) on fastPath.
  const typecheckHook = makeHook("TypeScript Check", "typecheck");

  const verifier = new VerifierWorker({
    typecheckHook,
    verificationConfig: {
      requiredChecks: ["typecheck"],
    },
  });

  const assignment = makeAssignment({ fastPath: true });
  const result = await verifier.execute(assignment);

  assert.equal(result.success, true);
  const output = result.output as any;
  assert.ok(output.receipt, "verification receipt must still be produced");
  assert.ok(output.receipt.stages.length > 0, "verification stages must still run");
});

test("VerificationPipeline.getConfig returns resolved config with hooks", () => {
  const hook = makeHook("Test", "tests");
  const pipeline = new VerificationPipeline({ hooks: [hook] });
  const config = pipeline.getConfig();
  assert.equal(config.hooks.length, 1);
  assert.equal(config.hooks[0].name, "Test");
});
