/**
 * WorkspaceManager — Disposable isolated workspace for Aedis runs.
 *
 * SAFETY INVARIANT: Aedis must NEVER mutate the original source repo
 * during experimental runs. All file writes, git operations, and
 * verification steps happen inside a disposable workspace.
 *
 * Workspace lifecycle:
 *   1. createWorkspace() — git worktree or temp clone from source
 *   2. All builder/verifier work targets workspace path
 *   3. On success: generatePatch() produces a promotion-ready artifact
 *   4. On failure: discardWorkspace() cleans up
 *   5. Promotion into source is a separate, explicit step
 *
 * The workspace is a real git working tree so git operations (add,
 * commit, diff, apply) work normally inside it. The source repo's
 * working tree and index are never touched.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { mkdtemp, rm, writeFile, readFile, mkdir, readdir } from "fs/promises";
import { existsSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";

import {
  PROMOTION_EXCLUDE_PATHSPECS,
  filterRuntimeArtifacts,
} from "./promotion-filter.js";

// AEDIS_TMPDIR lets the operator override where workspaces are created.
// Default is the system temp dir, but large repos can fill small /tmp partitions.
const WORKSPACE_ROOT = process.env.AEDIS_TMPDIR ?? tmpdir();

const exec = promisify(execFile);

// ─── Types ───────────────────────────────────────────────────────────

export interface WorkspaceHandle {
  /** Unique ID for this workspace (matches the run ID). */
  readonly runId: string;
  /** Absolute path to the source repo. NEVER write here. */
  readonly sourceRepo: string;
  /** Commit SHA the workspace was created from. */
  readonly sourceCommitSha: string;
  /** Absolute path to the disposable workspace. ALL writes go here. */
  readonly workspacePath: string;
  /** How the workspace was created. */
  readonly method: "worktree" | "clone" | "copy";
  /** ISO timestamp of creation. */
  readonly createdAt: string;
  /** Git branch name used in the worktree (if method === "worktree"). */
  readonly worktreeBranch: string | null;
}

export interface WorkspaceCleanupResult {
  readonly success: boolean;
  readonly method: "worktree_remove" | "rm_rf" | "failed";
  readonly error: string | null;
  readonly durationMs: number;
}

export interface PatchArtifact {
  /** Full unified diff of all changes in the workspace. */
  readonly diff: string;
  /** List of changed file paths (relative to workspace root). */
  readonly changedFiles: readonly string[];
  /** The commit SHA in the workspace (if committed). */
  readonly commitSha: string | null;
  /** ISO timestamp. */
  readonly generatedAt: string;
}

// ─── Workspace Manager ──────────────────────────────────────────────

/**
 * Create a disposable workspace from a source repo.
 *
 * Strategy (in order of preference):
 *   1. git worktree add — lightweight, shares .git objects
 *   2. git clone --local — full copy but uses hardlinks
 *   3. directory copy — fallback for non-git repos
 *
 * The workspace path is always under the system temp directory to
 * ensure cleanup even on abnormal termination.
 */
export async function createWorkspace(
  sourceRepo: string,
  runId: string,
): Promise<WorkspaceHandle> {
  const absSource = resolve(sourceRepo);
  const createdAt = new Date().toISOString();
  let sourceCopyableAtStart = false;
  let sourceEmptyAtStart = false;
  try {
    const entries = await readdir(absSource);
    sourceCopyableAtStart = true;
    sourceEmptyAtStart = entries.length === 0;
  } catch {
    sourceCopyableAtStart = false;
  }

  // Get current commit SHA from source
  let sourceCommitSha: string;
  try {
    const { stdout } = await exec("git", ["rev-parse", "HEAD"], {
      cwd: absSource,
      timeout: 10_000,
    });
    sourceCommitSha = stdout.trim();
  } catch {
    sourceCommitSha = "unknown";
  }

  // Try git worktree first
  const worktreeResult = await tryWorktree(absSource, runId, sourceCommitSha, createdAt);
  if (worktreeResult) return worktreeResult;

  // Fallback: git clone --local
  const cloneResult = await tryClone(absSource, runId, sourceCommitSha, createdAt);
  if (cloneResult) return cloneResult;

  // Last resort: directory copy
  if (!sourceCopyableAtStart) {
    throw new Error(`Source path does not exist or is not readable: ${absSource}`);
  }
  if (sourceEmptyAtStart) {
    throw new Error(`Source path is empty: ${absSource}`);
  }
  return await copyWorkspace(absSource, runId, sourceCommitSha, createdAt);
}

/**
 * Discard a workspace. Always succeeds at the logical level — even if
 * cleanup fails, the workspace is marked as discarded and the error
 * is surfaced explicitly (CLEANUP_ERROR).
 *
 * SAFETY: cleanup failure is NEVER silent. The caller must check
 * result.success and surface the error if false.
 */
export async function discardWorkspace(
  handle: WorkspaceHandle,
): Promise<WorkspaceCleanupResult> {
  const start = Date.now();

  // Worktree: remove via git worktree remove
  if (handle.method === "worktree" && handle.worktreeBranch) {
    try {
      await exec("git", ["worktree", "remove", "--force", handle.workspacePath], {
        cwd: handle.sourceRepo,
        timeout: 30_000,
      });
      // Clean up the temporary branch
      try {
        await exec("git", ["branch", "-D", handle.worktreeBranch], {
          cwd: handle.sourceRepo,
          timeout: 10_000,
        });
      } catch {
        // Branch cleanup is best-effort
      }
      return {
        success: true,
        method: "worktree_remove",
        error: null,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[workspace] worktree remove failed: ${msg} — falling back to rm`);
      // Fall through to rm -rf
    }
  }

  // Fallback: rm -rf the workspace directory
  try {
    await rm(handle.workspacePath, { recursive: true, force: true });
    return {
      success: true,
      method: "rm_rf",
      error: null,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[workspace] CLEANUP FAILED: ${msg}`);
    return {
      success: false,
      method: "failed",
      error: msg,
      durationMs: Date.now() - start,
    };
  }
}

/**
 * Generate a promotion-ready patch artifact from the workspace.
 * This captures the full diff between the source commit and the
 * current workspace state. The artifact is self-contained — it
 * can be applied to the source repo later via `git apply`.
 */
export async function generatePatch(
  handle: WorkspaceHandle,
): Promise<PatchArtifact> {
  const generatedAt = new Date().toISOString();

  // Pathspec arguments that exclude Aedis runtime artifacts from every
  // git query below. The leading "." is a positive pathspec (without a
  // positive entry, exclude-only pathspecs match nothing). This stops
  // `.aedis/memory.json`, workspace-local receipts, and similar Aedis-
  // written files from ever showing up in the patch artifact, so they
  // cannot be staged into a promoted commit.
  const excludePathspecs = [".", ...PROMOTION_EXCLUDE_PATHSPECS];

  try {
    // Determine whether the workspace has its own commit. Drives both
    // diff source (commit-range vs working-tree) and changedFiles
    // source (diff --name-only vs status --porcelain) so they always
    // agree on what is in the patch.
    let workspaceHead: string | null = null;
    try {
      const { stdout: headOut } = await exec("git", ["rev-parse", "HEAD"], { cwd: handle.workspacePath, timeout: 5_000 });
      const parsed = headOut.trim();
      if (parsed && parsed !== handle.sourceCommitSha) workspaceHead = parsed;
    } catch { /* no commit yet */ }

    // Get the diff — prefer commit diff if available, else working tree diff
    let diff = "";
    if (workspaceHead) {
      // We committed — get the diff from the source commit to HEAD,
      // scoped to the non-runtime-artifact pathspecs.
      const { stdout: patchDiff } = await exec(
        "git", ["diff", `${handle.sourceCommitSha}..${workspaceHead}`, "--", ...excludePathspecs],
        { cwd: handle.workspacePath, timeout: 30_000, maxBuffer: 10 * 1024 * 1024 },
      );
      diff = patchDiff;
    }
    if (!diff) {
      const { stdout: workingDiff } = await exec(
        "git", ["diff", "HEAD", "--", ...excludePathspecs],
        { cwd: handle.workspacePath, timeout: 30_000, maxBuffer: 10 * 1024 * 1024 },
      );
      diff = workingDiff;
    }

    // Source the file list from the SAME range as the diff. When the
    // workspace has committed, `git status --porcelain` is empty (the
    // index matches HEAD), so we need `git diff --name-only` against
    // the source commit instead. Otherwise downstream promotion sees an
    // empty changedFiles list and falls back to `git add -A`, which is
    // exactly how `.aedis/memory.json` leaked into the absent-pianist
    // 5838aad commit.
    //
    // The `-u` flag on `git status` (no-commit branch) enumerates
    // untracked files individually instead of collapsing them to a
    // single `?? .aedis/` line — without it the exclude pathspecs
    // match the directory rather than the runtime artifact inside.
    let rawFiles: string[];
    if (workspaceHead) {
      const { stdout: nameOnly } = await exec(
        "git",
        ["diff", "--name-only", `${handle.sourceCommitSha}..${workspaceHead}`, "--", ...excludePathspecs],
        { cwd: handle.workspacePath, timeout: 10_000 },
      );
      rawFiles = nameOnly.split("\n").filter(Boolean).map((s) => s.trim());
    } else {
      const { stdout: statusOutput } = await exec(
        "git",
        ["status", "--porcelain", "-u", "--", ...excludePathspecs],
        { cwd: handle.workspacePath, timeout: 10_000 },
      );
      rawFiles = statusOutput.split("\n").filter(Boolean).map((line) => line.slice(3).trim());
    }
    // Belt-and-suspenders: filter once more against the canonical
    // denylist in case the underlying git treats exclude pathspecs
    // differently on this host.
    const changedFiles = filterRuntimeArtifacts(rawFiles);
    const changedSet = new Set(changedFiles);

    // `git diff HEAD` does not include untracked files. Generate a
    // normal file-creation patch for each untracked file that survived
    // the promotion filter so `changedFiles` and `diff` describe the
    // same artifact. `git diff --no-index` exits 1 when differences are
    // found, so capture stdout from both resolve and reject paths.
    let untrackedDiff = "";
    if (!workspaceHead) {
      const { stdout: untrackedOut } = await exec(
        "git",
        ["ls-files", "--others", "--exclude-standard", "--", ...excludePathspecs],
        { cwd: handle.workspacePath, timeout: 10_000 },
      );
      const untrackedFiles = filterRuntimeArtifacts(
        untrackedOut.split("\n").filter(Boolean).map((s) => s.trim()),
      ).filter((file) => changedSet.has(file));
      const chunks: string[] = [];
      for (const file of untrackedFiles) {
        const stdout = await diffFileAgainstNull(handle.workspacePath, file);
        if (stdout.trim()) chunks.push(stdout);
      }
      untrackedDiff = chunks.join("\n");
    }

    const commitSha: string | null = workspaceHead;

    const fullDiff = [diff, untrackedDiff].filter(Boolean).join("\n");

    return {
      diff: fullDiff,
      changedFiles,
      commitSha,
      generatedAt,
    };
  } catch (err) {
    // If we can't generate a diff, return empty with error info
    console.error(
      `[workspace] generatePatch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return {
      diff: "",
      changedFiles: [],
      commitSha: null,
      generatedAt,
    };
  }
}

async function diffFileAgainstNull(cwd: string, file: string): Promise<string> {
  try {
    const { stdout } = await exec(
      "git",
      ["diff", "--no-index", "--", "/dev/null", file],
      { cwd, timeout: 10_000, maxBuffer: 10 * 1024 * 1024 },
    );
    return stdout;
  } catch (err) {
    const stdout = (err as { stdout?: string })?.stdout;
    return typeof stdout === "string" ? stdout : "";
  }
}

/**
 * Verify that a path is inside the workspace and NOT inside the
 * source repo. This is the safety gate that prevents accidental
 * writes to the original repo.
 *
 * Returns true only if the resolved path starts with the workspace
 * path AND does not start with the source repo path.
 */
export function isInsideWorkspace(
  filePath: string,
  handle: WorkspaceHandle,
): boolean {
  const abs = resolve(filePath);
  const wsPrefix = resolve(handle.workspacePath);
  const srcPrefix = resolve(handle.sourceRepo);

  // Must be inside workspace
  if (!abs.startsWith(wsPrefix + "/") && abs !== wsPrefix) {
    return false;
  }

  // Must NOT be inside source (in case workspace is a subdirectory of source)
  if (abs.startsWith(srcPrefix + "/") || abs === srcPrefix) {
    // Unless workspace IS inside source (worktree case) — check workspace first
    if (!abs.startsWith(wsPrefix + "/") && abs !== wsPrefix) {
      return false;
    }
  }

  return true;
}

/**
 * Save a receipt artifact to the workspace's .aedis directory.
 * This ensures receipts survive even if the run fails.
 */
export async function saveWorkspaceReceipt(
  handle: WorkspaceHandle,
  filename: string,
  content: string,
): Promise<void> {
  const receiptDir = join(handle.workspacePath, ".aedis", "receipts");
  await mkdir(receiptDir, { recursive: true });
  await writeFile(join(receiptDir, filename), content, "utf-8");
}

// ─── Internal Strategies ────────────────────────────────────────────

async function tryWorktree(
  sourceRepo: string,
  runId: string,
  sourceCommitSha: string,
  createdAt: string,
): Promise<WorkspaceHandle | null> {
  try {
    // Verify source is a git repo
    await exec("git", ["rev-parse", "--git-dir"], {
      cwd: sourceRepo,
      timeout: 5_000,
    });

    const workspacePath = join(WORKSPACE_ROOT, `aedis-ws-${runId.slice(0, 8)}-${Date.now()}`);
    const branchName = `aedis/workspace/${runId.slice(0, 8)}`;

    // Create a detached worktree from HEAD
    await exec(
      "git",
      ["worktree", "add", "--detach", workspacePath, "HEAD"],
      { cwd: sourceRepo, timeout: 30_000 },
    );

    // Create a branch in the worktree for commits
    await exec(
      "git",
      ["checkout", "-b", branchName],
      { cwd: workspacePath, timeout: 10_000 },
    );

    console.log(
      `[workspace] created worktree: ${workspacePath} (branch: ${branchName})`,
    );

    return {
      runId,
      sourceRepo,
      sourceCommitSha,
      workspacePath,
      method: "worktree",
      createdAt,
      worktreeBranch: branchName,
    };
  } catch (err) {
    console.warn(
      `[workspace] worktree failed: ${err instanceof Error ? err.message : String(err)} — trying clone`,
    );
    return null;
  }
}

async function tryClone(
  sourceRepo: string,
  runId: string,
  sourceCommitSha: string,
  createdAt: string,
): Promise<WorkspaceHandle | null> {
  try {
    const workspacePath = join(WORKSPACE_ROOT, `aedis-ws-${runId.slice(0, 8)}-${Date.now()}`);

    await exec(
      "git",
      ["clone", "--local", "--no-hardlinks", sourceRepo, workspacePath],
      { cwd: sourceRepo, timeout: 60_000 },
    );

    console.log(`[workspace] created local clone: ${workspacePath}`);

    return {
      runId,
      sourceRepo,
      sourceCommitSha,
      workspacePath,
      method: "clone",
      createdAt,
      worktreeBranch: null,
    };
  } catch (err) {
    console.warn(
      `[workspace] clone failed: ${err instanceof Error ? err.message : String(err)} — trying copy`,
    );
    return null;
  }
}

async function copyWorkspace(
  sourceRepo: string,
  runId: string,
  sourceCommitSha: string,
  createdAt: string,
): Promise<WorkspaceHandle> {
  if (!existsSync(sourceRepo)) {
    throw new Error(`Source path does not exist: ${sourceRepo}`);
  }
  const sourceEntries = await readdir(sourceRepo);
  if (sourceEntries.length === 0) {
    throw new Error(`Source path is empty: ${sourceRepo}`);
  }

  const workspacePath = await mkdtemp(join(WORKSPACE_ROOT, `aedis-ws-${runId.slice(0, 8)}-`));

  try {
    // Use cp -a for a faithful copy
    await exec("cp", ["-a", `${sourceRepo}/.`, workspacePath], {
      timeout: 120_000,
    });
  } catch (err) {
    await rm(workspacePath, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }

  console.log(`[workspace] created directory copy: ${workspacePath}`);

  return {
    runId,
    sourceRepo,
    sourceCommitSha,
    workspacePath,
    method: "copy",
    createdAt,
    worktreeBranch: null,
  };
}
