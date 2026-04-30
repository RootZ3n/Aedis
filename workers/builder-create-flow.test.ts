/**
 * Builder file-creation flow — regression for the ENOENT trap that
 * fired on both primary and shadow lanes when the model produced a
 * "create" change for a target whose parent directory didn't exist
 * in the workspace yet (e.g. a shadow worktree cloned from source
 * where git couldn't track the empty directory).
 *
 * The fix in workers/builder.ts adds an `mkdir(dirname(target),
 * { recursive: true })` immediately before the writeFile so the
 * create flow tolerates a missing parent. mkdir is idempotent so
 * the unconditional call is safe for the existing-file modify case.
 *
 * Two tests pin the contract:
 *   1. The behavioral pattern (mkdir + writeFile) works for nested
 *      paths whose parent directories don't exist.
 *   2. The builder source actually wires the mkdir into the write
 *      path right before writeFile (shape pin so a refactor can't
 *      silently drop the fix).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ─── 1. Behavioral pattern ──────────────────────────────────────────

test("create flow: mkdir(dirname, recursive) + writeFile creates a file in a non-existent parent directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "aedis-builder-create-"));
  try {
    const target = join(root, "tmp", "lane-demo", "hard-case.ts");
    // Parent directory does NOT exist — this is the ENOENT case.
    assert.equal(existsSync(dirname(target)), false, "parent must not exist");
    // The exact pattern the builder now uses: mkdir then writeFile.
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, "export const x = 1;\n", "utf8");
    assert.equal(existsSync(target), true);
    const back = await readFile(target, "utf8");
    assert.equal(back, "export const x = 1;\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("create flow: mkdir is idempotent for already-existing directories — no behavior change for modify case", async () => {
  const root = await mkdtemp(join(tmpdir(), "aedis-builder-create-"));
  try {
    // Pre-create the parent dir AND the file (modify case).
    const dir = join(root, "src");
    await mkdir(dir, { recursive: true });
    const target = join(dir, "widget.ts");
    await writeFile(target, "export const original = 1;\n", "utf8");
    // The same unconditional mkdir runs — must not throw on existing dir.
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, "export const original = 2;\n", "utf8");
    const back = await readFile(target, "utf8");
    assert.equal(back, "export const original = 2;\n", "modify case writes new content");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("create flow: nested-deeper missing parents (3 levels) — recursive flag handles all", async () => {
  // Source repos cloned via worktree miss empty dirs at any depth.
  // The recursive: true flag must create the entire chain, not just
  // the immediate parent.
  const root = await mkdtemp(join(tmpdir(), "aedis-builder-create-"));
  try {
    const target = join(root, "a", "b", "c", "deep.ts");
    assert.equal(existsSync(join(root, "a")), false);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, "deep\n", "utf8");
    assert.equal(existsSync(target), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ─── 2. Source-shape pin ────────────────────────────────────────────

test("builder source: writeFile in the create-or-modify path is preceded by safe mkdir", () => {
  // Pin the production wiring directly so a refactor that drops the
  // mkdir would surface here, not in a live shadow run minutes later.
  const builderPath = fileURLToPath(new URL("./builder.ts", import.meta.url));
  const src = readFileSync(builderPath, "utf-8");

  // The mkdir must use the safe resolved parent and the final write
  // must use the safe resolved target, so symlink swaps between path
  // resolution and write stay contained.
  assert.match(
    src,
    /const safeParent = await resolveSafeWritePath\(projectRoot,\s*dirname\(relativePath\)\);\s*\n\s*await mkdir\(safeParent,\s*\{\s*recursive:\s*true\s*\}\);\s*\n\s*const safeTargetPath = await resolveSafeWritePath\(projectRoot,\s*relativePath\);\s*\n\s*await writeFile\(safeTargetPath,\s*updatedContent/,
    "builder writes must resolve both parent and target through safe path checks",
  );

  // The imports must include mkdir, dirname, and safe path resolution.
  assert.match(src, /import\s+\{[^}]*\bmkdir\b[^}]*\}\s+from\s+"node:fs\/promises"/);
  assert.match(src, /import\s+\{[^}]*\bdirname\b[^}]*\}\s+from\s+"node:path"/);
  assert.match(src, /resolveSafeWritePath/);
});
