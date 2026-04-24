/**
 * ProjectMemoryStore — persistent per-project knowledge entries.
 *
 * Design principles:
 * - Memory is ADVISORY ONLY — never blocks or overrides source code truth
 * - Current repo always wins — if memory conflicts, repo wins
 * - Explicit > Implicit — every entry has source, confidence, expiry
 * - Bounded — max 200 entries, LRU eviction, auto-expiry
 * - Inspectable — every entry debuggable via /memory debug endpoint
 *
 * Storage: {projectRoot}/data/project-memory/
 *   meta.json        — entry id → filename index
 *   entries/         — individual entry JSON files
 *   access-log.json  — LRU tracking (lastAccessedAt for all entries)
 */

import { access, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";

// ─── Types ───────────────────────────────────────────────────────────

export interface ProjectMemoryEntry {
  id: string;
  key: string;
  value: string;
  confidence: number;       // 0.0-1.0
  source: string;          // e.g. "task-abc-123", "file:workers/verifier.ts"
  tags: string[];          // e.g. ["architecture", "conventions"]
  createdAt: number;
  updatedAt: number;
  lastAccessedAt: number;
  observationCount: number;
  expired: boolean;        // soft-delete when stale/incorrect
  expiresAt: number | null;
}

export interface MemoryObservation {
  taskId: string;
  timestamp: number;
  confirmed: boolean;
}

export interface MemoryEntryFile {
  entry: ProjectMemoryEntry;
  observations: MemoryObservation[];
}

// ─── Constants ───────────────────────────────────────────────────────

const STORAGE_DIR = "data/project-memory";
const META_FILE = "meta.json";
const ENTRIES_DIR = "entries";
const ACCESS_LOG_FILE = "access-log.json";
const MAX_ENTRIES = 200;
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;  // 30 days
const HIGH_CONFIDENCE_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
const USER_PROVIDED_TTL_MS = 60 * 24 * 60 * 60 * 1000;  // 60 days

interface Meta {
  entries: Record<string, string>; // id → filename
}

interface AccessLog {
  lastAccessed: Record<string, number>; // id → lastAccessedAt
}

// ─── Helpers ─────────────────────────────────────────────────────────

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function storagePath(projectRoot: string, ...parts: string[]): string {
  return join(resolve(projectRoot), STORAGE_DIR, ...parts);
}

async function ensureStorageDir(projectRoot: string): Promise<void> {
  await mkdir(storagePath(projectRoot), { recursive: true });
  await mkdir(storagePath(projectRoot, ENTRIES_DIR), { recursive: true });
}

// ─── Meta helpers ────────────────────────────────────────────────────

async function loadMeta(projectRoot: string): Promise<Meta> {
  const path = storagePath(projectRoot, META_FILE);
  if (!(await fileExists(path))) return { entries: {} };
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<Meta>;
    return { entries: parsed?.entries ?? {} };
  } catch {
    return { entries: {} };
  }
}

async function saveMeta(projectRoot: string, meta: Meta): Promise<void> {
  const path = storagePath(projectRoot, META_FILE);
  await writeFile(path, JSON.stringify(meta, null, 2), "utf8");
}

// ─── Access log helpers ──────────────────────────────────────────────

async function loadAccessLog(projectRoot: string): Promise<AccessLog> {
  const path = storagePath(projectRoot, ACCESS_LOG_FILE);
  if (!(await fileExists(path))) return { lastAccessed: {} };
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<AccessLog>;
    return { lastAccessed: parsed?.lastAccessed ?? {} };
  } catch {
    return { lastAccessed: {} };
  }
}

async function saveAccessLog(projectRoot: string, log: AccessLog): Promise<void> {
  const path = storagePath(projectRoot, ACCESS_LOG_FILE);
  await writeFile(path, JSON.stringify(log, null, 2), "utf8");
}

async function touchEntry(projectRoot: string, entryId: string): Promise<void> {
  const log = await loadAccessLog(projectRoot);
  log.lastAccessed[entryId] = Date.now();
  await saveAccessLog(projectRoot, log);
}

// ─── Atomic write helper ─────────────────────────────────────────────

async function atomicWrite(path: string, data: string): Promise<void> {
  const tmp = `${path}.tmp.${process.pid}`;
  await writeFile(tmp, data, "utf8");
  await rename(tmp, path);
}

// ─── Expiry helpers ──────────────────────────────────────────────────

function computeExpiresAt(confidence: number, source: string): number {
  const now = Date.now();
  if (confidence >= 0.9) return now + HIGH_CONFIDENCE_TTL_MS;
  if (source.startsWith("user:")) return now + USER_PROVIDED_TTL_MS;
  return now + DEFAULT_TTL_MS;
}

// ─── ProjectMemoryStore ───────────────────────────────────────────────

export class ProjectMemoryStore {
  private projectRoot: string;
  private meta: Meta;
  private accessLog: AccessLog;
  private dirty: boolean = false;

  private constructor(projectRoot: string, meta: Meta, accessLog: AccessLog) {
    this.projectRoot = resolve(projectRoot);
    this.meta = meta;
    this.accessLog = accessLog;
  }

  // ─── Factory / lifecycle ───────────────────────────────────────────

  /**
   * Open (or create) the memory store for `projectRoot`.
   * Runs expiry check on all entries as a side effect.
   */
  static async open(projectRoot: string): Promise<ProjectMemoryStore> {
    await ensureStorageDir(projectRoot);
    const meta = await loadMeta(projectRoot);
    const accessLog = await loadAccessLog(projectRoot);

    const store = new ProjectMemoryStore(projectRoot, meta, accessLog);
    await store.runExpiryCheck();
    return store;
  }

  /** Close the store (no-op for now, but signals intent). */
  close(): void {
    // future: flush any buffered state
  }

  // ─── CRUD ─────────────────────────────────────────────────────────

  /**
   * Create a new memory entry.
   * Auto-assigns id, createdAt, updatedAt, lastAccessedAt, observationCount=0.
   * Sets expiresAt based on confidence and source.
   * Prunes if over MAX_ENTRIES limit.
   */
  async createEntry(params: {
    key: string;
    value: string;
    confidence: number;
    source: string;
    tags?: string[];
  }): Promise<ProjectMemoryEntry> {
    const now = Date.now();
    const entry: ProjectMemoryEntry = {
      id: randomUUID(),
      key: params.key,
      value: params.value,
      confidence: params.confidence,
      source: params.source,
      tags: params.tags ?? [],
      createdAt: now,
      updatedAt: now,
      lastAccessedAt: now,
      observationCount: 0,
      expired: false,
      expiresAt: computeExpiresAt(params.confidence, params.source),
    };

    const filename = this.nextFilename();
    const entryFile: MemoryEntryFile = { entry, observations: [] };

    await ensureStorageDir(this.projectRoot);
    const entryPath = storagePath(this.projectRoot, ENTRIES_DIR, filename);
    await atomicWrite(entryPath, JSON.stringify(entryFile, null, 2));

    this.meta.entries[entry.id] = filename;
    await saveMeta(this.projectRoot, this.meta);

    this.accessLog.lastAccessed[entry.id] = now;
    await saveAccessLog(this.projectRoot, this.accessLog);

    await this.ensureMaxEntries();

    return entry;
  }

  /**
   * Get a single entry by id. Returns null if not found or expired.
   * Updates lastAccessedAt.
   */
  async getEntry(id: string): Promise<ProjectMemoryEntry | null> {
    const filename = this.meta.entries[id];
    if (!filename) return null;

    const entryPath = storagePath(this.projectRoot, ENTRIES_DIR, filename);
    if (!(await fileExists(entryPath))) return null;

    try {
      const raw = await readFile(entryPath, "utf8");
      const { entry } = JSON.parse(raw) as MemoryEntryFile;

      // Touch access time
      await touchEntry(this.projectRoot, id);

      return entry;
    } catch {
      return null;
    }
  }

  /**
   * List all entries (optionally filtered by tag).
   * Includes expired entries — caller must filter if needed.
   * Updates lastAccessedAt for each returned entry.
   */
  async listEntries(options?: { tag?: string; includeExpired?: boolean }): Promise<ProjectMemoryEntry[]> {
    const results: ProjectMemoryEntry[] = [];

    for (const [id, filename] of Object.entries(this.meta.entries)) {
      const entry = await this.getEntry(id);
      if (!entry) continue;

      if (options?.tag && !entry.tags.includes(options.tag)) continue;
      if (!options?.includeExpired && entry.expired) continue;

      results.push(entry);
    }

    return results;
  }

  /**
   * Update an existing entry's value and related fields.
   * Creates a new observation record.
   * Returns null if entry not found.
   */
  async updateEntry(
    id: string,
    params: {
      value?: string;
      confidence?: number;
      tags?: string[];
      expired?: boolean;
      observation?: { taskId: string; confirmed: boolean };
    },
  ): Promise<ProjectMemoryEntry | null> {
    const filename = this.meta.entries[id];
    if (!filename) return null;

    const entryPath = storagePath(this.projectRoot, ENTRIES_DIR, filename);
    if (!(await fileExists(entryPath))) return null;

    try {
      const raw = await readFile(entryPath, "utf8");
      const file = JSON.parse(raw) as MemoryEntryFile;

      const now = Date.now();
      const updatedEntry: ProjectMemoryEntry = {
        ...file.entry,
        updatedAt: now,
        lastAccessedAt: now,
      };

      if (params.value !== undefined) updatedEntry.value = params.value;
      if (params.confidence !== undefined) updatedEntry.confidence = params.confidence;
      if (params.tags !== undefined) updatedEntry.tags = params.tags;
      if (params.expired !== undefined) updatedEntry.expired = params.expired;

      // Add observation
      if (params.observation) {
        updatedEntry.observationCount = file.entry.observationCount + 1;
        file.observations.push({
          taskId: params.observation.taskId,
          timestamp: now,
          confirmed: params.observation.confirmed,
        });
      }

      // Sync the updated entry back into the file before persisting
      file.entry = updatedEntry;

      await atomicWrite(entryPath, JSON.stringify(file, null, 2));
      await touchEntry(this.projectRoot, id);

      return updatedEntry;
    } catch {
      return null;
    }
  }

  /**
   * Flag an entry as expired/incorrect.
   * Sets expired=true, confidence=0.1, and updates lastAccessedAt.
   */
  async flagExpired(id: string, reason?: string): Promise<ProjectMemoryEntry | null> {
    return this.updateEntry(id, {
      confidence: 0.1,
      expired: true,
      observation: { taskId: `flag:${reason ?? "manual"}`, confirmed: false },
    });
  }

  // ─── Retrieval ─────────────────────────────────────────────────────

  /**
   * Get memory entries relevant to a task.
   * Ranks by: tag overlap > recency (lastAccessedAt) > confidence > observationCount.
   * Excludes expired entries by default.
   */
  async getMemoryForTask(taskTags: string[]): Promise<ProjectMemoryEntry[]> {
    const all = await this.listEntries({ includeExpired: false });
    if (all.length === 0) return [];

    const scored = all.map((entry) => {
      let tagScore = 0;
      for (const tag of taskTags) {
        if (entry.tags.includes(tag)) tagScore++;
      }
      return { entry, tagScore };
    });

    // Sort: tag overlap desc, then lastAccessedAt desc, then confidence desc, then obs count desc
    scored.sort((a, b) => {
      if (b.tagScore !== a.tagScore) return b.tagScore - a.tagScore;
      if (b.entry.lastAccessedAt !== a.entry.lastAccessedAt) return b.entry.lastAccessedAt - a.entry.lastAccessedAt;
      if (b.entry.confidence !== a.entry.confidence) return b.entry.confidence - a.entry.confidence;
      return b.entry.observationCount - a.entry.observationCount;
    });

    return scored.map((s) => s.entry);
  }

  /**
   * Get all entries with a specific tag.
   */
  async getMemoryEntries(tag: string): Promise<ProjectMemoryEntry[]> {
    return this.listEntries({ tag, includeExpired: false });
  }

  // ─── Pruning / expiry ──────────────────────────────────────────────

  /**
   * Run expiry check: any entry where expiresAt < now becomes expired=true.
   * Called automatically on store open.
   */
  async runExpiryCheck(): Promise<number> {
    const now = Date.now();
    let expiredCount = 0;

    for (const [id, filename] of Object.entries(this.meta.entries)) {
      const entryPath = storagePath(this.projectRoot, ENTRIES_DIR, filename);
      if (!(await fileExists(entryPath))) continue;

      try {
        const raw = await readFile(entryPath, "utf8");
        const file = JSON.parse(raw) as MemoryEntryFile;

        if (!file.entry.expired && file.entry.expiresAt !== null && file.entry.expiresAt < now) {
          file.entry.expired = true;
          await atomicWrite(entryPath, JSON.stringify(file, null, 2));
          expiredCount++;
        }
      } catch {
        // skip unreadable entries
      }
    }

    return expiredCount;
  }

  /**
   * Prune oldest entries when over MAX_ENTRIES limit.
   * Evicts lowest lastAccessedAt entries that are either expired OR confidence < 0.3.
   * High-confidence entries (>= 0.9) are never evicted when under the limit.
   */
  async ensureMaxEntries(): Promise<number> {
    const all = await this.listEntries({ includeExpired: true });
    if (all.length <= MAX_ENTRIES) return 0;

    // Sort by lastAccessedAt asc (oldest first)
    const sorted = [...all].sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);

    let evicted = 0;
    const toEvict = new Set<string>();

    for (const entry of sorted) {
      if (all.length - evicted <= MAX_ENTRIES) break;

      // Never evict high-confidence entries
      if (entry.confidence >= 0.9) continue;

      // Evict if expired or low confidence
      if (entry.expired || entry.confidence < 0.3) {
        toEvict.add(entry.id);
        evicted++;
      }
    }

    for (const id of toEvict) {
      await this.deleteEntry(id);
    }

    return evicted;
  }

  /**
   * Delete an entry permanently.
   */
  async deleteEntry(id: string): Promise<boolean> {
    const filename = this.meta.entries[id];
    if (!filename) return false;

    const entryPath = storagePath(this.projectRoot, ENTRIES_DIR, filename);
    if (await fileExists(entryPath)) {
      await unlink(entryPath);
    }

    delete this.meta.entries[id];
    await saveMeta(this.projectRoot, this.meta);

    delete this.accessLog.lastAccessed[id];
    await saveAccessLog(this.projectRoot, this.accessLog);

    return true;
  }

  // ─── Debug / inspection ───────────────────────────────────────────

  /** List all entry ids (including expired). */
  async listEntryIds(): Promise<string[]> {
    return Object.keys(this.meta.entries);
  }

  /** Get full entry file including observations. */
  async getEntryFile(id: string): Promise<MemoryEntryFile | null> {
    const filename = this.meta.entries[id];
    if (!filename) return null;

    const entryPath = storagePath(this.projectRoot, ENTRIES_DIR, filename);
    if (!(await fileExists(entryPath))) return null;

    try {
      const raw = await readFile(entryPath, "utf8");
      return JSON.parse(raw) as MemoryEntryFile;
    } catch {
      return null;
    }
  }

  /** Get storage stats. */
  async stats(): Promise<{ total: number; expired: number; active: number }> {
    const all = await this.listEntries({ includeExpired: true });
    const expired = all.filter((e) => e.expired).length;
    return { total: all.length, expired, active: all.length - expired };
  }

  // ─── Internal helpers ──────────────────────────────────────────────

  private nextFilename(): string {
    const existing = new Set(Object.values(this.meta.entries));
    let n = 1;
    while (existing.has(`${String(n).padStart(4, "0")}.json`)) n++;
    return `${String(n).padStart(4, "0")}.json`;
  }
}

// ─── Standalone helpers (no store instance needed) ───────────────────

/**
 * Create or append to an entry. If the key already exists, the existing
 * entry's observationCount is incremented and lastAccessedAt is updated.
 * Returns the entry (new or existing).
 */
export async function upsertEntry(
  projectRoot: string,
  params: {
    key: string;
    value: string;
    confidence: number;
    source: string;
    tags?: string[];
    taskId?: string;
    confirmed?: boolean;
  },
): Promise<ProjectMemoryEntry> {
  const store = await ProjectMemoryStore.open(projectRoot);

  // Check if entry with this key already exists
  const existing = await store.listEntries({ includeExpired: true });
  const match = existing.find((e) => e.key === params.key && !e.expired);

  if (match) {
    const now = Date.now();
    // Update existing: value can be updated, observation added
    const filePath = storagePath(projectRoot, ENTRIES_DIR, store["meta"].entries[match.id]);
    const raw = await readFile(filePath, "utf8");
    const file = JSON.parse(raw) as MemoryEntryFile;

    file.entry.value = params.value; // update value
    file.entry.observationCount++;
    file.entry.updatedAt = now;
    file.entry.lastAccessedAt = now;
    if (params.tags) file.entry.tags = [...new Set([...file.entry.tags, ...params.tags])];

    if (params.taskId) {
      file.observations.push({
        taskId: params.taskId,
        timestamp: now,
        confirmed: params.confirmed ?? false,
      });
    }

    await atomicWrite(filePath, JSON.stringify(file, null, 2));
    await touchEntry(projectRoot, match.id);

    return file.entry;
  }

  return store.createEntry(params);
}

import { readFile as rf, writeFile as wf } from "node:fs/promises";