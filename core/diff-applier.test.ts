import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DiffApplier } from "./diff-applier.js";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "aedis-diff-applier-"));
}

test("diff applier blocks path traversal before applying patch", async () => {
  const root = tempRoot();
  const outside = tempRoot();
  try {
    writeFileSync(join(outside, "escape.txt"), "outside\n", "utf-8");
    const diff = [
      "--- a/../escape.txt",
      "+++ b/../escape.txt",
      "@@ -1,1 +1,1 @@",
      "-outside",
      "+changed",
      "",
    ].join("\n");
    const result = await new DiffApplier().apply(diff, root);
    assert.equal(result.success, false);
    assert.match(result.errors.join("\n"), /traversal|escapes/i);
    assert.equal(readFileSync(join(outside, "escape.txt"), "utf-8"), "outside\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("diff applier blocks symlink escape before applying patch", async (t) => {
  const root = tempRoot();
  const outside = tempRoot();
  try {
    writeFileSync(join(outside, "victim.txt"), "outside\n", "utf-8");
    try {
      symlinkSync(join(outside, "victim.txt"), join(root, "victim.txt"), "file");
    } catch {
      t.skip("symlink creation unavailable on this platform");
      return;
    }
    const diff = [
      "--- a/victim.txt",
      "+++ b/victim.txt",
      "@@ -1,1 +1,1 @@",
      "-outside",
      "+changed",
      "",
    ].join("\n");
    const result = await new DiffApplier().apply(diff, root);
    assert.equal(result.success, false);
    assert.match(result.errors.join("\n"), /symlink/i);
    assert.equal(readFileSync(join(outside, "victim.txt"), "utf-8"), "outside\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
