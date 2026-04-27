#!/usr/bin/env node
/**
 * Post-build hook — emits dist/build-info.json with the metadata the
 * runtime reads via core/build-metadata.ts. Runs after `tsc` succeeds
 * so the file lands inside the freshly compiled dist/.
 *
 * Outputs:
 *   { version, commit, commitShort, buildTime }
 *
 * Failure mode: never throw — the build should not fail because of
 * metadata. Missing values become "unknown"; the runtime fallback path
 * surfaces this in `aedis doctor`.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");
const OUT_PATH = resolve(REPO_ROOT, "dist", "build-info.json");

function readPackageVersion() {
  try {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf-8"));
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

function readGitCommit() {
  try {
    const out = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim() || "unknown";
  } catch {
    return "unknown";
  }
}

function main() {
  if (!existsSync(resolve(REPO_ROOT, "dist"))) {
    // tsc may have failed — don't manufacture a dist/.
    console.error("[write-build-info] dist/ missing; skipping");
    return;
  }

  const version = readPackageVersion();
  const commit = readGitCommit();
  const commitShort = commit === "unknown" ? "unknown" : commit.slice(0, 8);
  const buildTime = new Date().toISOString();

  const payload = { version, commit, commitShort, buildTime };

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2) + "\n", "utf-8");
  console.log(`[write-build-info] wrote ${OUT_PATH} commit=${commitShort} version=${version}`);
}

main();
