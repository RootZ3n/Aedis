import type { Deliverable, IntentObject } from "./intent.js";
import type { Invariant } from "./invariant-extractor.js";
import type { ImportGraph } from "./import-graph.js";

export type FileStatus =
  | "planned"
  | "in-progress"
  | "blocked"
  | "complete"
  | "verified"
  | "failed"
  | "skipped";

export type FileNecessity = "required" | "optional";

export type FileSensitivity = "normal" | "sensitive" | "critical";

export type FileMutationRole =
  | "write-required"
  | "write-optional"
  | "read-context"
  | "import-reference"
  | "type-reference"
  | "skipped-unsupported";

export interface FileInclusion {
  readonly path: string;
  readonly whyIncluded: string;
  readonly dependsOn: readonly string[];
  readonly status: FileStatus;
  /**
   * Whether this file is required for the change to be coherent, or
   * optional (e.g. docs, ancillary tests). Optional file failures
   * degrade to warnings instead of blocking the run.
   */
  readonly necessity: FileNecessity;
  /**
   * Whether this file is expected to mutate or is present only as
   * context/reference. `necessity` answers "is it relevant to the
   * task"; `mutationRole` answers "must the on-disk file change".
   */
  readonly mutationRole: FileMutationRole;
  readonly mutationExpected: boolean;
  readonly mutationReason: string;
  /**
   * Execution order hint — lower numbers execute first within the
   * same wave. Derived from dependency depth and file classification.
   * Zero-indexed.
   */
  readonly executionOrder: number;
  /**
   * Sensitivity classification for governance. Sensitive and critical
   * files lower confidence, trigger stronger review, and may block
   * autonomous apply.
   */
  readonly sensitivity: FileSensitivity;
  /**
   * Outcome of this file's processing at run completion. Null while
   * the run is still in progress.
   */
  readonly outcome: FileOutcome | null;
}

export interface FileOutcome {
  readonly status: "succeeded" | "failed" | "skipped" | "rolled_back";
  readonly reason: string;
  /** Wave this file was processed in, if applicable. */
  readonly waveId: number | null;
}

export interface CoherenceVerdict {
  readonly coherent: boolean;
  readonly reason: string;
}

export interface ChangeSet {
  readonly intent: IntentObject;
  readonly filesInScope: readonly FileInclusion[];
  readonly dependencyRelationships: Readonly<Record<string, readonly string[]>>;
  readonly invariants: readonly Invariant[];
  readonly sharedInvariants: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly coherenceVerdict: CoherenceVerdict;
}

function normalizeFiles(
  files: readonly string[],
  sourceRepo?: string,
): string[] {
  // Deduplicate absolute+relative duplicates. If a file appears as both
  // /mnt/ai/squidley-v2/... (absolute) and apps/... (worktree-relative),
  // resolve both to worktree-relative canonical form before deduplicating.
  const canonical = files.map((f) => {
    const trimmed = f.trim();
    if (!trimmed) return "";
    // Resolve absolute source-repo paths to worktree-relative.
    // This handles paths like /mnt/ai/squidley-v2/apps/api/src/routes/index.ts
    // that need to be expressed as apps/api/src/routes/index.ts for downstream
    // components (Builder, IntegrationJudge) that resolve relative to projectRoot.
    if (sourceRepo && trimmed.startsWith(sourceRepo)) {
      return trimmed.slice(sourceRepo.length).replace(/^[\\/]+/, "");
    }
    return trimmed;
  });
  return Array.from(new Set(canonical.filter((f) => f.length > 0)));
}

// ─── Sensitive File Detection ────────────────────────────────────────

const CRITICAL_FILE_PATTERNS = [
  /\bauth\b/i,
  /\bsecret/i,
  /\bcredential/i,
  /\bpassword/i,
  /\btoken/i,
  /\bpermission/i,
  /\.env($|\.)/,
  /\.(pem|key|cert)$/,
];

const SENSITIVE_FILE_PATTERNS = [
  /^package\.json$/,
  /^package-lock\.json$/,
  /^pnpm-lock\.yaml$/,
  /^yarn\.lock$/,
  /^tsconfig.*\.json$/,
  /^\.eslintrc/,
  /^\.prettierrc/,
  /^Dockerfile/,
  /^docker-compose/,
  /\.ya?ml$/,
  /^Makefile$/,
  /^\.github\//,
  /^\.gitlab-ci/,
  /^jest\.config/,
  /^vitest\.config/,
  /^vite\.config/,
  /^next\.config/,
  /^webpack\.config/,
  /\bmigration/i,
  /\bschema\b.*\.(sql|prisma|graphql)$/i,
  /^index\.[jt]sx?$/,
  /\/index\.[jt]sx?$/,
];

export function classifyFileSensitivity(filePath: string): FileSensitivity {
  const normalized = filePath.replace(/\\/g, "/");
  const basename = normalized.includes("/") ? normalized.slice(normalized.lastIndexOf("/") + 1) : normalized;

  if (CRITICAL_FILE_PATTERNS.some((pattern) => pattern.test(normalized) || pattern.test(basename))) {
    return "critical";
  }
  if (SENSITIVE_FILE_PATTERNS.some((pattern) => pattern.test(normalized) || pattern.test(basename))) {
    return "sensitive";
  }
  return "normal";
}

function isTestLikePath(file: string): boolean {
  const normalized = file.toLowerCase();
  return (
    normalized.includes("test") ||
    normalized.includes("spec") ||
    normalized.includes("__mocks__")
  );
}

function isAutoInjectedTestPair(deliverable: Deliverable): boolean {
  return /^test pairs for changed implementation files$/i.test(deliverable.description.trim());
}

function userExplicitlyAskedForTestMutation(userRequest: string): boolean {
  return (
    /\b(add|update|write|create|implement)\b.{0,80}\b(?:focused\s+|unit\s+|regression\s+)?tests?\b/i.test(userRequest) ||
    /\btests?\b.{0,80}\b(add|update|write|create|implement)\b/i.test(userRequest) ||
    /\b(?:test|spec)\s+(?:file|coverage)\b/i.test(userRequest) ||
    /\.(?:test|spec)\.[cm]?[jt]sx?\b/i.test(userRequest)
  );
}

function isExplicitMutableTestDeliverable(
  intent: IntentObject,
  deliverable: Deliverable | undefined,
  file: string,
): boolean {
  if (!deliverable || !isTestLikePath(file) || isAutoInjectedTestPair(deliverable)) return false;
  const userRequest = intent.userRequest;
  return (
    userRequest.toLowerCase().includes(file.toLowerCase()) ||
    userExplicitlyAskedForTestMutation(userRequest)
  );
}

function classifyNecessity(intent: IntentObject, file: string): FileNecessity {
  const normalized = file.toLowerCase();
  const deliverable = intent.charter.deliverables.find((d) =>
    d.targetFiles.some((t) => t === file),
  );

  // User-requested test authoring is a real mutation target, not a
  // context/reference file. Auto-injected test-pair deliverables still
  // fall through to optional below so their existing advisory behavior
  // is preserved.
  if (isExplicitMutableTestDeliverable(intent, deliverable, file)) {
    return "required";
  }

  // Files explicitly listed in deliverables are required. This includes
  // markdown/docs when the user asks for a precise edit to that file.
  if (deliverable && !isAutoInjectedTestPair(deliverable)) return "required";

  // Test files and docs are optional — their failure shouldn't block
  if (
    isTestLikePath(normalized) ||
    normalized.endsWith(".md") ||
    normalized.includes("docs/")
  ) {
    return "optional";
  }

  return "required";
}

function defaultMutationRole(necessity: FileNecessity): FileMutationRole {
  return necessity === "required" ? "write-required" : "write-optional";
}

function mutationExpectedFor(role: FileMutationRole): boolean {
  return role === "write-required";
}

function defaultMutationReason(role: FileMutationRole, whyIncluded: string): string {
  if (role === "write-required") return `Must change: ${whyIncluded}`;
  if (role === "write-optional") return `Optional change: ${whyIncluded}`;
  if (role === "read-context") return "Context-only file; mutation is not required.";
  if (role === "import-reference") return "Import reference file; mutation is not required.";
  if (role === "type-reference") return "Type reference file; mutation is not required.";
  return "Skipped by deterministic planner; mutation is not required.";
}

function computeExecutionOrder(file: string, dependencyMap: Map<string, string[]>): number {
  const deps = dependencyMap.get(file) ?? [];
  if (deps.length === 0) return 0;

  // Simple depth: count max chain length
  const visited = new Set<string>();
  function depth(f: string): number {
    if (visited.has(f)) return 0;
    visited.add(f);
    const fileDeps = dependencyMap.get(f) ?? [];
    if (fileDeps.length === 0) return 0;
    return 1 + Math.max(...fileDeps.map(depth));
  }

  return depth(file);
}

function inferWhyIncluded(intent: IntentObject, file: string): string {
  const deliverable = intent.charter.deliverables.find((entry) => entry.targetFiles.includes(file));

  if (deliverable) {
    return `${deliverable.type} required for deliverable: ${deliverable.description}`;
  }

  if (intent.charter.objective.toLowerCase().includes(file.toLowerCase())) {
    return `Referenced directly by charter objective: ${intent.charter.objective}`;
  }

  return `Included to satisfy intent objective: ${intent.charter.objective}`;
}

function inferDependencies(files: readonly string[]): Map<string, string[]> {
  const byDirectory = new Map<string, string[]>();
  const dependencies = new Map<string, string[]>();

  for (const file of files) {
    const directory = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : ".";
    const group = byDirectory.get(directory) ?? [];
    group.push(file);
    byDirectory.set(directory, group);
  }

  for (const file of files) {
    const directory = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : ".";
    const siblingFiles = (byDirectory.get(directory) ?? []).filter((candidate) => candidate !== file);
    const inferred = siblingFiles
      .filter((candidate) => candidate.length <= file.length || candidate.endsWith(".d.ts"))
      .slice(0, 4);
    dependencies.set(file, inferred);
  }

  return dependencies;
}

/**
 * Derive dependencies from a real ImportGraph. For each file in
 * scope, returns the other in-scope files it imports (direct deps
 * within the change set).
 */
function inferDependenciesFromGraph(
  files: readonly string[],
  graph: ImportGraph,
): Map<string, string[]> {
  const fileSet = new Set(files);
  const dependencies = new Map<string, string[]>();

  for (const file of files) {
    // Direct imports that are also in the change set
    const imports = graph.getImports(file).filter((dep) => fileSet.has(dep));
    // Also include files that import this file (reverse deps within scope)
    // — these are files that will break if this file changes
    const consumers = graph.getImportedBy(file).filter((dep) => fileSet.has(dep));
    // Combine and deduplicate — a file depends on its imports AND
    // is depended on by its consumers, both matter for ordering
    const combined = [...new Set([...imports, ...consumers])].filter((dep) => dep !== file);
    dependencies.set(file, combined);
  }

  return dependencies;
}

function collectSharedInvariants(intent: IntentObject, files: readonly string[]): string[] {
  const invariants = new Set<string>();

  invariants.add(`Stay within declared intent objective: ${intent.charter.objective}`);
  invariants.add(`Respect exclusions: ${intent.exclusions.join(", ") || "none"}`);
  invariants.add(`Keep affected files coherent across ${files.length} in-scope file(s)`);

  for (const criterion of intent.charter.successCriteria) {
    invariants.add(`Preserve success criterion: ${criterion}`);
  }

  return [...invariants];
}

function deriveAcceptanceCriteria(intent: IntentObject, files: readonly string[]): string[] {
  const criteria = [...intent.charter.successCriteria];
  criteria.push(`All in-scope files remain internally consistent: ${files.join(", ") || "none"}`);
  criteria.push("Dependency relationships are respected during implementation order.");
  return criteria;
}

function deriveCoherenceVerdict(
  files: readonly string[],
  dependencyRelationships: Readonly<Record<string, readonly string[]>>,
): CoherenceVerdict {
  if (files.length === 0) {
    return {
      coherent: false,
      reason: "No files were provided for the change set.",
    };
  }

  const orphaned = files.filter((file) => !(file in dependencyRelationships));
  if (orphaned.length > 0) {
    return {
      coherent: false,
      reason: `Missing dependency metadata for: ${orphaned.join(", ")}`,
    };
  }

  return {
    coherent: true,
    reason: `Change set covers ${files.length} file(s) with dependency metadata and acceptance criteria.`,
  };
}

/**
 * Create a ChangeSet with optional ImportGraph-backed dependency
 * inference. When an ImportGraph is provided, dependencies are
 * derived from real import/require relationships instead of the
 * directory-sibling heuristic fallback.
 */
export function createChangeSet(
  intent: IntentObject,
  files: readonly string[],
  importGraph?: ImportGraph | null,
  sourceRepo?: string,
): ChangeSet {
  const normalizedFiles = normalizeFiles(files, sourceRepo);

  // Use real import data when available, fall back to heuristic
  const dependencyMap = importGraph
    ? inferDependenciesFromGraph(normalizedFiles, importGraph)
    : inferDependencies(normalizedFiles);

  const filesInScope: FileInclusion[] = normalizedFiles.map((file) => {
    const necessity = classifyNecessity(intent, file);
    const mutationRole = defaultMutationRole(necessity);
    const whyIncluded = inferWhyIncluded(intent, file);
    return {
      path: file,
      whyIncluded,
      dependsOn: dependencyMap.get(file) ?? [],
      status: "planned",
      necessity,
      mutationRole,
      mutationExpected: mutationExpectedFor(mutationRole),
      mutationReason: defaultMutationReason(mutationRole, whyIncluded),
      executionOrder: computeExecutionOrder(file, dependencyMap),
      sensitivity: classifyFileSensitivity(file),
      outcome: null,
    };
  });

  const dependencyRelationships = Object.freeze(
    Object.fromEntries(
      normalizedFiles.map((file) => [file, Object.freeze([...(dependencyMap.get(file) ?? [])])]),
    ) as Record<string, readonly string[]>,
  );

  const sharedInvariants = Object.freeze(collectSharedInvariants(intent, normalizedFiles));
  const acceptanceCriteria = Object.freeze(deriveAcceptanceCriteria(intent, normalizedFiles));
  const coherenceVerdict = deriveCoherenceVerdict(normalizedFiles, dependencyRelationships);

  return Object.freeze({
    intent,
    filesInScope: Object.freeze(filesInScope.map((entry) => Object.freeze(entry))),
    dependencyRelationships,
    invariants: Object.freeze([]),
    sharedInvariants,
    acceptanceCriteria,
    coherenceVerdict: Object.freeze(coherenceVerdict),
  });
}

export interface FileMutationRoleUpdate {
  readonly path: string;
  readonly role: FileMutationRole;
  readonly reason: string;
}

export function applyFileMutationRoles(
  changeSet: ChangeSet,
  updates: readonly FileMutationRoleUpdate[],
): ChangeSet {
  if (updates.length === 0) return changeSet;
  const byPath = new Map(updates.map((entry) => [entry.path, entry]));
  return Object.freeze({
    ...changeSet,
    filesInScope: Object.freeze(changeSet.filesInScope.map((entry) => {
      const update = byPath.get(entry.path);
      if (!update) return entry;
      return Object.freeze({
        ...entry,
        mutationRole: update.role,
        mutationExpected: mutationExpectedFor(update.role),
        mutationReason: update.reason,
      });
    })),
  });
}

// ─── Manifest Queries ───────────────────────────────────────────────

/** Count files by sensitivity level. */
export function countSensitiveFiles(changeSet: ChangeSet): { normal: number; sensitive: number; critical: number } {
  const counts = { normal: 0, sensitive: 0, critical: 0 };
  for (const file of changeSet.filesInScope) {
    counts[file.sensitivity]++;
  }
  return counts;
}

/** Get files sorted by execution order. */
export function getExecutionOrder(changeSet: ChangeSet): readonly FileInclusion[] {
  return [...changeSet.filesInScope].sort((a, b) => a.executionOrder - b.executionOrder);
}

/** Check if any required files have a terminal failure status. */
export function hasRequiredFileFailures(changeSet: ChangeSet): boolean {
  return changeSet.filesInScope.some(
    (f) => f.mutationExpected && (f.status === "failed" || f.outcome?.status === "failed"),
  );
}

/** Produce a per-file outcome summary for receipts. */
export function summarizeFileOutcomes(changeSet: ChangeSet): readonly FileOutcomeSummary[] {
  return changeSet.filesInScope.map((f) => ({
    path: f.path,
    necessity: f.necessity,
    mutationRole: f.mutationRole,
    mutationExpected: f.mutationExpected,
    mutationReason: f.mutationReason,
    sensitivity: f.sensitivity,
    status: f.outcome?.status ?? (f.status === "verified" || f.status === "complete" ? "succeeded" : "pending"),
    reason: f.outcome?.reason ?? f.status,
    waveId: f.outcome?.waveId ?? null,
  }));
}

export interface FileOutcomeSummary {
  readonly path: string;
  readonly necessity: FileNecessity;
  readonly mutationRole: FileMutationRole;
  readonly mutationExpected: boolean;
  readonly mutationReason: string;
  readonly sensitivity: FileSensitivity;
  readonly status: "succeeded" | "failed" | "skipped" | "rolled_back" | "pending";
  readonly reason: string;
  readonly waveId: number | null;
}
