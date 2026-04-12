import type { ProjectMemory } from "./project-memory.js";
import type { ChangeSet } from "./change-set.js";
import type { PlanWave } from "./multi-file-planner.js";
import type { Invariant } from "./invariant-extractor.js";

export interface GatedContext {
  relevantFiles: string[];
  recentTaskSummaries: string[];
  language: string;
  clusterFiles?: string[];
  landmines?: string[];
  safeApproaches?: string[];
  memoryNotes?: string[];
  suggestedNextSteps?: string[];
  strictVerification?: boolean;
  /**
   * Shared invariants the current wave must respect. Populated only
   * when gating is wave-aware (see gateContextForWave). Empty on
   * plain gateContext calls so single-file runs don't see a token
   * bloat they don't need.
   */
  waveInvariants?: WaveInvariantRef[];
  /**
   * Sibling files drawn from the same wave — not the whole plan.
   * Included only when gating is wave-aware AND the sibling is likely
   * relevant (filename overlap with the prompt, or shared invariant
   * name). Minimal-context discipline is enforced by
   * MAX_WAVE_SIBLINGS.
   */
  waveSiblings?: string[];
  /**
   * Ordered log of reasons for every item we injected. Every entry
   * maps 1:1 to an item in relevantFiles / waveInvariants /
   * waveSiblings. The Coordinator prints this so reviewers can audit
   * what the gate showed the worker and why.
   */
  inclusionLog?: string[];
}

export interface WaveInvariantRef {
  readonly name: string;
  readonly type: Invariant["type"];
  readonly description: string;
}

const MAX_RELEVANT_FILES = 10;
const MAX_RECENT_TASKS = 3;
const MAX_WAVE_INVARIANTS = 12;
const MAX_WAVE_SIBLINGS = 6;
const MAX_ARCHITECTURAL_HUB_FILES = 10;

/**
 * Base context gate — used when there is no wave context yet (single-file
 * runs, scouting, pre-charter memory lookups). Keeps a flat, minimal
 * signature so the hot path stays cheap.
 */
export function gateContext(memory: ProjectMemory, prompt: string): GatedContext {
  const words = extractPromptWords(prompt);

  const recentFiles = memory.recentFiles ?? [];
  const relevantFiles = words.length === 0
    ? []
    : recentFiles
        .filter(path => {
          const normalizedPath = path.toLowerCase();
          return words.some(word => normalizedPath.includes(word));
        })
        .sort()
        .slice(0, MAX_RELEVANT_FILES);

  const recentTasks = memory.recentTasks ?? [];
  const recentTaskSummaries = recentTasks
    .slice(0, MAX_RECENT_TASKS)
    .map(task => (task.resultSummary ?? task.prompt).slice(0, 120));

  return {
    relevantFiles,
    recentTaskSummaries,
    language: memory.language ?? "unknown",
  };
}

export interface WaveContextInputs {
  readonly memory: ProjectMemory;
  readonly prompt: string;
  readonly changeSet: ChangeSet;
  readonly wave: PlanWave;
  /**
   * Target files the current worker has been assigned. Used to pick
   * siblings — we never return the target file itself as a sibling,
   * and we only pick from the wave's own file list.
   */
  readonly targetFiles: readonly string[];
}

/**
 * Wave-aware gate — used by the Coordinator when dispatching a builder
 * inside a multi-file plan. Returns a GatedContext with:
 *
 *   - relevantFiles         — same base heuristic as gateContext
 *   - waveInvariants        — only invariants whose `files` overlap
 *                             the current wave's file set. Invariants
 *                             that apply to later waves are deliberately
 *                             withheld to preserve minimal-context
 *                             discipline.
 *   - waveSiblings          — files in the same wave, ranked by filename
 *                             overlap with the prompt or shared
 *                             invariant names. Capped at
 *                             MAX_WAVE_SIBLINGS.
 *   - inclusionLog          — one line per injected item explaining
 *                             the reason (for Coordinator logging).
 */
export function gateContextForWave(inputs: WaveContextInputs): GatedContext {
  const { memory, prompt, changeSet, wave, targetFiles } = inputs;
  const base = gateContext(memory, prompt);
  const log: string[] = [];

  for (const file of base.relevantFiles) {
    log.push(`relevant: ${file} — prompt word match on project memory`);
  }

  const waveFiles = new Set(wave.files);
  const waveInvariants: WaveInvariantRef[] = [];
  for (const invariant of changeSet.invariants) {
    const touchesWave = invariant.files.some((f) => waveFiles.has(f));
    if (!touchesWave) continue;

    waveInvariants.push({
      name: invariant.name,
      type: invariant.type,
      description: invariant.description,
    });
    log.push(
      `invariant: ${invariant.type}:${invariant.name} — touches ${invariant.files.filter((f) => waveFiles.has(f)).length} file(s) in wave ${wave.id}`,
    );
    if (waveInvariants.length >= MAX_WAVE_INVARIANTS) break;
  }

  const words = extractPromptWords(prompt);
  const targetSet = new Set(targetFiles);
  const siblingCandidates = wave.files.filter((f) => !targetSet.has(f));

  const rankedSiblings = siblingCandidates
    .map((file) => {
      const normalized = file.toLowerCase();
      const promptMatch = words.some((w) => normalized.includes(w));
      const sharesInvariant = waveInvariants.some((inv) =>
        changeSet.invariants.some(
          (i) => i.name === inv.name && i.files.includes(file),
        ),
      );
      return { file, promptMatch, sharesInvariant };
    })
    .filter((entry) => entry.promptMatch || entry.sharesInvariant)
    .slice(0, MAX_WAVE_SIBLINGS);

  for (const entry of rankedSiblings) {
    const reasons: string[] = [];
    if (entry.promptMatch) reasons.push("prompt word match");
    if (entry.sharesInvariant) reasons.push("shared invariant");
    log.push(`sibling: ${entry.file} — ${reasons.join(", ")}`);
  }

  return {
    ...base,
    waveInvariants,
    waveSiblings: rankedSiblings.map((entry) => entry.file),
    inclusionLog: log,
  };
}

/**
 * Architectural-mode gate — triggered when scopeClassification.type === 'architectural'.
 * Reads the repo index to find the top 10 most-connected files (files imported
 * by the most other files), includes those as context regardless of prompt
 * relevance, and injects a repo-wide summary at the top of every worker prompt.
 */
export function gateContextForArchitectural(
  memory: ProjectMemory,
  prompt: string,
  repoIndex: { file: string; importedByCount: number }[],
): GatedContext {
  const base = gateContext(memory, prompt);
  const log: string[] = [];

  for (const file of base.relevantFiles) {
    log.push(`relevant: ${file} — prompt word match on project memory`);
  }

  // Find top N most-connected hub files from the repo index
  const sorted = [...repoIndex]
    .sort((a, b) => b.importedByCount - a.importedByCount)
    .slice(0, MAX_ARCHITECTURAL_HUB_FILES);

  const hubFiles = sorted.map((entry) => entry.file);
  for (const entry of sorted) {
    log.push(
      `hub: ${entry.file} — imported by ${entry.importedByCount} file(s) (architectural mode)`,
    );
  }

  // Merge hub files into relevant files, deduped
  const allRelevant = uniqueStrings([...base.relevantFiles, ...hubFiles]);

  const architecturalNote =
    `This is an architectural change. Key hub files: ${hubFiles.join(", ")}. ` +
    `Proceed with awareness of downstream impact.`;

  return {
    ...base,
    relevantFiles: allRelevant,
    memoryNotes: [...(base.memoryNotes ?? []), architecturalNote],
    inclusionLog: log,
  };
}

export function mergeGatedContext(base: GatedContext, overlay?: Partial<GatedContext>): GatedContext {
  if (!overlay) return base;
  return {
    relevantFiles: uniqueStrings([...base.relevantFiles, ...(overlay.relevantFiles ?? [])]),
    recentTaskSummaries: uniqueStrings([...base.recentTaskSummaries, ...(overlay.recentTaskSummaries ?? [])]).slice(0, MAX_RECENT_TASKS + 3),
    language: overlay.language ?? base.language,
    ...(mergeOptionalArrays(base.clusterFiles, overlay.clusterFiles, "clusterFiles")),
    ...(mergeOptionalArrays(base.landmines, overlay.landmines, "landmines")),
    ...(mergeOptionalArrays(base.safeApproaches, overlay.safeApproaches, "safeApproaches")),
    ...(mergeOptionalArrays(base.memoryNotes, overlay.memoryNotes, "memoryNotes")),
    ...(mergeOptionalArrays(base.suggestedNextSteps, overlay.suggestedNextSteps, "suggestedNextSteps")),
    ...(mergeOptionalArrays(base.waveInvariants, overlay.waveInvariants, "waveInvariants")),
    ...(mergeOptionalArrays(base.waveSiblings, overlay.waveSiblings, "waveSiblings")),
    ...(mergeOptionalArrays(base.inclusionLog, overlay.inclusionLog, "inclusionLog")),
    ...(overlay.strictVerification !== undefined ? { strictVerification: overlay.strictVerification } : base.strictVerification !== undefined ? { strictVerification: base.strictVerification } : {}),
  };
}

function extractPromptWords(prompt: string): string[] {
  return Array.from(
    new Set(
      prompt
        .toLowerCase()
        .split(/\s+/)
        .map(word => word.replace(/[^a-z0-9_-]/g, ""))
        .filter(word => word.length >= 4)
    )
  );
}

function uniqueStrings(values: readonly string[]): string[] {
  return Array.from(new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0)));
}

function mergeOptionalArrays<T>(
  base: readonly T[] | undefined,
  overlay: readonly T[] | undefined,
  key: "clusterFiles" | "landmines" | "safeApproaches" | "memoryNotes" | "suggestedNextSteps" | "waveInvariants" | "waveSiblings" | "inclusionLog",
): Partial<GatedContext> {
  const values = [...(base ?? []), ...(overlay ?? [])];
  if (values.length === 0) return {};
  return {
    [key]: Array.from(new Set(values)),
  } as Partial<GatedContext>;
}
