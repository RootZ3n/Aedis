/**
 * ProjectMemory — persistent per-repo knowledge across Aedis sessions.
 *
 * Stored at {projectRoot}/.aedis/memory.json. Tracks:
 *   - last 20 file paths touched (deduped, most-recent-first)
 *   - last 10 task summaries (prompt, verdict, commitSha, cost, timestamp)
 *   - up to 20 file clusters that tend to change together
 *   - repo language inferred from tsconfig.json / package.json presence
 *
 * The store is intentionally tiny and self-contained: no schemas, no DB,
 * no external state. A missing or malformed file is treated as "no memory
 * yet" rather than an error so the rest of the pipeline can keep running.
 */

import { access, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

// ─── Public types ────────────────────────────────────────────────────

export interface TaskSummary {
  readonly prompt: string;
  readonly verdict: string;
  readonly commitSha: string | null;
  readonly cost: number;
  readonly timestamp: string;
  readonly normalizedPrompt?: string;
  readonly scopeType?: string;
  readonly complexityTier?: string;
  readonly resultSummary?: string;
  readonly verificationVerdict?: string;
  readonly failureSummary?: string;
  readonly successPattern?: string;
  readonly affectedSystems?: readonly string[];
  readonly changeTypes?: readonly string[];
  /**
   * Optional list of files touched by this task. When provided, recordTask
   * folds them into the memory's `recentFiles` list (deduped, capped).
   */
  readonly filesTouched?: readonly string[];
  readonly taskTypeKey?: string;
  readonly plannedFilesCount?: number;
  readonly missingFiles?: readonly string[];
  readonly undeclaredFiles?: readonly string[];
  readonly verificationCoverageRatio?: number | null;
  readonly validatedRatio?: number | null;
  // ─── Evaluation feedback ────────────────────────────────────────
  /** Aedis confidence at time of run (0-1). */
  readonly aedisConfidence?: number | null;
  /** Crucibulum evaluation score (0-100), null if not evaluated. */
  readonly evaluationScore?: number | null;
  /** Whether the evaluation passed. */
  readonly evaluationPassed?: boolean | null;
  /** Direction of disagreement between Aedis confidence and evaluation. */
  readonly disagreementDirection?: "aligned" | "aedis-overconfident" | "aedis-underconfident" | null;
}

export interface FileCluster {
  readonly files: string[];
  readonly changedTogether: number;
  readonly lastSeen: string;
}

export interface ProjectMemory {
  readonly projectRoot: string;
  readonly language: string;
  readonly recentFiles: readonly string[];
  readonly recentTasks: readonly TaskSummary[];
  readonly fileClusters: readonly FileCluster[];
  readonly taskPatterns: readonly TaskPatternProfile[];
  readonly updatedAt: string;
  readonly schemaVersion: number;
}

export interface TaskPatternProfile {
  readonly taskTypeKey: string;
  readonly observedRuns: number;
  readonly avgFilesChanged: number;
  readonly successRate: number;
  readonly verificationGapRate: number;
  readonly commonFailureReasons: readonly string[];
  readonly commonMissingFiles: readonly string[];
  readonly lastSeen: string;
  // ─── Trust calibration (derived from evaluation feedback) ──────
  /** Number of runs that had Crucibulum evaluations. */
  readonly evaluatedRuns: number;
  /** Average Crucibulum score for evaluated runs (0-100). */
  readonly avgEvaluationScore: number;
  /** Rate of overconfidence: high Aedis confidence + failed evaluation. */
  readonly overconfidenceRate: number;
  /**
   * Confidence dampening factor derived from historical accuracy.
   * Applied as a multiplier (0.8-1.0) to confidence for this task type.
   * 1.0 = no dampening, 0.8 = maximum dampening for repeatedly
   * overconfident patterns. Only meaningful when evaluatedRuns >= 3.
   */
  readonly confidenceDampening: number;
  /**
   * Reliability tier for this task archetype.
   *   "reliable"  — successRate >= 0.8, overconfidenceRate < 0.15
   *   "risky"     — successRate < 0.6 OR overconfidenceRate >= 0.3
   *   "caution"   — everything else
   *   "unknown"   — fewer than 3 observed runs
   */
  readonly reliabilityTier: "reliable" | "risky" | "caution" | "unknown";
}

// ─── Internals ───────────────────────────────────────────────────────

const MEMORY_DIR = ".aedis";
const MEMORY_FILE = "memory.json";
const MAX_FILES = 20;
const MAX_TASKS = 10;
const MAX_CLUSTERS = 20;
const MAX_PATTERNS = 20;
const MAX_PATTERN_LIST = 5;

function memoryPath(projectRoot: string): string {
  return join(resolve(projectRoot), MEMORY_DIR, MEMORY_FILE);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function detectLanguage(projectRoot: string): Promise<string> {
  const root = resolve(projectRoot);
  if (await fileExists(join(root, "tsconfig.json"))) return "typescript";
  if (await fileExists(join(root, "Cargo.toml"))) return "rust";
  if (await fileExists(join(root, "go.mod"))) return "go";
  if (
    await fileExists(join(root, "requirements.txt")) ||
    await fileExists(join(root, "pyproject.toml"))
  ) return "python";
  if (await fileExists(join(root, "pom.xml"))) return "java";
  if (await fileExists(join(root, "package.json"))) return "javascript";
  return "unknown";
}

function emptyMemory(projectRoot: string, language: string): ProjectMemory {
  return {
    projectRoot: resolve(projectRoot),
    language,
    recentFiles: [],
    recentTasks: [],
    fileClusters: [],
    taskPatterns: [],
    updatedAt: new Date().toISOString(),
    schemaVersion: 1,
  };
}

function isTaskSummary(value: unknown): value is TaskSummary {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.prompt === "string" &&
    typeof v.verdict === "string" &&
    typeof v.timestamp === "string" &&
    typeof v.cost === "number" &&
    (v.commitSha === null || typeof v.commitSha === "string")
  );
}

function isFileCluster(value: unknown): value is FileCluster {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    Array.isArray(v.files) &&
    v.files.every((entry) => typeof entry === "string") &&
    typeof v.changedTogether === "number" &&
    typeof v.lastSeen === "string"
  );
}

function normalizeTouchedFiles(files: readonly string[]): string[] {
  return Array.from(
    new Set(
      files.filter((file): file is string => typeof file === "string" && file.length > 0),
    ),
  );
}

function isTaskPatternProfile(value: unknown): value is TaskPatternProfile {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (!(
    typeof v.taskTypeKey === "string" &&
    typeof v.observedRuns === "number" &&
    typeof v.avgFilesChanged === "number" &&
    typeof v.successRate === "number" &&
    typeof v.verificationGapRate === "number" &&
    Array.isArray(v.commonFailureReasons) &&
    Array.isArray(v.commonMissingFiles) &&
    typeof v.lastSeen === "string"
  )) return false;
  // Backfill trust calibration fields for older memory entries
  if (typeof v.evaluatedRuns !== "number") (v as any).evaluatedRuns = 0;
  if (typeof v.avgEvaluationScore !== "number") (v as any).avgEvaluationScore = 0;
  if (typeof v.overconfidenceRate !== "number") (v as any).overconfidenceRate = 0;
  if (typeof v.confidenceDampening !== "number") (v as any).confidenceDampening = 1.0;
  if (typeof v.reliabilityTier !== "string") (v as any).reliabilityTier = "unknown";
  return true;
}

function normalizeList(values: readonly string[], max = MAX_PATTERN_LIST): string[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    counts.set(trimmed, (counts.get(trimmed) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([value]) => value);
}

export function deriveTaskTypeKey(prompt: string, scopeType?: string): string {
  const normalized = prompt.toLowerCase();
  let action = "change";
  if (/\b(refactor|rename)\b/.test(normalized)) {
    action = "refactor";
  } else if (/\b(migrate|migration|schema)\b/.test(normalized)) {
    action = "migration";
  } else if (/\b(fix|bug|repair|correct)\b/.test(normalized)) {
    action = "fix";
  } else if (/\b(add|build|create|implement)\b/.test(normalized)) {
    action = "build";
  } else if (/\b(test|spec)\b/.test(normalized)) {
    action = "tests";
  }
  return `${scopeType ?? "unknown"}:${action}`;
}

function computeReliabilityTier(
  observedRuns: number,
  successRate: number,
  overconfidenceRate: number,
): TaskPatternProfile["reliabilityTier"] {
  if (observedRuns < 3) return "unknown";
  if (successRate >= 0.8 && overconfidenceRate < 0.15) return "reliable";
  if (successRate < 0.6 || overconfidenceRate >= 0.3) return "risky";
  return "caution";
}

function computeConfidenceDampening(
  evaluatedRuns: number,
  overconfidenceRate: number,
): number {
  // Only dampen when we have enough evaluation data (3+ evaluated runs)
  if (evaluatedRuns < 3) return 1.0;
  // Linear dampening: max 20% reduction for 100% overconfidence rate
  // Clamped to [0.80, 1.00] for stability — never crush confidence entirely
  return Math.max(0.80, 1.0 - overconfidenceRate * 0.20);
}

function updateTaskPatterns(
  patterns: readonly TaskPatternProfile[],
  summary: TaskSummary,
  touchedFiles: readonly string[],
): TaskPatternProfile[] {
  const taskTypeKey = summary.taskTypeKey ?? deriveTaskTypeKey(summary.prompt, summary.scopeType);
  const filesChanged = touchedFiles.length;
  const success = summary.verdict === "success" ? 1 : 0;
  const verificationGap = typeof summary.verificationCoverageRatio === "number" && summary.verificationCoverageRatio < 1 ? 1 : 0;
  const failureReasons = summary.failureSummary ? [summary.failureSummary] : [];
  const missingFiles = [
    ...(summary.missingFiles ?? []),
    ...(summary.undeclaredFiles ?? []).map((file) => `undeclared:${file}`),
  ];

  // Evaluation feedback signals
  const hasEvaluation = typeof summary.evaluationScore === "number";
  const evaluationContribution = hasEvaluation ? 1 : 0;
  const evaluationScoreContribution = typeof summary.evaluationScore === "number" ? summary.evaluationScore : 0;
  // Overconfident = Aedis confidence >= 0.7 AND evaluation failed
  const isOverconfident = (
    hasEvaluation &&
    summary.evaluationPassed === false &&
    typeof summary.aedisConfidence === "number" &&
    summary.aedisConfidence >= 0.7
  ) ? 1 : 0;

  const next = [...patterns];
  const idx = next.findIndex((pattern) => pattern.taskTypeKey === taskTypeKey);
  if (idx < 0) {
    const overconfidenceRate = isOverconfident;
    const evaluatedRuns = evaluationContribution;
    next.unshift({
      taskTypeKey,
      observedRuns: 1,
      avgFilesChanged: filesChanged,
      successRate: success,
      verificationGapRate: verificationGap,
      commonFailureReasons: normalizeList(failureReasons),
      commonMissingFiles: normalizeList(missingFiles),
      lastSeen: summary.timestamp,
      evaluatedRuns,
      avgEvaluationScore: evaluationScoreContribution,
      overconfidenceRate,
      confidenceDampening: computeConfidenceDampening(evaluatedRuns, overconfidenceRate),
      reliabilityTier: computeReliabilityTier(1, success, overconfidenceRate),
    });
  } else {
    const prev = next[idx];
    const observedRuns = prev.observedRuns + 1;
    const evaluatedRuns = prev.evaluatedRuns + evaluationContribution;
    const avgEvaluationScore = evaluatedRuns > 0
      ? Number((((prev.avgEvaluationScore * prev.evaluatedRuns) + evaluationScoreContribution) / evaluatedRuns).toFixed(1))
      : 0;
    const overconfidenceRate = evaluatedRuns > 0
      ? Number((((prev.overconfidenceRate * prev.evaluatedRuns) + isOverconfident) / evaluatedRuns).toFixed(3))
      : 0;
    const successRate = Number((((prev.successRate * prev.observedRuns) + success) / observedRuns).toFixed(3));

    next[idx] = {
      taskTypeKey,
      observedRuns,
      avgFilesChanged: Number((((prev.avgFilesChanged * prev.observedRuns) + filesChanged) / observedRuns).toFixed(2)),
      successRate,
      verificationGapRate: Number((((prev.verificationGapRate * prev.observedRuns) + verificationGap) / observedRuns).toFixed(3)),
      commonFailureReasons: normalizeList([...prev.commonFailureReasons, ...failureReasons]),
      commonMissingFiles: normalizeList([...prev.commonMissingFiles, ...missingFiles]),
      lastSeen: summary.timestamp,
      evaluatedRuns,
      avgEvaluationScore,
      overconfidenceRate,
      confidenceDampening: computeConfidenceDampening(evaluatedRuns, overconfidenceRate),
      reliabilityTier: computeReliabilityTier(observedRuns, successRate, overconfidenceRate),
    };
  }

  // Decay: patterns not seen in 30+ days lose half their weight per
  // save cycle. This prevents stale historical data from permanently
  // influencing confidence calibration. The decay is gentle — a
  // pattern needs to be unseen for multiple months to fully evaporate.
  const DECAY_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
  const now = Date.now();
  for (let i = 0; i < next.length; i++) {
    const age = now - new Date(next[i].lastSeen).getTime();
    if (age > DECAY_AGE_MS && next[i].observedRuns > 1) {
      const p = next[i];
      // Halve observed runs to reduce weight, but never below 1
      const decayedRuns = Math.max(1, Math.floor(p.observedRuns / 2));
      next[i] = { ...p, observedRuns: decayedRuns };
    }
  }

  return next
    .sort((a, b) => b.observedRuns - a.observedRuns || b.lastSeen.localeCompare(a.lastSeen))
    .slice(0, MAX_PATTERNS);
}

export function findPatternWarnings(
  memory: ProjectMemory,
  input: {
    prompt: string;
    scopeType?: string;
    plannedFilesCount?: number;
  },
): string[] {
  const taskTypeKey = deriveTaskTypeKey(input.prompt, input.scopeType);
  const pattern = memory.taskPatterns.find((entry) => entry.taskTypeKey === taskTypeKey);
  if (!pattern || pattern.observedRuns < 2) return [];

  const warnings: string[] = [];
  if (
    typeof input.plannedFilesCount === "number" &&
    pattern.avgFilesChanged >= input.plannedFilesCount + 1.5
  ) {
    warnings.push(
      `Similar ${taskTypeKey} tasks usually touch about ${Math.round(pattern.avgFilesChanged)} files; current plan may be too narrow.`,
    );
  }
  if (pattern.verificationGapRate >= 0.4) {
    warnings.push(
      `Similar ${taskTypeKey} tasks often ship with verification gaps (${Math.round(pattern.verificationGapRate * 100)}%). Review coverage closely.`,
    );
  }
  if (pattern.commonFailureReasons.length > 0 && pattern.successRate < 0.7) {
    warnings.push(
      `Similar ${taskTypeKey} tasks fail often (${Math.round(pattern.successRate * 100)}% success). Common issue: ${pattern.commonFailureReasons[0]}.`,
    );
  }
  if (pattern.commonMissingFiles.length > 0) {
    warnings.push(
      `Similar ${taskTypeKey} tasks commonly miss: ${pattern.commonMissingFiles.slice(0, 2).join(", ")}.`,
    );
  }
  return warnings.slice(0, 3);
}

// ─── Trust calibration queries ──────────────────────────────────────

export interface HistoricalInsight {
  /** One-line description for the explanation layer. */
  readonly line: string;
  /** Machine-readable category for UI filtering. */
  readonly category: "success-rate" | "overconfidence" | "verification-gap" | "reliability";
  /** Severity: determines whether this displaces other explanation lines. */
  readonly severity: "info" | "warning";
}

/**
 * Generate historical insights for a task pattern. Returns 0-2 compact
 * lines suitable for the explanation layer. Only produces insights when
 * there's enough history (3+ runs) to be meaningful.
 */
export function findHistoricalInsights(
  memory: ProjectMemory,
  input: { prompt: string; scopeType?: string },
): readonly HistoricalInsight[] {
  const taskTypeKey = deriveTaskTypeKey(input.prompt, input.scopeType);
  const pattern = memory.taskPatterns.find((p) => p.taskTypeKey === taskTypeKey);
  if (!pattern || pattern.observedRuns < 3) return [];

  const insights: HistoricalInsight[] = [];

  // Success rate insight — always show if enough history
  const pct = Math.round(pattern.successRate * 100);
  insights.push({
    line: `Similar changes: ${pct}% success rate across ${pattern.observedRuns} runs`,
    category: "success-rate",
    severity: "info",
  });

  // Overconfidence warning — only when evaluated and drift detected
  if (pattern.evaluatedRuns >= 3 && pattern.overconfidenceRate >= 0.25) {
    insights.push({
      line: `Aedis confidence previously overstated for this pattern (${Math.round(pattern.overconfidenceRate * 100)}% overconfident)`,
      category: "overconfidence",
      severity: "warning",
    });
  }

  // Reliability tier context
  if (pattern.reliabilityTier === "risky") {
    insights.push({
      line: `This task type is historically risky — consider decomposition or stronger review`,
      category: "reliability",
      severity: "warning",
    });
  }

  return insights.slice(0, 2);
}

/**
 * Get the confidence dampening factor for a task pattern. Returns 1.0
 * (no dampening) when there's insufficient history or the pattern is
 * reliable. Returns < 1.0 when the pattern is historically overconfident.
 */
export function getConfidenceDampening(
  memory: ProjectMemory,
  input: { prompt: string; scopeType?: string },
): number {
  const taskTypeKey = deriveTaskTypeKey(input.prompt, input.scopeType);
  const pattern = memory.taskPatterns.find((p) => p.taskTypeKey === taskTypeKey);
  if (!pattern) return 1.0;
  return pattern.confidenceDampening;
}

/**
 * Recommend whether strict mode should be enabled based on historical
 * pattern data. Returns true when the pattern shows frequent verification
 * gaps or low reliability.
 */
export function shouldRecommendStrictMode(
  memory: ProjectMemory,
  input: { prompt: string; scopeType?: string },
): boolean {
  const taskTypeKey = deriveTaskTypeKey(input.prompt, input.scopeType);
  const pattern = memory.taskPatterns.find((p) => p.taskTypeKey === taskTypeKey);
  if (!pattern || pattern.observedRuns < 3) return false;
  // Recommend strict mode when verification gaps are frequent
  // or the pattern is historically risky
  return pattern.verificationGapRate >= 0.5 || pattern.reliabilityTier === "risky";
}

/**
 * Get the historical reliability tier for a task pattern.
 * Returns null when no pattern matches.
 */
export function getReliabilityTier(
  memory: ProjectMemory,
  input: { prompt: string; scopeType?: string },
): TaskPatternProfile["reliabilityTier"] | null {
  const taskTypeKey = deriveTaskTypeKey(input.prompt, input.scopeType);
  const pattern = memory.taskPatterns.find((p) => p.taskTypeKey === taskTypeKey);
  if (!pattern) return null;
  return pattern.reliabilityTier;
}

function updateFileClusters(
  clusters: readonly FileCluster[],
  touchedFiles: readonly string[],
  timestamp: string,
): FileCluster[] {
  if (touchedFiles.length <= 1) {
    return [...clusters].slice(0, MAX_CLUSTERS);
  }

  const normalizedTouched = normalizeTouchedFiles(touchedFiles).sort();
  const existingIndex = clusters.findIndex((cluster) =>
    cluster.files.some((file) => normalizedTouched.includes(file)),
  );

  const nextClusters = [...clusters];

  if (existingIndex >= 0) {
    const existing = nextClusters[existingIndex];
    const mergedFiles = Array.from(new Set([...existing.files, ...normalizedTouched])).sort();
    nextClusters[existingIndex] = {
      files: mergedFiles,
      changedTogether: existing.changedTogether + 1,
      lastSeen: timestamp,
    };
  } else {
    nextClusters.unshift({
      files: normalizedTouched,
      changedTogether: 1,
      lastSeen: timestamp,
    });
  }

  return nextClusters
    .sort((a, b) => {
      if (b.changedTogether !== a.changedTogether) {
        return b.changedTogether - a.changedTogether;
      }
      return b.lastSeen.localeCompare(a.lastSeen);
    })
    .slice(0, MAX_CLUSTERS);
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Load the project memory for `projectRoot`. If the file does not exist
 * or is unreadable/corrupt, returns a fresh empty memory with the
 * detected language pre-filled. Never throws.
 */
export async function loadMemory(projectRoot: string): Promise<ProjectMemory> {
  const root = resolve(projectRoot);
  const path = memoryPath(root);
  const language = await detectLanguage(root);

  if (!(await fileExists(path))) {
    return emptyMemory(root, language);
  }

  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<ProjectMemory>;
    return {
      projectRoot: root,
      language: typeof parsed.language === "string" && parsed.language.length > 0
        ? parsed.language
        : language,
      recentFiles: Array.isArray(parsed.recentFiles)
        ? parsed.recentFiles
            .filter((entry): entry is string => typeof entry === "string")
            .slice(0, MAX_FILES)
        : [],
      recentTasks: Array.isArray(parsed.recentTasks)
        ? parsed.recentTasks
            .filter(isTaskSummary)
            .slice(0, MAX_TASKS)
        : [],
      fileClusters: Array.isArray(parsed.fileClusters)
        ? parsed.fileClusters
            .filter(isFileCluster)
            .map((cluster) => ({
              files: normalizeTouchedFiles(cluster.files).slice(0, MAX_FILES),
              changedTogether: cluster.changedTogether,
              lastSeen: cluster.lastSeen,
            }))
            .slice(0, MAX_CLUSTERS)
        : [],
      taskPatterns: Array.isArray(parsed.taskPatterns)
        ? parsed.taskPatterns
            .filter(isTaskPatternProfile)
            .slice(0, MAX_PATTERNS)
        : [],
      updatedAt: typeof parsed.updatedAt === "string"
        ? parsed.updatedAt
        : new Date().toISOString(),
      schemaVersion: typeof parsed.schemaVersion === "number" ? parsed.schemaVersion : 1,
    };
  } catch {
    return emptyMemory(root, language);
  }
}

/**
 * Persist `memory` to {projectRoot}/.aedis/memory.json. Creates the
 * .aedis directory if needed. Caps recentFiles/recentTasks to their
 * maxima and refreshes `updatedAt` so callers don't have to.
 */
export async function saveMemory(
  projectRoot: string,
  memory: ProjectMemory,
): Promise<void> {
  const root = resolve(projectRoot);
  const path = memoryPath(root);
  await mkdir(dirname(path), { recursive: true });

  const next: ProjectMemory = {
    projectRoot: root,
    language: memory.language,
    recentFiles: memory.recentFiles.slice(0, MAX_FILES),
    recentTasks: memory.recentTasks.slice(0, MAX_TASKS),
    fileClusters: memory.fileClusters.slice(0, MAX_CLUSTERS),
    taskPatterns: memory.taskPatterns.slice(0, MAX_PATTERNS),
    updatedAt: new Date().toISOString(),
    schemaVersion: memory.schemaVersion,
  };

  // Atomic write: write to temp file then rename to prevent corruption
  // from concurrent runs or crashes mid-write.
  const tmpPath = `${path}.tmp`;
  await writeFile(tmpPath, JSON.stringify(next, null, 2), "utf8");
  await rename(tmpPath, path);
}

/**
 * Record a finished task into the project memory and persist. The new
 * task is prepended to `recentTasks`; any `filesTouched` are merged into
 * `recentFiles` (most-recent-first, deduped, capped at 20). Multi-file
 * tasks also update `fileClusters` so memory learns which files tend to
 * move together. Returns the updated memory snapshot.
 */
export async function recordTask(
  projectRoot: string,
  taskSummary: TaskSummary,
): Promise<ProjectMemory> {
  const memory = await loadMemory(projectRoot);

  const touched = Array.isArray(taskSummary.filesTouched)
    ? normalizeTouchedFiles(taskSummary.filesTouched)
    : [];

  // Most-recent-first dedupe: new files come first, then any existing
  // entries that aren't already in the new set, capped at MAX_FILES.
  const seen = new Set<string>();
  const recentFiles: string[] = [];
  for (const file of [...touched, ...memory.recentFiles]) {
    if (seen.has(file)) continue;
    seen.add(file);
    recentFiles.push(file);
    if (recentFiles.length >= MAX_FILES) break;
  }

  const recentTasks = [taskSummary, ...memory.recentTasks].slice(0, MAX_TASKS);
  const fileClusters = updateFileClusters(memory.fileClusters, touched, taskSummary.timestamp);
  const taskPatterns = updateTaskPatterns(memory.taskPatterns ?? [], taskSummary, touched);

  const next: ProjectMemory = {
    projectRoot: memory.projectRoot,
    language: memory.language,
    recentFiles,
    recentTasks,
    fileClusters,
    taskPatterns,
    updatedAt: new Date().toISOString(),
    schemaVersion: memory.schemaVersion,
  };

  await saveMemory(projectRoot, next);
  return next;
}

/**
 * Reset the project memory to an empty state while preserving the detected
 * language and project root. Useful for starting a fresh session without
 * deleting the memory file itself.
 */
export async function clearMemory(projectRoot: string): Promise<ProjectMemory> {
  const memory = await loadMemory(projectRoot);
  const next: ProjectMemory = {
    projectRoot: memory.projectRoot,
    language: memory.language,
    recentFiles: [],
    recentTasks: [],
    fileClusters: [],
    taskPatterns: [],
    updatedAt: new Date().toISOString(),
    schemaVersion: memory.schemaVersion,
  };
  await saveMemory(projectRoot, next);
  return next;
}

/**
 * Delete the project memory file if it exists. Does not throw if the file
 * is already missing. Useful for resetting project state completely.
 */
export async function deleteMemory(projectRoot: string): Promise<void> {
  const path = memoryPath(projectRoot);
  if (await fileExists(path)) {
    await unlink(path);
  }
}

/**
 * Returns the absolute path to the memory file for a given project root.
 * Useful for external tooling, debugging, or manual inspection.
 */
export function getMemoryFilePath(projectRoot: string): string {
  return memoryPath(projectRoot);
}
