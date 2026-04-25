import { access, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ScopeClassification } from "./scope-classifier.js";
import type { ProjectMemory } from "./project-memory.js";
import type { GatedContext } from "./context-gate.js";
import type { RunReceipt } from "./coordinator.js";
import type { RunState } from "./runstate.js";
import type { FileChange, WorkerResult } from "../workers/base.js";
import type { VerificationReceipt } from "./verification-pipeline.js";
import type { MergeDecision } from "./merge-gate.js";
import type { RepairAuditResult } from "./repair-audit-pass.js";

type MemoryPrimitive = string | number | boolean | null;
type MemoryValue = MemoryPrimitive | MemoryValue[] | { [key: string]: MemoryValue };

export interface MemoryEvidenceRef {
  kind: string;
  ref: string;
  note?: string;
  timestamp?: string;
  sourceSystem?: string;
}

export interface MemoryRelationship {
  type: string;
  targetId: string;
  note?: string;
}

export interface MemoryEntryRecord {
  id: string;
  space: string;
  kind: string;
  title: string;
  summary?: string;
  raw?: string;
  tags: string[];
  createdAt: string;
  updatedAt?: string;
  sourceSystem?: string;
  repoId?: string;
  filePaths?: string[];
  evidenceRefs?: MemoryEvidenceRef[];
  relatedIds?: string[];
  relationships?: MemoryRelationship[];
  confidence?: number;
  metadata?: Record<string, MemoryValue>;
}

export interface MemorySearchResult {
  entry: MemoryEntryRecord;
  score: number;
  reasons: string[];
}

export interface MemoryContextPack {
  entries: MemorySearchResult[];
  totalChars: number;
  rationale: string[];
}

export interface MemoryIngestInput extends Omit<MemoryEntryRecord, "createdAt"> {
  createdAt?: string;
}

export interface AedisMemoryRuntime {
  ingest: {
    remember(input: MemoryIngestInput): Promise<MemoryEntryRecord>;
  };
  retrieval: {
    retrieve(query: Record<string, unknown>): Promise<MemorySearchResult[]>;
  };
  contextGate: {
    buildContextPack(request: Record<string, unknown>): Promise<MemoryContextPack>;
  };
  store?: {
    getMany?(ids: string[]): Promise<MemoryEntryRecord[]>;
  };
}

export interface AedisExecutionContext {
  relevantFiles: string[];
  recentTaskSummaries: string[];
  clusterFiles: string[];
  landmines: string[];
  safeApproaches: string[];
  memoryNotes: string[];
  suggestedNextSteps: string[];
  inclusionLog: string[];
  strictVerification: boolean;
}

export interface BuildExecutionContextInput {
  projectRoot: string;
  prompt: string;
  projectMemory: ProjectMemory;
  scopeClassification?: ScopeClassification | null;
  targetFiles?: readonly string[];
}

export interface PersistRunMemoryInput {
  projectRoot: string;
  rawInput: string;
  normalizedPrompt: string;
  scopeClassification?: ScopeClassification | null;
  projectMemory: ProjectMemory;
  run: RunState;
  receipt: RunReceipt;
  changes: readonly FileChange[];
  workerResults: readonly WorkerResult[];
  verificationReceipt: VerificationReceipt | null;
  mergeDecision: MergeDecision | null;
  /**
   * Audit-only structural findings from repair-audit-pass. Carries
   * advisory information about the change-set; never represents a
   * "repair was applied" claim. Null when the audit did not run
   * (e.g. single-file changes).
   */
  repairAudit: RepairAuditResult | null;
  commitSha: string | null;
}

interface RepoIndexFile {
  path: string;
  role: string;
  frameworkType: string;
  complexityEstimate: number;
  centralityScore: number;
  blastRadius: number;
  changeFrequency: number;
}

interface RepoIndexSnapshotLike {
  repoPath: string;
  updatedAt: string;
  files: RepoIndexFile[];
}

const DEFAULT_MEMORY_MODULE = process.env["AEDIS_LAB_MEMORY_MODULE"] ?? "/mnt/ai/squidley-v2/core/dist/memory/index.js";
const PROJECT_SPACE_PREFIX = "aedis/project";
const RUNS_SPACE = "aedis/runs";
const FAILURES_SPACE = "aedis/failures";
const SUCCESS_SPACE = "aedis/success";
const FILES_SPACE = "aedis/files";
const SOURCE_SYSTEM = "aedis";

export class AedisMemoryAdapter {
  constructor(private readonly runtime: AedisMemoryRuntime) {}

  async buildExecutionContext(input: BuildExecutionContextInput): Promise<AedisExecutionContext> {
    const repoId = repoIdentity(input.projectRoot);
    const targetFiles = uniqueStrings([...(input.targetFiles ?? [])]);
    const clusterFiles = await this.resolveClusterFiles(input.projectRoot, input.projectMemory, targetFiles);
    const scopedFiles = uniqueStrings([...targetFiles, ...clusterFiles]).slice(0, 10);
    const pack = await this.runtime.contextGate.buildContextPack({
      taskIntent: input.prompt,
      repoId,
      spaces: [projectSpace(repoId), RUNS_SPACE, FAILURES_SPACE, SUCCESS_SPACE, FILES_SPACE],
      ...(scopedFiles.length > 0 ? { filePaths: scopedFiles } : {}),
      maxEntries: 6,
      maxChars: 1800,
    });

    const entries = pack.entries.map((result) => result.entry);
    const relevantFiles = uniqueStrings([
      ...scopedFiles,
      ...entries.flatMap((entry) => entry.filePaths ?? []),
    ]).slice(0, 10);
    const recentTaskSummaries = entries
      .filter((entry) => entry.kind === "aedis-task" || entry.kind === "aedis-run")
      .map((entry) => entry.summary ?? entry.title)
      .filter(Boolean)
      .slice(0, 4);

    const landmines = summarizeLandmines(entries, targetFiles, await loadRepoIndexSnapshot(input.projectRoot));
    const safeApproaches = summarizeSuccessPatterns(entries).slice(0, 3);
    const memoryNotes = pack.entries
      .slice(0, 4)
      .map((result) => `${result.entry.title}: ${(result.entry.summary ?? "").slice(0, 140)}`.trim())
      .filter((line) => line.length > 0);
    const suggestedNextSteps = summarizeNextSteps(entries).slice(0, 3);

    const inclusionLog = [
      ...(clusterFiles.length > 0 ? [`cluster: ${clusterFiles.join(", ")} — related file-cluster history`] : []),
      ...pack.rationale.slice(0, 6),
      ...landmines.map((line) => `landmine: ${line}`),
    ];

    return {
      relevantFiles,
      recentTaskSummaries,
      clusterFiles,
      landmines,
      safeApproaches,
      memoryNotes,
      suggestedNextSteps,
      inclusionLog,
      strictVerification: landmines.length > 0 || (input.scopeClassification?.blastRadius ?? 0) >= 6,
    };
  }

  async persistRunMemory(input: PersistRunMemoryInput): Promise<{ suggestions: string[] }> {
    const repoId = repoIdentity(input.projectRoot);
    const filesTouched = uniqueStrings([
      ...input.changes.map((change) => change.path),
      ...input.run.filesTouched.map((touch) => touch.filePath),
    ]);
    const clusterFiles = await this.resolveClusterFiles(input.projectRoot, input.projectMemory, filesTouched);
    const suggestions = suggestFollowups(input.receipt, input.mergeDecision, input.verificationReceipt, input.repairAudit, filesTouched, clusterFiles);
    const entries = buildRunMemoryEntries({
      ...input,
      repoId,
      filesTouched,
      clusterFiles,
      suggestions,
    });
    await Promise.all(entries.map((entry) => this.runtime.ingest.remember(entry)));
    return { suggestions };
  }

  private async resolveClusterFiles(
    projectRoot: string,
    projectMemory: ProjectMemory,
    targetFiles: readonly string[],
  ): Promise<string[]> {
    const clusterPeers = projectMemory.fileClusters
      .filter((cluster) => cluster.files.some((file) => targetFiles.includes(file)))
      .flatMap((cluster) => cluster.files.filter((file) => !targetFiles.includes(file)));

    const repoIndex = await loadRepoIndexSnapshot(projectRoot);
    if (!repoIndex) {
      return uniqueStrings(clusterPeers).slice(0, 6);
    }

    const riskyRelated = repoIndex.files
      .filter((file) =>
        targetFiles.some((target) => sharesModule(target, file.path)) &&
        !targetFiles.includes(file.path) &&
        (file.blastRadius >= 4 || file.centralityScore >= 4),
      )
      .map((file) => file.path);

    return uniqueStrings([...clusterPeers, ...riskyRelated]).slice(0, 6);
  }
}

let adapterPromise: Promise<AedisMemoryAdapter | null> | null = null;

export async function getAedisMemoryAdapter(): Promise<AedisMemoryAdapter | null> {
  if (!adapterPromise) {
    adapterPromise = loadAedisMemoryRuntime()
      .then((runtime) => runtime ? new AedisMemoryAdapter(runtime) : null)
      .catch(() => null);
  }
  return adapterPromise;
}

export function resetAedisMemoryAdapterForTests(): void {
  adapterPromise = null;
}

export function toGatedContext(memory: AedisExecutionContext, language: string): Partial<GatedContext> {
  return {
    relevantFiles: memory.relevantFiles,
    recentTaskSummaries: memory.recentTaskSummaries,
    language,
    ...(memory.clusterFiles.length > 0 ? { clusterFiles: memory.clusterFiles } : {}),
    ...(memory.landmines.length > 0 ? { landmines: memory.landmines } : {}),
    ...(memory.safeApproaches.length > 0 ? { safeApproaches: memory.safeApproaches } : {}),
    ...(memory.memoryNotes.length > 0 ? { memoryNotes: memory.memoryNotes } : {}),
    ...(memory.suggestedNextSteps.length > 0 ? { suggestedNextSteps: memory.suggestedNextSteps } : {}),
    ...(memory.inclusionLog.length > 0 ? { inclusionLog: memory.inclusionLog } : {}),
    strictVerification: memory.strictVerification,
  };
}

async function loadAedisMemoryRuntime(): Promise<AedisMemoryRuntime | null> {
  const candidates = [DEFAULT_MEMORY_MODULE];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      const mod = await import(pathToFileURL(candidate).href) as { createMemorySubsystem?: () => Promise<AedisMemoryRuntime> };
      if (!mod.createMemorySubsystem) continue;
      return mod.createMemorySubsystem();
    } catch {
      continue;
    }
  }
  return null;
}

function buildRunMemoryEntries(input: PersistRunMemoryInput & {
  repoId: string;
  filesTouched: string[];
  clusterFiles: string[];
  suggestions: string[];
}): MemoryIngestInput[] {
  const taskEntryId = `aedis-task:${input.receipt.runId}`;
  const runEntryId = `aedis-run:${input.receipt.runId}`;
  const projectSpaceId = projectSpace(input.repoId);
  const verificationVerdict = input.verificationReceipt?.verdict ?? "not-run";
  const outcomeSpace = input.receipt.verdict === "success" ? SUCCESS_SPACE : FAILURES_SPACE;
  const outcomeId = `aedis-outcome:${input.receipt.runId}`;
  const changeTypes = uniqueStrings(input.changes.map((change) => change.operation));
  const moduleTags = detectModuleTags(input.filesTouched);
  const evidenceRefs = buildEvidenceRefs(input);
  const relatedIds = [runEntryId, taskEntryId, outcomeId];

  const entries: MemoryIngestInput[] = [
    {
      id: runEntryId,
      space: RUNS_SPACE,
      kind: "aedis-run",
      title: input.rawInput.slice(0, 160),
      summary: summarizeRun(input),
      raw: JSON.stringify({
        receipt: input.receipt,
        run: input.run,
        verificationReceipt: input.verificationReceipt,
        mergeDecision: input.mergeDecision,
        repairAudit: input.repairAudit,
      }, null, 2),
      tags: uniqueStrings([
        "aedis-run",
        `verdict:${input.receipt.verdict}`,
        `verification:${verificationVerdict}`,
        ...(input.scopeClassification ? [`scope:${input.scopeClassification.type}`] : []),
        ...moduleTags,
      ]),
      createdAt: input.receipt.timestamp,
      sourceSystem: SOURCE_SYSTEM,
      repoId: input.repoId,
      ...(input.filesTouched.length > 0 ? { filePaths: input.filesTouched } : {}),
      evidenceRefs,
      confidence: confidenceFromReceipt(input.receipt),
      metadata: {
        verdict: input.receipt.verdict,
        verificationVerdict,
        commitSha: input.commitSha ?? "",
        filesModified: input.receipt.summary.filesModified,
        scopeType: input.scopeClassification?.type ?? "",
        blastRadius: input.scopeClassification?.blastRadius ?? 0,
      },
    },
    {
      id: taskEntryId,
      space: projectSpaceId,
      kind: "aedis-task",
      title: input.normalizedPrompt.slice(0, 160),
      summary: summarizeTask(input),
      raw: JSON.stringify({
        rawInput: input.rawInput,
        normalizedPrompt: input.normalizedPrompt,
        workerResults: input.workerResults,
      }, null, 2),
      tags: uniqueStrings([
        "aedis-task",
        `verdict:${input.receipt.verdict}`,
        ...(input.scopeClassification ? [`scope:${input.scopeClassification.type}`] : []),
        ...changeTypes.map((type) => `change:${type}`),
        ...moduleTags,
      ]),
      createdAt: input.receipt.timestamp,
      sourceSystem: SOURCE_SYSTEM,
      repoId: input.repoId,
      ...(input.filesTouched.length > 0 ? { filePaths: input.filesTouched } : {}),
      evidenceRefs,
      relatedIds: [runEntryId, outcomeId],
      relationships: [
        { type: "run", targetId: runEntryId },
        { type: "outcome", targetId: outcomeId },
      ],
      confidence: confidenceFromReceipt(input.receipt),
      metadata: {
        scopeType: input.scopeClassification?.type ?? "",
        complexityTier: complexityTier(input.scopeClassification),
        verificationVerdict,
        filesTouched: input.filesTouched.length,
      },
    },
    {
      id: outcomeId,
      space: outcomeSpace,
      kind: input.receipt.verdict === "success" ? "aedis-success" : "aedis-failure",
      title: outcomeTitle(input),
      summary: summarizeOutcome(input),
      raw: JSON.stringify({
        issues: collectIssueMessages(input.workerResults),
        mergeDecision: input.mergeDecision,
        repairAudit: input.repairAudit,
      }, null, 2),
      tags: uniqueStrings([
        input.receipt.verdict === "success" ? "success-pattern" : "failure-pattern",
        `verification:${verificationVerdict}`,
        ...moduleTags,
      ]),
      createdAt: input.receipt.timestamp,
      sourceSystem: SOURCE_SYSTEM,
      repoId: input.repoId,
      ...(input.filesTouched.length > 0 ? { filePaths: input.filesTouched } : {}),
      evidenceRefs,
      relatedIds: [runEntryId, taskEntryId],
      relationships: [
        { type: "run", targetId: runEntryId },
        { type: "task", targetId: taskEntryId },
      ],
      confidence: confidenceFromReceipt(input.receipt),
      metadata: {
        verdict: input.receipt.verdict,
        verificationVerdict,
        primaryBlockReason: input.mergeDecision?.primaryBlockReason ?? "",
      },
    },
  ];

  for (const file of input.filesTouched) {
    const peers = input.clusterFiles.filter((entry) => entry !== file).slice(0, 4);
    entries.push({
      id: `aedis-file:${input.receipt.runId}:${slugSegment(file)}`,
      space: FILES_SPACE,
      kind: "aedis-file-touch",
      title: file,
      summary: `${input.receipt.verdict} after ${changeTypes.join(", ") || "repo work"} in ${file}`,
      raw: JSON.stringify({
        file,
        peers,
        scopeType: input.scopeClassification?.type ?? "",
      }, null, 2),
      tags: uniqueStrings([
        "file-touch",
        `verdict:${input.receipt.verdict}`,
        ...detectModuleTags([file]),
      ]),
      createdAt: input.receipt.timestamp,
      sourceSystem: SOURCE_SYSTEM,
      repoId: input.repoId,
      filePaths: [file],
      evidenceRefs,
      relatedIds,
      relationships: [
        { type: "run", targetId: runEntryId },
        { type: "task", targetId: taskEntryId },
        ...peers.map((peer) => ({ type: "cluster-peer", targetId: `file:${slugSegment(peer)}` })),
      ],
      metadata: {
        scopeType: input.scopeClassification?.type ?? "",
        clusterPeers: peers,
      },
    });
  }

  if (input.suggestions.length > 0) {
    entries.push({
      id: `aedis-suggestions:${input.receipt.runId}`,
      space: projectSpaceId,
      kind: "aedis-suggestions",
      title: `Follow-up suggestions for ${input.receipt.runId}`,
      summary: input.suggestions.join(" "),
      tags: ["suggestions", `verdict:${input.receipt.verdict}`],
      createdAt: input.receipt.timestamp,
      sourceSystem: SOURCE_SYSTEM,
      repoId: input.repoId,
      ...(input.filesTouched.length > 0 ? { filePaths: input.filesTouched } : {}),
      evidenceRefs,
      relatedIds,
      relationships: [
        { type: "run", targetId: runEntryId },
        { type: "task", targetId: taskEntryId },
      ],
      metadata: {
        suggestionCount: input.suggestions.length,
      },
    });
  }

  return entries;
}

function summarizeRun(input: PersistRunMemoryInput & { filesTouched: string[] }): string {
  return [
    `${input.receipt.verdict} run`,
    input.scopeClassification ? `${input.scopeClassification.type} scope` : null,
    input.filesTouched.length > 0 ? `${input.filesTouched.length} file(s) touched` : "no files touched",
    input.verificationReceipt ? `verification ${input.verificationReceipt.verdict}` : "verification not run",
  ].filter(Boolean).join(" · ");
}

function summarizeTask(input: PersistRunMemoryInput & { filesTouched: string[] }): string {
  const topIssues = collectIssueMessages(input.workerResults).slice(0, 2).join(" | ");
  return [
    input.scopeClassification ? `${input.scopeClassification.type}` : null,
    topIssues || summarizeRun(input),
  ].filter(Boolean).join(" · ");
}

function summarizeOutcome(input: PersistRunMemoryInput & { filesTouched: string[]; clusterFiles: string[] }): string {
  if (input.receipt.verdict === "success") {
    return [
      "Successful approach stayed inside the requested scope.",
      input.clusterFiles.length > 0 ? `Related cluster files: ${input.clusterFiles.join(", ")}.` : null,
    ].filter(Boolean).join(" ");
  }
  return [
    input.mergeDecision?.primaryBlockReason,
    input.repairAudit && input.repairAudit.findings.length > 0 ? `Repair-audit findings (audit-only, no repairs attempted): ${input.repairAudit.findings.slice(0, 2).join(" | ")}` : null,
    input.verificationReceipt?.summary,
  ].filter(Boolean).join(" ");
}

function outcomeTitle(input: PersistRunMemoryInput): string {
  if (input.receipt.verdict === "success") {
    return `Successful run for ${input.normalizedPrompt.slice(0, 120)}`;
  }
  return `Failure in ${input.normalizedPrompt.slice(0, 120)}`;
}

function buildEvidenceRefs(input: PersistRunMemoryInput): MemoryEvidenceRef[] {
  return uniqueEvidenceRefs([
    { kind: "run", ref: input.receipt.runId, sourceSystem: SOURCE_SYSTEM },
    { kind: "intent", ref: input.receipt.intentId, sourceSystem: SOURCE_SYSTEM },
    ...(input.commitSha ? [{ kind: "commit", ref: input.commitSha, sourceSystem: SOURCE_SYSTEM }] : []),
    ...(input.verificationReceipt ? [{ kind: "verification", ref: input.verificationReceipt.id, sourceSystem: SOURCE_SYSTEM }] : []),
  ]);
}

function suggestFollowups(
  receipt: RunReceipt,
  mergeDecision: MergeDecision | null,
  verificationReceipt: VerificationReceipt | null,
  repairAudit: RepairAuditResult | null,
  filesTouched: readonly string[],
  clusterFiles: readonly string[],
): string[] {
  const suggestions: string[] = [];
  if (receipt.verdict !== "success") {
    suggestions.push("Re-run the task with tighter scope around the failing files before attempting broader changes.");
  }
  if (mergeDecision?.action === "block" && mergeDecision.primaryBlockReason) {
    suggestions.push(`Address the merge blocker first: ${mergeDecision.primaryBlockReason}`);
  }
  if (verificationReceipt && verificationReceipt.verdict !== "pass") {
    suggestions.push(`Validate ${filesTouched.slice(0, 3).join(", ") || "the touched files"} with focused verification before the next attempt.`);
  }
  if (repairAudit && repairAudit.findings.length > 0) {
    suggestions.push(`Inspect repair-audit findings (audit-only, no repairs attempted): ${repairAudit.findings.slice(0, 2).join(" | ")}`);
  }
  if (clusterFiles.length > 0) {
    suggestions.push(`Check nearby cluster files next: ${clusterFiles.slice(0, 3).join(", ")}`);
  }
  return uniqueStrings(suggestions).slice(0, 4);
}

function summarizeLandmines(
  entries: MemoryEntryRecord[],
  targetFiles: readonly string[],
  repoIndex: RepoIndexSnapshotLike | null,
): string[] {
  const fileFailureCounts = new Map<string, number>();
  for (const entry of entries) {
    if (entry.space !== FAILURES_SPACE) continue;
    for (const file of entry.filePaths ?? []) {
      fileFailureCounts.set(file, (fileFailureCounts.get(file) ?? 0) + 1);
    }
  }

  const landmines: string[] = [];
  for (const file of targetFiles) {
    const failureCount = fileFailureCounts.get(file) ?? 0;
    if (failureCount >= 2) {
      landmines.push(`${file} has failed ${failureCount} times in prior Aedis runs.`);
    }
    const indexed = repoIndex?.files.find((entry) => entry.path === file);
    if (indexed && (indexed.blastRadius >= 5 || indexed.complexityEstimate >= 7)) {
      landmines.push(`${file} is a high-blast-radius area (${indexed.blastRadius}) with elevated complexity.`);
    }
  }
  return uniqueStrings(landmines).slice(0, 4);
}

function summarizeSuccessPatterns(entries: MemoryEntryRecord[]): string[] {
  return entries
    .filter((entry) => entry.space === SUCCESS_SPACE || entry.tags.includes("success-pattern"))
    .map((entry) => entry.summary ?? entry.title)
    .filter(Boolean)
    .slice(0, 3);
}

function summarizeNextSteps(entries: MemoryEntryRecord[]): string[] {
  return entries
    .filter((entry) => entry.kind === "aedis-suggestions" || entry.tags.includes("suggestions"))
    .map((entry) => entry.summary ?? entry.title)
    .filter(Boolean)
    .slice(0, 3);
}

async function loadRepoIndexSnapshot(projectRoot: string): Promise<RepoIndexSnapshotLike | null> {
  const path = join(resolve(projectRoot), ".aedis", "repo-index.json");
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as RepoIndexSnapshotLike;
    if (!parsed || !Array.isArray(parsed.files)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function detectModuleTags(files: readonly string[]): string[] {
  return uniqueStrings(
    files.flatMap((file) => {
      const normalized = file.replace(/\\/g, "/");
      const parts = normalized.split("/").filter(Boolean);
      const tags: string[] = [];
      if (parts[0]) tags.push(`module:${parts[0]}`);
      const ext = normalized.includes(".") ? normalized.slice(normalized.lastIndexOf(".") + 1) : "";
      if (ext) tags.push(`ext:${ext}`);
      return tags;
    }),
  );
}

function confidenceFromReceipt(receipt: RunReceipt): number {
  switch (receipt.verdict) {
    case "success":
      return 0.85;
    case "partial":
      return 0.55;
    case "failed":
      return 0.35;
    default:
      return 0.2;
  }
}

function complexityTier(scopeClassification?: ScopeClassification | null): string {
  if (!scopeClassification) return "unknown";
  if (scopeClassification.blastRadius >= 12) return "high";
  if (scopeClassification.blastRadius >= 6) return "medium";
  return "low";
}

function collectIssueMessages(workerResults: readonly WorkerResult[]): string[] {
  return uniqueStrings(workerResults.flatMap((result) => result.issues.map((issue) => issue.message)));
}

function projectSpace(repoId: string): string {
  return `${PROJECT_SPACE_PREFIX}/${slugSegment(repoId)}`;
}

function repoIdentity(projectRoot: string): string {
  return resolve(projectRoot);
}

function uniqueStrings(values: readonly string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function uniqueEvidenceRefs(values: readonly MemoryEvidenceRef[]): MemoryEvidenceRef[] {
  const seen = new Set<string>();
  const out: MemoryEvidenceRef[] = [];
  for (const value of values) {
    const key = `${value.kind}:${value.ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function slugSegment(value: string): string {
  const cleaned = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "unknown";
}

function sharesModule(left: string, right: string): boolean {
  const l = left.replace(/\\/g, "/").split("/")[0];
  const r = right.replace(/\\/g, "/").split("/")[0];
  return Boolean(l && r && l === r);
}
