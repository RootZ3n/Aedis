import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  clearBuildMetadataCache,
  detectSourceNewerThanDist,
  getBuildMetadata,
} from "./build-metadata.js";

function withTmp(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "aedis-buildmeta-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("getBuildMetadata reads dist/build-info.json when present", () => {
  withTmp((dir) => {
    clearBuildMetadataCache();
    const buildInfoPath = join(dir, "build-info.json");
    writeFileSync(
      buildInfoPath,
      JSON.stringify({
        version: "9.9.9",
        commit: "abcdef0123456789abcdef0123456789abcdef01",
        buildTime: "2030-01-02T03:04:05.000Z",
      }),
      "utf-8",
    );
    const meta = getBuildMetadata({ buildInfoPath, fresh: true });
    assert.equal(meta.version, "9.9.9");
    assert.equal(meta.commit, "abcdef0123456789abcdef0123456789abcdef01");
    assert.equal(meta.commitShort, "abcdef01");
    assert.equal(meta.buildTime, "2030-01-02T03:04:05.000Z");
    assert.equal(meta.source, "build-info");
  });
});

test("getBuildMetadata falls back to git/package.json when build-info missing", () => {
  withTmp((dir) => {
    clearBuildMetadataCache();
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", version: "0.5.0" }));
    // No build-info file present — point at a non-existent path so the
    // function must take the fallback branch.
    const meta = getBuildMetadata({
      projectRoot: dir,
      buildInfoPath: join(dir, "does-not-exist.json"),
      fresh: true,
    });
    assert.equal(meta.version, "0.5.0");
    // Not a git repo — commit must degrade to "unknown" without throwing.
    assert.equal(meta.commit, "unknown");
    assert.equal(meta.commitShort, "unknown");
    assert.equal(meta.source, "git-runtime");
    // buildTime is stamped with "now" in dev mode — must be a valid ISO date.
    assert.ok(!Number.isNaN(Date.parse(meta.buildTime)), `buildTime must parse: ${meta.buildTime}`);
  });
});

test("getBuildMetadata never throws on a malformed build-info.json", () => {
  withTmp((dir) => {
    clearBuildMetadataCache();
    const buildInfoPath = join(dir, "build-info.json");
    writeFileSync(buildInfoPath, "{ not valid json", "utf-8");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "0.0.1" }));
    const meta = getBuildMetadata({ projectRoot: dir, buildInfoPath, fresh: true });
    // Falls through to runtime path; doesn't crash.
    assert.equal(meta.source, "git-runtime");
    assert.equal(meta.version, "0.0.1");
  });
});

test("detectSourceNewerThanDist returns null when dist/build-info.json is missing", () => {
  withTmp((dir) => {
    mkdirSync(join(dir, "core"), { recursive: true });
    writeFileSync(join(dir, "core", "x.ts"), "// stub\n");
    assert.equal(detectSourceNewerThanDist(dir), null);
  });
});

test("detectSourceNewerThanDist flags a source file edited after the build", () => {
  withTmp((dir) => {
    mkdirSync(join(dir, "dist"), { recursive: true });
    mkdirSync(join(dir, "core"), { recursive: true });
    const buildInfo = join(dir, "dist", "build-info.json");
    writeFileSync(buildInfo, JSON.stringify({ buildTime: "2026-01-01T00:00:00.000Z" }));
    // Backdate dist/build-info.json to an hour ago.
    const past = new Date("2026-01-01T00:00:00.000Z");
    utimesSync(buildInfo, past, past);

    const sourceFile = join(dir, "core", "fresh.ts");
    writeFileSync(sourceFile, "// edited after the build\n");
    // Future-date the source file so the comparison is unambiguous.
    const future = new Date(Date.now() + 60_000);
    utimesSync(sourceFile, future, future);

    const f = detectSourceNewerThanDist(dir, ["core"]);
    assert.ok(f, "freshness result must be returned");
    assert.equal(f!.sourceNewerThanDist, true, "source-newer-than-dist must be true");
    assert.equal(resolve(f!.newestSourcePath), resolve(sourceFile));
  });
});

test("detectSourceNewerThanDist returns false when dist is newer than every source", () => {
  withTmp((dir) => {
    mkdirSync(join(dir, "dist"), { recursive: true });
    mkdirSync(join(dir, "core"), { recursive: true });

    const oldSource = join(dir, "core", "old.ts");
    writeFileSync(oldSource, "// stub\n");
    const past = new Date("2026-01-01T00:00:00.000Z");
    utimesSync(oldSource, past, past);

    const buildInfo = join(dir, "dist", "build-info.json");
    writeFileSync(buildInfo, JSON.stringify({ buildTime: "2026-06-01T00:00:00.000Z" }));
    const fresh = new Date("2026-06-01T00:00:00.000Z");
    utimesSync(buildInfo, fresh, fresh);

    const f = detectSourceNewerThanDist(dir, ["core"]);
    assert.ok(f, "freshness result must be returned");
    assert.equal(f!.sourceNewerThanDist, false);
  });
});
