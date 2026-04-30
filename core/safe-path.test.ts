import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mkdir, unlink, writeFile } from "node:fs/promises";

import {
  resolveSafeDeletePath,
  resolveSafeWritePath,
  SafePathError,
} from "./safe-path.js";
import { BuilderWorker } from "../workers/builder.js";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "aedis-safe-path-"));
}

function makeSymlink(target: string, path: string, type: "file" | "dir"): boolean {
  try {
    symlinkSync(target, path, type);
    return true;
  } catch {
    return false;
  }
}

test("safe path: path traversal is blocked", async () => {
  const root = tempRoot();
  try {
    await assert.rejects(
      () => resolveSafeWritePath(root, "../escape.txt"),
      SafePathError,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("safe path: symlink file escape is blocked", async (t) => {
  const root = tempRoot();
  const outside = tempRoot();
  try {
    writeFileSync(join(outside, "secret.txt"), "outside\n", "utf-8");
    if (!makeSymlink(join(outside, "secret.txt"), join(root, "link.txt"), "file")) {
      t.skip("symlink creation unavailable on this platform");
      return;
    }
    await assert.rejects(
      () => resolveSafeWritePath(root, "link.txt"),
      /symlink/i,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("safe path: symlink directory escape is blocked", async (t) => {
  const root = tempRoot();
  const outside = tempRoot();
  try {
    if (!makeSymlink(outside, join(root, "linked-dir"), "dir")) {
      t.skip("symlink creation unavailable on this platform");
      return;
    }
    await assert.rejects(
      () => resolveSafeWritePath(root, "linked-dir/escape.txt"),
      /symlink/i,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("safe path: normal safe writes still work", async () => {
  const root = tempRoot();
  try {
    const target = await resolveSafeWritePath(root, "src/index.ts");
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, "export const ok = true;\n", "utf-8");
    assert.equal(readFileSync(join(root, "src/index.ts"), "utf-8"), "export const ok = true;\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("builder rollback restore cannot write through symlink outside root", async (t) => {
  const root = tempRoot();
  const outside = tempRoot();
  try {
    writeFileSync(join(outside, "victim.txt"), "outside\n", "utf-8");
    if (!makeSymlink(join(outside, "victim.txt"), join(root, "victim.txt"), "file")) {
      t.skip("symlink creation unavailable on this platform");
      return;
    }
    const builder = new BuilderWorker({ projectRoot: root });
    await assert.rejects(
      () => (builder as any).rollbackAppliedChanges(root, [{
        path: "victim.txt",
        operation: "modify",
        originalContent: "restored\n",
      }]),
      /symlink/i,
    );
    assert.equal(readFileSync(join(outside, "victim.txt"), "utf-8"), "outside\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("builder rollback delete cannot unlink through symlink outside root", async (t) => {
  const root = tempRoot();
  const outside = tempRoot();
  try {
    writeFileSync(join(outside, "victim.txt"), "outside\n", "utf-8");
    if (!makeSymlink(join(outside, "victim.txt"), join(root, "victim.txt"), "file")) {
      t.skip("symlink creation unavailable on this platform");
      return;
    }
    const builder = new BuilderWorker({ projectRoot: root });
    await assert.rejects(
      () => (builder as any).rollbackAppliedChanges(root, [{
        path: "victim.txt",
        operation: "create",
        content: "created\n",
      }]),
      /symlink/i,
    );
    assert.equal(existsSync(join(outside, "victim.txt")), true);
    assert.equal(readFileSync(join(outside, "victim.txt"), "utf-8"), "outside\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("safe path: delete resolves missing target only through contained parents", async () => {
  const root = tempRoot();
  try {
    const target = await resolveSafeDeletePath(root, "missing.txt");
    assert.match(target, /missing\.txt$/);
    await unlink(target).catch(() => undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
