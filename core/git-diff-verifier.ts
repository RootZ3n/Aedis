/**
 * GitDiffVerifier — post-execution truth check.
 *
 * After the Builder applies changes, this module runs `git diff`
 * against the working tree to verify what actually changed on disk
 * matches what the change manifest declared.
 *
 * Detects:
 *   - Files expected to change (in manifest) but unchanged on disk
 *   - Files changed on disk but not declared in the manifest
 *   - Diff application failures (manifest says modified, disk shows no diff)
 *
 * The result feeds into:
 *   - IntegrationJudge (manifest completeness)
 *   - Confidence scoring (penalties for discrepancies)
 *   - Run outcome (per-file success/failure)
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

// ─── Types ───────────────────────────────────────────────────────────

export interface GitDiffResult {
  /** Files that have actual changes on disk (from git diff). */
  readonly actualChangedFiles: readonly string[];
  /** Files declared in manifest but NOT changed on disk. */
  readonly expectedButUnchanged: readonly string[];
  /** Files changed on disk but NOT declared in manifest. */
  readonly undeclaredChanges: readonly string[];
  /** Files that match between manifest and disk. */
  readonly confirmed: readonly string[];
  /** Whether the verification passed (no discrepancies). */
  readonly passed: boolean;
  /** Ratio of confirmed files to total expected files. 0-1. */
  readonly confirmationRatio: number;
  /** Human-readable summary. */
  readonly summary: string;
  /** Raw git diff stat output for debugging. */
  readonly rawDiffStat: string;
}

export interface GitDiffInput {
  /** Absolute path to the project root (where git runs). */
  readonly projectRoot: string;
  /** Files declared in the change manifest. */
  readonly manifestFiles: readonly string[];
  /**
   * Optional: files that are expected to be newly created (not yet
   * tracked by git). These show up in `git status` not `git diff`.
   */
  readonly createdFiles?: readonly string[];
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Run git diff and compare the actual working tree changes against
 * the declared change manifest.
 *
 * Should be called after the Builder has applied changes to disk
 * but before git commit.
 */
export async function verifyGitDiff(input: GitDiffInput): Promise<GitDiffResult> {
  const { projectRoot, manifestFiles, createdFiles = [] } = input;

  try {
    // Get actual changed files from git
    const diffFiles = await getGitDiffFiles(projectRoot);
    const untrackedFiles = await getGitUntrackedFiles(projectRoot);
    const rawDiffStat = await getGitDiffStat(projectRoot);

    // Combine diff + untracked for the full picture
    const actualChangedSet = new Set([...diffFiles, ...untrackedFiles]);
    const manifestSet = new Set(manifestFiles);
    const createdSet = new Set(createdFiles);

    // Files in manifest but not actually changed
    const expectedButUnchanged = manifestFiles.filter(
      (f) => !actualChangedSet.has(f) && !createdSet.has(f),
    );

    // Files actually changed but not in manifest
    const undeclaredChanges = [...actualChangedSet].filter(
      (f) => !manifestSet.has(f) && !isIgnoredForDiffCheck(f),
    );

    // Files confirmed — in both manifest and actual changes
    const confirmed = manifestFiles.filter(
      (f) => actualChangedSet.has(f) || createdSet.has(f),
    );

    const totalExpected = manifestFiles.length;
    const confirmationRatio = totalExpected > 0
      ? confirmed.length / totalExpected
      : 1;

    const passed = expectedButUnchanged.length === 0 && undeclaredChanges.length === 0;

    const summaryParts: string[] = [];
    summaryParts.push(`${confirmed.length}/${totalExpected} manifest files confirmed on disk`);
    if (expectedButUnchanged.length > 0) {
      summaryParts.push(`${expectedButUnchanged.length} expected but unchanged`);
    }
    if (undeclaredChanges.length > 0) {
      summaryParts.push(`${undeclaredChanges.length} undeclared changes`);
    }

    return {
      actualChangedFiles: [...actualChangedSet],
      expectedButUnchanged,
      undeclaredChanges,
      confirmed,
      passed,
      confirmationRatio,
      summary: summaryParts.join(", "),
      rawDiffStat,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`[git-diff-verifier] git diff failed: ${message}`);

    return {
      actualChangedFiles: [],
      expectedButUnchanged: [...manifestFiles],
      undeclaredChanges: [],
      confirmed: [],
      passed: false,
      confirmationRatio: 0,
      summary: `git diff failed: ${message}`,
      rawDiffStat: "",
    };
  }
}

// ─── Git Commands ───────────────────────────────────────────────────

async function getGitDiffFiles(projectRoot: string): Promise<string[]> {
  try {
    // --name-only shows just filenames, no content
    // We check both staged and unstaged changes
    const { stdout: staged } = await exec(
      "git", ["diff", "--cached", "--name-only"],
      { cwd: projectRoot, timeout: 10_000 },
    );
    const { stdout: unstaged } = await exec(
      "git", ["diff", "--name-only"],
      { cwd: projectRoot, timeout: 10_000 },
    );

    const files = new Set<string>();
    for (const line of [...staged.split("\n"), ...unstaged.split("\n")]) {
      const trimmed = line.trim();
      if (trimmed) files.add(trimmed);
    }
    return [...files];
  } catch {
    return [];
  }
}

async function getGitUntrackedFiles(projectRoot: string): Promise<string[]> {
  try {
    const { stdout } = await exec(
      "git", ["ls-files", "--others", "--exclude-standard"],
      { cwd: projectRoot, timeout: 10_000 },
    );
    return stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

async function getGitDiffStat(projectRoot: string): Promise<string> {
  try {
    const { stdout } = await exec(
      "git", ["diff", "--stat"],
      { cwd: projectRoot, timeout: 10_000 },
    );
    return stdout;
  } catch {
    return "";
  }
}

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Ignore certain files when checking for undeclared changes.
 * Lock files, build artifacts, etc. can change as side effects
 * of the builder's work and shouldn't be treated as discrepancies.
 */
function isIgnoredForDiffCheck(filePath: string): boolean {
  const ignored = [
    /^package-lock\.json$/,
    /^pnpm-lock\.yaml$/,
    /^yarn\.lock$/,
    /^\.aedis\//,
    /^\.zendorium\//,
    /^state\//,
    /^dist\//,
    /^build\//,
    /^\.next\//,
    /^node_modules\//,
  ];
  return ignored.some((pattern) => pattern.test(filePath));
}
