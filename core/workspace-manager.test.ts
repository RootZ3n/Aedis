import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { createWorkspace, discardWorkspace, generatePatch } from "./workspace-manager.js";

function makeSourceRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "aedis-promotion-filter-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src/index.ts"), "export const x = 1;\n", "utf-8");
  writeFileSync(join(dir, "README.md"), "# fixture\n", "utf-8");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "aedis@example.test"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Aedis Test"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: dir });
  return dir;
}

test("generatePatch: drops .aedis/memory.json from both changedFiles and diff", async () => {
  const sourceRepo = makeSourceRepo();
  let handle: Awaited<ReturnType<typeof createWorkspace>> | null = null;
  try {
    handle = await createWorkspace(sourceRepo, "test-run-aaaaaaaa");

    // Simulate a Builder edit on a real source file PLUS a runtime
    // artifact that Aedis would have written during the run.
    writeFileSync(join(handle.workspacePath, "src/index.ts"), "export const x = 2;\n", "utf-8");
    mkdirSync(join(handle.workspacePath, ".aedis"), { recursive: true });
    writeFileSync(
      join(handle.workspacePath, ".aedis/memory.json"),
      JSON.stringify({ recentTasks: [{ verdict: "partial" }] }),
      "utf-8",
    );

    const patch = await generatePatch(handle);

    assert.ok(
      patch.changedFiles.includes("src/index.ts"),
      `expected src/index.ts in changedFiles, got: ${patch.changedFiles.join(", ")}`,
    );
    assert.ok(
      !patch.changedFiles.some((f) => f.startsWith(".aedis/")),
      `.aedis/* must be excluded from changedFiles, got: ${patch.changedFiles.join(", ")}`,
    );
    assert.ok(
      !patch.diff.includes(".aedis/memory.json"),
      "diff text must not reference the runtime artifact",
    );
    assert.ok(
      !patch.diff.includes("recentTasks"),
      "diff text must not contain runtime artifact contents",
    );
    assert.ok(
      patch.diff.includes("src/index.ts"),
      "diff text must still contain the legitimate code change",
    );
  } finally {
    if (handle) await discardWorkspace(handle);
    rmSync(sourceRepo, { recursive: true, force: true });
  }
});

test("generatePatch: drops state/receipts/** even when other repos use that path", async () => {
  const sourceRepo = makeSourceRepo();
  let handle: Awaited<ReturnType<typeof createWorkspace>> | null = null;
  try {
    handle = await createWorkspace(sourceRepo, "test-run-bbbbbbbb");

    writeFileSync(join(handle.workspacePath, "src/index.ts"), "export const x = 3;\n", "utf-8");
    mkdirSync(join(handle.workspacePath, "state/receipts/runs"), { recursive: true });
    writeFileSync(
      join(handle.workspacePath, "state/receipts/runs/abc.json"),
      JSON.stringify({ runId: "abc" }),
      "utf-8",
    );

    const patch = await generatePatch(handle);

    assert.ok(patch.changedFiles.includes("src/index.ts"));
    assert.ok(
      !patch.changedFiles.some((f) => f.startsWith("state/receipts/")),
      `state/receipts/** must be excluded, got: ${patch.changedFiles.join(", ")}`,
    );
    assert.ok(!patch.diff.includes("state/receipts/runs/abc.json"));
  } finally {
    if (handle) await discardWorkspace(handle);
    rmSync(sourceRepo, { recursive: true, force: true });
  }
});

test("generatePatch: ALLOWS user-edited .aedis/model-config.json", async () => {
  // Promotion filter must not block legitimate user-config edits under
  // .aedis/. If a task targets model-config.json the change must
  // promote normally. Commits the workspace to mirror production —
  // workers commit before generatePatch runs.
  const sourceRepo = makeSourceRepo();
  let handle: Awaited<ReturnType<typeof createWorkspace>> | null = null;
  try {
    handle = await createWorkspace(sourceRepo, "test-run-cccccccc");

    mkdirSync(join(handle.workspacePath, ".aedis"), { recursive: true });
    writeFileSync(
      join(handle.workspacePath, ".aedis/model-config.json"),
      JSON.stringify({ builder: { model: "qwen3.5:9b" } }),
      "utf-8",
    );
    execFileSync("git", ["add", "-A"], { cwd: handle.workspacePath });
    execFileSync("git", ["commit", "-qm", "user config edit"], { cwd: handle.workspacePath });

    const patch = await generatePatch(handle);

    assert.ok(
      patch.changedFiles.includes(".aedis/model-config.json"),
      `user config must promote, got: ${patch.changedFiles.join(", ")}`,
    );
    assert.ok(patch.diff.includes(".aedis/model-config.json"));
  } finally {
    if (handle) await discardWorkspace(handle);
    rmSync(sourceRepo, { recursive: true, force: true });
  }
});

test("generatePatch: committed workspace surfaces changedFiles via diff --name-only (regression: 5838aad)", async () => {
  // The original bug: when the workspace committed cleanly, `git
  // status --porcelain` was empty, so changedFiles was [], and
  // promoteToSource fell back to `git add -A` — which swept the
  // memory.json that Aedis wrote to source AFTER persistMemoryArtifacts
  // and BEFORE promoteToSource. This test proves changedFiles still
  // populates after a workspace commit.
  const sourceRepo = makeSourceRepo();
  let handle: Awaited<ReturnType<typeof createWorkspace>> | null = null;
  try {
    handle = await createWorkspace(sourceRepo, "test-run-eeeeeeee");

    writeFileSync(join(handle.workspacePath, "src/index.ts"), "export const x = 4;\n", "utf-8");
    execFileSync("git", ["add", "-A"], { cwd: handle.workspacePath });
    execFileSync("git", ["commit", "-qm", "builder change"], { cwd: handle.workspacePath });

    const patch = await generatePatch(handle);

    assert.ok(
      patch.commitSha,
      "workspace commit SHA must be captured when workspace committed",
    );
    assert.deepEqual(
      patch.changedFiles,
      ["src/index.ts"],
      `committed workspace must still report changedFiles, got: ${patch.changedFiles.join(", ")}`,
    );
    assert.ok(patch.diff.includes("src/index.ts"));
  } finally {
    if (handle) await discardWorkspace(handle);
    rmSync(sourceRepo, { recursive: true, force: true });
  }
});

test("generatePatch: committed workspace + later runtime artifact in source does NOT leak into patch", async () => {
  // Simulates the precise sequence that produced 5838aad:
  //  1. Workspace commits a real source change (generate.py).
  //  2. After workspace work is done, Aedis writes `.aedis/memory.json`
  //     to the SOURCE repo via persistMemoryArtifacts.
  //  3. promoteToSource then reads the patch artifact.
  // Even though memory.json now exists on the source side, the
  // patchArtifact must not reference it.
  const sourceRepo = makeSourceRepo();
  let handle: Awaited<ReturnType<typeof createWorkspace>> | null = null;
  try {
    handle = await createWorkspace(sourceRepo, "test-run-ffffffff");

    writeFileSync(join(handle.workspacePath, "src/index.ts"), "export const x = 5;\n", "utf-8");
    execFileSync("git", ["add", "-A"], { cwd: handle.workspacePath });
    execFileSync("git", ["commit", "-qm", "builder change"], { cwd: handle.workspacePath });

    // Simulate persistMemoryArtifacts writing to the SOURCE repo
    // after the workspace work completed.
    mkdirSync(join(sourceRepo, ".aedis"), { recursive: true });
    writeFileSync(join(sourceRepo, ".aedis/memory.json"), JSON.stringify({ recentTasks: [] }), "utf-8");

    const patch = await generatePatch(handle);

    assert.deepEqual(
      patch.changedFiles,
      ["src/index.ts"],
      `runtime artifacts written to source after workspace commit must not appear in patchArtifact, got: ${patch.changedFiles.join(", ")}`,
    );
    assert.ok(!patch.diff.includes(".aedis/memory.json"));
  } finally {
    if (handle) await discardWorkspace(handle);
    rmSync(sourceRepo, { recursive: true, force: true });
  }
});

test("generatePatch: when ONLY runtime artifacts changed, returns empty changedFiles", async () => {
  const sourceRepo = makeSourceRepo();
  let handle: Awaited<ReturnType<typeof createWorkspace>> | null = null;
  try {
    handle = await createWorkspace(sourceRepo, "test-run-dddddddd");

    mkdirSync(join(handle.workspacePath, ".aedis"), { recursive: true });
    writeFileSync(join(handle.workspacePath, ".aedis/memory.json"), "{}", "utf-8");
    writeFileSync(join(handle.workspacePath, ".aedis/circuit-breaker-state.json"), "{}", "utf-8");

    const patch = await generatePatch(handle);

    assert.deepEqual(
      patch.changedFiles,
      [],
      `runtime-only churn must produce empty changedFiles, got: ${patch.changedFiles.join(", ")}`,
    );
  } finally {
    if (handle) await discardWorkspace(handle);
    rmSync(sourceRepo, { recursive: true, force: true });
  }
});
