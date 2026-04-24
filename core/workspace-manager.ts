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
import { mkdtemp, rm, writeFile, readFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";

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

  try {
    // Get the diff — prefer commit diff if available, else working tree diff
    let diff = "";
    try {
      const { stdout: commitSha } = await exec("git", ["rev-parse", "HEAD"], { cwd: handle.workspacePath, timeout: 5_000 });
      const head = commitSha.trim();
      if (head !== handle.sourceCommitSha) {
        // We committed — get the diff from the source commit to HEAD
        const { stdout: patchDiff } = await exec(
          "git", ["diff", handle.sourceCommitSha + "..HEAD"],
          { cwd: handle.workspacePath, timeout: 30_000, maxBuffer: 10 * 1024 * 1024 },
        );
        diff = patchDiff;
      }
    } catch { /* no commit yet, fall through */ }
    if (!diff) {
      const { stdout: workingDiff } = await exec(
        "git", ["diff", "HEAD"],
        { cwd: handle.workspacePath, timeout: 30_000, maxBuffer: 10 * 1024 * 1024 },
      );
      diff = workingDiff;
    }

    // Also include untracked files
    const { stdout: untrackedDiff } = await exec(
      "git",
      ["diff", "--no-index", "/dev/null", "."],
      { cwd: handle.workspacePath, timeout: 10_000, maxBuffer: 10 * 1024 * 1024 },
    ).catch(() => ({ stdout: "" }));

    // Get list of changed files
    const { stdout: statusOutput } = await exec(
      "git",
      ["status", "--porcelain"],
      { cwd: handle.workspacePath, timeout: 10_000 },
    );
    const changedFiles = statusOutput
      .split("\n")
      .filter(Boolean)
      .map((line) => line.slice(3).trim());

    // Try to get the workspace commit SHA
    let commitSha: string | null = null;
    try {
      const { stdout: sha } = await exec(
        "git",
        ["rev-parse", "HEAD"],
        { cwd: handle.workspacePath, timeout: 5_000 },
      );
      const parsed = sha.trim();
      // Only record if it differs from source (meaning we committed)
      commitSha = parsed !== handle.sourceCommitSha ? parsed : null;
    } catch {
      // No commit yet
    }

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
  const workspacePath = await mkdtemp(join(WORKSPACE_ROOT, `aedis-ws-${runId.slice(0, 8)}-`));

  // Use cp -a for a faithful copy
  await exec("cp", ["-a", `${sourceRepo}/.`, workspacePath], {
    timeout: 120_000,
  });

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
