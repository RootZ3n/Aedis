import type { FileChange } from "../workers/base.js";

export interface DiffTruthResult {
  readonly ok: boolean;
  readonly reason: string;
  readonly changedLines: number;
}

export interface ChangeTruthResult {
  readonly ok: boolean;
  readonly reason: string;
  readonly changedFiles: readonly string[];
  readonly changedLines: number;
}

export interface CanonicalDiffResult extends ChangeTruthResult {
  readonly diff: string;
}

const HUNK_HEADER = /^@@\s+-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@/m;
const FILE_HEADER = /^(diff --git a\/\S+ b\/\S+|---\s+(?:a\/|\S)|\+\+\+\s+(?:b\/|\S))/m;

export function countRealDiffLines(diff: string | null | undefined): number {
  if (!diff) return 0;
  let count = 0;
  for (const raw of diff.split(/\r?\n/)) {
    if (!raw) continue;
    if (raw.startsWith("+++") || raw.startsWith("---")) continue;
    if (raw.startsWith("+") || raw.startsWith("-")) count++;
  }
  return count;
}

export function validateUnifiedDiff(diff: string | null | undefined): DiffTruthResult {
  const text = String(diff ?? "");
  if (!text.trim()) {
    return { ok: false, reason: "diff is empty", changedLines: 0 };
  }
  const changedLines = countRealDiffLines(text);
  if (!FILE_HEADER.test(text) || !HUNK_HEADER.test(text)) {
    return {
      ok: false,
      reason: "diff is missing unified patch headers",
      changedLines,
    };
  }
  if (changedLines <= 0) {
    return {
      ok: false,
      reason: "diff has no real line additions or removals",
      changedLines,
    };
  }
  return { ok: true, reason: "diff contains real line modifications", changedLines };
}

export function validateFileChange(change: FileChange): DiffTruthResult {
  return validateUnifiedDiff(change.diff);
}

export function validateApprovalChanges(changes: readonly FileChange[]): ChangeTruthResult {
  if (changes.length === 0) {
    return {
      ok: false,
      reason: "no file changes were produced",
      changedFiles: [],
      changedLines: 0,
    };
  }

  const validFiles: string[] = [];
  const failures: string[] = [];
  let changedLines = 0;

  for (const change of changes) {
    const result = validateFileChange(change);
    if (result.ok) {
      validFiles.push(change.path);
      changedLines += result.changedLines;
    } else {
      failures.push(`${change.path}: ${result.reason}`);
    }
  }

  if (failures.length > 0) {
    return {
      ok: false,
      reason: failures.join("; "),
      changedFiles: validFiles,
      changedLines,
    };
  }

  if (changedLines <= 0) {
    return {
      ok: false,
      reason: "no real line modifications were detected",
      changedFiles: validFiles,
      changedLines,
    };
  }

  return {
    ok: true,
    reason: `${validFiles.length} file(s), ${changedLines} changed diff line(s)`,
    changedFiles: validFiles,
    changedLines,
  };
}

export function buildCanonicalDiff(changes: readonly FileChange[]): CanonicalDiffResult {
  const normalized = changes.map((change) => ({ ...change, diff: canonicalDiffForChange(change) }));
  const truth = validateApprovalChanges(normalized);
  const diff = truth.ok
    ? `${normalized.map((change) => change.diff ?? "").filter((value) => value.trim()).join("\n")}\n`
    : "";
  return {
    ...truth,
    diff,
  };
}

export function canonicalDiffForChange(change: FileChange): string {
  if (typeof change.diff === "string" && change.diff.trim()) {
    const supplied = validateUnifiedDiff(change.diff);
    if (supplied.ok) return change.diff;
  }
  if (change.operation === "create") {
    return synthesizeCreateDiff(change.path, change.content ?? "");
  }
  if (change.operation === "delete") {
    return synthesizeDeleteDiff(change.path, change.originalContent ?? "");
  }
  if (
    change.operation === "modify" &&
    typeof change.originalContent === "string" &&
    typeof change.content === "string"
  ) {
    return synthesizeModifyDiff(change.path, change.originalContent, change.content);
  }
  return "";
}

export function synthesizeCreateDiff(filePath: string, content: string): string {
  const lines = splitPatchLines(content);
  return [
    `diff --git a/${filePath} b/${filePath}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${filePath}`,
    `@@ -0,0 +1,${Math.max(lines.length, 1)} @@`,
    ...(lines.length > 0 ? lines.map((line) => `+${line}`) : ["+"]),
  ].join("\n");
}

export function synthesizeDeleteDiff(filePath: string, originalContent: string): string {
  const lines = splitPatchLines(originalContent);
  return [
    `diff --git a/${filePath} b/${filePath}`,
    "deleted file mode 100644",
    `--- a/${filePath}`,
    "+++ /dev/null",
    `@@ -1,${Math.max(lines.length, 1)} +0,0 @@`,
    ...(lines.length > 0 ? lines.map((line) => `-${line}`) : ["-"]),
  ].join("\n");
}

export function synthesizeModifyDiff(
  filePath: string,
  originalContent: string,
  updatedContent: string,
): string {
  const originalLines = splitPatchLines(originalContent);
  const updatedLines = splitPatchLines(updatedContent);
  const max = Math.max(originalLines.length, updatedLines.length);
  const body: string[] = [];
  for (let i = 0; i < max; i++) {
    const before = originalLines[i];
    const after = updatedLines[i];
    if (before === after) {
      if (before !== undefined) body.push(` ${before}`);
      continue;
    }
    if (before !== undefined) body.push(`-${before}`);
    if (after !== undefined) body.push(`+${after}`);
  }
  return [
    `diff --git a/${filePath} b/${filePath}`,
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    `@@ -1,${Math.max(originalLines.length, 1)} +1,${Math.max(updatedLines.length, 1)} @@`,
    ...body,
  ].join("\n");
}

function splitPatchLines(content: string): string[] {
  const normalized = content.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}
