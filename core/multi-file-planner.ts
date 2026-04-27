// buildIntentGraph does not exist in this file; no deletion needed.
import type { ChangeSet } from "./change-set.js";
import type { ImportGraph } from "./import-graph.js";

export type WaveStatus =
  | "pending"
  | "in-progress"
  | "checkpoint-evaluating"
  | "passed"
  | "failed"
  | "halted"      // downstream wave halted because an upstream failed
  | "skipped";    // wave had no files

export interface WaveCheckpointResult {
  readonly evaluated: boolean;
  readonly passed: boolean;
  readonly reason: string;
  readonly timestamp: string | null;
  /** Confidence at the point of this checkpoint. */
  readonly confidenceAtCheckpoint: number | null;
  /** Files that failed verification in this wave. */
  readonly failedFiles: readonly string[];
}

export interface PlanWave {
  readonly id: number;
  readonly name: string;
  readonly files: readonly string[];
  readonly dependsOn: readonly number[];
  readonly verificationCheckpoint: string;
  /**
   * Mutable status — updated by the Coordinator as waves execute.
   * Starts as "pending". Transitions:
   *   pending → in-progress → checkpoint-evaluating → passed | failed
   *   pending → halted (if upstream wave failed)
   *   pending → skipped (if wave has no files)
   */
  status: WaveStatus;
  /**
   * Checkpoint evaluation result. Null until the checkpoint is run.
   * If the checkpoint fails, all downstream waves should be halted.
   */
  checkpointResult: WaveCheckpointResult | null;
}

export interface PlanEdge {
  fromWave: number;
  toWave: number;
  reason: string;
}

export interface Plan {
  prompt: string;
  changeSet: string[];
  waves: PlanWave[];
  dependencyEdges: PlanEdge[];
}

function normalizeChangeSet(changeSet: ChangeSet): string[] {
  return Array.from(
    new Set(
      changeSet.filesInScope
        .map((file) => file.path.trim())
        .filter((file) => file.length > 0),
    ),
  );
}

function classifyWave(file: string): number {
  const normalized = file.toLowerCase();

  if (
    normalized.includes("schema") ||
    normalized.includes("types") ||
    normalized.endsWith(".d.ts") ||
    normalized.includes("interface") ||
    normalized.includes("model")
  ) {
    return 1;
  }

  if (
    normalized.includes("test") ||
    normalized.includes("spec") ||
    normalized.includes("docs") ||
    normalized.endsWith(".md")
  ) {
    return 3;
  }

  if (
    normalized.includes("integration") ||
    normalized.includes("coordinator") ||
    normalized.includes("pipeline") ||
    normalized.includes("router") ||
    normalized.includes("server")
  ) {
    return 4;
  }

  return 2;
}

function buildCheckpoint(waveId: number, prompt: string, files: readonly string[]): string {
  const focus = files.length > 0 ? files.join(", ") : "no files assigned";

  switch (waveId) {
    case 1:
      return `Verify schema/type updates compile cleanly and still support: ${prompt}. Files: ${focus}`;
    case 2:
      return `Verify consumers now match the updated contracts before broader rollout. Files: ${focus}`;
    case 3:
      return `Verify tests/docs reflect the intended behavior and prompt expectations. Files: ${focus}`;
    case 4:
      return `Verify end-to-end integration behavior is coherent after all prior waves. Files: ${focus}`;
    default:
      return `Verify wave ${waveId} changes are internally consistent. Files: ${focus}`;
  }
}

/**
 * Classify a file's wave using both filename heuristics and import
 * graph data. When the graph is available, files that have no
 * in-scope consumers (leaf nodes) stay in their heuristic wave,
 * but files that are imported by many other scope files get
 * promoted to an earlier wave (they should change first).
 */
function classifyWaveWithGraph(
  file: string,
  scopeFiles: readonly string[],
  graph: ImportGraph | null,
): number {
  const baseWave = classifyWave(file);

  if (!graph) return baseWave;

  const fileSet = new Set(scopeFiles);
  const consumers = graph.getImportedBy(file).filter((f) => fileSet.has(f));
  const imports = graph.getImports(file).filter((f) => fileSet.has(f));

  // Files consumed by many scope files are foundational — promote
  // to wave 1 if they're not already tests/docs
  if (consumers.length >= 3 && baseWave === 2) {
    return 1;
  }

  // Files that import many scope files but are consumed by none
  // are integration endpoints — promote to wave 4
  if (imports.length >= 3 && consumers.length === 0 && baseWave === 2) {
    return 4;
  }

  return baseWave;
}

export function planChangeSet(
  changeSet: ChangeSet,
  prompt: string,
  importGraph?: ImportGraph | null,
): Plan {
  const files = normalizeChangeSet(changeSet);
  const buckets = new Map<number, string[]>([
    [1, []],
    [2, []],
    [3, []],
    [4, []],
  ]);

  for (const file of files) {
    const waveId = classifyWaveWithGraph(file, files, importGraph ?? null);
    buckets.get(waveId)?.push(file);
  }

  const waves: PlanWave[] = [
    {
      id: 1,
      name: "schema/types",
      files: buckets.get(1) ?? [],
      dependsOn: [],
      verificationCheckpoint: buildCheckpoint(1, prompt, buckets.get(1) ?? []),
      status: (buckets.get(1) ?? []).length === 0 ? "skipped" : "pending",
      checkpointResult: null,
    },
    {
      id: 2,
      name: "consumers",
      files: buckets.get(2) ?? [],
      dependsOn: [1],
      verificationCheckpoint: buildCheckpoint(2, prompt, buckets.get(2) ?? []),
      status: (buckets.get(2) ?? []).length === 0 ? "skipped" : "pending",
      checkpointResult: null,
    },
    {
      id: 3,
      name: "tests/docs",
      files: buckets.get(3) ?? [],
      dependsOn: [1, 2],
      verificationCheckpoint: buildCheckpoint(3, prompt, buckets.get(3) ?? []),
      status: (buckets.get(3) ?? []).length === 0 ? "skipped" : "pending",
      checkpointResult: null,
    },
    {
      id: 4,
      name: "integration",
      files: buckets.get(4) ?? [],
      dependsOn: [1, 2, 3],
      verificationCheckpoint: buildCheckpoint(4, prompt, buckets.get(4) ?? []),
      status: (buckets.get(4) ?? []).length === 0 ? "skipped" : "pending",
      checkpointResult: null,
    },
  ];

  const dependencyEdges: PlanEdge[] = [
    { fromWave: 1, toWave: 2, reason: "Consumers should follow schema and type changes." },
    { fromWave: 2, toWave: 3, reason: "Tests and docs should reflect updated consumer behavior." },
    { fromWave: 3, toWave: 4, reason: "Integration checks should run after implementation and verification artifacts are aligned." },
  ];

  return {
    prompt,
    changeSet: files,
    waves,
    dependencyEdges,
  };
}

// ─── Wave Lifecycle Helpers ─────────────────────────────────────────

/** Start a wave. Only valid from "pending" status. */
export function startWave(wave: PlanWave): void {
  if (wave.status !== "pending") return;
  wave.status = "in-progress";
}

/**
 * Record the result of a wave's checkpoint evaluation.
 * If the checkpoint fails, halts all downstream waves in the plan.
 */
export function completeWaveCheckpoint(
  plan: Plan,
  waveId: number,
  result: Omit<WaveCheckpointResult, "evaluated">,
): void {
  const wave = plan.waves.find((w) => w.id === waveId);
  if (!wave) return;

  wave.status = "checkpoint-evaluating";
  wave.checkpointResult = { ...result, evaluated: true };
  wave.status = result.passed ? "passed" : "failed";

  if (!result.passed) {
    haltDownstreamWaves(plan, waveId);
  }
}

/**
 * Halt all waves that depend (transitively) on the given wave.
 * Called when a wave fails its checkpoint — prevents blindly
 * continuing through broken state.
 */
export function haltDownstreamWaves(plan: Plan, failedWaveId: number): void {
  const halted = new Set<number>();
  const queue = [failedWaveId];

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const wave of plan.waves) {
      if (wave.dependsOn.includes(current) && !halted.has(wave.id)) {
        if (wave.status === "pending") {
          wave.status = "halted";
          halted.add(wave.id);
          queue.push(wave.id);
        }
      }
    }
  }
}

/** Check if all non-skipped waves have a terminal status. */
export function isAllWavesTerminal(plan: Plan): boolean {
  return plan.waves.every(
    (w) => w.status === "passed" || w.status === "failed" || w.status === "halted" || w.status === "skipped",
  );
}

/** Check if any required wave (non-skipped) failed or was halted. */
export function hasWaveFailures(plan: Plan): boolean {
  return plan.waves.some(
    (w) => w.status === "failed" || w.status === "halted",
  );
}

/** Summarize wave outcomes for receipts. */
export function summarizeWaveOutcomes(plan: Plan): readonly WaveOutcomeSummary[] {
  return plan.waves.map((w) => ({
    waveId: w.id,
    name: w.name,
    fileCount: w.files.length,
    status: w.status,
    checkpointPassed: w.checkpointResult?.passed ?? null,
    checkpointReason: w.checkpointResult?.reason ?? null,
    failedFiles: w.checkpointResult?.failedFiles ?? [],
  }));
}

export interface WaveOutcomeSummary {
  readonly waveId: number;
  readonly name: string;
  readonly fileCount: number;
  readonly status: WaveStatus;
  readonly checkpointPassed: boolean | null;
  readonly checkpointReason: string | null;
  readonly failedFiles: readonly string[];
}

/**
 * Attempts to add a function to core/nonexistent-file-xyz.ts.
 * Note: The target file does not exist in the current scope.
 */
export function tryAddFunctionToNonexistentFile(): { success: boolean; reason: string } {
  return { success: false, reason: "core/nonexistent-file-xyz.ts does not exist" };
}
