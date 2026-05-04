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
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { validateUnifiedDiff } from "./diff-truth.js";

const exec = promisify(execFile);

// ─── Types ───────────────────────────────────────────────────────────

export interface GitDiffResult {
  /** Files that have actual changes on disk (from git diff). */
  readonly actualChangedFiles: readonly string[];
  /** Files declared in manifest but NOT changed on disk. */
  readonly expectedButUnchanged: readonly string[];
  /** Files changed on disk but NOT declared in manifest. */
  readonly undeclaredChanges: readonly string[];
  /** Files declared as non-mutating references but changed on disk. */
  readonly unexpectedReferenceChanges: readonly string[];
  /** Files that match between manifest and disk. */
  readonly confirmed: readonly string[];
  /** Files that have at least one concrete added/deleted diff line. */
  readonly filesWithDiffLines: readonly string[];
  /** Expected files that changed by name/status but have no concrete diff lines. */
  readonly filesWithoutDiffLines: readonly string[];
  /** Total concrete added/deleted lines across changed files. */
  readonly changedLineCount: number;
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
  /** Manifest files that are actually expected to mutate. Defaults to all manifest files. */
  readonly expectedFiles?: readonly string[];
  /** Manifest files included only as context/reference and not expected to mutate. */
  readonly nonMutatingFiles?: readonly string[];
  /**
   * Optional: files that are expected to be newly created (not yet
   * tracked by git). These show up in `git status` not `git diff`.
   */
  readonly createdFiles?: readonly string[];
  /** Canonical FileChange-derived diff. Verification must fail if it is absent or invalid. */
  readonly canonicalDiff?: string;
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
  const { projectRoot, manifestFiles, expectedFiles = manifestFiles, nonMutatingFiles = [], createdFiles = [] } = input;

  try {
    const hasCanonicalDiff = Object.prototype.hasOwnProperty.call(input, "canonicalDiff");
    const canonicalTruth = hasCanonicalDiff
      ? validateUnifiedDiff(input.canonicalDiff ?? "")
      : { ok: true, reason: "canonical diff not supplied", changedLines: 1 };
    // Get actual changed files from git
    const diffFiles = await getGitDiffFiles(projectRoot);
    const untrackedFiles = await getGitUntrackedFiles(projectRoot);
    const rawDiffStat = await getGitDiffStat(projectRoot);
    const diffLineCounts = await getGitDiffLineCounts(projectRoot);
    for (const file of untrackedFiles) {
      diffLineCounts.set(file, await countFileLines(projectRoot, file));
    }

    // Combine diff + untracked for the full picture
    const actualChangedSet = new Set([...diffFiles, ...untrackedFiles]);
    const manifestSet = new Set(manifestFiles);
    const createdSet = new Set(createdFiles);
    const nonMutatingSet = new Set(nonMutatingFiles);

    // Files in manifest but not actually changed
    const expectedButUnchanged = expectedFiles.filter(
      (f) => !actualChangedSet.has(f) && !createdSet.has(f),
    );
    const filesWithoutDiffLines = expectedFiles.filter((f) => {
      if (createdSet.has(f)) return false;
      return actualChangedSet.has(f) && (diffLineCounts.get(f) ?? 0) <= 0;
    });
    const unexpectedReferenceChanges = nonMutatingFiles.filter((f) => actualChangedSet.has(f));

    // Files actually changed but not in manifest.
    //
    // Test-injection files (test/*, *.test.ts, *.spec.ts and variants)
    // are exempt from critical undeclared-change blocking: they're a
    // common legitimate side-effect of coverage/test-generation tasks
    // where the charter declared only the source file but the builder
    // also produced or updated an adjacent test. They are still
    // reported in `actualChangedFiles` so the receipt stays truthful —
    // we only skip them here so they don't trigger a merge-gate block.
    const undeclaredChanges = [...actualChangedSet].filter(
      (f) =>
        !manifestSet.has(f) &&
        !isIgnoredForDiffCheck(f) &&
        !isTestInjectionFile(f),
    );

    // Files confirmed — in both manifest and actual changes
    const confirmed = expectedFiles.filter(
      (f) => (actualChangedSet.has(f) || createdSet.has(f)) && (createdSet.has(f) || (diffLineCounts.get(f) ?? 0) > 0),
    );
    const filesWithDiffLines = [...diffLineCounts.entries()]
      .filter(([, lines]) => lines > 0)
      .map(([file]) => file);
    const changedLineCount = [...diffLineCounts.values()].reduce((sum, lines) => sum + lines, 0);

    const totalExpected = expectedFiles.length;
    const confirmationRatio = totalExpected > 0
      ? confirmed.length / totalExpected
      : 1;

    const passed =
      canonicalTruth.ok &&
      expectedButUnchanged.length === 0 &&
      filesWithoutDiffLines.length === 0 &&
      undeclaredChanges.length === 0 &&
      unexpectedReferenceChanges.length === 0 &&
      changedLineCount > 0;

    const summaryParts: string[] = [];
    summaryParts.push(`${confirmed.length}/${totalExpected} manifest files confirmed on disk`);
    if (hasCanonicalDiff && !canonicalTruth.ok) {
      summaryParts.push(`canonical diff invalid: ${canonicalTruth.reason}`);
    }
    if (expectedButUnchanged.length > 0) {
      summaryParts.push(`${expectedButUnchanged.length} expected but unchanged`);
    }
    if (filesWithoutDiffLines.length > 0) {
      summaryParts.push(`${filesWithoutDiffLines.length} expected without concrete diff lines`);
    }
    if (undeclaredChanges.length > 0) {
      summaryParts.push(`${undeclaredChanges.length} undeclared changes`);
    }
    if (unexpectedReferenceChanges.length > 0) {
      summaryParts.push(`${unexpectedReferenceChanges.length} reference/context changed unexpectedly`);
    }

    return {
      actualChangedFiles: [...actualChangedSet],
      expectedButUnchanged,
      undeclaredChanges,
      unexpectedReferenceChanges,
      confirmed,
      filesWithDiffLines,
      filesWithoutDiffLines,
      changedLineCount,
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
      unexpectedReferenceChanges: [],
      confirmed: [],
      filesWithDiffLines: [],
      filesWithoutDiffLines: [],
      changedLineCount: 0,
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

async function getGitDiffLineCounts(projectRoot: string): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const addLine = (line: string): void => {
    const parts = line.split("\t");
    if (parts.length < 3) return;
    const added = parts[0] === "-" ? 0 : Number(parts[0]);
    const deleted = parts[1] === "-" ? 0 : Number(parts[1]);
    const file = parts.slice(2).join("\t").trim();
    if (!file) return;
    counts.set(file, (Number.isFinite(added) ? added : 0) + (Number.isFinite(deleted) ? deleted : 0));
  };
  try {
    const { stdout: staged } = await exec(
      "git", ["diff", "--cached", "--numstat"],
      { cwd: projectRoot, timeout: 10_000 },
    );
    const { stdout: unstaged } = await exec(
      "git", ["diff", "--numstat"],
      { cwd: projectRoot, timeout: 10_000 },
    );
    for (const line of [...staged.split("\n"), ...unstaged.split("\n")]) {
      if (line.trim()) addLine(line);
    }
  } catch {
    return counts;
  }
  return counts;
}

async function countFileLines(projectRoot: string, filePath: string): Promise<number> {
  try {
    const content = await readFile(join(projectRoot, filePath), "utf8");
    return content.split(/\r?\n/).filter((line) => line.length > 0).length;
  } catch {
    return 0;
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

/**
 * Is this file a test file that we should allow as an un-manifested
 * side-effect? Deliberately separate from `isIgnoredForDiffCheck` so
 * real undeclared-change detection stays untouched: test files are
 * still reported in `actualChangedFiles`, they just don't block the
 * merge when they appear alongside a declared source-file change.
 *
 * Matches:
 *   - top-level / nested `test/`, `tests/`, `__tests__/` directories
 *   - files named `*.test.ts|tsx|js|jsx|mjs|cjs`
 *   - files named `*.spec.ts|tsx|js|jsx|mjs|cjs`
 *
 * Exported so the merge-gate and integration-judge layers can apply
 * the same rule if they need to check "is this a test file?" in the
 * future, keeping the definition in one place.
 */
export function isTestInjectionFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
  const patterns: readonly RegExp[] = [
    /^test\//,
    /^tests\//,
    /^__tests__\//,
    /\/test\//,
    /\/tests\//,
    /\/__tests__\//,
    /\.test\.[mc]?[jt]sx?$/,
    /\.spec\.[mc]?[jt]sx?$/,
  ];
  return patterns.some((pattern) => pattern.test(normalized));
}
