/**
 * Server-staleness assessment — pure projection used by `aedis doctor`,
 * the burn-in preamble, and the TUI dashboard so the same three checks
 * are evaluated identically everywhere. Catches the "fixed code but
 * old server still running" trap that wasted a session worth of time
 * before it became hard to ignore.
 *
 * Three independent stale conditions, any one of which triggers:
 *   1. commit-mismatch — the running server's build commit is not the
 *      same as the source checkout's commit. The fix Aedis built is
 *      not the code answering requests.
 *   2. dist-older-than-source — the dist build-info file mtime is
 *      older than the newest source file. There's a fresher build
 *      sitting unbuilt, or there's no build at all.
 *   3. uptime-predates-build — the server's startedAt is older than
 *      the local dist build-info time. A fresh build landed AFTER
 *      the server started, so the server is now running stale code
 *      even though dist on disk is current.
 *
 * Every input is optional. Missing data is NOT inferred as stale —
 * if we can't tell, the contract is "unknown" and the caller surfaces
 * a separate "metadata missing" warning. Conservative on stale,
 * loud on missing.
 */

export interface StalenessInput {
  /** Local source commit (from a fresh build-info or `git rev-parse`). */
  readonly localCommit?: string;
  /** Server-reported build commit (from /health.build.commit). */
  readonly serverCommit?: string;
  /**
   * Dist build-info mtime in milliseconds since epoch — the time a
   * `npm run build` last produced output. Compared against newest
   * source mtime for condition (2) and against server startedAt
   * for condition (3).
   */
  readonly distBuildTimeMs?: number;
  /** Newest source file mtime, milliseconds since epoch. */
  readonly newestSourceMtimeMs?: number;
  /** Path to the newest source file, surfaced in the reason line. */
  readonly newestSourcePath?: string;
  /** Server uptime: when the server process started, ISO string. */
  readonly serverStartedAtIso?: string;
}

/**
 * One stale condition. `code` is machine-stable so the burn-in
 * harness can switch on it; `message` is human-facing.
 */
export interface StalenessReason {
  readonly code:
    | "commit-mismatch"
    | "dist-older-than-source"
    | "uptime-predates-build";
  readonly message: string;
}

export interface StalenessResult {
  /** True iff at least one stale condition fired. */
  readonly stale: boolean;
  /** Empty when `stale` is false; one entry per fired condition otherwise. */
  readonly reasons: readonly StalenessReason[];
}

const UNKNOWN_TOKENS: ReadonlySet<string> = new Set(["", "unknown"]);

function isKnown(s: string | undefined): s is string {
  return typeof s === "string" && !UNKNOWN_TOKENS.has(s);
}

/**
 * Check every stale condition. Pure — no I/O, no clocks, no env reads.
 * Caller supplies whatever signals it has; missing signals are not
 * inferred as stale.
 */
export function assessStaleness(input: StalenessInput): StalenessResult {
  const reasons: StalenessReason[] = [];

  // ── 1. commit mismatch ────────────────────────────────────────────
  // The running build commit doesn't match the source checkout — the
  // fix you just made isn't what's answering requests. Fires only
  // when both sides are known; missing values are surfaced separately.
  if (
    isKnown(input.localCommit) &&
    isKnown(input.serverCommit) &&
    input.localCommit !== input.serverCommit
  ) {
    reasons.push({
      code: "commit-mismatch",
      message:
        `running server commit ${input.serverCommit.slice(0, 8)} does NOT ` +
        `match local source commit ${input.localCommit.slice(0, 8)} — the ` +
        `running build is not from this checkout`,
    });
  }

  // ── 2. dist build older than source ───────────────────────────────
  // There is uncompiled work newer than the dist on disk. Even if the
  // server happens to be running the right commit, a `npm run build`
  // is needed before the latest source can ship. Fires when both
  // signals are present.
  if (
    typeof input.distBuildTimeMs === "number" &&
    typeof input.newestSourceMtimeMs === "number" &&
    input.newestSourceMtimeMs > input.distBuildTimeMs
  ) {
    const lagSec = Math.max(
      0,
      Math.round((input.newestSourceMtimeMs - input.distBuildTimeMs) / 1000),
    );
    const path = input.newestSourcePath ? ` (${input.newestSourcePath})` : "";
    reasons.push({
      code: "dist-older-than-source",
      message:
        `source is ${lagSec}s newer than dist/build-info.json${path} — ` +
        `run \`npm run build\` to refresh the build`,
    });
  }

  // ── 3. server uptime predates latest build ────────────────────────
  // The dist on disk is newer than when the server started. A build
  // happened after the server started, so the server is running an
  // older dist than is on disk. Restart needed.
  if (
    typeof input.distBuildTimeMs === "number" &&
    typeof input.serverStartedAtIso === "string"
  ) {
    const startedMs = Date.parse(input.serverStartedAtIso);
    if (!Number.isNaN(startedMs) && input.distBuildTimeMs > startedMs) {
      const lagSec = Math.max(
        0,
        Math.round((input.distBuildTimeMs - startedMs) / 1000),
      );
      reasons.push({
        code: "uptime-predates-build",
        message:
          `server started ${lagSec}s before the current dist was built — ` +
          `restart the server to pick up the newer build`,
      });
    }
  }

  return { stale: reasons.length > 0, reasons };
}
