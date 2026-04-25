import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { isTestInjectionFile, verifyGitDiff } from "./git-diff-verifier.js";

const TEST_INJECTION_MATCHES: readonly string[] = [
  "test/utils.test.ts",
  "tests/utils.test.ts",
  "__tests__/utils.test.ts",
  "src/test/utils.ts",
  "src/tests/utils.ts",
  "src/__tests__/utils.ts",
  "packages/api/test/routes.test.ts",
  "src/utils.test.ts",
  "src/utils.spec.ts",
  "src/utils.test.tsx",
  "src/utils.spec.tsx",
  "src/utils.test.js",
  "src/utils.test.jsx",
  "src/utils.test.mjs",
  "src/utils.test.cjs",
  "src/utils.spec.mjs",
  "./test/utils.test.ts",
];

for (const path of TEST_INJECTION_MATCHES) {
  test(`isTestInjectionFile: "${path}" is treated as a test file`, () => {
    assert.equal(isTestInjectionFile(path), true);
  });
}

const NON_TEST_FILES: readonly string[] = [
  "src/utils.ts",
  "src/utils.tsx",
  "core/coordinator.ts",
  "README.md",
  "package.json",
  "src/test-helpers.ts",
  "src/testing.ts",
  "src/contest.ts",
  "src/my-tests.ts",
  "docs/test-plan.md",
];

for (const path of NON_TEST_FILES) {
  test(`isTestInjectionFile: "${path}" is NOT treated as a test file`, () => {
    assert.equal(isTestInjectionFile(path), false);
  });
}

test("isTestInjectionFile: Windows-style backslash paths are normalized", () => {
  assert.equal(isTestInjectionFile("src\\utils.test.ts"), true);
  assert.equal(isTestInjectionFile("test\\utils.ts"), true);
});

test("isTestInjectionFile: stress-suite regression case (test/utils.test.ts)", () => {
  assert.equal(isTestInjectionFile("test/utils.test.ts"), true);
});

function makeGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "aedis-git-diff-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src/user.controller.ts"), "export class UserController {}\n", "utf-8");
  writeFileSync(join(dir, "src/user.service.ts"), "export class UserService {}\n", "utf-8");
  writeFileSync(join(dir, "src/create-user.dto.ts"), "export interface CreateUserDto { name: string; }\n", "utf-8");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "aedis@example.test"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Aedis Test"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: dir });
  return dir;
}

test("git diff verifier: unchanged reference file does not block expected writes", async () => {
  const repo = makeGitRepo();
  try {
    writeFileSync(join(repo, "src/user.controller.ts"), "export class UserController { createUser() {} }\n", "utf-8");
    writeFileSync(join(repo, "src/user.service.ts"), "export class UserService { createUser() {} }\n", "utf-8");

    const result = await verifyGitDiff({
      projectRoot: repo,
      manifestFiles: ["src/user.controller.ts", "src/user.service.ts", "src/create-user.dto.ts"],
      expectedFiles: ["src/user.controller.ts", "src/user.service.ts"],
      nonMutatingFiles: ["src/create-user.dto.ts"],
    });

    assert.equal(result.passed, true, result.summary);
    assert.deepEqual(result.expectedButUnchanged, []);
    assert.deepEqual(result.unexpectedReferenceChanges, []);
    assert.deepEqual([...result.confirmed].sort(), ["src/user.controller.ts", "src/user.service.ts"].sort());
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("git diff verifier: unchanged write-required controller blocks", async () => {
  const repo = makeGitRepo();
  try {
    writeFileSync(join(repo, "src/user.service.ts"), "export class UserService { createUser() {} }\n", "utf-8");

    const result = await verifyGitDiff({
      projectRoot: repo,
      manifestFiles: ["src/user.controller.ts", "src/user.service.ts", "src/create-user.dto.ts"],
      expectedFiles: ["src/user.controller.ts", "src/user.service.ts"],
      nonMutatingFiles: ["src/create-user.dto.ts"],
    });

    assert.equal(result.passed, false);
    assert.deepEqual(result.expectedButUnchanged, ["src/user.controller.ts"]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("git diff verifier: unchanged write-required service blocks", async () => {
  const repo = makeGitRepo();
  try {
    writeFileSync(join(repo, "src/user.controller.ts"), "export class UserController { createUser() {} }\n", "utf-8");

    const result = await verifyGitDiff({
      projectRoot: repo,
      manifestFiles: ["src/user.controller.ts", "src/user.service.ts", "src/create-user.dto.ts"],
      expectedFiles: ["src/user.controller.ts", "src/user.service.ts"],
      nonMutatingFiles: ["src/create-user.dto.ts"],
    });

    assert.equal(result.passed, false);
    assert.deepEqual(result.expectedButUnchanged, ["src/user.service.ts"]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("git diff verifier: unexpected reference mutation trips safety", async () => {
  const repo = makeGitRepo();
  try {
    writeFileSync(join(repo, "src/user.controller.ts"), "export class UserController { createUser() {} }\n", "utf-8");
    writeFileSync(join(repo, "src/user.service.ts"), "export class UserService { createUser() {} }\n", "utf-8");
    writeFileSync(join(repo, "src/create-user.dto.ts"), "export interface CreateUserDto { name: string; email: string; }\n", "utf-8");

    const result = await verifyGitDiff({
      projectRoot: repo,
      manifestFiles: ["src/user.controller.ts", "src/user.service.ts", "src/create-user.dto.ts"],
      expectedFiles: ["src/user.controller.ts", "src/user.service.ts"],
      nonMutatingFiles: ["src/create-user.dto.ts"],
    });

    assert.equal(result.passed, false);
    assert.deepEqual(result.unexpectedReferenceChanges, ["src/create-user.dto.ts"]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
