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
  writeFileSync(join(dir, "README.md"), "# Test Repo\n", "utf-8");
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
      // Auto-injection is detected by description, not by `type` —
      // see isAutoInjectedTestPair in change-set.ts. Use a valid
      // Deliverable.type ("modify") to satisfy the union.
      { description: "Test pairs for changed implementation files", type: "modify", targetFiles: ["core/run-summary.test.ts"] },
    ],
  );

  const changeSet = createChangeSet(intent, ["core/run-summary.ts", "core/run-summary.test.ts"]);
  const testFile = changeSet.filesInScope.find((file) => file.path === "core/run-summary.test.ts");

  assert.equal(testFile?.mutationRole, "write-optional");
  assert.equal(testFile?.mutationExpected, false);
});

test("change-set: explicitly requested README append is expected mutation", async () => {
  const repo = makeRepo();
  try {
    const intent = intentFor(
      "Append the exact line Aedis RC smoke test. to README.md.",
      [
        { description: "Modify README.md", type: "modify", targetFiles: ["README.md"] },
      ],
    );
    const changeSet = createChangeSet(intent, ["README.md"], undefined, repo);
    const readme = changeSet.filesInScope.find((file) => file.path === "README.md");

    assert.equal(readme?.mutationRole, "write-required");
    assert.equal(readme?.mutationExpected, true);

    writeFileSync(join(repo, "README.md"), "# Test Repo\nAedis RC smoke test.\n", "utf-8");
    const result = await verifyGitDiff({
      projectRoot: repo,
      manifestFiles: changeSet.filesInScope.map((file) => file.path),
      expectedFiles: changeSet.filesInScope.filter((file) => file.mutationExpected).map((file) => file.path),
      nonMutatingFiles: changeSet.filesInScope.filter((file) => !file.mutationExpected).map((file) => file.path),
    });

    assert.deepEqual(result.unexpectedReferenceChanges, []);
    assert.equal(result.passed, true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
