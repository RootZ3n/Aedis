import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export type SafePathOperation = "read" | "write" | "delete";

export class SafePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SafePathError";
  }
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function canonicalRoot(root: string): Promise<string> {
  const abs = resolve(root);
  try {
    return await realpath(abs);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new SafePathError(`Safe path root does not exist: ${abs} (${msg})`);
  }
}

/**
 * Resolve a user/model supplied path under root and prove that every existing
 * path component either is inside root or is a symlink resolving inside root.
 * Missing final targets are allowed for writes/deletes, but their existing
 * parent chain must still be contained.
 */
export async function resolveSafePath(
  root: string,
  requestedPath: string,
  operation: SafePathOperation,
): Promise<string> {
  const rootAbs = resolve(root);
  const rootReal = await canonicalRoot(rootAbs);
  const targetAbs = resolve(rootAbs, requestedPath);

  if (!isWithin(rootAbs, targetAbs)) {
    throw new SafePathError(`Path escapes root by traversal: ${requestedPath}`);
  }

  const rel = relative(rootAbs, targetAbs);
  if (rel === "") return rootReal;
  const parts = rel.split(/[\\/]+/).filter(Boolean);

  let currentLexical = rootAbs;
  for (let i = 0; i < parts.length; i++) {
    currentLexical = resolve(currentLexical, parts[i]!);
    let stat;
    try {
      stat = await lstat(currentLexical);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") {
        if (operation === "read") {
          throw new SafePathError(`Path does not exist inside root: ${requestedPath}`);
        }
        return targetAbs;
      }
      throw err;
    }

    if (stat.isSymbolicLink()) {
      const linkedReal = await realpath(currentLexical);
      if (!isWithin(rootReal, linkedReal)) {
        throw new SafePathError(`Path escapes root through symlink: ${requestedPath}`);
      }
    } else {
      const currentReal = await realpath(currentLexical);
      if (!isWithin(rootReal, currentReal)) {
        throw new SafePathError(`Path escapes root: ${requestedPath}`);
      }
    }
  }

  return targetAbs;
}

export async function resolveSafeExistingPath(root: string, requestedPath: string): Promise<string> {
  return resolveSafePath(root, requestedPath, "read");
}

export async function resolveSafeWritePath(root: string, requestedPath: string): Promise<string> {
  return resolveSafePath(root, requestedPath, "write");
}

export async function resolveSafeDeletePath(root: string, requestedPath: string): Promise<string> {
  return resolveSafePath(root, requestedPath, "delete");
}

export function assertRelativePath(requestedPath: string): void {
  if (requestedPath.length === 0 || isAbsolute(requestedPath)) {
    throw new SafePathError(`Expected a relative path inside root: ${requestedPath}`);
  }
  const normalized = requestedPath.replace(/\\/g, "/");
  if (normalized.split("/").some((part) => part === "..")) {
    throw new SafePathError(`Path traversal is not allowed: ${requestedPath}`);
  }
}
