import type { FileChange } from "../workers/base.js";

export interface AtomicBuilderStep {
  readonly file: string;
  readonly operation: string;
  readonly expectedDiffShape: string;
}

export interface AtomicDiffValidationResult {
  readonly ok: boolean;
  readonly reason: string;
}

export interface AtomicDispatchValidationInputs {
  /** The file the deliverable wants Builder to dispatch against. */
  readonly file: string;
  /** Deliverable metadata. type==="create" relaxes the existence check. */
  readonly deliverable: { readonly description: string; readonly type: "create" | "modify" | "delete" | "refactor" };
  /** Charter targets after prepare + scout merge — `active.analysis.targets`. */
  readonly knownTargets: readonly string[];
  /** Scout advisory targets — `active.preflightScoutResult?.advisoryTargets`. */
  readonly advisoryTargets: readonly string[];
  /** Existence probe — caller injects so the helper stays pure. */
  readonly fileExists: (file: string) => boolean;
  /**
   * When true, a missing file is treated as legitimate (caller has
   * detected create-intent in the prompt). Mirrors the existing
   * prepareDeliverablesForGraph keep-logic so a `type: "modify"`
   * deliverable for a not-yet-existing file is accepted when the
   * prompt actually asks to create it.
   */
  readonly allowMissingFile?: boolean;
}

export type AtomicDispatchValidationResult =
  | { readonly ok: true; readonly file: string }
  | {
      readonly ok: false;
      readonly reason: "empty" | "missing" | "unknown";
      readonly message: string;
      readonly suggestedTargets: readonly string[];
    };

/**
 * Validate that a deliverable's targetFiles[0] is safe to feed into
 * `buildAtomicStep`:
 *
 *   1. non-empty
 *   2. exists on disk (unless deliverable.type === "create")
 *   3. was actually surfaced by the discovery pipeline for THIS task
 *      (charter `analysis.targets` ∪ scout `advisoryTargets`)
 *
 * Without (3), a phantom target path can slip through `prepareDeliv-
 * erablesForGraph` (which only checks existence) and Builder gets
 * dispatched against a real-but-irrelevant file. canHandle inside
 * Builder validates internal consistency (assignment.task.targetFiles
 * matches assignment.atomicBuilder.file) but cannot tell whether the
 * file is *the right* file for the task.
 *
 * Returns a structured result; the caller turns failure into a
 * NeedsClarificationError so the task-loop can route through
 * needs_replan with the discovery evidence.
 */
export function validateAtomicDispatchTarget(
  inputs: AtomicDispatchValidationInputs,
): AtomicDispatchValidationResult {
  const file = inputs.file;
  const known = uniqueDispatchTargets([
    ...inputs.knownTargets,
    ...inputs.advisoryTargets,
  ]);

  if (!file) {
    return {
      ok: false,
      reason: "empty",
      message:
        `Atomic dispatch refused — deliverable "${inputs.deliverable.description}" carries no target file.`,
      suggestedTargets: known,
    };
  }

  const allowMissing = inputs.deliverable.type === "create" || inputs.allowMissingFile === true;
  if (!allowMissing && !inputs.fileExists(file)) {
    return {
      ok: false,
      reason: "missing",
      message:
        `Atomic dispatch refused — target "${file}" for deliverable ` +
        `"${inputs.deliverable.description}" does not exist on disk.`,
      suggestedTargets: known,
    };
  }

  if (!known.includes(file)) {
    return {
      ok: false,
      reason: "unknown",
      message:
        `Atomic dispatch refused — target "${file}" was not discovered by Scout/charter for this task. ` +
        `Builder would edit a real file that nobody asked for.`,
      suggestedTargets: known,
    };
  }

  return { ok: true, file };
}

function uniqueDispatchTargets(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

const SMALL_OP_MAX_CHANGED_LINES = 80;
const LARGE_OP_MAX_CHANGED_LINES = 220;

export function inferAtomicOperation(description: string): string {
  const text = description.toLowerCase();
  if (/\badd\b.*\benum\b|\benum\b.*\badd\b/.test(text)) return "add enum";
  if (/\badd\b.*\bfunction\b|\bfunction\b.*\badd\b/.test(text)) return "add function";
  if (/\badd\b.*\bmethod\b|\bmethod\b.*\badd\b/.test(text)) return "add method";
  if (/\badd\b.*\bimport\b|\bimport\b.*\badd\b/.test(text)) return "modify import";
  if (/\badd\b.*\broute\b|\broute\b.*\badd\b/.test(text)) return "add route";
  if (/\badd\b.*\btest\b|\btest\b.*\badd\b/.test(text)) return "add test";
  if (/\bcreate\b|\bnew file\b/.test(text)) return "create file";
  if (/\bdelete\b|\bremove\b/.test(text)) return "remove code";
  if (/\brename\b/.test(text)) return "rename symbol";
  if (/\bfix\b|\bmodify\b|\bupdate\b|\bchange\b/.test(text)) return "modify code";
  return "single-file minimal edit";
}

export function buildAtomicStep(file: string, description: string): AtomicBuilderStep {
  const operation = inferAtomicOperation(description);
  return {
    file,
    operation,
    expectedDiffShape: expectedDiffShapeForOperation(operation),
  };
}

export function expectedDiffShapeForOperation(operation: string): string {
  switch (operation) {
    case "modify import":
      return "one import hunk plus only the directly required use-site hunk";
    case "add route":
      return "one route registration hunk and, only if necessary, one handler hunk in the same file";
    case "add enum":
    case "add function":
    case "add method":
      return "one localized insertion hunk near the matching declaration";
    case "create file":
      return "one new-file diff for the declared file only";
    case "remove code":
      return "one localized deletion hunk with no unrelated rewrites";
    default:
      return "one localized hunk, or two adjacent hunks when the file structure requires it";
  }
}

export function changedLineCount(diff: string): number {
  return diff
    .split("\n")
    .filter((line) =>
      (line.startsWith("+") && !line.startsWith("+++")) ||
      (line.startsWith("-") && !line.startsWith("---")),
    )
    .length;
}

export function filesInUnifiedDiff(diff: string): string[] {
  const files = new Set<string>();
  for (const line of diff.split("\n")) {
    const git = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (git) {
      files.add(git[2]);
      continue;
    }
    const plus = line.match(/^\+\+\+ b\/(.+)$/);
    if (plus) files.add(plus[1]);
  }
  return [...files];
}

export function validateAtomicDiff(
  step: AtomicBuilderStep,
  changes: readonly FileChange[],
): AtomicDiffValidationResult {
  if (changes.length !== 1) {
    return { ok: false, reason: `atomic builder expected exactly one FileChange, got ${changes.length}` };
  }

  const change = changes[0]!;
  if (change.path !== step.file) {
    return { ok: false, reason: `atomic builder touched ${change.path}, expected ${step.file}` };
  }

  const diff = change.diff ?? "";
  if (!diff.trim()) {
    return { ok: false, reason: "atomic builder produced an empty diff" };
  }

  const files = filesInUnifiedDiff(diff);
  const unexpected = files.filter((file) => file !== step.file);
  if (unexpected.length > 0 || files.length > 1) {
    return {
      ok: false,
      reason: `atomic builder diff touched multiple files: ${files.join(", ")}`,
    };
  }

  const changed = changedLineCount(diff);
  const max = step.operation === "create file" ? LARGE_OP_MAX_CHANGED_LINES : SMALL_OP_MAX_CHANGED_LINES;
  if (changed > max) {
    return {
      ok: false,
      reason: `atomic builder diff too large for ${step.operation}: ${changed} changed lines > ${max}`,
    };
  }

  if (step.operation === "modify import" && !/^\s*[+-]\s*import\s/m.test(diff)) {
    return { ok: false, reason: "atomic modify import step did not change an import line" };
  }

  if (step.operation === "add enum" && !/^\+\s*(export\s+)?enum\s+\w+/m.test(diff)) {
    return { ok: false, reason: "atomic add enum step did not add an enum declaration" };
  }

  if (step.operation === "add route" && !/^\+.*\b(route|get|post|put|patch|delete|router)\b/i.test(diff)) {
    return { ok: false, reason: "atomic add route step did not add route-shaped code" };
  }

  return { ok: true, reason: "atomic diff valid" };
}
