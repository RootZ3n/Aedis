import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createChangeSet } from "./change-set.js";
import { Coordinator } from "./coordinator.js";
import { createIntent } from "./intent.js";
import { verifyGitDiff } from "./git-diff-verifier.js";
import type { Deliverable } from "./intent.js";

function intentFor(userRequest: string, deliverables: Deliverable[]) {
  return createIntent({
    runId: "run-change-set-test",
    userRequest,
    charter: {
      objective: userRequest,
      successCriteria: [],
      deliverables,
      qualityBar: "minimal",
    },
    constraints: [],
  });
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "aedis-change-set-"));
  mkdirSync(join(dir, "core"), { recursive: true });
  writeFileSync(join(dir, "core/run-summary.ts"), "export const summary = 1;\n", "utf-8");
  writeFileSync(join(dir, "core/run-summary.test.ts"), "import test from 'node:test';\n", "utf-8");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@aedis.local"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Aedis Test"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: dir });
  return dir;
}

test("change-set: explicit test file deliverable becomes mutationExpected", () => {
  const intent = intentFor(
    "Fix core/run-summary.ts and add one focused test in core/run-summary.test.ts.",
    [
      { description: "Modify core/run-summary.ts", type: "modify", targetFiles: ["core/run-summary.ts"] },
      { description: "Modify core/run-summary.test.ts", type: "modify", targetFiles: ["core/run-summary.test.ts"] },
    ],
  );

  const changeSet = createChangeSet(intent, ["core/run-summary.ts", "core/run-summary.test.ts"]);
  const testFile = changeSet.filesInScope.find((file) => file.path === "core/run-summary.test.ts");

  assert.equal(testFile?.mutationRole, "write-required");
  assert.equal(testFile?.mutationExpected, true);
});

test("change-set: 'Add one focused test in core/run-summary.test.ts' allows modifying the test file", async () => {
  const repo = makeRepo();
  try {
    const intent = intentFor(
      "Add one focused test in core/run-summary.test.ts.",
      [
        { description: "Modify core/run-summary.test.ts", type: "modify", targetFiles: ["core/run-summary.test.ts"] },
      ],
    );
    const changeSet = createChangeSet(intent, ["core/run-summary.test.ts"], undefined, repo);
    writeFileSync(join(repo, "core/run-summary.test.ts"), "import test from 'node:test';\ntest('focused', () => {});\n", "utf-8");

    const expectedFiles = changeSet.filesInScope.filter((file) => file.mutationExpected).map((file) => file.path);
    const nonMutatingFiles = changeSet.filesInScope.filter((file) => !file.mutationExpected).map((file) => file.path);
    const result = await verifyGitDiff({
      projectRoot: repo,
      manifestFiles: changeSet.filesInScope.map((file) => file.path),
      expectedFiles,
      nonMutatingFiles,
    });

    assert.deepEqual(result.expectedButUnchanged, []);
    assert.deepEqual(result.unexpectedReferenceChanges, []);
    assert.equal(result.passed, true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("change-set: merge gate does not flag explicitly requested test file as unexpected reference/context change", async () => {
  const repo = makeRepo();
  try {
    const intent = intentFor(
      "Fix core/run-summary.ts and add one focused test in core/run-summary.test.ts.",
      [
        { description: "Modify core/run-summary.ts", type: "modify", targetFiles: ["core/run-summary.ts"] },
        { description: "Modify core/run-summary.test.ts", type: "modify", targetFiles: ["core/run-summary.test.ts"] },
      ],
    );
    const changeSet = createChangeSet(intent, ["core/run-summary.ts", "core/run-summary.test.ts"], undefined, repo);
    writeFileSync(join(repo, "core/run-summary.ts"), "export const summary = 2;\n", "utf-8");
    writeFileSync(join(repo, "core/run-summary.test.ts"), "import test from 'node:test';\ntest('focused', () => {});\n", "utf-8");

    const result = await verifyGitDiff({
      projectRoot: repo,
      manifestFiles: changeSet.filesInScope.map((file) => file.path),
      expectedFiles: changeSet.filesInScope.filter((file) => file.mutationExpected).map((file) => file.path),
      nonMutatingFiles: changeSet.filesInScope.filter((file) => !file.mutationExpected).map((file) => file.path),
    });
    const findings = new (Coordinator as any)({ projectRoot: repo }).gitDiffFindings(result);

    assert.deepEqual(result.unexpectedReferenceChanges, []);
    assert.equal(
      findings.some((finding: any) => finding.code === "git-diff:unexpected-reference-change"),
      false,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("change-set: auto-injected test pairs stay optional/non-mutating", () => {
  const intent = intentFor(
    "Fix the off-by-one in core/run-summary.ts.",
    [
      { description: "Modify core/run-summary.ts", type: "modify", targetFiles: ["core/run-summary.ts"] },
      { description: "Test pairs for changed implementation files", type: "test", targetFiles: ["core/run-summary.test.ts"] },
    ],
  );

  const changeSet = createChangeSet(intent, ["core/run-summary.ts", "core/run-summary.test.ts"]);
  const testFile = changeSet.filesInScope.find((file) => file.path === "core/run-summary.test.ts");

  assert.equal(testFile?.mutationRole, "write-optional");
  assert.equal(testFile?.mutationExpected, false);
});
