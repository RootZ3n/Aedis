import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { profileRepo, proveRepo } from "./proving-harness.js";

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "aedis-prove-repo-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "tests"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "prove-repo-fixture" }), "utf-8");
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "NodeNext" } }), "utf-8");
  writeFileSync(join(dir, "src", "main.ts"), "export const answer = 42;\n", "utf-8");
  for (let i = 0; i < 25; i++) {
    writeFileSync(join(dir, "src", `module-${i}.ts`), `export const value${i} = ${i};\n`, "utf-8");
  }
  writeFileSync(join(dir, "tests", "main.test.ts"), "import '../src/main.js';\n", "utf-8");
  return dir;
}

test("profileRepo detects test directories under ESM without require", async () => {
  const repo = makeRepo();
  try {
    const profile = await profileRepo(repo);
    assert.equal(profile.hasTests, true);
    assert.equal(profile.hasPackageJson, true);
    assert.equal(profile.hasTsConfig, true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("proveRepo returns a safe report instead of throwing require-is-not-defined", async () => {
  const repo = makeRepo();
  try {
    const report = await proveRepo(repo);
    assert.equal(report.repo.path, repo);
    assert.equal(report.repo.hasTests, true);
    assert.match(report.suite, /^cross-repo:/);
    assert.ok(report.summary.total > 0);
    assert.equal(report.summary.failed, 0);
    assert.equal(report.recommendation, "safe");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
