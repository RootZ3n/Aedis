import test from "node:test";
import assert from "node:assert/strict";

import { createRunState } from "./runstate.js";
import {
  VerificationPipeline,
  createCustomHook,
  type VerificationReceipt,
} from "./verification-pipeline.js";

test("VerificationPipeline fails closed when required checks are missing", async () => {
  const pipeline = new VerificationPipeline();
  const receipt = await pipeline.verify(
    intentFixture(),
    createRunState("intent-1", "run-1"),
    [changeFixture()],
    [],
  );

  assert.equal(receipt.verdict, "fail");
  assert.deepEqual(receipt.requiredChecks, ["typecheck", "tests"]);
  assert.equal(receipt.checks.filter((check) => check.executed).length, 0);
  assert.match(receipt.summary, /missing required checks/i);
});

test("VerificationPipeline records the real checks that executed", async () => {
  const pipeline = new VerificationPipeline({
    hooks: [
      createCustomHook({ name: "Lint", command: "true", kind: "lint" }),
      createCustomHook({ name: "Typecheck", command: "true", kind: "typecheck" }),
      createCustomHook({ name: "Tests", command: "true", kind: "tests" }),
    ],
  });

  const receipt = await pipeline.verify(
    intentFixture(),
    createRunState("intent-1", "run-2"),
    [changeFixture()],
    [],
  );

  assert.notEqual(receipt.verdict, "fail");
  assert.deepEqual(receipt.checks.map((check) => check.kind), ["lint", "typecheck", "tests"]);
  assert.ok(receipt.checks.every((check) => check.executed));
  assert.ok(receipt.checks.every((check) => check.passed));
});

function intentFixture(): any {
  return {
    id: "intent-1",
    exclusions: [],
    charter: {
      deliverables: [
        {
          description: "update src/example.ts",
          targetFiles: ["src/example.ts"],
        },
      ],
    },
  };
}

function changeFixture(): any {
  return {
    path: "src/example.ts",
    operation: "modify",
    diff: "-export const oldValue = 1;\n+export const newValue = 2;\n",
    content: "export const newValue = 2;\n",
    originalContent: "export const oldValue = 1;\n",
  };
}
