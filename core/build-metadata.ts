/**
 * Build metadata — answers "which dist am I running?" at runtime.
 *
 * The duplicate-server / stale-dist incident (burn-in-09 BLOCKED) showed
 * that a server started from a stale build and a server started after a
 * fresh rebuild are externally indistinguishable. /health and the boot
 * log both reported the same shape, so a stale process kept handling
 * requests with old planning logic and the operator had no way to tell.
 *
 * Resolution order:
 *   1. `dist/build-info.json` — written at build time by
 *      `scripts/write-build-info.mjs`. Authoritative for installed/
 *      built servers.
 *   2. Live git + package.json — used in dev (`npm start` via tsx,
 *      tests, etc.) where the build-info file does not exist.
 *   3. `{ unknown }` fallback — never throw; metadata is observability,
 *      not a runtime gate.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface BuildMetadata {
  /** Package version from package.json. `"unknown"` if unreadable. */
  readonly version: string;
  /** Full git commit SHA at build time (or live if no build-info). */
  readonly commit: string;
  /** Short git SHA (first 8 chars of `commit`). */
  readonly commitShort: string;
  /** ISO timestamp of when the build was produced (or "now" in dev). */
  readonly buildTime: string;
  /**
   * Where these values came from. Useful in `aedis doctor` to flag a
   * mismatched/missing build-info file.
   */
  readonly source: "build-info" | "git-runtime" | "fallback";
}

const BUILD_INFO_FILENAME = "build-info.json";

const UNKNOWN: BuildMetadata = Object.freeze({
  version: "unknown",
  commit: "unknown",
  commitShort: "unknown",
  buildTime: "unknown",
  source: "fallback",
});

/**
 * Read `dist/build-info.json` from a known location. Returns `null` on
 * any failure — caller falls through to runtime detection.
 */
function readBuildInfoFile(path: string): BuildMetadata | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    const data = JSON.parse(raw) as Partial<BuildMetadata>;
    const commit = typeof data.commit === "string" && data.commit.length > 0 ? data.commit : "unknown";
    return Object.freeze({
      version: typeof data.version === "string" && data.version.length > 0 ? data.version : "unknown",
      commit,
      commitShort: commit === "unknown" ? "unknown" : commit.slice(0, 8),
      buildTime: typeof data.buildTime === "string" && data.buildTime.length > 0 ? data.buildTime : "unknown",
      source: "build-info" as const,
    });
  } catch {
    return null;
  }
}

function readPackageVersion(projectRoot: string): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(projectRoot, "package.json"), "utf-8")) as { version?: string };
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

function readGitCommit(projectRoot: string): string {
  try {
    const out = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: projectRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim() || "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Best-effort guess at the project root by walking up from `start`
 * until a directory containing `package.json` is found, capped at 6
 * parents. Used when no projectRoot is passed.
 */
function inferProjectRoot(start: string): string {
  let cur = start;
  for (let i = 0; i < 6; i += 1) {
    if (existsSync(resolve(cur, "package.json"))) return cur;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return start;
}

/**
 * Resolve the location this module is loaded from. When running from
 * `dist/core/build-metadata.js`, `dist/build-info.json` is one level up;
 * when running from `core/build-metadata.ts` via tsx (dev), no
 * build-info file exists and we fall through to runtime detection.
 */
function defaultBuildInfoPath(): string {
  const here = fileURLToPath(import.meta.url);
  return resolve(dirname(here), "..", BUILD_INFO_FILENAME);
}

let cached: BuildMetadata | null = null;

export interface BuildMetadataOptions {
  /** Override the project root used for runtime fallback git/package reads. */
  readonly projectRoot?: string;
  /** Override the build-info.json path. */
  readonly buildInfoPath?: string;
  /** Force a fresh resolve even if a cached value exists. */
  readonly fresh?: boolean;
}

export function getBuildMetadata(opts: BuildMetadataOptions = {}): BuildMetadata {
  if (cached && !opts.fresh) return cached;

  const buildInfoPath = opts.buildInfoPath ?? defaultBuildInfoPath();
  const fromFile = readBuildInfoFile(buildInfoPath);
  if (fromFile) {
    cached = fromFile;
    return cached;
  }

  const projectRoot = opts.projectRoot ?? inferProjectRoot(dirname(fileURLToPath(import.meta.url)));
  const version = readPackageVersion(projectRoot);
  const commit = readGitCommit(projectRoot);
  const buildTime = (() => {
    // Dev mode: stamp with "now" so the server boot log carries a
    // wall-clock timestamp the operator can compare against the
    // dist mtime — not as reliable as build-info but better than
    // "unknown".
    return new Date().toISOString();
  })();

  cached = Object.freeze({
    version,
    commit,
    commitShort: commit === "unknown" ? "unknown" : commit.slice(0, 8),
    buildTime,
    source: "git-runtime" as const,
  });
  return cached;
}

/** Reset the in-process cache. Test-only — do not call in production code. */
export function clearBuildMetadataCache(): void {
  cached = null;
}

/** Returned when a doctor/staleness check has all the inputs it needs. */
export interface SourceFreshness {
  /** Most recent mtime across the source globs (TS files). */
  readonly newestSourceMtime: number;
  /** Mtime of the dist build-info file (the build's own clock). */
  readonly distBuildTime: number;
  /** True when source has been edited since the dist was built. */
  readonly sourceNewerThanDist: boolean;
  /** Path that produced `newestSourceMtime`. */
  readonly newestSourcePath: string;
}

/**
 * Compare source-file mtimes to the dist build-info mtime. Skipped
 * (returns null) when the dist build-info file is missing — there is
 * nothing to compare against. Used by `aedis doctor` and the burn-in
 * preamble to flag a stale-dist server before it eats more runs.
 */
export function detectSourceNewerThanDist(
  projectRoot: string,
  scanDirs: readonly string[] = ["core", "server", "workers", "cli", "router"],
): SourceFreshness | null {
  const buildInfoPath = resolve(projectRoot, "dist", BUILD_INFO_FILENAME);
  if (!existsSync(buildInfoPath)) return null;
  let distBuildTime: number;
  try {
    distBuildTime = statSync(buildInfoPath).mtimeMs;
  } catch {
    return null;
  }

  let newestSourceMtime = 0;
  let newestSourcePath = "";
  const walk = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as Dirent[];
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!/\.(ts|tsx|mts|cts)$/.test(entry.name)) continue;
      try {
        const m = statSync(full).mtimeMs;
        if (m > newestSourceMtime) {
          newestSourceMtime = m;
          newestSourcePath = full;
        }
      } catch {
        /* ignore */
      }
    }
  };
  for (const sub of scanDirs) {
    const full = resolve(projectRoot, sub);
    if (existsSync(full)) walk(full);
  }
  if (newestSourceMtime === 0) {
    // Couldn't find any source — treat as inconclusive.
    return null;
  }
  return {
    newestSourceMtime,
    distBuildTime,
    sourceNewerThanDist: newestSourceMtime > distBuildTime,
    newestSourcePath,
  };
}

/** Convenient unknown sentinel for callers that want a typed default. */
export const UNKNOWN_BUILD_METADATA: BuildMetadata = UNKNOWN;
