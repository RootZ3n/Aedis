/**
 * DiffApplier — Applies unified diffs to actual files safely.
 *
 * Safety rules:
 *   - Validate diff format before applying
 *   - Snapshot original content before any change
 *   - Never apply diffs outside repoPath
 *   - Return rollback snapshot always
 *   - Use git apply if available, fallback to manual patch
 *   - Verify output is real content, not raw diff text
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { spawn } from "child_process";
import { resolve, dirname, sep } from "path";
import { existsSync } from "fs";

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
   * Reads the original file, applies hunks, writes the patched content.
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

    // Try git apply first (piping diff via stdin properly)
    const gitResult = await this.tryGitApply(diff, absRepo);
    if (gitResult.success) {
      // Verify the files contain real content, not raw diff
      const verifyResult = await this.verifyAppliedFiles(changedFiles, absRepo, rollbackSnapshot);
      if (verifyResult.ok) {
        return { success: true, filesChanged: changedFiles, errors: [], rollbackSnapshot };
      }
      // git apply wrote bad content — rollback and try manual
      console.warn(`[diff-applier] git apply produced invalid content, rolling back and trying manual apply`);
      await this.rollback(rollbackSnapshot, absRepo);
    }

    // Fallback: manual patch — read original, apply hunks, write patched content
    const manualResult = await this.manualApply(diff, absRepo);
    if (manualResult.errors.length > 0) {
      errors.push(...manualResult.errors);
    }

    // Verify manual apply produced valid content
    if (manualResult.filesChanged.length > 0) {
      const verifyResult = await this.verifyAppliedFiles(manualResult.filesChanged, absRepo, rollbackSnapshot);
      if (!verifyResult.ok) {
        errors.push(...verifyResult.errors);
        console.error(`[diff-applier] Manual apply produced invalid content, rolling back`);
        await this.rollback(rollbackSnapshot, absRepo);
        return { success: false, filesChanged: [], errors, rollbackSnapshot };
      }
    }

    return {
      success: manualResult.filesChanged.length > 0 && errors.length === 0,
      filesChanged: manualResult.filesChanged,
      errors,
      rollbackSnapshot,
    };
  }

  /**
   * Apply a diff to a string in memory (no file I/O).
   * Returns the patched content.
   */
  applyToString(diff: string, originalContent: string): string {
    const hunks = this.parseAllHunks(diff);
    if (hunks.length === 0) {
      console.warn(`[diff-applier] No hunks found in diff, returning original`);
      return originalContent;
    }

    const lines = originalContent.split("\n");

    // Apply hunks in reverse order so line numbers stay valid
    const sorted = [...hunks].sort((a, b) => b.oldStart - a.oldStart);

    for (const hunk of sorted) {
      const { oldStart, removals, additions, contextBefore } = hunk;
      let pos = oldStart - 1; // 0-indexed

      // Use context lines to find exact position
      if (contextBefore.length > 0) {
        const found = this.findContextPosition(lines, contextBefore, pos);
        if (found >= 0) {
          pos = found + contextBefore.length;
        }
      }

      if (removals.length > 0) {
        // Find the removal block
        const removePos = this.findSequence(lines, removals, pos);
        if (removePos >= 0) {
          lines.splice(removePos, removals.length, ...additions);
        } else {
          console.warn(`[diff-applier] Could not find removal block at ~line ${pos + 1}, skipping hunk`);
        }
      } else if (additions.length > 0) {
        // Pure insertion
        lines.splice(pos, 0, ...additions);
      }
    }

    return lines.join("\n");
  }

  /**
   * Rollback files to their snapshot state.
   */
  async rollback(snapshot: Record<string, string>, repoPath?: string): Promise<void> {
    for (const [file, content] of Object.entries(snapshot)) {
      try {
        if (content === "") continue; // Was a new file — leave as-is

        const absFile = repoPath ? resolve(repoPath, file) : file;
        const dir = dirname(absFile);
        if (!existsSync(dir)) {
          await mkdir(dir, { recursive: true });
        }
        await writeFile(absFile, content, "utf-8");
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

    const hasFilePair = /^---\s+\S/m.test(trimmed) && /^\+\+\+\s+\S/m.test(trimmed);
    const hasHunkHeader = /^@@\s+-\d+/m.test(trimmed);

    return hasFilePair && hasHunkHeader;
  }

  /**
   * Extract file paths that would be changed by this diff.
   */
  extractChangedFiles(diff: string): string[] {
    const files = new Set<string>();

    const plusLines = diff.matchAll(/^\+\+\+\s+(?:b\/)?(.+)$/gm);
    for (const match of plusLines) {
      const path = match[1].trim();
      if (path && path !== "/dev/null") {
        files.add(path);
      }
    }

    return [...files];
  }

  /**
   * Check if text looks like raw diff content (not valid source code).
   */
  static looksLikeRawDiff(content: string): boolean {
    const first100 = content.slice(0, 100).trimStart();
    return (
      first100.startsWith("--- a/") ||
      first100.startsWith("+++ b/") ||
      first100.startsWith("@@ -") ||
      first100.startsWith("diff --git")
    );
  }

  // ─── git apply via stdin pipe ──────────────────────────────────

  private async tryGitApply(diff: string, repoPath: string): Promise<{ success: boolean; error?: string }> {
    try {
      // Check if we're in a git repo
      await this.spawnCommand("git", ["rev-parse", "--git-dir"], repoPath);

      // Dry run first
      await this.spawnCommand("git", ["apply", "--check", "-"], repoPath, diff);

      // Actually apply
      await this.spawnCommand("git", ["apply", "-"], repoPath, diff);

      return { success: true };
    } catch (err: any) {
      return { success: false, error: String(err) };
    }
  }

  /**
   * Spawn a command with optional stdin input.
   * Unlike execFile, this properly pipes stdin.
   */
  private spawnCommand(cmd: string, args: string[], cwd: string, stdin?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn(cmd, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
      proc.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });

      proc.on("close", (code) => {
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(stderr || `${cmd} exited with code ${code}`));
        }
      });

      proc.on("error", (err) => {
        reject(err);
      });

      if (stdin) {
        proc.stdin.write(stdin);
        proc.stdin.end();
      } else {
        proc.stdin.end();
      }
    });
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

      if (line.startsWith("--- ")) continue;

      if (line.startsWith("@@ ")) {
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

    if (currentFile && currentHunk.length > 0) {
      const existing = chunks.find((c) => c.file === currentFile);
      if (existing) existing.hunks.push(currentHunk.join("\n"));
      else chunks.push({ file: currentFile, hunks: [currentHunk.join("\n")] });
    }

    return chunks;
  }

  /**
   * Apply hunks to a single file: READ original → apply hunks → WRITE patched content.
   */
  private async applyFileChunk(
    chunk: { file: string; hunks: string[] },
    repoPath: string
  ): Promise<{ file: string; changed: boolean }> {
    const absFile = resolve(repoPath, chunk.file);

    // Step 1: Read the ORIGINAL file content
    let original: string;
    try {
      original = await readFile(absFile, "utf-8");
    } catch {
      original = "";
    }

    // Step 2: Apply hunks to produce new content
    let content = original;

    for (const hunkStr of chunk.hunks) {
      const lines = hunkStr.split("\n");
      const headerMatch = lines[0]?.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
      if (!headerMatch) continue;

      const oldStart = parseInt(headerMatch[1], 10) - 1; // 0-indexed
      const contentLines = content.split("\n");
      const removals: string[] = [];
      const additions: string[] = [];
      const contextBefore: string[] = [];
      let seenChange = false;

      for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith("-")) {
          seenChange = true;
          removals.push(line.slice(1));
        } else if (line.startsWith("+")) {
          seenChange = true;
          additions.push(line.slice(1));
        } else if (line.startsWith(" ")) {
          if (!seenChange) {
            contextBefore.push(line.slice(1));
          }
          // Context after changes is ignored for positioning
        }
      }

      // Use context to find the right position
      let pos = oldStart;
      if (contextBefore.length > 0) {
        const found = this.findContextPosition(contentLines, contextBefore, oldStart);
        if (found >= 0) {
          pos = found + contextBefore.length;
        }
      }

      if (removals.length > 0) {
        const removeStart = this.findSequence(contentLines, removals, pos);
        if (removeStart >= 0) {
          contentLines.splice(removeStart, removals.length, ...additions);
          content = contentLines.join("\n");
        } else {
          throw new Error(`Could not locate removal block at ~line ${oldStart + 1} in ${chunk.file}`);
        }
      } else if (additions.length > 0) {
        contentLines.splice(pos, 0, ...additions);
        content = contentLines.join("\n");
      }
    }

    // Step 3: Verify we're not about to write raw diff text
    if (content !== original && DiffApplier.looksLikeRawDiff(content)) {
      throw new Error(`Patch produced raw diff output instead of source code for ${chunk.file}`);
    }

    // Step 4: Write the PATCHED content (not the diff)
    if (content !== original) {
      const dir = dirname(absFile);
      if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true });
      }
      await writeFile(absFile, content, "utf-8");
      console.log(`[diff-applier] Patched ${chunk.file} (${original.split("\n").length} → ${content.split("\n").length} lines)`);
      return { file: chunk.file, changed: true };
    }

    return { file: chunk.file, changed: false };
  }

  // ─── Verification ──────────────────────────────────────────────

  /**
   * Verify that applied files contain valid content, not raw diff text.
   */
  private async verifyAppliedFiles(
    files: string[],
    repoPath: string,
    snapshot: Record<string, string>
  ): Promise<{ ok: boolean; errors: string[] }> {
    const errors: string[] = [];

    for (const file of files) {
      const absFile = resolve(repoPath, file);
      try {
        const content = await readFile(absFile, "utf-8");
        if (DiffApplier.looksLikeRawDiff(content)) {
          errors.push(`${file} contains raw diff headers instead of patched content`);
        }
      } catch {
        // File might not exist — that's OK for deletions
      }
    }

    return { ok: errors.length === 0, errors };
  }

  // ─── Hunk Parsing ─────────────────────────────────────────────

  private parseAllHunks(diff: string): Array<{
    oldStart: number;
    removals: string[];
    additions: string[];
    contextBefore: string[];
  }> {
    const hunks: Array<{
      oldStart: number;
      removals: string[];
      additions: string[];
      contextBefore: string[];
    }> = [];

    const lines = diff.split("\n");
    let i = 0;

    while (i < lines.length) {
      const headerMatch = lines[i].match(/^@@\s+-(\d+)(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@/);
      if (!headerMatch) { i++; continue; }

      const oldStart = parseInt(headerMatch[1], 10);
      const removals: string[] = [];
      const additions: string[] = [];
      const contextBefore: string[] = [];
      let seenChange = false;
      i++;

      while (i < lines.length && !lines[i].startsWith("@@") && !lines[i].startsWith("--- ")) {
        const line = lines[i];
        if (line.startsWith("-")) {
          seenChange = true;
          removals.push(line.slice(1));
        } else if (line.startsWith("+")) {
          seenChange = true;
          additions.push(line.slice(1));
        } else if (line.startsWith(" ") || line === "") {
          if (!seenChange) {
            contextBefore.push(line.startsWith(" ") ? line.slice(1) : line);
          }
        }
        i++;
      }

      hunks.push({ oldStart, removals, additions, contextBefore });
    }

    return hunks;
  }

  // ─── Sequence Matching ─────────────────────────────────────────

  private findContextPosition(lines: string[], context: string[], hint: number): number {
    if (this.matchesAt(lines, context, hint)) return hint;
    for (let offset = 1; offset <= 15; offset++) {
      if (hint - offset >= 0 && this.matchesAt(lines, context, hint - offset)) return hint - offset;
      if (hint + offset < lines.length && this.matchesAt(lines, context, hint + offset)) return hint + offset;
    }
    return -1;
  }

  private findSequence(haystack: string[], needle: string[], hint: number): number {
    if (this.matchesAt(haystack, needle, hint)) return hint;

    for (let offset = 1; offset <= 20; offset++) {
      if (hint - offset >= 0 && this.matchesAt(haystack, needle, hint - offset)) return hint - offset;
      if (hint + offset < haystack.length && this.matchesAt(haystack, needle, hint + offset)) return hint + offset;
    }

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
