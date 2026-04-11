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

import { access, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

// ─── Public types ────────────────────────────────────────────────────

export interface TaskSummary {
  readonly prompt: string;
  readonly verdict: string;
  readonly commitSha: string | null;
  readonly cost: number;
  readonly timestamp: string;
  /**
   * Optional list of files touched by this task. When provided, recordTask
   * folds them into the memory's `recentFiles` list (deduped, capped).
   */
  readonly filesTouched?: readonly string[];
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
  readonly updatedAt: string;
  readonly schemaVersion: number;
}

// ─── Internals ───────────────────────────────────────────────────────

const MEMORY_DIR = ".aedis";
const MEMORY_FILE = "memory.json";
const MAX_FILES = 20;
const MAX_TASKS = 10;
const MAX_CLUSTERS = 20;

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
    updatedAt: new Date().toISOString(),
    schemaVersion: memory.schemaVersion,
  };

  await writeFile(path, JSON.stringify(next, null, 2), "utf8");
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

  const next: ProjectMemory = {
    projectRoot: memory.projectRoot,
    language: memory.language,
    recentFiles,
    recentTasks,
    fileClusters,
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
