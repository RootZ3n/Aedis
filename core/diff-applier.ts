/**
 * DiffApplier — Applies unified diffs to actual files safely.
 *
 * Safety rules:
 *   - Validate diff format before applying
 *   - Snapshot original content before any change
 *   - Never apply diffs outside repoPath
 *   - Return rollback snapshot always
 *   - Use git apply if available, fallback to manual patch
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { execFile } from "child_process";
import { promisify } from "util";
import { resolve, dirname, relative, sep } from "path";
import { existsSync } from "fs";

const exec = promisify(execFile);

// ─── Types ───────────────────────────────────────────────────────────

export interface ApplyResult {
  success: boolean;
  filesChanged: string[];
  errors: string[];
  rollbackSnapshot: Record<string, string>;
}

// ─── DiffApplier ─────────────────────────────────────────────────────

export class DiffApplier {
  /**
   * Apply a unified diff to files within repoPath.
   * Returns a rollback snapshot regardless of success/failure.
   */
  async apply(diff: string, repoPath: string): Promise<ApplyResult> {
    const absRepo = resolve(repoPath);
    const errors: string[] = [];
    const rollbackSnapshot: Record<string, string> = {};

    if (!this.validateDiff(diff)) {
      return { success: false, filesChanged: [], errors: ["Invalid diff format"], rollbackSnapshot };
    }

    const changedFiles = this.extractChangedFiles(diff);
    if (changedFiles.length === 0) {
      return { success: false, filesChanged: [], errors: ["No files found in diff"], rollbackSnapshot };
    }

    // Safety: verify all files are within repoPath
    for (const file of changedFiles) {
      const absFile = resolve(absRepo, file);
      const normalizedRepo = absRepo.endsWith(sep) ? absRepo : absRepo + sep;
      if (absFile !== absRepo && !absFile.startsWith(normalizedRepo)) {
        return {
          success: false,
          filesChanged: [],
          errors: [`Path traversal blocked: "${file}" resolves outside repo`],
          rollbackSnapshot,
        };
      }
    }

    // Snapshot all existing files before changes
    for (const file of changedFiles) {
      const absFile = resolve(absRepo, file);
      try {
        const content = await readFile(absFile, "utf-8");
        rollbackSnapshot[file] = content;
      } catch {
        // File doesn't exist yet (new file) — snapshot as empty
        rollbackSnapshot[file] = "";
      }
    }

    // Try git apply first
    const gitResult = await this.tryGitApply(diff, absRepo);
    if (gitResult.success) {
      return { success: true, filesChanged: changedFiles, errors: [], rollbackSnapshot };
    }

    // Fallback: manual patch
    const manualResult = await this.manualApply(diff, absRepo);
    if (manualResult.errors.length > 0) {
      errors.push(...manualResult.errors);
    }

    return {
      success: manualResult.filesChanged.length > 0 && errors.length === 0,
      filesChanged: manualResult.filesChanged,
      errors,
      rollbackSnapshot,
    };
  }

  /**
   * Rollback files to their snapshot state.
   */
  async rollback(snapshot: Record<string, string>): Promise<void> {
    for (const [file, content] of Object.entries(snapshot)) {
      try {
        if (content === "") {
          // File was new — we could delete it, but safer to leave as-is
          // and let git clean handle it
          continue;
        }
        const dir = dirname(file);
        if (dir && !existsSync(dir)) {
          await mkdir(dir, { recursive: true });
        }
        await writeFile(file, content, "utf-8");
      } catch (err) {
        console.error(`[diff-applier] Rollback failed for ${file}: ${err}`);
      }
    }
  }

  /**
   * Validate that a string looks like a unified diff.
   */
  validateDiff(diff: string): boolean {
    if (!diff || typeof diff !== "string") return false;
    const trimmed = diff.trim();
    if (trimmed.length === 0) return false;

    // Must have at least one --- / +++ pair or @@ hunk header
    const hasFilePair = /^---\s+\S/m.test(trimmed) && /^\+\+\+\s+\S/m.test(trimmed);
    const hasHunkHeader = /^@@\s+-\d+/m.test(trimmed);

    return hasFilePair || hasHunkHeader;
  }

  /**
   * Extract file paths that would be changed by this diff.
   */
  extractChangedFiles(diff: string): string[] {
    const files = new Set<string>();

    // Match +++ b/path or +++ path lines
    const plusLines = diff.matchAll(/^\+\+\+\s+(?:b\/)?(.+)$/gm);
    for (const match of plusLines) {
      const path = match[1].trim();
      if (path && path !== "/dev/null") {
        files.add(path);
      }
    }

    // Also check --- lines for deleted files
    const minusLines = diff.matchAll(/^---\s+(?:a\/)?(.+)$/gm);
    for (const match of minusLines) {
      const path = match[1].trim();
      if (path && path !== "/dev/null") {
        files.add(path);
      }
    }

    return [...files];
  }

  // ─── git apply ─────────────────────────────────────────────────

  private async tryGitApply(diff: string, repoPath: string): Promise<{ success: boolean; error?: string }> {
    try {
      // Check if git is available and we're in a repo
      await exec("git", ["rev-parse", "--git-dir"], { cwd: repoPath });

      // Try to apply with --check first (dry run)
      await exec("git", ["apply", "--check", "-"], {
        cwd: repoPath,
        input: diff,
      } as any);

      // Actually apply
      await exec("git", ["apply", "-"], {
        cwd: repoPath,
        input: diff,
      } as any);

      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.stderr ?? err.message ?? String(err) };
    }
  }

  // ─── Manual Patch ──────────────────────────────────────────────

  private async manualApply(
    diff: string,
    repoPath: string
  ): Promise<{ filesChanged: string[]; errors: string[] }> {
    const filesChanged: string[] = [];
    const errors: string[] = [];
    const chunks = this.splitDiffByFile(diff);

    for (const chunk of chunks) {
      try {
        const result = await this.applyFileChunk(chunk, repoPath);
        if (result.changed) {
          filesChanged.push(result.file);
        }
      } catch (err) {
        errors.push(`Failed to apply chunk for ${chunk.file}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return { filesChanged, errors };
  }

  private splitDiffByFile(diff: string): Array<{ file: string; hunks: string[] }> {
    const chunks: Array<{ file: string; hunks: string[] }> = [];
    const lines = diff.split("\n");
    let currentFile = "";
    let currentHunk: string[] = [];
    let inHunk = false;

    for (const line of lines) {
      const plusMatch = line.match(/^\+\+\+\s+(?:b\/)?(.+)/);
      if (plusMatch) {
        // Save previous chunk
        if (currentFile && currentHunk.length > 0) {
          const existing = chunks.find((c) => c.file === currentFile);
          if (existing) existing.hunks.push(currentHunk.join("\n"));
          else chunks.push({ file: currentFile, hunks: [currentHunk.join("\n")] });
          currentHunk = [];
        }
        currentFile = plusMatch[1].trim();
        inHunk = false;
        continue;
      }

      if (line.startsWith("--- ")) continue; // skip minus header

      if (line.startsWith("@@ ")) {
        // Save previous hunk
        if (currentHunk.length > 0 && currentFile) {
          const existing = chunks.find((c) => c.file === currentFile);
          if (existing) existing.hunks.push(currentHunk.join("\n"));
          else chunks.push({ file: currentFile, hunks: [currentHunk.join("\n")] });
        }
        currentHunk = [line];
        inHunk = true;
        continue;
      }

      if (inHunk) {
        currentHunk.push(line);
      }
    }

    // Flush last chunk
    if (currentFile && currentHunk.length > 0) {
      const existing = chunks.find((c) => c.file === currentFile);
      if (existing) existing.hunks.push(currentHunk.join("\n"));
      else chunks.push({ file: currentFile, hunks: [currentHunk.join("\n")] });
    }

    return chunks;
  }

  private async applyFileChunk(
    chunk: { file: string; hunks: string[] },
    repoPath: string
  ): Promise<{ file: string; changed: boolean }> {
    const absFile = resolve(repoPath, chunk.file);

    let original: string;
    try {
      original = await readFile(absFile, "utf-8");
    } catch {
      original = "";
    }

    let content = original;

    for (const hunkStr of chunk.hunks) {
      const lines = hunkStr.split("\n");
      const headerMatch = lines[0]?.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
      if (!headerMatch) continue;

      const oldStart = parseInt(headerMatch[1], 10) - 1; // 0-indexed
      const contentLines = content.split("\n");
      const removals: string[] = [];
      const additions: string[] = [];

      for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith("-")) {
          removals.push(line.slice(1));
        } else if (line.startsWith("+")) {
          additions.push(line.slice(1));
        }
        // Context lines (starting with space) are skipped for simplicity
      }

      // Find and replace the removal block with the addition block
      if (removals.length > 0) {
        const removeStart = this.findSequence(contentLines, removals, oldStart);
        if (removeStart >= 0) {
          contentLines.splice(removeStart, removals.length, ...additions);
          content = contentLines.join("\n");
        } else {
          throw new Error(`Could not locate removal block at line ${oldStart + 1} in ${chunk.file}`);
        }
      } else if (additions.length > 0) {
        // Pure insertion at oldStart
        contentLines.splice(oldStart, 0, ...additions);
        content = contentLines.join("\n");
      }
    }

    if (content !== original) {
      const dir = dirname(absFile);
      if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true });
      }
      await writeFile(absFile, content, "utf-8");
      return { file: chunk.file, changed: true };
    }

    return { file: chunk.file, changed: false };
  }

  private findSequence(haystack: string[], needle: string[], hint: number): number {
    // Try at the hint position first
    if (this.matchesAt(haystack, needle, hint)) return hint;

    // Search nearby (within 20 lines)
    for (let offset = 1; offset <= 20; offset++) {
      if (hint - offset >= 0 && this.matchesAt(haystack, needle, hint - offset)) return hint - offset;
      if (hint + offset < haystack.length && this.matchesAt(haystack, needle, hint + offset)) return hint + offset;
    }

    // Full scan as last resort
    for (let i = 0; i <= haystack.length - needle.length; i++) {
      if (this.matchesAt(haystack, needle, i)) return i;
    }

    return -1;
  }

  private matchesAt(haystack: string[], needle: string[], start: number): boolean {
    if (start + needle.length > haystack.length) return false;
    for (let i = 0; i < needle.length; i++) {
      if (haystack[start + i] !== needle[i]) return false;
    }
    return true;
  }
}
