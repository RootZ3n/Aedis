/**
 * Advisory file lock + atomic JSON write helpers.
 *
 * SCOPE: cross-process serialization for writes to single-JSON state
 * files (.aedis/memory.json, .aedis/campaign-registry.json, campaign
 * report files). Two Aedis runs on the same repo will otherwise race
 * and silently clobber each other's learning.
 *
 * This is an ADVISORY lock — it only protects callers that use
 * `withRepoLock` around their read-modify-write. Readers that only
 * call `readFile` are unaffected. That is deliberate: we never want
 * a stuck lockfile to break reads.
 *
 * Lock mechanism: create a sibling `<path>.lock` with `O_EXCL`
 * (via `fs.open(..., 'wx')`). If the file exists, wait and retry up
 * to `timeoutMs`. If the existing lock is older than `staleMs`, it
 * is reclaimed automatically (a prior process crashed without
 * releasing). Lock contents are the PID + ISO timestamp to aid
 * debugging stale locks.
 *
 * Atomic write: tmp+rename so a crash mid-write leaves the previous
 * valid file intact and parseable.
 */

import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";

export interface LockOptions {
  /** Timeout waiting for the lock. Default 10_000ms. */
  timeoutMs?: number;
  /** Poll interval. Default 50ms. */
  pollMs?: number;
  /** Consider a lockfile older than this stale and reclaim it. Default 60_000ms. */
  staleMs?: number;
}

const DEFAULT_TIMEOUT = 10_000;
const DEFAULT_POLL = 50;
const DEFAULT_STALE = 60_000;

/**
 * Run `fn` while holding an advisory lockfile for `lockPath + ".lock"`.
 * Returns whatever `fn` returns; always releases the lock, even on
 * exception. If the timeout is hit, throws `Error` with a message
 * that identifies the holder (best-effort).
 */
export async function withRepoLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  options: LockOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT;
  const pollMs = options.pollMs ?? DEFAULT_POLL;
  const staleMs = options.staleMs ?? DEFAULT_STALE;
  const filePath = `${lockPath}.lock`;

  // Ensure the parent dir exists so we can create the lockfile. The
  // lock is a standalone primitive and should not require callers to
  // mkdir beforehand.
  await mkdir(dirname(filePath), { recursive: true });

  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const handle = await open(filePath, "wx");
      try {
        await handle.writeFile(
          `${process.pid} ${new Date().toISOString()}\n`,
          "utf8",
        );
      } finally {
        await handle.close();
      }
      try {
        return await fn();
      } finally {
        await unlink(filePath).catch(() => undefined);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
      // Lock held — maybe stale?
      try {
        const info = await stat(filePath);
        if (Date.now() - info.mtimeMs > staleMs) {
          await unlink(filePath).catch(() => undefined);
          continue; // retry immediately
        }
      } catch {
        // File vanished between EEXIST and stat — retry
        continue;
      }
      if (Date.now() - start > timeoutMs) {
        let holder = "unknown";
        try {
          holder = (await readFile(filePath, "utf8")).trim();
        } catch { /* best-effort */ }
        throw new Error(
          `withRepoLock: timed out after ${timeoutMs}ms waiting for ${filePath} (held by: ${holder})`,
        );
      }
      await sleep(pollMs);
    }
  }
}

/**
 * Write a JSON value to `path` atomically (tmp+rename). Crash-safe:
 * on partial write, the original file is left intact.
 */
export async function writeJsonAtomicLocked(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

/**
 * Convenience: acquire the advisory lock, then atomic-write JSON.
 * Callers that need to read-modify-write should use `withRepoLock`
 * directly and do the read + write inside the closure.
 */
export async function atomicJsonWrite(path: string, value: unknown, options?: LockOptions): Promise<void> {
  await withRepoLock(path, () => writeJsonAtomicLocked(path, value), options);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Returns true if the lock file currently exists. For debugging/tests. */
export function isLocked(lockPath: string): boolean {
  return existsSync(`${lockPath}.lock`);
}
