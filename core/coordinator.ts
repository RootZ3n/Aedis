/**
 * Coordinator — Master orchestrator for Aedis build runs.
 *
 * The Coordinator owns the full lifecycle of a build:
 *   1. Receive task (from Simple Mode or API)
 *   2. Generate Charter via CharterGenerator
 *   3. Create and lock IntentObject
 *   4. Build TaskGraph via architectural decomposition
 *   5. Run Pre-Build Coherence Pass
 *   6. Dispatch tasks through TrustRouter → workers
 *   7. Manage Rehearsal Loop (Builder ↔ Critic ↔ Verifier)
 *   8. Run Post-Build IntegrationJudge pass
 *   9. Gate merge via VerificationPipeline
 *  10. Commit via git at task boundaries
 *  11. Invoke RecoveryEngine on failure
 *  12. Emit WebSocket events throughout
 *  13. Produce final RunReceipt
 *
 * The Coordinator never does work itself — it orchestrates workers,
 * enforces governance, and maintains the audit trail.
 *
 * PROJECT ROOT THREADING:
 * The Coordinator's `config.projectRoot` is the boot-time default. Per-task
 * submissions can override via `TaskSubmission.projectRoot` — the API
 * server's POST /tasks route handler passes the request body's `repoPath`
 * field through. The effective projectRoot is computed at the top of
 * submit() and stored on `ActiveRun.projectRoot`. From there it flows to:
 *   - `active.contextAssembler` and `active.judge` (constructed fresh per
 *     submit() so they honor the per-task projectRoot)
 *   - `assignment.projectRoot` in dispatchNode (workers read this and
 *     thread it to all their helpers)
 *   - `gitCommit` (cwd for `git add -A` / `git commit`)
 *   - `prepareDeliverablesForGraph` (path resolution for dedup)
 *   - `fileExists` (existence check for deliverable files)
 *
 * INSTRUMENTATION NOTE:
 * Every phase transition, graph mutation, dispatch decision, and early
 * exit branch is logged with the [coordinator] prefix.
 */

import { randomUUID } from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import { resolve } from "path";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";

import {
  createIntent,
  reviseIntent,
  validateIntent,
  type IntentObject,
  type CreateIntentParams,
  type Assumption,
  type Deliverable,
} from "./intent.js";
import { getCallLog, escalateOnLowConfidence, createRunInvocationContext, type RunInvocationContext } from "./model-invoker.js";
import { captureAndAnalyze } from "./vision.js";
import { runPreflight } from "./preflight.js";
import {
  CharterGenerator,
  type RequestAnalysis,
  type CharterGeneratorConfig,
} from "./charter.js";
import {
  createRunState,
  advancePhase,
  addTask,
  startTask,
  completeTask,
  failRun,
  abortRun,
  recordAssumption,
  recordFileTouch,
  recordDecision,
  recordCoherenceCheck,
  getActiveTasks,
  getPendingTasks,
  getFailedTasks,
  getRunSummary,
  isTerminalPhase,
  type RunState,
  type RunTask,
  type TaskResult,
  type CostEntry,
} from "./runstate.js";
import {
  ReceiptStore,
  type ReceiptPatch,
  type ReceiptCheckpoint,
  type ReceiptWorkerEvent,
  type ReceiptRoutingDecision,
  type ReceiptRoutingEscalation,
  type ReceiptProviderAttempt,
} from "./receipt-store.js";
import {
  PROMOTION_EXCLUDE_PATHSPECS,
  filterRuntimeArtifacts,
} from "./promotion-filter.js";
import {
  createTaskGraph,
  addNode,
  addEdge,
  addCheckpoint,
  addEscalationBoundary,
  addMergeGroup,
  topologicalSort,
  getDispatchableNodes,
  markReady,
  markDispatched,
  markCompleted,
  markFailed,
  isGraphComplete,
  hasFailedNodes,
  getGraphSummary,
  type TaskGraphState,
  type TaskNode,
} from "./task-graph.js";
import { ContextAssembler, type AssembledContext } from "./context-assembler.js";
import { DiffApplier } from "./diff-applier.js";
import {
  IntegrationJudge,
  type JudgmentReport,
} from "./integration-judge.js";
import type { GuardFinding } from "./adversarial-guard.js";
import {
  VerificationPipeline,
  parseTscOutput,
  type VerificationPipelineConfig,
  type VerificationReceipt,
} from "./verification-pipeline.js";
import {
  deriveTaskTypeKey,
  findPatternWarnings,
  findHistoricalInsights,
  getConfidenceDampening,
  getReliabilityTier,
  shouldRecommendStrictMode,
  loadMemory,
  recordTask,
} from "./project-memory.js";
import { ProjectMemoryStore } from "./project-memory-store.js";
import {
  gateContext,
  gateContextForArchitectural,
  gateContextForWave,
  mergeGatedContext,
  type GatedContext,
} from "./context-gate.js";
import { getAedisMemoryAdapter, toGatedContext } from "./aedis-memory.js";
import {
  evaluateExecutionGate,
  type ExecutionEvidence,
  type ExecutionGateDecision,
  type ExecutionReceipt,
} from "./execution-gate.js";
import { generateRunSummary, type RunSummary, type TrustRegressionAlert } from "./run-summary.js";

type TrustRegressionSnapshot = TrustRegressionAlert;
import { calibrateThresholds } from "./confidence-scoring.js";
import { buildRunSummaryPayload, persistentStatusForReceipt } from "./coordinator-audit.js";
import { buildDispatchAssignment, workerCompleteEventType } from "./coordinator-dispatch.js";
import { determineRunVerdict } from "./coordinator-lifecycle.js";
import { estimateBlastRadius, type BlastRadiusEstimate } from "./blast-radius.js";
import { redactText } from "./redaction.js";
import { normalizePrompt } from "./prompt-normalizer.js";
import {
  classifyScope,
  isBugfixLikePrompt,
  type ScopeClassification,
} from "./scope-classifier.js";

import { applyFileMutationRoles, createChangeSet, type ChangeSet } from "./change-set.js";
import {
  PostRunEvaluator,
  type EvaluationAttachment,
  type EvaluationInput,
} from "./post-run-evaluator.js";
import { type CrucibulumConfig, DEFAULT_CRUCIBULUM_CONFIG } from "./crucibulum-client.js";
import { extractInvariants } from "./invariant-extractor.js";
import {
  planChangeSet,
  haltDownstreamWaves,
  summarizeWaveOutcomes,
  type Plan,
  type PlanWave,
  type WaveOutcomeSummary,
} from "./multi-file-planner.js";
import {
  buildImplementationBriefOrFallback,
  buildMinimalImplementationBrief,
  briefWithRetryHint,
  briefWithRejectedCandidates,
  capabilityFloorForBrief,
  classifyWeakOutput,
  briefToReceiptJson,
  type ImplementationBrief,
  type RejectedCandidate,
} from "./implementation-brief.js";
import { tryDeterministicBuilder, type DeterministicBuilderResult } from "./code-transforms/deterministic-builder.js";
import { runRepairAuditPass, type RepairAuditResult } from "./repair-audit-pass.js";
import { isTrivialTask, type TrivialCheckResult } from "./trivial-task-detector.js";
import { prepareTargetsForPrompt } from "./target-discovery.js";
import {
  decideMerge,
  groupFindingsBySource,
  type MergeDecision,
  type MergeFinding,
} from "./merge-gate.js";
import {
  isTestInjectionFile,
  verifyGitDiff,
  type GitDiffResult,
} from "./git-diff-verifier.js";
import { scanInput as velumScanInput } from "./velum-input.js";
import { scanDiff as velumScanDiff, type VelumResult } from "./velum-output.js";
import { classifyTask, type ImpactClassification, type ImpactLevel } from "./impact-classifier.js";
import { scoreConfidence, type ConfidenceLevel, type ConfidenceResult } from "./confidence-gate.js";
import { withRepoLock } from "./file-lock.js";
import {
  createWorkspace,
  discardWorkspace,
  generatePatch,
  saveWorkspaceReceipt,
  type WorkspaceHandle,
  type WorkspaceCleanupResult,
  type PatchArtifact,
} from "./workspace-manager.js";
import {
  createShadowWorkspace,
  candidateDisqualification,
  selectBestCandidate,
  type Candidate,
  type CandidateStatus,
  type WorkspaceEntry,
  type WorkspaceRole,
} from "./candidate.js";
import {
  DEFAULT_LANE_CONFIG,
  laneConfigRunsShadow,
  loadLaneConfigFromDisk,
  type LaneConfig,
} from "./lane-config.js";
import { createBuilderForLane } from "./lane-builder-factory.js";
import { findImplForTest, findMissingTestFiles } from "./import-graph.js";
import { TrustRouter, type TrustProfile, type RoutingDecision } from "../router/trust-router.js";
import {
  type BaseWorker,
  type WorkerAssignment,
  type WorkerResult,
  type WorkerType,
  type FileChange,
  WorkerRegistry,
} from "../workers/base.js";
import type { EventBus, AedisEvent } from "../server/websocket.js";
import {
  loadModelConfig as loadModelConfigFromDisk,
  builderTierCollapseWarning,
  findNextStrongerBuilderTier,
  resolveAllBuilderTierModels,
} from "../server/routes/config.js";

const exec = promisify(execFile);

// ─── Types ───────────────────────────────────────────────────────────

export interface CoordinatorConfig {
  projectRoot: string;
  /** Maximum rehearsal iterations (Builder ↔ Critic ↔ Verifier) */
  maxRehearsalRounds: number;
  /** Maximum recovery attempts on failure */
  maxRecoveryAttempts: number;
  /** Auto-commit at task boundaries */
  autoCommit: boolean;
  /**
   * Require external approval before committing.
   * When true, MergeGate approval pauses the run with status "awaiting_approval"
   * instead of auto-committing. The run can then be approved via approveRun(runId).
   * This implements the DOCTRINE requirement: "user approves final apply".
   */
  requireApproval: boolean;
  /**
   * Auto-promote a workspace commit to the source repo when the run
   * finishes with a clean VERIFIED_SUCCESS classification. Off by default
   * — operators opt in once they trust the pipeline. Does nothing for
   * PARTIAL_SUCCESS / FAILED / AWAITING_APPROVAL; those still require
   * the explicit promote endpoint.
   */
  autoPromoteOnSuccess: boolean;
  /** Git branch to work on (created if needed) */
  workBranch: string;
  /** Maximum seconds for external commands (git, npm test, etc). Default: 120 */
  externalCommandTimeoutSec: number;
  /** CharterGenerator config overrides */
  charterConfig?: Partial<CharterGeneratorConfig>;
  /** Verification configuration, including required external hooks. */
  verificationConfig?: Partial<VerificationPipelineConfig>;
  /** Post-run Crucibulum evaluation configuration. */
  evaluationConfig?: Partial<CrucibulumConfig>;
  /** Maximum total graph iterations before forced abort. Default: 50 */
  maxGraphIterations: number;
  /** Maximum seconds for the entire run. Default: 600 (10 min) */
  maxRunTimeoutSec: number;
  /** Maximum seconds per individual dispatch stage. Default: 180 */
  maxStageTimeoutSec: number;
  /** Maximum USD cost per run. Null = no limit. Default: 1.00 */
  maxRunCostUsd: number | null;
  /**
   * When true (default), the run is hard-aborted if the isolated
   * workspace (worktree / clone / copy) cannot be created. The
   * source repo is NEVER mutated in this mode — even as a last
   * resort — and a receipt is persisted explaining why execution
   * stopped.
   *
   * When false, the legacy fallback is re-enabled: if every workspace
   * strategy fails, the Coordinator runs against the source repo
   * directly. This is UNSAFE and must be explicitly opted into by
   * setting `requireWorkspace: false` in the CoordinatorConfig.
   */
  requireWorkspace: boolean;
  /**
   * Phase D injection point — used by `maybeRunFallbackShadow` to
   * construct the lane-pinned BuilderWorker for the shadow lane.
   * Defaults to the real `createBuilderForLane` factory; tests
   * (and any future caller that needs to swap in a stub builder
   * without mutating WorkerRegistry) can override it.
   *
   * When the factory returns null the shadow lane silently falls
   * back to the registered default Builder so a misconfigured
   * `lane-config.json` never crashes the run.
   */
  laneBuilderFactory?: typeof createBuilderForLane;
}

const DEFAULT_CONFIG: CoordinatorConfig = {
  projectRoot: process.cwd(),
  maxRehearsalRounds: 3,
  maxRecoveryAttempts: 2,
  autoCommit: true,
  requireApproval: false,
  autoPromoteOnSuccess: false,
  workBranch: "aedis/run",
  externalCommandTimeoutSec: 120,
  maxGraphIterations: 50,
  maxRunTimeoutSec: 600,
  maxStageTimeoutSec: 180,
  maxRunCostUsd: 1.00,
  // Default strict — source repo is never mutated when workspace
  // creation fails. Operators must explicitly opt into the legacy
  // unsafe fallback by setting requireWorkspace: false.
  requireWorkspace: true,
};

/**
 * Detect whether a prompt is too ambiguous to execute without clarification.
 * Returns true if the prompt is fewer than 8 words AND contains no file
 * path AND contains no function/class name pattern.
 */
function detectAmbiguity(input: string): boolean {
  const trimmed = input.trim();
  const words = trimmed.split(/\s+/).filter(Boolean);
  // Longer prompts are inherently less ambiguous
  if (words.length >= 6) return false;

  // Check for file path patterns (contains / or . with extension)
  const hasFilePath = /[A-Za-z0-9_-]+\/[A-Za-z0-9._/-]+/.test(trimmed) ||
    /[A-Za-z0-9_-]+\.[tj]sx?$/.test(trimmed) ||
    /[A-Za-z0-9_-]+\.(?:py|pyi|rs|go|java|kt|swift|c|cc|cpp|h|hpp|cs|rb|php|scala|lua|sh|bash|gd|tscn|tres|gdshader|vue|svelte|css|scss|sass|less|html|json|yaml|yml|toml|md)/.test(trimmed);
  if (hasFilePath) return false;

  // Check for function/class name patterns (camelCase, PascalCase, snake_case identifiers)
  const hasFunctionOrClass =
    /\b[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*\b/.test(trimmed) ||   // camelCase
    /\b[A-Z][a-zA-Z0-9]{2,}\b/.test(trimmed) ||                  // PascalCase
    /\b[a-z]+_[a-z]+\b/.test(trimmed);                            // snake_case
  if (hasFunctionOrClass) return false;

  // Check for concrete action verbs — a prompt with a clear verb
  // and a domain noun is actionable even without code identifiers.
  // "improve the health route" or "fix error handling" are clear.
  const hasActionVerb = /\b(add|fix|update|modify|create|remove|refactor|improve|implement|replace|rename|delete|extend|extract|move|clean|optimize|simplify|make)\b/i.test(trimmed);
  if (hasActionVerb && words.length >= 4) return false;

  return true;
}

function hasConcreteCodeTarget(input: string): boolean {
  const trimmed = input.trim();
  const hasFilePath = /[A-Za-z0-9_-]+\/[A-Za-z0-9._/-]+/.test(trimmed) ||
    /[A-Za-z0-9_-]+\.[tj]sx?$/.test(trimmed) ||
    /[A-Za-z0-9_-]+\.(?:py|pyi|rs|go|java|kt|swift|c|cc|cpp|h|hpp|cs|rb|php|scala|lua|sh|bash|gd|tscn|tres|gdshader|vue|svelte|css|scss|sass|less|html|json|yaml|yml|toml|md)/.test(trimmed);
  if (hasFilePath) return true;

  return (
    /\b[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*\b/.test(trimmed) ||
    /\b[a-z]+_[a-z]+\b/.test(trimmed)
  );
}

export function needsBroadCleanupClarification(input: string): boolean {
  const normalized = input.trim().toLowerCase();
  if (!normalized) return false;
  if (hasConcreteCodeTarget(input)) return false;

  const hasBroadCleanupVerb = /\b(clean\s+up|cleanup|refactor|improve|simplify|standardize|consolidate)\b/.test(normalized);
  if (!hasBroadCleanupVerb) return false;

  return /\b(config|configuration|settings|options|handling|error handling|auth|routing|routes?|state|storage|providers?)\b/.test(normalized);
}

/**
 * Result of a task submission — may be immediate execution, a
 * clarification request, a decomposition plan requiring approval,
 * or a hard block from Velum's input guard. The `blocked` outcome
 * never creates an active run, never allocates a workspace, and
 * never reaches the Builder. The `reasons` and `flags` arrays mirror
 * Velum's `VelumResult` so the receipt can record exactly what
 * tripped the guard.
 */
export type TaskSubmissionResult =
  | { kind: "executing"; receipt: Promise<RunReceipt> }
  | { kind: "needs_clarification"; question: string }
  | { kind: "needs_decomposition"; taskId: string; plan: Plan; message: string }
  | { kind: "blocked"; reason: string; flags: readonly string[] };

/**
 * Normalized build result for session-coordinator cycles.
 * Abstracts the full RunReceipt into the fields that session-coordinator
 * needs for iteration decisions and receipt storage.
 */
export interface BuildResult {
  success: boolean;
  touchedFiles: string[];
  verificationPassed: boolean;
  errorType?: string;
  errorMessage?: string;
  model?: string;
  costUsd?: number;
  runId: string;
}

/**
 * Pending decomposition plan awaiting user approval. Stored in
 * Coordinator.pendingPlans so POST /tasks/:id/approve can resume.
 */
interface PendingPlan {
  taskId: string;
  submission: TaskSubmission;
  plan: Plan;
  scopeClassification: ScopeClassification;
  createdAt: string;
}

export interface TaskSubmission {
  /** Raw user request (natural language) */
  input: string;
  /** Durable run ID assigned before execution begins. */
  runId?: string;
  /**
   * Pre-normalized input from submitWithGates. When present, submit()
   * skips the redundant normalizePrompt() call (~15-20s ollama savings).
   */
  normalizedInput?: string;
  /** Optional pre-structured charter params (bypasses CharterGenerator) */
  charterOverride?: CreateIntentParams;
  /** Optional constraints to add */
  extraConstraints?: CreateIntentParams["constraints"];
  /** Optional exclusions */
  exclusions?: string[];
  /**
   * Optional per-task project root override. Defaults to the Coordinator's
   * boot-time config.projectRoot. When provided, the Coordinator constructs
   * a fresh ContextAssembler and IntegrationJudge for this submission with
   * the override, attaches it to ActiveRun.projectRoot, and propagates it
   * to workers via assignment.projectRoot in dispatchNode. The route
   * handler at server/routes/tasks.ts passes the request body's `repoPath`
   * field through this option so callers can target any local repo via the
   * --repo CLI flag or the repoPath field on POST /tasks.
   */
  projectRoot?: string;
}

export interface RunReceipt {
  readonly id: string;
  readonly runId: string;
  readonly intentId: string;
  readonly timestamp: string;
  readonly verdict: "success" | "partial" | "failed" | "aborted";
  readonly summary: ReturnType<typeof getRunSummary> & {
    /**
     * Per-wave outcome summary on multi-step runs. Undefined for
     * single-file runs (no plan). Populated from
     * summarizeWaveOutcomes(active.plan) at receipt build time so
     * consumers can read pending → passed / failed / halted /
     * skipped per wave without re-deriving it from waveVerifications.
     */
    readonly waveSummary?: readonly WaveOutcomeSummary[];
  };
  readonly graphSummary: ReturnType<typeof getGraphSummary>;
  readonly verificationReceipt: VerificationReceipt | null;
  /**
   * Per-wave verification receipts (P2). Empty for single-file runs.
   * Each receipt carries a `scope` tag identifying its wave so Lumen
   * can display wave-scoped findings.
   */
  readonly waveVerifications: readonly VerificationReceipt[];
  readonly judgmentReport: JudgmentReport | null;
  /**
   * MergeGate decision (P1). Null on exception paths where the gate
   * never ran. On successful runs this is the primary record of why
   * the commit was allowed or blocked — Lumen and the receipt feed
   * read this to surface critical/advisory findings.
   */
  readonly mergeDecision: MergeDecision | null;
  readonly totalCost: CostEntry;
  readonly commitSha: string | null;
  readonly durationMs: number;
  readonly memorySuggestions?: readonly string[];
  /**
   * Execution Truth Enforcement v1. `executionVerified` is the single
   * authority on whether the run produced real, verifiable work —
   * files created/modified/deleted on disk, a real commit SHA, or an
   * explicit read-only output. When false, the run is forced to the
   * "failed" verdict regardless of how other gates scored, and
   * `executionGateReason` explains why.
   *
   * `executionEvidence` is the full audit trail of what the gate
   * observed; `executionReceipts` is one synthesized receipt per
   * worker so Lumen can render "exactly what changed" per stage.
   */
  readonly executionVerified: boolean;
  readonly executionGateReason: string;
  readonly executionEvidence: readonly ExecutionEvidence[];
  readonly executionReceipts: readonly ExecutionReceipt[];
  /**
   * Human-Readable Execution + Trust Layer v1. A structured,
   * human-readable summary of the run, composed from the other
   * receipt fields (classification, blast radius, confidence,
   * failure explanation, cost). The UI renders this instead of
   * asking the user to read logs. Always populated on the happy
   * path; may be null on the legacy catch-path where buildReceipt
   * is called before the summary wiring landed (defensive only —
   * in practice the coordinator always provides the summary).
   *
   * Named `humanSummary` rather than `summary` because the
   * RunReceipt already has a `summary` field (the structured
   * task-count / phase snapshot from getRunSummary in runstate.ts).
   */
  readonly humanSummary: RunSummary | null;
  /**
   * Planning-time blast radius estimate. Computed after scope
   * classification, before execution. Surfaced on the RunReceipt
   * so the UI can show a "projected risk" chip before the run
   * finishes and compare it to the post-run actuals.
   */
  readonly blastRadius: BlastRadiusEstimate | null;
  /**
   * GAP 4 — Confidence-based model escalation. Records whether
   * an escalation was triggered, which model was used, and why.
   * Null when no builder triggered an escalation.
   */
  readonly escalation?: {
    readonly triggered: boolean;
    readonly fromConfidence: number;
    readonly toModel: string;
    readonly reason: string;
  } | null;
  /**
   * Post-run Crucibulum evaluation results. Null when evaluation
   * is disabled, was not triggered for this outcome, or the run
   * hasn't been evaluated yet. Contains structured results, scores,
   * disagreement analysis, and confidence adjustments.
   */
  readonly evaluation: EvaluationAttachment | null;
  /**
   * Promotion-ready patch artifact. Contains the unified diff of all
   * changes made in the workspace. Null on failure paths or when no
   * changes were produced. This is the artifact used to apply changes
   * to the source repo in a later promotion step.
   */
  readonly patchArtifact: PatchArtifact | null;
  /**
   * Workspace cleanup result. Records whether the disposable workspace
   * was successfully cleaned up. Null when no workspace was created.
   * cleanup_error is a SEVERE state — the receipt must surface it.
   */
  readonly workspaceCleanup: WorkspaceCleanupResult | null;
  /**
   * Source repo path (never mutated). Null for legacy runs that
   * predated the isolated workspace model.
   */
  readonly sourceRepo: string | null;
  /**
   * Source commit SHA at the time the workspace was created.
   */
  readonly sourceCommitSha: string | null;
  /**
   * Per-target mutation intent and outcome. Distinguishes required
   * writes from files included only for context/import/type references.
   */
  readonly targetRoles?: readonly TargetRoleReceipt[];
  /**
   * Discrete confidence gate label. Computed from tests_passed,
   * integration_passed, critic_iterations, and impact_level.
   * "high" | "medium" | "low". Null on early-exit paths where
   * the gate inputs aren't available.
   */
  readonly confidenceGate: ConfidenceResult | null;
  /**
   * True when this run used the fast execution path for trivial
   * single-file edits (no integrator, heuristic-only critic, test
   * hook skipped in verifier).
   */
  readonly fastPath?: boolean;
  /**
   * Candidate manifest — additive Phase B field. Records the lane
   * outcomes for runs that exercised the multi-lane policy
   * (`local_then_cloud` and friends). Empty/omitted on single-lane
   * primary_only runs so existing receipt consumers see no change.
   * The selected candidate (if any) is identified by
   * `selectedCandidateWorkspaceId`; only the primary candidate can
   * actually promote — see promoteToSource's role guard.
   */
  readonly candidates?: readonly CandidateManifestEntry[];
  readonly selectedCandidateWorkspaceId?: string | null;
  readonly laneMode?: import("./lane-config.js").LaneMode;
}

/**
 * Per-candidate row on the receipt manifest. Pruned subset of the
 * full Candidate type — only the fields a receipt reader needs to
 * render lane status without dragging the workspace path / patch
 * artifact through serialization.
 */
export interface CandidateManifestEntry {
  readonly workspaceId: string;
  readonly role: WorkspaceRole;
  readonly lane?: import("./candidate.js").Lane;
  readonly provider?: string;
  readonly model?: string;
  /** Lane-config requested model (mirrors `model`; surfaced for clarity). */
  readonly intentModel?: string;
  /** Model that actually answered (from cost.model); diverges on fallback. */
  readonly actualModel?: string;
  /** Alias for actualModel — kept for receipt-schema symmetry with providerUsed. */
  readonly modelUsed?: string;
  /** Provider that actually answered (only when intent==actual; see Candidate doc). */
  readonly providerUsed?: string;
  readonly status: CandidateStatus;
  readonly disqualification: string | null;
  readonly costUsd: number;
  readonly latencyMs: number;
  readonly verifierVerdict: Candidate["verifierVerdict"];
  readonly reason: string;
}

export interface TargetRoleReceipt {
  readonly file: string;
  readonly role: string;
  readonly mutationExpected: boolean;
  readonly actualChanged: boolean;
  readonly reason: string;
}

// ─── Coordinator Errors ────────────────────────────────────────────

export class CoordinatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoordinatorError";
  }
}

export function collectAdversarialFindingsForConfidence(
  workerResults: readonly WorkerResult[],
  executionDecision: ExecutionGateDecision | null,
  judgmentReport: JudgmentReport | null,
): GuardFinding[] {
  const findings: GuardFinding[] = [];
  const seen = new Set<string>();
  const push = (finding: GuardFinding) => {
    const key = `${finding.code}|${finding.severity}|${finding.ref ?? ""}|${finding.message}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push(finding);
  };

  for (const result of workerResults) {
    if (result.workerType === "scout") {
      const scoutOutput = result.output as { inspections?: { injectionFindings?: readonly GuardFinding[] } };
      for (const finding of scoutOutput.inspections?.injectionFindings ?? []) {
        push(finding);
      }
      continue;
    }
    if (result.workerType === "builder") {
      // Phase 8.5 — provider-anomaly findings from the builder flow
      // through the same aggregation path so they gate confidence
      // alongside scout / execution / judge findings.
      const builderOutput = result.output as { providerFindings?: readonly GuardFinding[] };
      for (const finding of builderOutput.providerFindings ?? []) {
        push(finding);
      }
      continue;
    }
  }

  for (const finding of executionDecision?.contentIdentityFindings ?? []) {
    push(finding);
  }

  for (const check of judgmentReport?.checks ?? []) {
    if (check.category !== "adversarial-guard" || check.score >= 1) continue;
    push({
      code:
        check.name === "Adversarial Consensus"
          ? "judge.adversarial_consensus"
          : check.name === "Adversarial Intent"
            ? "judge.adversarial_intent"
            : "judge.adversarial_guard",
      severity: check.score <= 0.3 ? "downgrade" : "warn",
      message: check.details,
      ref: check.affectedFiles[0],
    });
  }

  return findings;
}

// ─── Coordinator ─────────────────────────────────────────────────────

export class Coordinator {
  /** Deduplicate a list of strings, filtering out empty values. */
  private uniqueStrings(values: readonly string[]): string[] {
    return Array.from(new Set(values.filter((v): v is string => typeof v === "string" && v.length > 0)));
  }
  private config: CoordinatorConfig;
  private charterGen: CharterGenerator;
  // ContextAssembler and IntegrationJudge are NOT class fields. They are
  // constructed fresh per submit() call so they can honor per-task
  // projectRoot overrides from TaskSubmission. See submit() and the
  // ActiveRun.contextAssembler / .judge fields.
  private verifier: VerificationPipeline;
  private trustRouter: TrustRouter;
  private workerRegistry: WorkerRegistry;
  private eventBus: EventBus | null;
  private receiptStore: ReceiptStore;
  private evaluator: PostRunEvaluator;

  /** Active runs indexed by run ID */
  private activeRuns = new Map<string, ActiveRun>();
  /** Runs awaiting external approval before commit (requireApproval mode) */
  private pendingApproval = new Map<string, ActiveRun>();
  /** Pending decomposition plans awaiting approval, indexed by task ID */
  private pendingPlans = new Map<string, PendingPlan>();
  /** Cached repo hub index per projectRoot. TTL: 5 minutes. */
  private hubIndexCache = new Map<string, { result: { file: string; importedByCount: number }[]; timestamp: number }>();

  constructor(
    config: Partial<CoordinatorConfig>,
    trustProfile: TrustProfile,
    workerRegistry: WorkerRegistry,
    eventBus?: EventBus,
    receiptStore?: ReceiptStore,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.charterGen = new CharterGenerator(this.config.charterConfig);
    // ContextAssembler and IntegrationJudge are constructed per-submit so
    // they can pick up per-task projectRoot overrides. The constructor
    // intentionally does not create boot-time defaults — there's no use
    // case for a "default" assembler or judge that uses the wrong root.
    this.verifier = new VerificationPipeline(this.config.verificationConfig);
    this.trustRouter = new TrustRouter(trustProfile);
    this.workerRegistry = workerRegistry;
    this.eventBus = eventBus ?? null;
    this.receiptStore = receiptStore ?? new ReceiptStore(this.config.projectRoot);
    this.evaluator = new PostRunEvaluator(this.config.evaluationConfig);

    // Startup recovery: scan for orphaned AWAITING_APPROVAL runs that were
    // left behind by a previous process crash or restart. These runs have
    // preserved workspaces and pending changes that need to be rolled back
    // since we can't resume approval without the user's context.
    this.recoverPendingApprovals().catch((err) => {
      console.error(`[coordinator] startup recovery failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  /**
   * Recover runs that were left in AWAITING_APPROVAL state by a previous
   * process. Since we have no way to re-present the approval UI after a
   * restart, we roll back their changes and mark them as INTERRUPTED.
   * The workspace is cleaned up if it still exists.
   */
  private async recoverPendingApprovals(): Promise<void> {
    const awaitingRuns = await this.receiptStore.listRuns(100, "AWAITING_APPROVAL");
    if (awaitingRuns.length === 0) return;

    console.log(`[coordinator] STARTUP RECOVERY: found ${awaitingRuns.length} orphaned AWAITING_APPROVAL run(s) — rolling back`);

    for (const entry of awaitingRuns) {
      const runId = entry.runId;
      try {
        // Try to load the full receipt to get workspace info
        const receipt = await this.receiptStore.getRun(runId);
        const workspacePath = (receipt as any)?.workspace?.workspacePath as string | undefined;

        // Clean up workspace if it exists
        if (workspacePath) {
          try {
            const { existsSync } = await import("node:fs");
            if (existsSync(workspacePath)) {
              const { rm } = await import("node:fs/promises");
              await rm(workspacePath, { recursive: true, force: true });
              console.log(`[coordinator] STARTUP RECOVERY: cleaned up workspace ${workspacePath} for run ${runId}`);
            }
          } catch (cleanupErr) {
            console.warn(`[coordinator] STARTUP RECOVERY: workspace cleanup failed for ${runId}: ${cleanupErr}`);
          }
        }

        // Mark the run as interrupted in the receipt store
        await this.receiptStore.patchRun(runId, {
          status: "INTERRUPTED",
          taskSummary: "Interrupted — process restarted while awaiting approval",
          completedAt: new Date().toISOString(),
          appendErrors: ["Orphaned AWAITING_APPROVAL run recovered on startup — changes rolled back"],
          appendCheckpoints: [{
            at: new Date().toISOString(),
            type: "failure_occurred",
            status: "INTERRUPTED",
            phase: "awaiting_approval",
            summary: "Startup recovery: rolled back orphaned approval run",
          }],
        });
        console.log(`[coordinator] STARTUP RECOVERY: run ${runId} marked as INTERRUPTED`);
      } catch (err) {
        console.error(`[coordinator] STARTUP RECOVERY: failed to recover run ${runId}: ${err}`);
      }
    }
    console.log(`[coordinator] STARTUP RECOVERY: complete`);
  }

  // ─── Public API ────────────────────────────────────────────────────

  /**
   * Submit a task with pre-execution gates (ambiguity detection +
   * decomposition). Returns a discriminated union so the route handler
   * can respond with the appropriate HTTP status / body.
   */
  async submitWithGates(submission: TaskSubmission): Promise<TaskSubmissionResult> {
    const input = submission.input.trim();

    // GAP 0 — Velum input guard at the entry. The deeper Velum scan in
    // submit() catches the same patterns, but by then an intent + run
    // + workspace have already been created. Running the guard here
    // means a blocked prompt never allocates state. The downgrade-on-
    // -literal-only logic inside scanInput keeps benign quoted
    // requests alive (decision === "warn"); only true instruction-
    // position injection reaches the BLOCK branch.
    const earlyGuard = velumScanInput(input);
    if (earlyGuard.decision === "block") {
      const reason = earlyGuard.reasons.join("; ");
      console.warn(
        `[coordinator] submitWithGates: BLOCKED at entry — flags=[${earlyGuard.flags.join(", ")}] reasons="${reason}"`,
      );
      return { kind: "blocked", reason, flags: earlyGuard.flags };
    }

    // GAP 1 — Ambiguity detection
    if (detectAmbiguity(input)) {
      console.log(`[coordinator] ambiguity detected — prompt too vague: "${input}"`);
      return {
        kind: "needs_clarification",
        question: "Which file or function should I modify? Be specific.",
      };
    }
    if (needsBroadCleanupClarification(input)) {
      console.log(`[coordinator] broad cleanup prompt needs clarification before target inference: "${input}"`);
      return {
        kind: "needs_clarification",
        question: "Which config file, function, or route should I clean up? Please name the target path or symbol.",
      };
    }

    // GAP 2 — Decomposition gate: run scope classification early
    // to check if decomposition is recommended before full execution.
    const effectiveProjectRoot = submission.projectRoot ?? this.config.projectRoot;
    const projectMemory = await loadMemory(effectiveProjectRoot);
    const gated = gateContext(projectMemory, input);
    let normalizedInput = await normalizePrompt(input, gated, effectiveProjectRoot);

    const baseAnalysis = this.charterGen.analyzeRequest(normalizedInput);
    const preparedTargets = prepareTargetsForPrompt({
      projectRoot: effectiveProjectRoot,
      prompt: normalizedInput,
      analysis: baseAnalysis,
    });
    const analysis: RequestAnalysis = {
      ...baseAnalysis,
      targets: preparedTargets.targets.length > 0
        ? [...preparedTargets.targets]
        : [...baseAnalysis.targets],
      ambiguities:
        preparedTargets.clarification && preparedTargets.targets.length === 0
          ? [...baseAnalysis.ambiguities, preparedTargets.clarification]
          : [...baseAnalysis.ambiguities],
    };
    const charter = this.charterGen.generateCharter(analysis);
    const charterTargets: string[] = Array.from(
      new Set(charter.deliverables.flatMap((d) => [...d.targetFiles])),
    );
    const preflight = runPreflight({
      input: normalizedInput,
      projectRoot: effectiveProjectRoot,
      extractedTargets: analysis.targets,
      ambiguities: analysis.ambiguities,
    });

    if (charterTargets.length === 0) {
      if (charterTargets.length === 0) {
        console.log(`[coordinator] no actionable targets found — asking for clarification: "${input}"`);
        return {
          kind: "needs_clarification",
          question:
            preparedTargets.clarification ??
            "I couldn't identify a file to work on. Please name a specific file (e.g. `core/foo.ts`) or describe the module to change.",
        };
      }
    }

    const allTargetsMissing = preflight.findings.some((f) => f.code === "all-targets-missing");
    const hasCreateIntent =
      analysis.category === "scaffold" ||
      /\b(create|new file|new module|extract\s+\w+\s+into|move\s+\w+\s+to\s+a\s+new)\b/i.test(normalizedInput);
    if (allTargetsMissing && !hasCreateIntent) {
      console.log(`[coordinator] all extracted targets missing — asking for clarification: "${input}"`);
      return {
        kind: "needs_clarification",
        question: "The file path you named does not exist in this repo. Check the path and retry, or name the correct file/module to work on.",
      };
    }

    const scopeClassification = classifyScope(normalizedInput, charterTargets);

    if (scopeClassification.recommendDecompose) {
      console.log(
        `[coordinator] large scope detected (blast=${scopeClassification.blastRadius}) — generating decomposition plan`,
      );
      const constraints = [
        ...this.charterGen.generateDefaultConstraints(analysis),
        ...(submission.extraConstraints ?? []),
      ];
      const intent = createIntent({
        runId: randomUUID(),
        userRequest: normalizedInput,
        charter,
        constraints,
        exclusions: submission.exclusions,
      });
      const baseChangeSet = createChangeSet(intent, charterTargets, undefined, effectiveProjectRoot);
      const invariants = await extractInvariants(charterTargets, effectiveProjectRoot);
      const changeSet: ChangeSet = Object.freeze({
        ...baseChangeSet,
        invariants: Object.freeze(invariants),
      });
      const plan = planChangeSet(changeSet, normalizedInput);

      // Auto-approve when governance doesn't strictly require decomposition
      // (e.g., multi-file with 2-4 files). This prevents the UX dead-end
      // where simple multi-file tasks get stranded awaiting approval.
      const governanceRequiresApproval = scopeClassification.governance.decompositionRequired;
      if (!governanceRequiresApproval) {
        console.log(
          `[coordinator] decomposition recommended but NOT required by governance (blast=${scopeClassification.blastRadius}) — auto-approving plan`,
        );
        const receiptPromise = this.submit({ ...submission, normalizedInput });
        return { kind: "executing", receipt: receiptPromise };
      }

      const taskId = `plan_${randomUUID().slice(0, 8)}`;
      this.pendingPlans.set(taskId, {
        taskId,
        submission: { ...submission, normalizedInput },
        plan,
        scopeClassification,
        createdAt: new Date().toISOString(),
      });

      return {
        kind: "needs_decomposition",
        taskId,
        plan,
        message: `This task is large (blast radius ${scopeClassification.blastRadius}, ${plan.waves.length} wave(s)). Here's how I'd break it down. Reply 'approve' to proceed or refine the plan.`,
      };
    }

    // No gates tripped — proceed with full execution.
    // Pass the already-normalized input so submit() doesn't re-run
    // the expensive ollama normalization call (~15-20s saved).
    const receiptPromise = this.submit({ ...submission, normalizedInput });
    return { kind: "executing", receipt: receiptPromise };
  }

  /**
   * Approve a pending decomposition plan and resume execution.
   * Returns null if no pending plan found for the given taskId.
   */
  approvePlan(taskId: string): { receipt: Promise<RunReceipt> } | null {
    const pending = this.pendingPlans.get(taskId);
    if (!pending) return null;
    this.pendingPlans.delete(taskId);
    console.log(`[coordinator] plan approved for ${taskId} — resuming execution`);
    const receipt = this.submit(pending.submission);
    return { receipt };
  }

  /**
   * Get a pending plan by task ID, if one exists.
   */
  getPendingPlan(taskId: string): PendingPlan | undefined {
    return this.pendingPlans.get(taskId);
  }

  /**
   * Drop a pending decomposition plan without executing it. Returns
   * true if a plan was removed, false if no plan existed for the
   * given taskId. Used by the /plans/:id/reject API to discard a
   * plan the user does not want to run.
   */
  rejectPlan(taskId: string): boolean {
    const had = this.pendingPlans.has(taskId);
    if (had) {
      this.pendingPlans.delete(taskId);
      console.log(`[coordinator] plan rejected for ${taskId} — pending plan dropped`);
    }
    return had;
  }

  /**
   * Submit a task and run the full build pipeline.
   * Returns a RunReceipt when complete.
   */
  async submit(submission: TaskSubmission): Promise<RunReceipt> {
    const startTime = Date.now();
    let commitSha: string | null = null;
    let verificationReceipt: VerificationReceipt | null = null;
    let judgmentReport: JudgmentReport | null = null;
    let repairAudit: RepairAuditResult | null = null;
    const input = submission.input;

    console.log(`[coordinator] ═══ submit() entry — input="${submission.input.slice(0, 80)}${submission.input.length > 80 ? "…" : ""}"`);

    // Resolve effective projectRoot for this submission. The Coordinator's
    // own config.projectRoot is the boot-time default; per-task submissions
    // can override via TaskSubmission.projectRoot. Workers receive the
    // effective root via assignment.projectRoot in dispatchNode.
    const effectiveProjectRoot = submission.projectRoot ?? this.config.projectRoot;
    const sourceRootExistsAtStart = existsSync(effectiveProjectRoot);
    console.log(
      `[coordinator] effective projectRoot for this submission: ${effectiveProjectRoot}` +
      (submission.projectRoot ? " (overridden via submission)" : " (Coordinator default)")
    );
    const projectMemory = await loadMemory(effectiveProjectRoot);
    let gatedContext = gateContext(projectMemory, input);
    console.log("[coordinator] gated context:", JSON.stringify(gatedContext));
    // Skip redundant normalization when submitWithGates already did it.
    const normalizedInput = submission.normalizedInput
      ? (console.log("[coordinator] using pre-normalized input from submitWithGates (skipped ~15-20s ollama call)"), submission.normalizedInput)
      : await normalizePrompt(input, gatedContext, effectiveProjectRoot);

    // Construct per-submit ContextAssembler and IntegrationJudge so they
    // honor the effective projectRoot. These can't be class fields because
    // the projectRoot may differ per submission. The IntegrationJudge in
    // particular needs the right projectRoot for its checkIntentAlignment
    // path normalization — without it, deliverable paths from the Charter
    // (which may be absolute, relative, or basenames) won't match the
    // Builder's relative-to-projectRoot change paths and the judge fails
    // on every successful build.
    const contextAssembler = new ContextAssembler({ projectRoot: effectiveProjectRoot });
    const judge = new IntegrationJudge({ projectRoot: effectiveProjectRoot });

    // Phase 1: Charter
    console.log(`[coordinator] PHASE 1: Charter — analyzing request`);
    this.emit({ type: "run_started", payload: { runId: submission.runId ?? null, input: redactText(normalizedInput) } });

    const baseAnalysis = this.charterGen.analyzeRequest(normalizedInput);
    const preparedTargets = prepareTargetsForPrompt({
      projectRoot: effectiveProjectRoot,
      prompt: normalizedInput,
      analysis: baseAnalysis,
    });
    const analysis: RequestAnalysis = {
      ...baseAnalysis,
      targets: preparedTargets.targets.length > 0
        ? [...preparedTargets.targets]
        : [...baseAnalysis.targets],
      ambiguities:
        preparedTargets.clarification && preparedTargets.targets.length === 0
          ? [...baseAnalysis.ambiguities, preparedTargets.clarification]
          : [...baseAnalysis.ambiguities],
    };
    const charter = this.charterGen.generateCharter(analysis);
    const constraints = [
      ...this.charterGen.generateDefaultConstraints(analysis),
      ...(submission.extraConstraints ?? []),
    ];
    console.log(`[coordinator] PHASE 1 done — category=${analysis.category} scope=${analysis.scopeEstimate} deliverables=${charter.deliverables.length} targets=[${analysis.targets.slice(0, 5).join(", ")}${analysis.targets.length > 5 ? "…" : ""}]`);

    this.emit({ type: "charter_generated", payload: { charter, analysis } });

    // Classify scope from the charter's target files (deduped union of
    // every deliverable's targetFiles). Surfaces oversized requests early
    // so we can warn the operator before spending tokens on planning.
    const charterTargets = Array.from(
      new Set(
        charter.deliverables.flatMap((d) => [...d.targetFiles]),
      ),
    );
    if (preparedTargets.selected.length > 0) {
      console.log(
        `[coordinator] target preparation selected ${preparedTargets.selected.length} candidate(s): ` +
        `${preparedTargets.selected.map((candidate) => candidate.path).join(", ")}`,
      );
    }
    if (preparedTargets.rejected.length > 0) {
      console.log(
        `[coordinator] target preparation rejected ${preparedTargets.rejected.length} candidate(s): ` +
        `${preparedTargets.rejected.map((candidate) => `${candidate.path} (${candidate.reason})`).join("; ")}`,
      );
    }
    if (charterTargets.length === 0) {
      throw new CoordinatorError(
        preparedTargets.clarification ??
        "No actionable target files were identified for this request.",
      );
    }
    const scopeClassification = classifyScope(normalizedInput, charterTargets);
    console.log(
      `[coordinator] scope: ${scopeClassification.type} blastRadius=${scopeClassification.blastRadius} decompose=${scopeClassification.recommendDecompose}`
    );
    if (scopeClassification.recommendDecompose) {
      console.warn("[coordinator] WARN: large scope detected — consider decomposing this task.");
    }

    // ── Trivial Task Detection ──────────────────────────────────────
    // Fast path for single-file comment/whitespace edits: skips
    // decomposition overhead, limits scout scope, uses heuristic-only
    // critic, drops integrator — but keeps verifier + typecheck.
    const trivialCheck = isTrivialTask({
      targets: charterTargets,
      prompt: normalizedInput,
      scopeEstimate: analysis.scopeEstimate,
      riskSignals: analysis.riskSignals,
    });
    console.log(
      `[coordinator] trivial-task-detector: isTrivial=${trivialCheck.isTrivial} reason="${trivialCheck.reason}"`,
    );

    // GAP 3 — Architectural context gate: when scope is architectural,
    // build a repo-wide hub-file index and merge it into the gated
    // context so workers see the most-connected files regardless of
    // prompt relevance. The hub summary is injected as a memoryNote.
    if (scopeClassification.type === "architectural") {
      console.log("[coordinator] architectural scope — building hub-file index for context gate");
      try {
        const repoIndex = await this.buildRepoHubIndex(effectiveProjectRoot);
        const archContext = gateContextForArchitectural(projectMemory, normalizedInput, repoIndex);
        gatedContext = mergeGatedContext(gatedContext, archContext);
        console.log(
          `[coordinator] architectural gate: injected ${repoIndex.length} hub files, ` +
          `${archContext.inclusionLog?.length ?? 0} inclusion log entries`,
        );
      } catch (err) {
        console.warn(
          `[coordinator] architectural gate failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Human-Readable Execution + Trust Layer v1 — compute a user-
    // facing blast radius estimate as soon as we have a scope
    // classification. This is additive: the estimate is emitted as
    // an event and also attached to the final RunReceipt so the UI
    // can render a "projected risk" chip before execution and
    // compare it to the post-run actuals.
    const blastRadius = estimateBlastRadius({
      scopeClassification,
      charterFileCount: charterTargets.length,
      prompt: normalizedInput,
    });
    console.log(
      `[coordinator] blast radius: level=${blastRadius.level} scope=${blastRadius.scopeType} ` +
      `estFiles=${blastRadius.estimatedFiles} raw=${blastRadius.rawScore} ` +
      `(${blastRadius.rationale})`,
    );
    this.emit({
      type: "blast_radius_estimated",
      payload: {
        level: blastRadius.level,
        scopeType: blastRadius.scopeType,
        estimatedFiles: blastRadius.estimatedFiles,
        rawScore: blastRadius.rawScore,
        recommendDecompose: blastRadius.recommendDecompose,
        rationale: blastRadius.rationale,
        signals: blastRadius.signals,
      },
    });

    // Governance enforcement: scope classification governance triggers
    // must materially affect execution, not just be advisory metadata.
    const governance = scopeClassification.governance;
    // Effective approval requirement: config.requireApproval OR governance says so
    const effectiveRequireApproval = this.config.requireApproval || governance.approvalRequired;
    if (governance.approvalRequired && !this.config.requireApproval) {
      console.log(`[coordinator] GOVERNANCE: scope requires approval (${scopeClassification.type}) — approval enforced for this run`);
    }
    if (governance.escalationRecommended) {
      console.log(`[coordinator] GOVERNANCE: escalation recommended for ${scopeClassification.type} scope`);
    }

    // Phase 2: Intent
    console.log(`[coordinator] PHASE 2: Intent — creating and validating`);
    const intent = createIntent({
      runId: randomUUID(),
      userRequest: normalizedInput,
      charter,
      constraints,
      exclusions: submission.exclusions,
    });

    const intentErrors = validateIntent(intent);
    if (intentErrors.length > 0) {
      console.error(`[coordinator] PHASE 2 FAIL — invalid intent: ${intentErrors.join(", ")}`);
      throw new CoordinatorError(`Invalid intent: ${intentErrors.join(", ")}`);
    }
    console.log(`[coordinator] PHASE 2 done — intent ${intent.id} v${intent.version} locked`);

    this.emit({ type: "intent_locked", payload: { intentId: intent.id, version: intent.version } });

    // Build the ChangeSet now that the IntentObject is locked. createChangeSet
    // wants the immutable intent + the same deduped charter target list we
    // used for the scope classifier above, so file inclusion / dependency
    // relationships / coherence verdict line up with what was just classified.
    const baseChangeSet = createChangeSet(intent, charterTargets, undefined, effectiveProjectRoot);
    const invariants = await extractInvariants(charterTargets, effectiveProjectRoot);
    const changeSet: ChangeSet = Object.freeze({
      ...baseChangeSet,
      invariants: Object.freeze(invariants),
    });
    console.log(`[coordinator] invariants: ${invariants.length} cross-file alignment constraints found.`);
    const plan = this.shouldPlanForScope(scopeClassification)
      ? planChangeSet(changeSet, normalizedInput)
      : undefined;
    if (plan) {
      console.log(`[coordinator] multi-file plan: ${plan.waves.length} wave(s).`);
    }
    const patternWarnings = findPatternWarnings(projectMemory, {
      prompt: normalizedInput,
      scopeType: scopeClassification.type,
      plannedFilesCount: changeSet.filesInScope.length,
    });
    if (patternWarnings.length > 0) {
      gatedContext = mergeGatedContext(gatedContext, {
        memoryNotes: patternWarnings,
        suggestedNextSteps: ["Review whether the planned file set is broad enough for this task pattern."],
      });
      console.log(`[coordinator] pattern memory: ${patternWarnings.length} warning(s) injected`);
    }

    if (this.config.requireWorkspace && !sourceRootExistsAtStart) {
      console.error(
        `[coordinator] source root missing at submit time — aborting before workspace setup: ${effectiveProjectRoot}`,
      );
      const run = createRunState(intent.id, submission.runId);
      return this.abortWorkspaceRun({
        run,
        intentId: intent.id,
        prompt: input,
        blastRadius,
        sourceRepo: effectiveProjectRoot,
        sourceRootExistsAtStart,
        cause: `source path does not exist at submission time: ${effectiveProjectRoot}`,
        startTime,
      });
    }

    // ── Phase 5: Project Memory Store (advisory hints) ─────────────
    // Retrieve relevant memory entries and inject as prior-knowledge hints.
    // Memory is ADVISORY ONLY — current source code always takes precedence.
    try {
      const memoryStore = await ProjectMemoryStore.open(effectiveProjectRoot);
      const taskTags = [
        scopeClassification.type,
        ...(charterTargets.length > 0 ? ["multi-file"] : ["single-file"]),
      ];
      const priorKnowledge = await memoryStore.getMemoryForTask(taskTags);
      if (priorKnowledge.length > 0) {
        const hints = priorKnowledge.map((e) =>
          `// Prior knowledge [${e.key}] (confidence ${e.confidence}): ${e.value}`,
        );
        const existingNotes = gatedContext.memoryNotes ?? [];
        gatedContext = mergeGatedContext(gatedContext, {
          memoryNotes: [...existingNotes, ...hints],
        });
        console.log(`[coordinator] project memory: ${priorKnowledge.length} prior knowledge hint(s) injected`);
      }
      memoryStore.close();
    } catch (err) {
      console.warn(`[coordinator] project memory store unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      const memoryAdapter = await getAedisMemoryAdapter();
      if (memoryAdapter) {
        const memoryContext = await memoryAdapter.buildExecutionContext({
          projectRoot: effectiveProjectRoot,
          prompt: normalizedInput,
          projectMemory,
          scopeClassification,
          targetFiles: charterTargets,
        });
        gatedContext = mergeGatedContext(gatedContext, toGatedContext(memoryContext, projectMemory.language));
        console.log("[coordinator] memory-backed gate:", JSON.stringify({
          relevantFiles: memoryContext.relevantFiles,
          clusterFiles: memoryContext.clusterFiles,
          landmines: memoryContext.landmines,
          strictVerification: memoryContext.strictVerification,
        }));
        if (memoryContext.inclusionLog.length > 0) {
          console.log(
            `[coordinator] memory-backed gate: ${memoryContext.inclusionLog.length} item(s) in inclusion log`,
          );
          for (const line of memoryContext.inclusionLog) {
            console.log(`[coordinator] memory-backed   ${line}`);
          }
        }
        if (memoryContext.memoryNotes.length > 0) {
          console.log(
            `[coordinator] memory-backed gate: ${memoryContext.memoryNotes.length} high-signal note(s) injected`,
          );
        }
      }
    } catch (err) {
      console.warn(`[coordinator] memory-backed gate unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Phase 3: RunState + Isolated Workspace
    console.log(`[coordinator] PHASE 3: RunState — creating`);
    const run = createRunState(intent.id, submission.runId);

    // ── Isolated Workspace ──────────────────────────────────────────
    // Create a disposable workspace so all mutations happen outside
    // the source repo. The workspace path becomes the projectRoot for
    // all worker dispatches, git operations, and verification steps.
    //
    // SAFETY: when config.requireWorkspace is true (default), a failed
    // workspace creation hard-aborts the run — the source repo is
    // never touched. The legacy fallback-to-source-repo path only
    // runs when requireWorkspace=false is set explicitly.
    let workspace: WorkspaceHandle | null = null;
    let workspaceProjectRoot = effectiveProjectRoot;
    let workspaceCreationError: string | null = null;
    try {
      workspace = await createWorkspace(effectiveProjectRoot, run.id);
      workspaceProjectRoot = workspace.workspacePath;
      console.log(
        `[coordinator] workspace created: method=${workspace.method} path=${workspace.workspacePath} ` +
        `source=${workspace.sourceRepo} sha=${workspace.sourceCommitSha.slice(0, 8)}`,
      );
    } catch (err) {
      workspaceCreationError = err instanceof Error ? err.message : String(err);
      if (this.config.requireWorkspace) {
        console.error(
          `[coordinator] workspace creation FAILED — requireWorkspace=true, aborting run ` +
          `(source repo untouched): ${workspaceCreationError}`,
        );
      } else {
        console.error(
          `[coordinator] workspace creation FAILED — falling back to source repo (UNSAFE, ` +
          `requireWorkspace=false): ${workspaceCreationError}`,
        );
      }
    }

    // Hard-abort path for requireWorkspace=true. We write a minimal
    // failing receipt so the user sees the reason, then return before
    // any worker/gate logic can touch the source repo.
    if (this.config.requireWorkspace && (!workspace || !sourceRootExistsAtStart)) {
      if (workspace) {
        await discardWorkspace(workspace).catch(() => undefined);
        workspace = null;
      }
      const workspaceAbortCause =
        !sourceRootExistsAtStart
          ? `source path does not exist at submission time: ${effectiveProjectRoot}`
          : (workspaceCreationError ?? "unknown");
      return this.abortWorkspaceRun({
        run,
        intentId: intent.id,
        prompt: input,
        blastRadius,
        sourceRepo: effectiveProjectRoot,
        sourceRootExistsAtStart,
        cause: workspaceAbortCause,
        startTime,
      });
    }

    const active: ActiveRun = {
      intent,
      run,
      graph: createTaskGraph(intent.id),
      changes: [],
      workerResults: [],
      cancelled: false,
      projectRoot: workspaceProjectRoot,
      sourceRepo: effectiveProjectRoot,
      workspace,
      // Multi-workspace registry. Primary is registered immediately so
      // any code path that resolves a workspace by id (shadow safety
      // checks, candidate plumbing) sees a consistent map. Shadow
      // workspaces are added later via createShadowWorkspaceForRun.
      workspaces: workspace
        ? new Map<string, WorkspaceEntry>([[
            "primary",
            { workspaceId: "primary", role: "primary", handle: workspace },
          ]])
        : new Map<string, WorkspaceEntry>(),
      candidates: [],
      // Lane policy: load from `.aedis/lane-config.json` once per run
      // off the SOURCE repo (not the workspace clone — the file lives
      // alongside the source's other .aedis/ config). Fallback to
      // DEFAULT_LANE_CONFIG when the file is absent so existing
      // single-lane projects keep their current behavior verbatim.
      laneConfig: loadLaneConfigFromDisk(effectiveProjectRoot),
      gatedContext,
      projectMemory,
      analysis,
      normalizedInput,
      memorySuggestions: [],
      contextAssembler,
      judge,
      scopeClassification: scopeClassification ?? null,
      changeSet,
      plan,
      waveVerifications: [],
      rawUserPrompt: input,
      blastRadius,
      runInvocationContext: createRunInvocationContext(),
      gitDiffResult: null,
      patchArtifact: null,
      workspaceCleanup: null,
      patternWarnings,
      historicalInsights: findHistoricalInsights(projectMemory, { prompt: normalizedInput, scopeType: scopeClassification.type }).map((i) => i.line),
      confidenceDampening: getConfidenceDampening(projectMemory, { prompt: normalizedInput, scopeType: scopeClassification.type }),
      historicalReliabilityTier: getReliabilityTier(projectMemory, { prompt: normalizedInput, scopeType: scopeClassification.type }),
      weakOutputRetries: 0,
      cancelledGenerations: new Set<string>(),
      pendingDispatches: new Map<string, Promise<unknown>>(),
      rejectedCandidates: preparedTargets.rejected.map((entry) => ({ path: entry.path, reason: entry.reason })),
      userNamedStrippedTargets: [],
      fastPath: false,
      runAbortController: new AbortController(),
    };
    this.activeRuns.set(run.id, active);

    if (trivialCheck.isTrivial) {
      active.fastPath = true;
      console.log(`[coordinator] FAST PATH enabled — skipping integrator, heuristic-only critic`);
    }

    if (active.confidenceDampening < 1.0) {
      console.log(`[coordinator] LEARNING: confidence dampening ${active.confidenceDampening.toFixed(2)} applied for task type (historical overconfidence)`);
    }
    if (active.historicalInsights.length > 0) {
      console.log(`[coordinator] LEARNING: ${active.historicalInsights.length} historical insight(s) for explanation layer`);
    }
    console.log(`[coordinator] PHASE 3 done — run ${run.id} created, registered as active (projectRoot=${active.projectRoot})`);
    console.log(`[coordinator] changeSet created: ${charterTargets.length} file(s), scope=${active.scopeClassification?.type ?? "unknown"}`);
    await this.receiptStore.beginRun({
      runId: active.run.id,
      intentId: intent.id,
      prompt: input,
      taskSummary: input,
      startedAt: run.startedAt,
      phase: run.phase,
    });

    // Persist the workspace reference on the receipt as soon as it
    // exists so startup recovery can reconcile the worktree if this
    // process crashes mid-run.
    if (active.workspace) {
      await this.receiptStore.patchRun(active.run.id, {
        workspace: {
          workspacePath: active.workspace.workspacePath,
          sourceRepo: active.workspace.sourceRepo,
          sourceCommitSha: active.workspace.sourceCommitSha,
          method: active.workspace.method,
          createdAt: active.workspace.createdAt,
          worktreeBranch: active.workspace.worktreeBranch,
          cleanedUp: false,
        },
      });
    }

    if (preparedTargets.selected.length > 0 || preparedTargets.rejected.length > 0) {
      await this.persistReceiptCheckpoint(active, {
        at: new Date().toISOString(),
        type: "run_started",
        status: "EXECUTING_IN_WORKSPACE",
        phase: run.phase,
        summary: `target preparation: ${charterTargets.length} actionable file(s)`,
        details: {
          selected: preparedTargets.selected,
          rejected: preparedTargets.rejected,
        },
      });
    }

    // ── Worker Model Resolution Receipt ─────────────────────────────
    // Resolve the exact models Builder and Critic will dispatch with,
    // reading from the SAME source the workers read from (the source
    // repo's .aedis/model-config.json). Emit a run_started checkpoint
    // so the receipt shows which models were selected and whether they
    // came from the user's saved config or the hardcoded defaults. If
    // the UI shows model X but this checkpoint shows default Y, the
    // save->execute pipeline is broken — the dogfood receipt is the
    // ground truth.
    {
      const configPath = resolve(active.sourceRepo, ".aedis", "model-config.json");
      const configSource: "user-config" | "fallback" = existsSync(configPath)
        ? "user-config"
        : "fallback";
      const resolved = loadModelConfigFromDisk(active.sourceRepo);
      const builderTierModels = resolveAllBuilderTierModels(resolved);
      const tierWarning = builderTierCollapseWarning(resolved);
      const workerModels = {
        builder: `${resolved.builder.provider}/${resolved.builder.model}`,
        critic: `${resolved.critic.provider}/${resolved.critic.model}`,
        scout: `${resolved.scout.provider}/${resolved.scout.model}`,
        verifier: `${resolved.verifier.provider}/${resolved.verifier.model}`,
        integrator: `${resolved.integrator.provider}/${resolved.integrator.model}`,
        escalation: `${resolved.escalation.provider}/${resolved.escalation.model}`,
        coordinator: `${resolved.coordinator.provider}/${resolved.coordinator.model}`,
      };
      console.log(
        `[coordinator] worker models resolved (source=${configSource}, path=${configPath}): ` +
        `builder=${workerModels.builder} critic=${workerModels.critic}`,
      );
      if (tierWarning) {
        console.warn(`[coordinator] ${tierWarning}`);
      }
      await this.persistReceiptCheckpoint(active, {
        at: new Date().toISOString(),
        type: "run_started",
        status: "EXECUTING_IN_WORKSPACE",
        phase: run.phase,
        summary: `worker models resolved (source=${configSource})`,
        details: {
          workerModels,
          builderTierModels: {
            fast: builderTierModels.fast.identity,
            standard: builderTierModels.standard.identity,
            premium: builderTierModels.premium.identity,
          },
          builderTierSources: {
            fast: builderTierModels.fast.source,
            standard: builderTierModels.standard.source,
            premium: builderTierModels.premium.source,
          },
          tierWarning,
          source: configSource,
          configPath,
        },
      });
    }

    // ── Velum Input Guard ──────────────────────────────────────────
    // Runs before the Builder touches anything. Block/review/warn/allow.
    const velumInput = velumScanInput(normalizedInput, gatedContext.memoryNotes);
    console.log(`[coordinator] velum.input.scan: decision=${velumInput.decision} flags=[${velumInput.flags.join(", ")}]`);
    await this.persistReceiptCheckpoint(active, {
      at: new Date().toISOString(),
      type: "worker_step",
      status: "EXECUTING_IN_WORKSPACE",
      phase: run.phase,
      summary: `velum.input.scan: ${velumInput.decision}`,
      details: { decision: velumInput.decision, reasons: velumInput.reasons, flags: velumInput.flags },
    });
    if (velumInput.decision === "block") {
      const blockMsg = `Velum input guard blocked execution: ${velumInput.reasons.join("; ")}`;
      console.error(`[coordinator] ${blockMsg}`);
      failRun(run, blockMsg);
      this.emit({ type: "merge_blocked", payload: { runId: active.run.id, blockers: [blockMsg] } });
      return this.buildReceipt(active, null, null, null, Date.now() - startTime, null, null, "failed");
    }
    if (velumInput.decision === "review" && effectiveRequireApproval) {
      console.log(`[coordinator] velum.input.scan: review required — pausing for approval`);
      recordDecision(run, {
        description: `Velum input guard flagged for review: ${velumInput.reasons.join("; ")}`,
        madeBy: "velum",
        taskId: null,
        alternatives: ["Block execution", "Allow execution"],
        rationale: velumInput.flags.join(", "),
      });
    }
    if (velumInput.decision === "warn") {
      console.warn(`[coordinator] velum.input.scan: warnings: ${velumInput.reasons.join("; ")}`);
      recordDecision(run, {
        description: `Velum input guard warning: ${velumInput.reasons.join("; ")}`,
        madeBy: "velum",
        taskId: null,
        alternatives: [],
        rationale: velumInput.flags.join(", "),
      });
    }

    // ── Impact Classification Gate ─────────────────────────────────
    // Runs before the Builder. HIGH → approval required, MEDIUM → strict verification.
    const impactClassification = classifyTask(normalizedInput, charterTargets);
    console.log(`[coordinator] impact.classification: level=${impactClassification.level} reasons=[${impactClassification.reasons.join("; ")}]`);
    await this.persistReceiptCheckpoint(active, {
      at: new Date().toISOString(),
      type: "worker_step",
      status: "EXECUTING_IN_WORKSPACE",
      phase: run.phase,
      summary: `impact.classification: ${impactClassification.level}`,
      details: { level: impactClassification.level, reasons: impactClassification.reasons },
    });
    if (impactClassification.level === "high") {
      console.log(`[coordinator] impact.classification: HIGH — enforcing approval requirement`);
      // Override effective approval — variable was declared with const, so
      // we use a mutable alias that downstream code already reads.
      // effectiveRequireApproval is const, so we shadow it below.
    }
    if (impactClassification.level === "medium") {
      console.log(`[coordinator] impact.classification: MEDIUM — enabling strict verification`);
      active.gatedContext = mergeGatedContext(active.gatedContext, { strictVerification: true });
    }

    // Re-derive effectiveRequireApproval to include impact classification
    const finalRequireApproval = effectiveRequireApproval || impactClassification.level === "high";
    if (impactClassification.level === "high" && !effectiveRequireApproval) {
      recordDecision(run, {
        description: `Impact classification HIGH — approval enforced: ${impactClassification.reasons.join("; ")}`,
        madeBy: "impact-classifier",
        taskId: null,
        alternatives: ["Proceed without approval"],
        rationale: impactClassification.reasons.join(", "),
      });
    }

    try {
      // Phase 4: Build TaskGraph
      console.log(`[coordinator] PHASE 4: BuildTaskGraph — entering`);
      advancePhase(run, "planning");
      this.buildTaskGraph(active, analysis);
      const summaryAfterBuild = getGraphSummary(active.graph);
      console.log(`[coordinator] PHASE 4 done — graph summary: ${JSON.stringify(summaryAfterBuild)}`);
      console.log(`[coordinator] PHASE 4 done — graph has ${active.graph.nodes.length} node(s): ${active.graph.nodes.map(n => `${n.workerType}(${n.id.slice(0, 6)}:${n.status})`).join(", ")}`);

      if (active.graph.nodes.length === 0) {
        console.error(`[coordinator] PHASE 4 FAIL — buildTaskGraph produced ZERO nodes. This is the early-exit bug. Graph state will be empty so executeGraph will exit immediately and verdict will fall through to "partial" via hasFailedNodes/empty fallthrough.`);
      }

      this.emit({
        type: "task_graph_built",
        payload: { runId: active.run.id, summary: summaryAfterBuild },
      });
      await this.persistReceiptCheckpoint(active, {
        at: new Date().toISOString(),
        type: "planner_finished",
        status: "EXECUTING_IN_WORKSPACE",
        phase: run.phase,
        summary: `Planner built ${active.graph.nodes.length} task node(s)`,
        details: { graphSummary: summaryAfterBuild },
      });
      this.refreshImplementationBrief(active, "post-plan");

      // Phase 5: Pre-Build Coherence
      console.log(`[coordinator] PHASE 5: Pre-Build Coherence — entering`);
      advancePhase(run, "scouting");
      await this.runPreBuildCoherence(active);
      console.log(`[coordinator] PHASE 5 done — coherence passed`);

      // ── Baseline Test Snapshot ────────────────────────────────────
      // Capture test results BEFORE execution so we can distinguish
      // pre-existing failures from new regressions after the Builder runs.
      const verifier = this.verificationPipelineFor(active);
      let testBaseline: import("./verification-pipeline.js").TestBaseline | null = null;
      try {
        testBaseline = await verifier.captureBaseline(charterTargets);
        if (testBaseline) {
          console.log(
            `[coordinator] verification.baseline: ${testBaseline.totalTests} test(s), ${testBaseline.failedTests} failing`,
          );
          await this.persistReceiptCheckpoint(active, {
            at: new Date().toISOString(),
            type: "worker_step",
            status: "EXECUTING_IN_WORKSPACE",
            phase: run.phase,
            summary: `verification.baseline: ${testBaseline.totalTests} tests, ${testBaseline.failedTests} failing`,
            details: {
              totalTests: testBaseline.totalTests,
              failedTests: testBaseline.failedTests,
              failingTestNames: testBaseline.failingTestNames,
            },
          });
        } else {
          console.log(`[coordinator] verification.baseline: no test hooks configured — skipping`);
        }
      } catch (err) {
        console.warn(
          `[coordinator] verification.baseline failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // Phase 6–7: Execute (Scout → Build → Rehearsal Loop)
      console.log(`[coordinator] PHASE 6: ExecuteGraph — entering with ${active.graph.nodes.length} node(s)`);
      await this.executeGraph(active);
      // Reconcile wave.status from the now-terminal node statuses so
      // downstream waves whose upstream failed end up "halted" rather
      // than dangling at "pending", and so finalReceipt.summary.waveSummary
      // shows an accurate per-wave outcome.
      this.reconcileWaveStatuses(active);
      console.log(`[coordinator] PHASE 6 done — graph state: ${JSON.stringify(getGraphSummary(active.graph))}`);
      console.log(`[coordinator] PHASE 6 trace — builder nodes processed: ${active.graph.nodes.filter(n => n.workerType === 'builder').length}`);

      // ── Velum Output Guard ──────────────────────────────────────
      // Scan builder output diffs for security issues before Critic.
      if (active.changes.length > 0 && !active.cancelled) {
        const combinedDiff = active.changes
          .map((c) => c.diff ?? (c.content ? `+++ ${c.path}\n${c.content.split("\n").map((l) => `+${l}`).join("\n")}` : ""))
          .filter(Boolean)
          .join("\n");
        const velumOutput = velumScanDiff(combinedDiff);
        console.log(`[coordinator] velum.output.scan: decision=${velumOutput.decision} flags=[${velumOutput.flags.join(", ")}]`);
        await this.persistReceiptCheckpoint(active, {
          at: new Date().toISOString(),
          type: "worker_step",
          status: "EXECUTING_IN_WORKSPACE",
          phase: run.phase,
          summary: `velum.output.scan: ${velumOutput.decision}`,
          details: { decision: velumOutput.decision, reasons: velumOutput.reasons, flags: velumOutput.flags },
        });
        if (velumOutput.decision === "block") {
          const blockMsg = `Velum output guard blocked: ${velumOutput.reasons.join("; ")}`;
          console.error(`[coordinator] ${blockMsg}`);
          failRun(run, blockMsg);
          this.emit({ type: "merge_blocked", payload: { runId: active.run.id, blockers: [blockMsg] } });
          return this.buildReceipt(active, null, null, null, Date.now() - startTime, null, null, "failed");
        }
        if (velumOutput.decision === "review") {
          console.log(`[coordinator] velum.output.scan: review required`);
          recordDecision(run, {
            description: `Velum output guard flagged for review: ${velumOutput.reasons.join("; ")}`,
            madeBy: "velum",
            taskId: null,
            alternatives: ["Block execution", "Allow execution"],
            rationale: velumOutput.flags.join(", "),
          });
        }
        if (velumOutput.decision === "warn") {
          console.warn(`[coordinator] velum.output.scan: warnings: ${velumOutput.reasons.join("; ")}`);
          recordDecision(run, {
            description: `Velum output guard warning: ${velumOutput.reasons.join("; ")}`,
            madeBy: "velum",
            taskId: null,
            alternatives: [],
            rationale: velumOutput.flags.join(", "),
          });
        }
      }

      // Phase 7: Per-wave verification (multi-file only).
      //
      // Runs the VerificationPipeline once per wave of the plan,
      // filtered to that wave's files. Failures here surface as
      // critical merge-gate findings downstream, attributed to the
      // wave that produced them. Skipped for single-file runs (no
      // plan) and for runs with failed nodes (recovery path owns the
      // retry loop).
      if (
        active.plan &&
        active.plan.waves.length > 0 &&
        !active.cancelled &&
        !hasFailedNodes(active.graph)
      ) {
        console.log(`[coordinator] PHASE 7: PerWaveVerification — ${active.plan.waves.length} wave(s)`);
        await this.verifyCompletedWaves(active);
        console.log(`[coordinator] PHASE 7 done — ${active.waveVerifications.length} wave receipt(s) collected`);
      } else {
        console.log(`[coordinator] PHASE 7 SKIPPED — plan=${!!active.plan} cancelled=${active.cancelled} failedNodes=${hasFailedNodes(active.graph)}`);
      }

      // Phase 8: Post-Build IntegrationJudge
      if (!active.cancelled && !hasFailedNodes(active.graph)) {
        console.log(`[coordinator] PHASE 8: IntegrationJudge — entering`);
        this.emit({ type: "integration_check", payload: { runId: active.run.id, phase: "post-build" } });
        judgmentReport = active.judge.judge(
          active.intent,
          run,
          active.changes,
          active.workerResults,
          "pre-apply",
          active.changeSet,
        );
        recordCoherenceCheck(run, {
          phase: "post-build",
          passed: judgmentReport.passed,
          checks: judgmentReport.checks.map((c) => ({
            name: c.name,
            passed: c.passed,
            message: c.details,
          })),
        });
        console.log(`[coordinator] PHASE 8 done — judgment passed=${judgmentReport.passed}`);

        if (!judgmentReport.passed) {
          this.emit({
            type: "merge_blocked",
            payload: { runId: active.run.id, blockers: judgmentReport.blockers },
          });
        }
      } else {
        console.log(`[coordinator] PHASE 8 SKIPPED — cancelled=${active.cancelled} hasFailedNodes=${hasFailedNodes(active.graph)}`);
      }

      // Phase 9: Verification Pipeline
      //
      // Unlike the previous advisory gate, Phase 9 now ALWAYS runs when
      // the judge passed — and for multi-file plans it runs the
      // change-set-level verification, not a loose bag of FileChange
      // records. The resulting receipt is the primary verification
      // signal for the MergeGate below. Per-wave verification has
      // already happened inside executeGraph (see verifyCompletedWaves).
      if (judgmentReport?.passed && !active.cancelled) {
        const isMultiFile = active.changeSet.filesInScope.length > 1;
        const phase9Verifier = this.verificationPipelineFor(active);

        // ── Preflight integration check ──────────────────────────────
        // Lightweight check: imports/exports exist, basic type alignment.
        // If this fails, skip expensive full verification and fail early.
        const preflight = active.judge.preflight(active.changes);
        console.log(
          `[coordinator] PHASE 9 preflight: passed=${preflight.passed} (${preflight.durationMs}ms)` +
          (preflight.issues.length > 0 ? ` issues: ${preflight.issues.join("; ")}` : ""),
        );
        if (!preflight.passed) {
          console.error(`[coordinator] PHASE 9 preflight FAILED — skipping full verification`);
          // Synthesize a failing verification receipt from the preflight
          verificationReceipt = {
            id: randomUUID(),
            runId: active.run.id,
            intentId: active.intent.id,
            timestamp: new Date().toISOString(),
            verdict: "fail",
            confidenceScore: 0,
            stages: [{
              stage: "cross-file-check",
              name: "Integration Preflight",
              passed: false,
              score: 0,
              issues: preflight.issues.map((msg) => ({
                stage: "cross-file-check" as const,
                severity: "blocker" as const,
                message: msg,
              })),
              durationMs: preflight.durationMs,
              details: `Preflight failed: ${preflight.issues.join("; ")}`,
            }],
            judgmentReport: null,
            allIssues: preflight.issues.map((msg) => ({
              stage: "cross-file-check" as const,
              severity: "blocker" as const,
              message: msg,
            })),
            blockers: preflight.issues.map((msg) => ({
              stage: "cross-file-check" as const,
              severity: "blocker" as const,
              message: msg,
            })),
            requiredChecks: [],
            checks: [],
            summary: `PREFLIGHT FAIL — ${preflight.issues.join("; ")}`,
            totalDurationMs: preflight.durationMs,
            fileCoverage: null,
            coverageRatio: null,
            validatedRatio: null,
          };
        } else {
          console.log(
            `[coordinator] PHASE 9: Verification — entering (${isMultiFile ? "change-set" : "single-file"} scope)`,
          );
          verificationReceipt = isMultiFile
            ? await phase9Verifier.verifyChangeSet(
                active.intent,
                run,
                active.changeSet,
                active.changes,
                active.workerResults,
                testBaseline,
              )
            : await phase9Verifier.verify(
                active.intent,
                run,
                active.changes,
                active.workerResults,
                null,
                testBaseline,
              );
        }
        console.log(`[coordinator] PHASE 9 done — verdict=${verificationReceipt.verdict} summary=${verificationReceipt.summary}`);
        await this.persistReceiptCheckpoint(active, {
          at: new Date().toISOString(),
          type: "verification_result",
          status: "EXECUTING_IN_WORKSPACE",
          phase: run.phase,
          summary: verificationReceipt.summary,
          details: { verdict: verificationReceipt.verdict },
        }, {
          verificationResults: {
            final: verificationReceipt,
            waves: [...active.waveVerifications],
          },
        });
      } else {
        console.log(`[coordinator] PHASE 9 SKIPPED — judgmentReport=${judgmentReport ? `passed=${judgmentReport.passed}` : "null"} cancelled=${active.cancelled}`);
      }

      // Phase 9b: change-set gate (invariants + repair-audit) — only
      // meaningful for multi-file runs. Output is fed into the
      // MergeGate alongside judgment and verification. The repair-audit
      // pass is audit-only — its findings are advisory, never blocking.
      let changeSetGateInput:
        | Parameters<typeof decideMerge>[0]["changeSetGate"]
        | undefined;

      if (active.changeSet.filesInScope.length > 1) {
        const invariants = active.changeSet.invariants.length > 0
          ? [...active.changeSet.invariants]
          : await extractInvariants(
              active.changeSet.filesInScope.map((entry) => entry.path),
              active.projectRoot,
            );
        repairAudit = await runRepairAuditPass(active.changeSet, active.projectRoot);

        const allWavesComplete = isGraphComplete(active.graph) && !hasFailedNodes(active.graph);
        const invariantsSatisfied =
          active.changeSet.coherenceVerdict.coherent;

        changeSetGateInput = {
          changeSet: active.changeSet,
          allWavesComplete,
          invariantsSatisfied,
          invariantCount: invariants.length,
          repairAudit,
        };
      }

      // Phase 9d: GitDiffVerifier — reconcile manifest vs on-disk truth
      // before the merge gate. This catches files that were declared but
      // never changed, and files that changed but were never declared.
      // The result feeds into merge-gate findings and confidence scoring.
      let gitDiffResult: GitDiffResult | null = null;
      if (!active.cancelled && active.changes.length > 0) {
        try {
          const manifestFiles = active.changeSet.filesInScope.map((f) => f.path);
          const expectedFiles = active.changeSet.filesInScope
            .filter((f) => f.mutationExpected)
            .map((f) => f.path);
          const nonMutatingFiles = active.changeSet.filesInScope
            .filter((f) => !f.mutationExpected)
            .map((f) => f.path);
          const createdFiles = active.changes
            .filter((c) => c.operation === "create")
            .map((c) => c.path);
          gitDiffResult = await verifyGitDiff({
            projectRoot: active.projectRoot,
            manifestFiles,
            expectedFiles,
            nonMutatingFiles,
            createdFiles,
          });
          active.gitDiffResult = gitDiffResult;
          console.log(
            `[coordinator] PHASE 9d: GitDiffVerifier — ${gitDiffResult.summary} ` +
            `(ratio=${gitDiffResult.confirmationRatio.toFixed(2)} passed=${gitDiffResult.passed})`,
          );
        } catch (err) {
          // Git diff failure is a signal-quality issue — we couldn't verify
          // on-disk truth. Log it as a warning and create a synthetic failed
          // result so the merge gate knows verification couldn't confirm truth.
          const errMsg = err instanceof Error ? err.message : String(err);
          console.warn(`[coordinator] PHASE 9d: GitDiffVerifier failed: ${errMsg}`);
          gitDiffResult = {
            actualChangedFiles: [],
            expectedButUnchanged: [],
            undeclaredChanges: [],
            unexpectedReferenceChanges: [],
            confirmed: [],
            passed: false,
            confirmationRatio: 0,
            summary: `git diff verification failed: ${errMsg}`,
            rawDiffStat: "",
          };
          active.gitDiffResult = gitDiffResult;
        }
      }

      // Phase 9c: MergeGate — the single source of truth for "can we
      // apply / commit". Replaces the old advisory behaviour where
      // merge_blocked was emitted and the commit happened anyway.
      const baseDecision = decideMerge({
        judgment: judgmentReport,
        verification: verificationReceipt,
        changeSetGate: changeSetGateInput,
        cancelled: active.cancelled,
        hasFailedNodes: hasFailedNodes(active.graph),
      });
      // Inject per-wave failures as critical findings — they come
      // from Phase 7 and are already emitted as merge_blocked events,
      // but the gate decision needs them so `action` becomes "block"
      // and the commit is prevented.
      const waveFailures = this.waveFailureFindings(active);
      // Inject git diff findings — undeclared changes and missing manifest
      // files are critical because they indicate the on-disk state diverged
      // from what was declared.
      const gitDiffFindings = this.gitDiffFindings(gitDiffResult);
      // Bugfix must-modify rule — fires only when the user request
      // looks bugfix-shaped AND no non-test source files were
      // actually modified. Feature / refactor tasks are unaffected.
      const bugfixFindings = this.bugfixTargetFindings(
        active.intent.userRequest,
        gitDiffResult,
      );
      // Tripwire: user-named targets that were dropped from deliverables
      // before the graph was built. Should never fire after the Phase 4.5
      // fix; kept as a defense-in-depth net for future regressions.
      const userTargetFindings = this.userTargetFindings(active);
      const extraFindings = [...waveFailures, ...gitDiffFindings, ...bugfixFindings, ...userTargetFindings];
      const mergeDecision: MergeDecision =
        extraFindings.length === 0
          ? baseDecision
          : this.mergeInFindings(baseDecision, extraFindings);
      this.logMergeDecision(mergeDecision);
      this.recordMergeDecision(active, mergeDecision);

      if (mergeDecision.action === "block") {
        this.emit({
          type: "merge_blocked",
          payload: {
            runId: active.run.id,
            reason: mergeDecision.primaryBlockReason,
            summary: mergeDecision.summary,
            findings: mergeDecision.findings,
            critical: mergeDecision.critical,
            advisory: mergeDecision.advisory,
            groups: groupFindingsBySource(mergeDecision.findings),
          },
        });
        // Roll back on-disk changes the builder already wrote so the
        // repo is left in the state the user started with. This is the
        // difference between an advisory gate (commit anyway) and a
        // blocking gate (fail safely).
        await this.rollbackChanges(active, mergeDecision);
        await this.persistReceiptCheckpoint(active, {
          at: new Date().toISOString(),
          type: "failure_occurred",
          status: "VERIFIED_FAIL",
          phase: run.phase,
          summary: mergeDecision.primaryBlockReason,
          details: { summary: mergeDecision.summary },
        }, {
          appendErrors: [mergeDecision.primaryBlockReason],
        });
      } else {
        this.emit({
          type: "merge_approved",
          payload: {
            runId: active.run.id,
            summary: mergeDecision.summary,
            advisory: mergeDecision.advisory,
            groups: groupFindingsBySource(mergeDecision.findings),
          },
        });
      }

      const verdict = this.determineVerdict(
        active,
        verificationReceipt,
        judgmentReport,
        mergeDecision,
      );
      const totalCost = active.run.totalCost?.estimatedCostUsd ?? 0;

      // ── Phase B (local_then_cloud) — record primary candidate, run
      // shadow if primary disqualified, select best. SAFETY: this runs
      // BEFORE canCommit / approval branches, but does not modify
      // mergeDecision, verificationReceipt, or workspace contents.
      // The selection is observability-only in Phase B — even if a
      // shadow wins, today's pipeline still routes the primary
      // workspace to approval (no swap). Shadow's content reaching
      // promote is Phase C and explicitly out of scope here.
      this.recordPrimaryCandidate(active, {
        mergeDecision,
        verificationReceipt,
        lane: active.laneConfig.primary.lane,
        provider: active.laneConfig.primary.provider,
        model: active.laneConfig.primary.model,
      });
      try {
        await this.maybeRunFallbackShadow(active);
      } catch (err) {
        // Shadow lane errors must not break the primary's outcome —
        // log and continue. The primary candidate is already recorded.
        console.warn(
          `[coordinator] local_then_cloud shadow lane threw (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // Phase 10: Commit
      const changeCount = Math.max(active.changes.length, active.run.filesTouched.length);
      const canCommit =
        this.config.autoCommit &&
        !active.cancelled &&
        changeCount > 0 &&
        mergeDecision.action === "apply";

      // Approval gate: if requireApproval is true, pause instead of auto-committing.
      // Also pause when auto-promote is disabled: the workspace commit would
      // otherwise become a confusing VERIFICATION_PENDING terminal run with
      // no pending approval and no path for the user to accept/reject it.
      // The run transitions to "awaiting_approval" — a first-class, explicit state.
      // The run is NOT complete, NOT partial, NOT failed. It is paused.
      const shouldPauseForApproval = finalRequireApproval || !this.config.autoPromoteOnSuccess;
      if (canCommit && shouldPauseForApproval) {
        console.log(`[coordinator] PHASE 10: APPROVAL REQUIRED — ${changeCount} change(s) ready. Pausing for external approval.`);
        advancePhase(run, "awaiting_approval");
        this.emit({ type: "system_event", payload: { runId: active.run.id, event: "approval_required", changeCount } });
        recordDecision(active.run, {
          description: `Commit paused — ${finalRequireApproval ? "approval required" : "auto-promote disabled"}. ${changeCount} files ready to commit.`,
          madeBy: "coordinator",
          taskId: null,
          alternatives: ["Approve and commit", "Reject and rollback"],
          rationale: "DOCTRINE: user approves final apply",
        });
        // Store the active run for later approval via approveRun()
        // Stamp the moment the run entered AWAITING_APPROVAL so the
        // optional approval-timeout sweeper (rejectExpiredApprovals)
        // can age it. Set HERE instead of at construction so a long
        // build doesn't count toward the approval-pending clock.
        active.awaitingApprovalSinceMs = Date.now();
        this.pendingApproval.set(run.id, active);
        // Build the awaiting-approval receipt FIRST so we can persist it
        // into finalReceipt below. Run ffe132ed/4b3ec065 surfaced the bug:
        // without finalReceipt being populated at this gate, approveRun
        // had no shape to merge the post-commit patchArtifact + commitSha
        // into, and promoteToSource later failed with "No commit SHA —
        // nothing to promote" even though the workspace commit existed.
        // verdict is "partial" because the run is not yet complete — the
        // phase "awaiting_approval" is what the UI must show distinctly.
        const durationMs = Date.now() - new Date(active.run.startedAt).getTime();
        const awaitReceipt = this.buildReceipt(active, verificationReceipt, judgmentReport, null, durationMs, mergeDecision, null, "partial");
        // Patch receipt — run is paused awaiting approval (NOT "RUNNING" — truthful).
        // Persist the full awaitReceipt into finalReceipt so approveRun can
        // graft commit/diff data into it before workspace cleanup.
        // AWAITED (not void) so the AWAITING_APPROVAL state is observable
        // immediately after submit() returns — without this, callers polling
        // /tasks/:id right after the response see stale EXECUTING_IN_WORKSPACE
        // status until the fire-and-forget patch lands. Cost is one JSON
        // file write; consistent with persistFinalReceipt being awaited
        // at the auto-promote terminal a few lines later.
        await this.receiptStore.patchRun(run.id, {
          status: "AWAITING_APPROVAL",
          taskSummary: `Awaiting approval — ${changeCount} change(s) ready to commit`,
          finalReceipt: awaitReceipt,
        });
        return awaitReceipt;
      }

      if (canCommit) {
        console.log(`[coordinator] PHASE 10: committing ${changeCount} change(s) (active.changes=${active.changes.length}, filesTouched=${active.run.filesTouched.length}) in ${active.projectRoot}...`);
        commitSha = await this.gitCommit(active);
        if (commitSha) {
          console.log(`[coordinator] PHASE 10 done — commit ${commitSha.slice(0, 8)} created`);
          this.emit({ type: "commit_created", payload: { runId: active.run.id, sha: commitSha } });
        } else {
          // Merge gate approved but commit failed — explicit commit_failed
          // terminal state. Roll back on-disk changes to leave the repo clean.
          console.error(`[coordinator] PHASE 10 FAILED — gitCommit returned null. Rolling back builder changes.`);
          await this.rollbackChanges(active, mergeDecision);
          run.failureReason = "Merge gate approved but git commit failed — changes rolled back";
          advancePhase(run, "commit_failed");
        }
      } else if (this.config.autoCommit && !active.cancelled) {
        console.log(`[coordinator] PHASE 10 SKIPPED — no changes to commit (active.changes=0, filesTouched=0)`);
      } else {
        console.log(`[coordinator] PHASE 10 SKIPPED — autoCommit=${this.config.autoCommit} cancelled=${active.cancelled} changeCount=${changeCount}`);
      }

      if (repairAudit) {
        // Audit-only: log the finding count without any "applied" claim.
        // The previous repair-pass log line said "X attempted, 0 applied"
        // which read as "we tried but failed to repair" — misleading,
        // since the pass never attempts repairs at all.
        console.log(
          `[coordinator] repair-audit: ${repairAudit.findingsCount} finding(s) — audit-only, no repairs attempted`
        );
      }

      if (process.env.AEDIS_VISION === "true") {
        try {
          const visionResult = await captureAndAnalyze(
            "http://localhost:18796",
            "describe the current run status and any visible errors",
          );
          if (visionResult.skipped) {
            // Distinct log line so operators can tell "vision is opt-in
            // and not configured" apart from "vision tried and threw."
            // Pre-fix this log line was indistinguishable from a real
            // failure — qwen3-vl:8b kept showing up in journals as a
            // failure even though it was an unconfigured default.
            console.warn(`[coordinator] vision check skipped: ${visionResult.reason}`);
          } else {
            console.log(
              `[coordinator] vision check (${visionResult.model}): ${(visionResult.analysis ?? "").slice(0, 200)}`,
            );
          }
        } catch (err) {
          const visionMessage = err instanceof Error ? err.message : String(err);
          console.warn(
            `[coordinator] vision check failed: ${visionMessage.slice(0, 200)}`
          );
        }
      }

      // Execution Truth Enforcement v1 — the single authority on
      // whether this run actually produced real, verifiable work.
      // Runs AFTER every other gate so it sees the final state of
      // changes / commitSha / verification, and its decision can
      // override the verdict: a "success" from determineVerdict that
      // produces zero evidence is forced to "failed" here.
      const executionDecision = evaluateExecutionGate({
        runId: active.run.id,
        projectRoot: active.projectRoot,
        workerResults: active.workerResults,
        changes: active.changes,
        commitSha,
        verificationReceipt,
        graphNodeCount: active.graph.nodes.length,
        cancelled: active.cancelled,
        thrownError: null,
      });
      this.logExecutionDecision(executionDecision);

      const verdictAfterGate: RunReceipt["verdict"] =
        !executionDecision.executionVerified && (verdict === "success" || verdict === "partial")
          ? "failed"
          : verdict;

      // ── Patch artifact generation ─────────────────────────────────
      // On success/partial, generate a promotion-ready patch from the
      // workspace. On failure, still try to capture the diff for debugging.
      if (active.workspace) {
        try {
          active.patchArtifact = await generatePatch(active.workspace);
          console.log(
            `[coordinator] patch artifact: ${active.patchArtifact.changedFiles.length} file(s), ` +
            `${active.patchArtifact.diff.length} bytes, commit=${active.patchArtifact.commitSha?.slice(0, 8) ?? "none"}`,
          );
          // Save patch to workspace receipts directory
          await saveWorkspaceReceipt(
            active.workspace,
            `patch-${run.id.slice(0, 8)}.diff`,
            active.patchArtifact.diff,
          );
        } catch (err) {
          console.warn(
            `[coordinator] patch generation failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // Finalize
      console.log(`[coordinator] FINALIZE — verdict=${verdictAfterGate} (pre-gate=${verdict} executionVerified=${executionDecision.executionVerified} cancelled=${active.cancelled} phase=${run.phase} hasFailedNodes=${hasFailedNodes(active.graph)} workerResults=${active.workerResults.length})`);

      if (!isTerminalPhase(run.phase)) {
        if (verdictAfterGate === "success" || verdictAfterGate === "partial") {
          advancePhase(run, "complete");
        } else {
          failRun(
            run,
            !executionDecision.executionVerified
              ? executionDecision.reason
              : "Build did not pass all checks",
          );
        }
      } else if (!run.failureReason && verdictAfterGate !== "success" && verdictAfterGate !== "partial") {
        run.failureReason = !executionDecision.executionVerified
          ? executionDecision.reason
          : "Build did not pass all checks";
      }

      const receipt = this.buildReceipt(
        active,
        verificationReceipt,
        judgmentReport,
        commitSha,
        Date.now() - startTime,
        mergeDecision,
        executionDecision,
        verdictAfterGate,
      );
      active.memorySuggestions = await this.persistMemoryArtifacts(
        active,
        input,
        normalizedInput,
        receipt,
        verificationReceipt,
        mergeDecision,
        repairAudit,
        commitSha,
      );
      const finalReceipt: RunReceipt = active.memorySuggestions.length > 0
        ? { ...receipt, memorySuggestions: [...active.memorySuggestions] }
        : receipt;
      await this.persistFinalReceipt(active, finalReceipt);

      // Emit execution_verified / execution_failed BEFORE run_complete
      // so the UI can render real state before any "complete" flourish.
      this.emitExecutionEvent(run.id, executionDecision);

      // Emit the human-readable run summary. Always fires, on
      // every terminal path, so Lumen has a single event to bind
      // to for "here is the plain-English story of this run."
      this.emitRunSummary(run.id, finalReceipt);

      // ─── Post-run Crucibulum evaluation (non-blocking) ────────
      // Runs after the receipt is built so evaluation failures
      // never corrupt the Aedis run. Results are attached to the
      // receipt and persisted separately.
      let evaluatedReceipt = finalReceipt;
      if (this.evaluator.shouldEvaluate(verdictAfterGate)) {
        try {
          console.log(`[coordinator] POST-RUN EVALUATION — triggering Crucibulum for run ${run.id}`);
          this.emit({ type: "evaluation_started", payload: { runId: active.run.id } });
          const evalInput: EvaluationInput = {
            runId: active.run.id,
            verdict: verdictAfterGate,
            aedisConfidence: finalReceipt.humanSummary?.confidence?.overall ?? 0.5,
            scopeType: active.scopeClassification?.type ?? "unknown",
            filesChanged: active.changes.map((c) => c.path),
            commitSha,
            taskSummary: active.intent.charter.objective,
          };
          const evaluation = await this.evaluator.evaluate(evalInput);
          evaluatedReceipt = {
            ...finalReceipt,
            evaluation,
          };
          evaluatedReceipt = {
            ...evaluatedReceipt,
            humanSummary: this.composeHumanSummary(active, evaluatedReceipt),
          };
          await this.persistFinalReceipt(active, evaluatedReceipt);
          console.log(`[coordinator] POST-RUN EVALUATION — ${evaluation.completed ? "completed" : "incomplete"}: ${evaluation.aggregate?.summary ?? evaluation.reason}`);
          if (evaluation.disagreement?.escalate) {
            console.log(`[coordinator] EVALUATION DISAGREEMENT — ${evaluation.disagreement.summary}`);
          }
          this.emit({ type: "evaluation_complete", payload: { runId: active.run.id, evaluation } });
        } catch (evalErr) {
          console.log(`[coordinator] POST-RUN EVALUATION FAILED (non-fatal): ${evalErr}`);
          this.emit({ type: "evaluation_failed", payload: { runId: active.run.id, error: String(evalErr) } });
        }
      }

      console.log(`[coordinator] ═══ submit() exit — verdict=${verdictAfterGate} duration=${Date.now() - startTime}ms`);
      this.emit({ type: "run_complete", payload: { runId: active.run.id, verdict: verdictAfterGate, executionVerified: executionDecision.executionVerified, executionReason: executionDecision.reason, classification: evaluatedReceipt.humanSummary?.classification ?? null } });
      this.emit({ type: "run_receipt", payload: { runId: active.run.id, receiptId: evaluatedReceipt.id, receipt: evaluatedReceipt } });
      // Notify trust dashboard consumers that trust data has changed.
      this.emit({ type: "trust_updated", payload: { runId: active.run.id, confidence: evaluatedReceipt.humanSummary?.confidence?.overall ?? 0, verdict: verdictAfterGate } });

      // Trust regression detection: check if recent runs show degrading
      // trust signals. Fires a trust_regression event and attaches the
      // alert snapshot to the receipt so UIs can render a durable
      // banner even after reloads.
      const regressionAlert = await this.detectTrustRegression(active, evaluatedReceipt);
      if (regressionAlert) {
        const alertedSummary = this.composeHumanSummary(active, evaluatedReceipt, undefined, regressionAlert);
        evaluatedReceipt = { ...evaluatedReceipt, humanSummary: alertedSummary };
        await this.persistFinalReceipt(active, evaluatedReceipt);
        this.emit({ type: "run_receipt", payload: { runId: active.run.id, receiptId: evaluatedReceipt.id, receipt: evaluatedReceipt } });
      }

      // Auto-promote on VERIFIED_SUCCESS when operator has opted in.
      // Only fires for the cleanest classification and only when a
      // regression alert didn't downgrade us. Promotion failures are
      // logged as warnings — they don't retroactively flip the run's
      // classification (the workspace commit still exists and can be
      // promoted manually via the promote endpoint).
      const classification = evaluatedReceipt.humanSummary?.classification ?? null;
      const sourceRepo = active.workspace?.sourceRepo ?? active.sourceRepo ?? null;
      // Trust regression blocks auto-promote for VERIFIED_SUCCESS (high-bar
      // classification) but NOT for PARTIAL_SUCCESS+verified — the execution
      // gate already proved the code landed. Blocking verified partial
      // successes was causing false-positive orphaned commits.
      const regressionBlocksPromote = regressionAlert !== null && classification !== "PARTIAL_SUCCESS";
      const shouldAutoPromote =
        this.config.autoPromoteOnSuccess &&
        !regressionBlocksPromote &&
        sourceRepo &&
        (classification === "VERIFIED_SUCCESS" ||
          (classification === "PARTIAL_SUCCESS" && executionDecision.executionVerified));
      if (shouldAutoPromote) {
        const reason = classification === "VERIFIED_SUCCESS"
          ? "VERIFIED_SUCCESS"
          : "PARTIAL_SUCCESS+verified";
        const regressionNote = regressionAlert ? " (regression alert present but overridden — execution verified)" : "";
        console.log(`[coordinator] autoPromoteOnSuccess=true + ${reason}${regressionNote} → promoting run ${active.run.id} to ${sourceRepo}`);
        try {
          const promoteResult = await this.promoteToSource(active.run.id, sourceRepo);
          if (promoteResult.ok) {
            console.log(`[coordinator] auto-promoted run ${active.run.id} → ${promoteResult.commitSha}`);
          } else {
            console.warn(`[coordinator] auto-promote failed (workspace commit still valid, promote manually): ${promoteResult.error}`);
          }
        } catch (err) {
          console.warn(`[coordinator] auto-promote threw (workspace commit still valid): ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      return evaluatedReceipt;
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err);
      const errStack = err instanceof Error ? err.stack : undefined;
      console.error(`[coordinator] ═══ submit() CAUGHT EXCEPTION — ${errMessage}`);
      if (errStack) {
        console.error(`[coordinator] stack trace:\n${errStack}`);
      }
      console.error(`[coordinator]   run.phase at catch:        ${active.run.phase}`);
      console.error(`[coordinator]   graph.nodes at catch:      ${active.graph.nodes.length}`);
      console.error(`[coordinator]   graph.nodes statuses:      ${active.graph.nodes.map(n => `${n.workerType}=${n.status}`).join(", ") || "(none)"}`);
      console.error(`[coordinator]   active.changes at catch:   ${active.changes.length}`);
      console.error(`[coordinator]   active.workerResults:      ${active.workerResults.length}`);
      console.error(`[coordinator]   intent.deliverables:       ${active.intent.charter.deliverables.length}`);
      console.error(`[coordinator]   active.projectRoot:        ${active.projectRoot}`);
      console.error(`[coordinator]   duration before failure:   ${Date.now() - startTime}ms`);

      if (!isTerminalPhase(run.phase)) {
        failRun(run, errMessage);
      } else if (!run.failureReason) {
        run.failureReason = errMessage;
      }

      // Execution gate on the exception path — a thrown error is
      // always an "errored" verdict and can never flip to success.
      // The gate still collects whatever evidence exists (partial
      // file writes, etc.) so the receipt tells the truth about
      // what got done before the failure.
      const executionDecision = evaluateExecutionGate({
        runId: active.run.id,
        projectRoot: active.projectRoot,
        workerResults: active.workerResults,
        changes: active.changes,
        commitSha: null,
        verificationReceipt,
        graphNodeCount: active.graph.nodes.length,
        cancelled: active.cancelled,
        thrownError: err instanceof Error ? err : new Error(errMessage),
      });
      this.logExecutionDecision(executionDecision);

      if (!active.implementationBrief) {
        active.implementationBrief = buildMinimalImplementationBrief({
          intent: active.intent,
          rawUserPrompt: active.rawUserPrompt,
          normalizedPrompt: active.normalizedInput,
          error: errMessage,
          analysis: active.analysis,
          charter: active.intent.charter,
          scope: active.scopeClassification,
          dispatchableFiles: active.changeSet.filesInScope.map((entry) => entry.path),
          rejectedCandidates: active.rejectedCandidates,
        });
        await this.receiptStore.patchRun(active.run.id, {
          implementationBrief: briefToReceiptJson(active.implementationBrief),
        });
      }

      const receipt = this.buildReceipt(
        active,
        verificationReceipt,
        judgmentReport,
        null,
        Date.now() - startTime,
        null,
        executionDecision,
        "failed",
      );
      active.memorySuggestions = await this.persistMemoryArtifacts(
        active,
        input,
        normalizedInput,
        receipt,
        verificationReceipt,
        null,
        repairAudit,
        null,
      );
      const finalReceipt: RunReceipt = active.memorySuggestions.length > 0
        ? { ...receipt, memorySuggestions: [...active.memorySuggestions] }
        : receipt;
      await this.persistFinalReceipt(active, finalReceipt);

      this.emitExecutionEvent(run.id, executionDecision);
      this.emitRunSummary(run.id, finalReceipt);
      console.log(`[coordinator] ═══ submit() exit (failed) — verdict=${receipt.verdict} duration=${Date.now() - startTime}ms`);
      this.emit({ type: "run_complete", payload: { runId: active.run.id, verdict: "failed", executionVerified: false, executionReason: executionDecision.reason, error: errMessage, classification: finalReceipt.humanSummary?.classification ?? null } });
      this.emit({ type: "run_receipt", payload: { runId: active.run.id, receiptId: finalReceipt.id, receipt: finalReceipt } });
      this.emit({ type: "trust_updated", payload: { runId: active.run.id, confidence: 0, verdict: "failed" } });
      return finalReceipt;
    } finally {
      // ── Workspace cleanup ───────────────────────────────────────
      // Clean up the workspace ONLY when the run is terminal (not
      // awaiting approval). When requireApproval pauses the run,
      // the workspace must survive until approveRun/rejectRun
      // processes it — they call gitCommit/rollbackChanges which
      // need the workspace to exist.
      const isAwaitingApproval = run.phase === "awaiting_approval";
      if (active.workspace && !isAwaitingApproval) {
        const cleanup = await discardWorkspace(active.workspace);
        active.workspaceCleanup = cleanup;
        if (!cleanup.success) {
          console.error(
            `[coordinator] CLEANUP_ERROR: workspace ${active.workspace.workspacePath} — ${cleanup.error}`,
          );
          void this.receiptStore.patchRun(run.id, {
            status: "CLEANUP_ERROR",
            appendErrors: [`Workspace cleanup failed: ${cleanup.error}`],
            // Leave workspace.cleanedUp=false so startup recovery can
            // retry the rm on next boot.
          });
        } else {
          console.log(
            `[coordinator] workspace cleaned up: method=${cleanup.method} (${cleanup.durationMs}ms)`,
          );
          // Mark the persisted workspace ref as cleanedUp so startup
          // recovery knows to skip this run's workspace. Awaited so
          // the receipt is fully up to date before the finally block
          // exits — tests and downstream consumers can rely on it.
          try {
            const persisted = await this.receiptStore.getRun(run.id);
            const finalReceipt = persisted?.finalReceipt
              ? { ...persisted.finalReceipt, workspaceCleanup: cleanup }
              : undefined;
            await this.receiptStore.patchRun(run.id, {
              ...(finalReceipt ? { finalReceipt } : {}),
              workspace: {
                workspacePath: active.workspace.workspacePath,
                sourceRepo: active.workspace.sourceRepo,
                sourceCommitSha: active.workspace.sourceCommitSha,
                method: active.workspace.method,
                createdAt: active.workspace.createdAt,
                worktreeBranch: active.workspace.worktreeBranch,
                cleanedUp: true,
              },
              appendCheckpoints: [
                {
                  at: new Date().toISOString(),
                  type: "run_completed",
                  status: persisted?.status ?? "EXECUTING_IN_WORKSPACE",
                  phase: active.run.phase,
                  summary: `workspace cleanup completed: ${cleanup.method}`,
                  details: {
                    workspacePath: active.workspace.workspacePath,
                    success: cleanup.success,
                    durationMs: cleanup.durationMs,
                  },
                },
              ],
            });
          } catch (err) {
            console.warn(
              `[coordinator] patch cleanedUp=true failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      } else if (isAwaitingApproval && active.workspace) {
        console.log(
          `[coordinator] workspace PRESERVED for approval: ${active.workspace.workspacePath}`,
        );
      }
      if (!isAwaitingApproval) {
        this.activeRuns.delete(run.id);
      }
    }
  }

  /**
   * Lightweight build cycle for session-coordinator.
   *
   * Runs the full pipeline (charter → intent → workspace → graph →
   * execute → verify → merge) on a single task intent string and
   * returns a normalized BuildResult.
   *
   * Unlike submit(), this does NOT go through submitWithGates — it is
   * called directly by the session coordinator which already has the
   * validated task intent from a prior session-scoped LLM call.
   *
   * @param taskIntent  The task description (e.g. "add error handling to
   *                    the parseFile function in utils.ts")
   * @param projectRoot The path to the project root for this session's
   *                    workspace (from SessionState.projectRoot)
   */
  async buildCycle(taskIntent: string, projectRoot: string): Promise<BuildResult> {
    try {
      const receipt = await this.submit({
        input: taskIntent,
        projectRoot,
        // No extraConstraints — session coordinator provides a clean intent
      });

      const verdict = receipt.verdict;
      const success = verdict === "success" || verdict === "partial";
      const touchedFiles = receipt.humanSummary?.whatChanged?.map((f) => f.path) ?? [];

      return {
        success,
        touchedFiles,
        verificationPassed:
          receipt.humanSummary?.verification === "pass" ||
          receipt.humanSummary?.verification === "pass-with-warnings",
        errorType: success ? undefined : verdict,
        errorMessage: success
          ? undefined
          : (receipt.humanSummary?.failureExplanation?.rootCause ?? receipt.summary.phase),
        model: receipt.totalCost?.model,
        costUsd: receipt.totalCost?.estimatedCostUsd,
        runId: receipt.runId,
      };
    } catch (err) {
      return {
        success: false,
        touchedFiles: [],
        verificationPassed: false,
        errorType: err instanceof Error ? err.name : "UnknownError",
        errorMessage: err instanceof Error ? err.message : String(err),
        runId: "",
      };
    }
  }

  /**
   * Cancel a running task.
   */
  cancel(runId: string): boolean {
    const active = this.activeRuns.get(runId);
    if (!active) return false;
    active.cancelled = true;
    // Abort any in-flight provider HTTP requests so the cancel takes
    // effect immediately instead of after the worker call returns.
    // Stale-result guards (cancelledGenerations) still catch late
    // settlements as a backstop.
    try {
      active.runAbortController.abort("Cancelled by user");
    } catch {
      // AbortController.abort is synchronous and never throws in
      // current Node, but be defensive — cancel() must never reject.
    }
    abortRun(active.run, "Cancelled by user");

    if (this.pendingApproval.has(runId)) {
      this.pendingApproval.delete(runId);
      this.activeRuns.delete(runId);
      void this.cancelPendingApprovalRun(active);
      return true;
    }

    void this.receiptStore.patchRun(runId, {
      intentId: active.intent.id,
      prompt: active.rawUserPrompt,
      taskSummary: active.rawUserPrompt,
      status: "INTERRUPTED",
      phase: active.run.phase,
      completedAt: active.run.completedAt,
      appendErrors: ["Cancelled by user"],
      appendCheckpoints: [
        {
          at: new Date().toISOString(),
          type: "failure_occurred",
          status: "INTERRUPTED",
          phase: active.run.phase,
          summary: "Run interrupted by user cancellation",
        },
      ],
    });
    return true;
  }

  /**
   * Cancel an approval-paused run through the same cleanup shape as
   * rejection: roll back unapproved workspace edits, clean up the
   * preserved workspace, and make the persisted receipt terminal.
   */
  private async cancelPendingApprovalRun(active: ActiveRun): Promise<void> {
    const runId = active.run.id;
    try {
      await this.rollbackChanges(active, {
        action: "block",
        findings: [],
        critical: [{
          source: "coordinator",
          severity: "critical",
          code: "coordinator:cancelled",
          message: "Run cancelled by user during approval",
        }],
        advisory: [],
        primaryBlockReason: "Run cancelled by user during approval",
        summary: "CANCELLED — user cancelled during approval gate",
      });

      const persisted = await this.receiptStore.getRun(runId);
      const runSummary = getRunSummary(active.run);
      const finalReceipt = persisted?.finalReceipt
        ? { ...persisted.finalReceipt, verdict: "aborted" as const, summary: runSummary }
        : undefined;

      await this.receiptStore.patchRun(runId, {
        intentId: active.intent.id,
        prompt: active.rawUserPrompt,
        taskSummary: "Cancelled by user during approval — changes rolled back",
        status: "INTERRUPTED",
        phase: active.run.phase,
        completedAt: active.run.completedAt,
        runSummary,
        ...(finalReceipt ? { finalReceipt } : {}),
        appendErrors: ["Cancelled by user during approval gate"],
        appendCheckpoints: [
          {
            at: new Date().toISOString(),
            type: "failure_occurred",
            status: "INTERRUPTED",
            phase: active.run.phase,
            summary: "Run interrupted by user cancellation during approval",
          },
        ],
      });
    } catch (err) {
      console.warn(
        `[coordinator] approval cancellation rollback failed for ${runId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      try {
        await this.receiptStore.patchRun(runId, {
          status: "INTERRUPTED",
          phase: active.run.phase,
          completedAt: active.run.completedAt,
          appendErrors: [`Approval cancellation cleanup failed: ${err instanceof Error ? err.message : String(err)}`],
        });
      } catch { /* best-effort */ }
    } finally {
      await this.cleanupWorkspaceForApproval(active);
      this.emit({
        type: "run_complete",
        payload: { runId, verdict: "aborted", executionVerified: false, executionReason: "Cancelled by user", classification: null },
      });
    }
  }

  /**
   * Get status of an active run.
   */
  getRunStatus(runId: string): { run: RunState; graph: TaskGraphState } | null {
    const active = this.activeRuns.get(runId);
    if (!active) return null;
    return { run: active.run, graph: active.graph };
  }

  /**
   * Snapshot of all in-flight run IDs. Used by heavy/competing routes
   * (e.g. /prove/repo) to refuse work while a build is mid-flight, so
   * they don't compete for workers, providers, file locks, and memory.
   */
  listActiveRunIds(): string[] {
    return [...this.activeRuns.keys()];
  }

  // ─── Graph Construction ────────────────────────────────────────────

  private buildTaskGraph(active: ActiveRun, analysis: RequestAnalysis): void {
    console.log(`[coordinator] buildTaskGraph: entering with ${active.intent.charter.deliverables.length} deliverable(s) on intent`);
    const { graph } = active;
    const deliverables = this.prepareDeliverablesForGraph(active, analysis);
    console.log(`[coordinator] buildTaskGraph: prepareDeliverablesForGraph returned ${deliverables.length} deliverable(s)`);

    if (deliverables.length === 0) {
      console.error(`[coordinator] buildTaskGraph: ABORT — 0 deliverables after prepare. Graph will be empty. This is a fatal early-exit condition.`);
      throw new CoordinatorError("buildTaskGraph received 0 deliverables — refusing to build empty graph");
    }

    const targetFiles = deliverables.flatMap((d) => d.targetFiles);
    console.log(`[coordinator] buildTaskGraph: total target files across deliverables = ${targetFiles.length}`);

    // ── Fast Path Graph ─────────────────────────────────────────────
    // Trivial single-file edits get a minimal graph:
    //   Scout (limited) → Builder → Critic (heuristic-only) → Verifier
    // No integrator, no escalation boundaries. Scope lock still
    // enforced via critic heuristics + merge gate.
    if (active.fastPath) {
      console.log(`[coordinator] buildTaskGraph: FAST PATH — building minimal graph`);
      const scoutNode = addNode(graph, {
        label: "Scout: gather context (fast-path)",
        workerType: "scout",
        targetFiles,
        metadata: { category: analysis.category, scopeEstimate: analysis.scopeEstimate, fastPath: true },
      });

      const deliverable = deliverables[0]!;
      const builderNode = addNode(graph, {
        label: `Build: ${deliverable.description}`,
        workerType: "builder",
        targetFiles: deliverable.targetFiles,
        metadata: { deliverableType: deliverable.type, fastPath: true },
      });
      addEdge(graph, scoutNode.id, builderNode.id, "data");

      const criticNode = addNode(graph, {
        label: "Critic: heuristic review (fast-path)",
        workerType: "critic",
        targetFiles,
        metadata: { fastPath: true },
      });
      addEdge(graph, builderNode.id, criticNode.id, "data");

      const verifierNode = addNode(graph, {
        label: "Verifier: tests, types, lint",
        workerType: "verifier",
        targetFiles,
        metadata: { fastPath: true },
      });
      addEdge(graph, criticNode.id, verifierNode.id, "data");

      markReady(graph, scoutNode.id);
      console.log(`[coordinator] buildTaskGraph: FAST PATH complete — ${graph.nodes.length} node(s), ${graph.edges.length} edge(s)`);
      return;
    }

    // ── Standard Graph ──────────────────────────────────────────────
    const scoutNode = addNode(graph, {
      label: "Scout: gather context and assess risk",
      workerType: "scout",
      targetFiles,
      metadata: { category: analysis.category, scopeEstimate: analysis.scopeEstimate },
    });
    console.log(`[coordinator] buildTaskGraph: scout node added (${scoutNode.id.slice(0, 6)})`);

    const builderDeliverables = this.groupBuilderDeliverables(active, deliverables);
    if (builderDeliverables.length !== deliverables.length) {
      console.log(
        `[coordinator] buildTaskGraph: grouped ${deliverables.length} deliverable(s) into ` +
        `${builderDeliverables.length} coordinated builder assignment(s)`,
      );
    }

    const builderNodes: TaskNode[] = [];
    for (const deliverable of builderDeliverables) {
      // Tag with wave id (P2) — if the plan exists and this deliverable's
      // files belong to a wave, attach it to metadata so downstream
      // verification and UI can attribute work per wave. Picks the
      // smallest wave id covered so multi-wave deliverables land in the
      // earliest phase (schema before consumers).
      const waveId = this.resolveWaveForFiles(active.plan, deliverable.targetFiles);
      const builder = addNode(graph, {
        label: `Build: ${deliverable.description}`,
        workerType: "builder",
        targetFiles: deliverable.targetFiles,
        metadata: {
          deliverableType: deliverable.type,
          ...(waveId != null ? { waveId } : {}),
        },
      });
      addEdge(graph, scoutNode.id, builder.id, "data");
      builderNodes.push(builder);
    }
    console.log(`[coordinator] buildTaskGraph: ${builderNodes.length} builder node(s) added`);

    const criticNode = addNode(graph, {
      label: "Critic: review all builder outputs",
      workerType: "critic",
      targetFiles,
      metadata: {},
    });
    for (const builder of builderNodes) {
      addEdge(graph, builder.id, criticNode.id, "data");
    }

    const verifierNode = addNode(graph, {
      label: "Verifier: tests, types, lint",
      workerType: "verifier",
      targetFiles,
      metadata: {},
    });
    addEdge(graph, criticNode.id, verifierNode.id, "data");

    const integratorNode = addNode(graph, {
      label: "Integrator: merge and final coherence",
      workerType: "integrator",
      targetFiles,
      metadata: {},
    });
    addEdge(graph, verifierNode.id, integratorNode.id, "data");

    if (builderNodes.length > 1) {
      addMergeGroup(
        graph,
        "All builder outputs",
        builderNodes.map((b) => b.id),
        integratorNode.id
      );
    }

    addCheckpoint(graph, {
      label: "Post-review checkpoint",
      upstreamNodeIds: [criticNode.id],
      downstreamNodeIds: [verifierNode.id],
      checks: [
        { name: "Critic approved", type: "coherence", required: true },
        { name: "Cost within budget", type: "cost-gate", required: false },
      ],
      allowsIntentRevision: true,
    });

    const memoryLandmines = active.gatedContext.landmines ?? [];
    const escalationReasons = [
      ...analysis.riskSignals,
      ...memoryLandmines.map((item) => `memory:${item}`),
    ];
    if (escalationReasons.length > 0) {
      console.log(`[coordinator] buildTaskGraph: adding escalation boundaries for ${builderNodes.length} builder(s) due to risk signals: ${escalationReasons.join(", ")}`);
      for (const builder of builderNodes) {
        addEscalationBoundary(
          graph,
          builder.id,
          "standard",
          `Risk signals: ${escalationReasons.join(", ")}`,
          "coordinator"
        );
      }
    }

    markReady(graph, scoutNode.id);
    console.log(`[coordinator] buildTaskGraph: complete — total nodes=${graph.nodes.length} edges=${graph.edges.length} scout marked ready`);
  }

  private shouldCoordinateBuilderScope(active: ActiveRun): boolean {
    const scope = active.scopeClassification;
    if (!scope) return false;
    return (
      scope.type === "multi-file" ||
      scope.type === "architectural" ||
      scope.type === "migration" ||
      scope.type === "cross-cutting-sweep" ||
      scope.governance.wavesRequired
    );
  }

  private groupBuilderDeliverables(
    active: ActiveRun,
    deliverables: readonly Deliverable[],
  ): readonly Deliverable[] {
    const uniqueFiles = this.uniqueStrings(deliverables.flatMap((deliverable) => deliverable.targetFiles));
    if (uniqueFiles.length <= 1 || !this.shouldCoordinateBuilderScope(active)) {
      return deliverables;
    }

    const typeForFiles = (files: readonly string[]): Deliverable["type"] => {
      const matched = new Set(
        deliverables
          .filter((deliverable) => deliverable.targetFiles.some((file) => files.includes(file)))
          .map((deliverable) => deliverable.type),
      );
      return matched.size === 1
        ? [...matched][0]!
        : "modify";
    };

    const grouped: Deliverable[] = [];
    const assigned = new Set<string>();
    const plan = active.plan;

    if (plan && plan.waves.length > 0) {
      for (const wave of plan.waves) {
        const files = uniqueFiles.filter((file) => wave.files.includes(file));
        if (files.length === 0) continue;
        files.forEach((file) => assigned.add(file));
        grouped.push({
          description: `Coordinated ${wave.name} update (${files.length} file(s))`,
          targetFiles: files,
          type: typeForFiles(files),
        });
      }
    }

    const leftovers = uniqueFiles.filter((file) => !assigned.has(file));
    if (leftovers.length > 0) {
      grouped.push({
        description: `Coordinated implementation across ${leftovers.length} file(s)`,
        targetFiles: leftovers,
        type: typeForFiles(leftovers),
      });
    }

    return grouped.length > 0
      ? grouped
      : [{
          description: `Coordinated implementation across ${uniqueFiles.length} file(s)`,
          targetFiles: uniqueFiles,
          type: typeForFiles(uniqueFiles),
        }];
  }

  private refreshImplementationBrief(active: ActiveRun, reason: string): void {
    const dispatchableFiles = this.uniqueStrings(
      active.intent.charter.deliverables.flatMap((d) => [...d.targetFiles]),
    );
    const scope = active.scopeClassification ?? classifyScope(active.normalizedInput, dispatchableFiles);
    const brief = buildImplementationBriefOrFallback({
      intent: active.intent,
      analysis: active.analysis,
      charter: active.intent.charter,
      scope,
      changeSet: active.changeSet,
      plan: active.plan,
      rawUserPrompt: active.rawUserPrompt,
      normalizedPrompt: active.normalizedInput,
      dispatchableFiles,
      rejectedCandidates: active.rejectedCandidates,
    });
    active.implementationBrief = brief;

    const floor = capabilityFloorForBrief(brief);
    active.capabilityFloorApplied = {
      floor: floor.floor,
      reason: floor.reason,
      configured: floor.floor,
      escalated: false,
    };

    console.log(
      `[coordinator] implementation brief built (${reason}) — taskType=${brief.taskType} scope=${brief.scope} ` +
      `risk=${brief.riskLevel} files=${brief.selectedFiles.length} rejected=${brief.rejectedCandidates.length} ` +
      `stages=${brief.stages.length} needsClarification=${brief.needsClarification}`,
    );
    console.log(`[coordinator] capability floor: ${floor.floor} — ${floor.reason}`);
    this.emit({
      type: "system_event",
      payload: {
        runId: active.run.id,
        checkpointLabel: "implementation_brief",
        summary:
          `brief (${reason}): ${brief.taskType}/${brief.scope} risk=${brief.riskLevel} ` +
          `files=${brief.selectedFiles.length} rejected=${brief.rejectedCandidates.length}`,
      },
    });
    this.receiptStore.patchRun(active.run.id, {
      implementationBrief: briefToReceiptJson(brief),
    }).catch((e) => {
      console.warn(`[coordinator] receipt persist of implementation brief failed: ${e instanceof Error ? e.message : String(e)}`);
    });
  }

  private shouldPlanForScope(scope: ScopeClassification | null): boolean {
    if (!scope) return false;
    return scope.type === "multi-file" || scope.type === "architectural" || scope.governance.wavesRequired;
  }

  private appendRejectedCandidates(
    active: ActiveRun,
    rejectedCandidates: readonly RejectedCandidate[],
  ): void {
    const seen = new Set(active.rejectedCandidates.map((item) => `${item.path}::${item.reason}`));
    for (const candidate of rejectedCandidates) {
      const path = candidate.path.trim();
      const reason = candidate.reason.trim();
      if (!path || !reason) continue;
      const key = `${path}::${reason}`;
      if (seen.has(key)) continue;
      seen.add(key);
      active.rejectedCandidates.push({ path, reason });
    }
  }

  private builderContextTargets(
    active: ActiveRun,
    node: TaskNode,
    mode: "initial" | "retry",
  ): string[] {
    const baseTargets = this.uniqueStrings(node.targetFiles);
    if (node.workerType !== "builder" || !this.shouldCoordinateBuilderScope(active)) {
      return baseTargets;
    }

    const brief = active.implementationBrief;
    if (!brief || brief.selectedFiles.length === 0) {
      return baseTargets;
    }

    const waveId = typeof node.metadata.waveId === "number"
      ? node.metadata.waveId
      : null;
    const waveScoped = waveId == null
      ? brief.selectedFiles.map((file) => file.path)
      : brief.selectedFiles
          .filter((file) => file.waveId === waveId || baseTargets.includes(file.path))
          .map((file) => file.path);
    const broader = mode === "retry"
      ? brief.selectedFiles.map((file) => file.path)
      : waveScoped;
    const maxTargets = mode === "retry" ? 10 : 6;

    return this.uniqueStrings([
      ...baseTargets,
      ...waveScoped,
      ...broader,
    ]).slice(0, Math.max(baseTargets.length, maxTargets));
  }

  private isIgnoredPlanningPath(pathLike: string): boolean {
    return /(^|\/)(node_modules|\.git|dist|build|coverage|\.next|\.aedis|\.zendorium)(\/|$)/.test(pathLike);
  }

  private looksGeneratedPlanningFile(absolutePath: string, relativePath: string): boolean {
    if (/\.generated\./i.test(relativePath)) return true;
    try {
      const preview = readFileSync(absolutePath, "utf-8").slice(0, 512);
      return /@generated|AUTO-GENERATED|generated by/i.test(preview);
    } catch {
      return false;
    }
  }

  private scoreDirectoryCandidate(relativePath: string, analysis: RequestAnalysis): number {
    const normalized = relativePath.toLowerCase();
    const promptWords = new Set(
      (analysis.raw.toLowerCase().match(/[a-z]{3,}/g) ?? [])
        .filter((word) => !["the", "and", "with", "from", "into", "that", "this", "when"].includes(word)),
    );

    let score = 0;
    for (const word of promptWords) {
      if (normalized.includes(word)) score += 3;
    }

    if (analysis.category === "docs" && /\.(md|mdx|rst|txt)$/i.test(relativePath)) score += 6;
    if (analysis.category === "test" && /(?:^|\/).*\.(test|spec)\.[a-z0-9]+$/i.test(relativePath)) score += 6;
    if (analysis.category === "config" && /\.(json|ya?ml|toml|env)$/i.test(relativePath)) score += 4;
    if (analysis.category !== "docs" && !/\.(md|mdx|rst|txt)$/i.test(relativePath)) score += 2;
    if (analysis.category !== "test" && !/(?:^|\/).*\.(test|spec)\.[a-z0-9]+$/i.test(relativePath)) score += 1;
    if (/index|router|route|controller|server|provider|auth|health/i.test(relativePath)) score += 1;

    const depthPenalty = relativePath.split("/").length - 1;
    return score - depthPenalty * 0.1;
  }

  private isRelevantDirectoryCandidate(relativePath: string, analysis: RequestAnalysis): boolean {
    if (!/\.(ts|tsx|js|jsx|mjs|cjs|json|ya?ml|toml|md|mdx|rst|txt|py|rs|go|java|kt|swift|c|cc|cpp|h|hpp|cs|rb|php|scala|lua|sh|bash|vue|svelte|html|css|scss|sass|less)$/i.test(relativePath)) {
      return false;
    }
    if (analysis.category === "docs") return /\.(md|mdx|rst|txt)$/i.test(relativePath);
    if (analysis.category === "test") return /(?:^|\/).*\.(test|spec)\.[a-z0-9]+$/i.test(relativePath) || /tests?\//i.test(relativePath);
    return true;
  }

  private expandDirectoryTarget(
    active: ActiveRun,
    analysis: RequestAnalysis,
    target: string,
  ): { selectedFiles: string[]; rejectedCandidates: RejectedCandidate[] } | null {
    const absoluteTarget = resolve(active.projectRoot, target);
    let info;
    try {
      info = statSync(absoluteTarget);
    } catch {
      return null;
    }
    if (!info.isDirectory()) return null;

    const candidates: Array<{ path: string; score: number }> = [];
    const rejectedCandidates: RejectedCandidate[] = [];

    const walk = (relativeDir: string): void => {
      const absoluteDir = resolve(active.projectRoot, relativeDir);
      for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
        const relativePath = `${relativeDir.replace(/\\/g, "/").replace(/\/+$/, "")}/${entry.name}`.replace(/^\.\//, "");
        if (entry.isDirectory()) {
          if (this.isIgnoredPlanningPath(relativePath)) {
            rejectedCandidates.push({ path: relativePath, reason: "ignored path: skipped during directory expansion" });
            continue;
          }
          walk(relativePath);
          continue;
        }
        if (!entry.isFile()) {
          rejectedCandidates.push({ path: relativePath, reason: "unsafe path: not a regular file" });
          continue;
        }
        if (this.isIgnoredPlanningPath(relativePath)) {
          rejectedCandidates.push({ path: relativePath, reason: "ignored path: skipped during directory expansion" });
          continue;
        }
        const absoluteFile = resolve(active.projectRoot, relativePath);
        if (this.looksGeneratedPlanningFile(absoluteFile, relativePath)) {
          rejectedCandidates.push({ path: relativePath, reason: "generated file: skipped during directory expansion" });
          continue;
        }
        if (!this.isRelevantDirectoryCandidate(relativePath, analysis)) {
          rejectedCandidates.push({ path: relativePath, reason: "unsafe path: unsupported or irrelevant file type for this task" });
          continue;
        }
        candidates.push({
          path: relativePath,
          score: this.scoreDirectoryCandidate(relativePath, analysis),
        });
      }
    };

    walk(target.replace(/\/+$/, ""));
    candidates.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

    const maxSelected = analysis.category === "docs" ? 4 : analysis.category === "test" ? 6 : 5;
    const selected = candidates.slice(0, maxSelected).map((item) => item.path);
    for (const dropped of candidates.slice(maxSelected)) {
      rejectedCandidates.push({
        path: dropped.path,
        reason: "low relevance: ranked below the directory expansion candidate cap",
      });
    }

    rejectedCandidates.unshift({
      path: target,
      reason: selected.length > 0
        ? `directory target expanded into candidate files: ${selected.join(", ")}`
        : "directory target contained no relevant dispatchable files",
    });

    return {
      selectedFiles: selected,
      rejectedCandidates,
    };
  }

  private prepareDeliverablesForGraph(
    active: ActiveRun,
    analysis: RequestAnalysis
  ): readonly Deliverable[] {
    const explicitTestRequest = this.userExplicitlyAskedForTests(analysis.raw);

    const explicitlyMentioned = new Set<string>();
    for (const target of analysis.targets) {
      const trimmed = target.trim();
      if (!trimmed) continue;
      // Register both the raw form (possibly absolute) and the canonical
      // worktree-relative form so isExplicit() matches regardless of which
      // shape a downstream caller passes.
      explicitlyMentioned.add(trimmed);
      explicitlyMentioned.add(trimmed.replace(/^.*\//, ""));
      if (active.sourceRepo && trimmed.startsWith(active.sourceRepo)) {
        explicitlyMentioned.add(trimmed.slice(active.sourceRepo.length).replace(/^[\\/]+/, ""));
      }
    }
    for (const testPath of this.extractExplicitTestPathMentions(analysis.raw)) {
      explicitlyMentioned.add(testPath);
      explicitlyMentioned.add(testPath.replace(/^.*\//, ""));
    }
    const isExplicit = (file: string): boolean =>
      explicitlyMentioned.has(file) || explicitlyMentioned.has(file.replace(/^.*\//, ""));

    const totalBefore = active.intent.charter.deliverables.length;
    const decisions: string[] = [];
    let didFilter = false;
    active.rejectedCandidates = [];

    console.log(`[coordinator] prepareDeliverablesForGraph: ${totalBefore} deliverable(s) before filter (projectRoot=${active.projectRoot})`);

    // ── PHASE 0 — Canonicalize absolute source-repo paths to worktree-relative ──
    // The charter's regex extractor captures absolute paths verbatim from the
    // user prompt (e.g. /mnt/ai/squidley-v2/apps/api/src/routes/index.ts).
    // Every downstream worker resolves target files relative to the
    // per-task projectRoot (the isolated workspace), so absolute paths
    // from the source repo cause set-membership mismatches (Critic reports
    // "Scope drift" because Builder's change.path is relative). Strip the
    // sourceRepo prefix here so all phases below operate on a consistent
    // relative shape.
    const canonicalizePath = (f: string): string => {
      const trimmed = f.trim();
      if (!trimmed) return "";
      if (active.sourceRepo && trimmed.startsWith(active.sourceRepo)) {
        return trimmed.slice(active.sourceRepo.length).replace(/^[\\/]+/, "");
      }
      return trimmed;
    };
    const hadDirectoryTargets = analysis.targets.some((target) => {
      const canonical = canonicalizePath(target);
      if (!canonical) return false;
      try {
        return statSync(resolve(active.projectRoot, canonical)).isDirectory();
      } catch {
        return false;
      }
    });

    // ── PHASE 1 — Upstream empty guard ──────────────────────────────────
    const guarded: Deliverable[] = [];
    for (const d of active.intent.charter.deliverables) {
      if (!d.targetFiles || d.targetFiles.length === 0) {
        const label = d.description;
        console.warn(`[coordinator] WARN: dropping deliverable "${label}" upstream — no target files (charter placeholder or upstream bug)`);
        this.appendRejectedCandidates(active, [
          { path: label, reason: "upstream placeholder: deliverable had no target files" },
        ]);
        decisions.push(`  drop deliverable "${label}" (no target files at all — upstream guard)`);
        didFilter = true;
        continue;
      }
      const expandedTargets: string[] = [];
      for (const rawTarget of d.targetFiles.map(canonicalizePath).filter((f) => f.length > 0)) {
        const expansion = this.expandDirectoryTarget(active, analysis, rawTarget);
        if (!expansion) {
          expandedTargets.push(rawTarget);
          continue;
        }
        didFilter = true;
        this.appendRejectedCandidates(active, expansion.rejectedCandidates);
        decisions.push(
          `  expand ${rawTarget} -> ${expansion.selectedFiles.join(", ") || "(no dispatchable files found)"}`,
        );
        expandedTargets.push(...expansion.selectedFiles);
      }
      guarded.push({
        ...d,
        targetFiles: this.uniqueStrings(expandedTargets),
      });
    }

    // ── PHASE 2 — Test/non-existent filter ──────────────────────────────
    const filtered: Deliverable[] = [];
    for (const deliverable of guarded) {
      const verifiedTargets = deliverable.targetFiles.filter((file) => {
        if (!file) {
          this.appendRejectedCandidates(active, [
            { path: deliverable.description, reason: "empty target path after canonicalization" },
          ]);
          decisions.push(`  drop empty file path in deliverable "${deliverable.description}"`);
          return false;
        }

        if (file.startsWith(".aedis/") || file.endsWith(".json")) {
          console.log(`[coordinator] dropping system file from deliverables: ${file}`);
          this.appendRejectedCandidates(active, [
            { path: file, reason: "ignored path: system or state file excluded from deliverables" },
          ]);
          decisions.push(`  drop ${file} (system file excluded from deliverables)`);
          didFilter = true;
          return false;
        }

        const exists = this.fileExists(file, active.projectRoot);
        const isTest = this.isTestFile(file);
        const wasExplicit = isExplicit(file);

        if (wasExplicit) {
          if (exists) {
            decisions.push(`  keep ${file} (explicitly mentioned in request)`);
            return true;
          }
          // Phase 12 — explicit files that don't exist are kept when
          // the deliverable type signals a create operation OR the
          // analysis indicates create intent ("new file", "create",
          // "extract … into a new file"). Without this, prompts like
          // "Create src/email.ts with isValidEmail" produce zero
          // deliverables → empty graph → empty-graph failure code →
          // ambiguous_prompt classification, even though the user
          // gave a perfectly clear file target.
          const isCreateDeliverable = deliverable.type === "create";
          const promptHasCreateIntent =
            /\b(create|new file|new module|extract\s+\w+\s+into|move\s+\w+\s+to\s+a\s+new)\b/i.test(
              analysis.raw,
            );
          const explicitMissingTestWithAuthoringIntent =
            isTest && explicitTestRequest && this.extractExplicitTestPathMentions(analysis.raw).includes(file);
          if (explicitMissingTestWithAuthoringIntent) {
            decisions.push(
              `  keep ${file} (explicit test-authoring target — will be created)`,
            );
            return true;
          }
          if (isCreateDeliverable || promptHasCreateIntent) {
            decisions.push(
              `  keep ${file} (explicit new-file target — ${isCreateDeliverable ? "deliverable.type=create" : "prompt has create intent"})`,
            );
            return true;
          }
          this.appendRejectedCandidates(active, [
            { path: file, reason: "unsafe path: explicit target does not exist in the repo" },
          ]);
          decisions.push(`  drop ${file} (explicitly mentioned but does not exist)`);
          didFilter = true;
          return false;
        }

        // Test files: keep existing tests (they pair with implementation files
        // and should be updated). Only drop auto-generated test targets for
        // implementation files that don't exist yet.
        if (isTest) {
          if (exists) {
            decisions.push(`  keep ${file} (existing test file — paired with implementation)`);
            return true;
          }
          if (!explicitTestRequest) {
            this.appendRejectedCandidates(active, [
              { path: file, reason: "low relevance: auto-generated test target does not exist" },
            ]);
            decisions.push(`  drop ${file} (auto-generated test for non-existent file)`);
            didFilter = true;
            return false;
          }
        }

        decisions.push(`  keep ${file}${exists ? "" : " (will be created)"}`);
        return true;
      });

      if (deliverable.targetFiles.length > 0 && verifiedTargets.length === 0) {
        this.appendRejectedCandidates(active, [
          { path: deliverable.description, reason: "all candidate targets were filtered before graph build" },
        ]);
        decisions.push(`  drop deliverable "${deliverable.description}" (all target files were filtered)`);
        didFilter = true;
        continue;
      }

      if (verifiedTargets.length !== deliverable.targetFiles.length) {
        didFilter = true;
      }

      filtered.push({
        ...deliverable,
        targetFiles: verifiedTargets,
      });
    }

    // ── PHASE 3 — Deduplicate by resolved absolute path ─────────────────
    const seenPaths = new Set<string>();
    let deduped: Deliverable[] = [];
    for (const d of filtered) {
      const uniqueFiles: string[] = [];
      for (const f of d.targetFiles) {
        // Resolve against active.projectRoot (the per-task effective root)
        // so dedup honors the per-task projectRoot rather than the
        // Coordinator's boot-time default. Also normalize absolute source-repo
        // paths (e.g. /mnt/ai/squidley-v2/...) to worktree-relative so they
        // deduplicate correctly against relative forms of the same file.
        // We push the canonical (relative) form downstream so workers all
        // operate on the same path shape — otherwise the Critic's
        // allowedFiles set (absolute) won't match Builder's change.path (relative)
        // and it fires "Scope drift" on the user's own explicit target.
        const canonical = active.sourceRepo && f.startsWith(active.sourceRepo)
          ? f.slice(active.sourceRepo.length).replace(/^[\\/]+/, "")
          : f;
        const abs = resolve(active.projectRoot, canonical);
        if (seenPaths.has(abs)) {
          this.appendRejectedCandidates(active, [
            { path: canonical, reason: "duplicate target: already covered by an earlier deliverable" },
          ]);
          decisions.push(`  dedupe ${f} (already covered by earlier deliverable as ${abs})`);
          didFilter = true;
          continue;
        }
        seenPaths.add(abs);
        uniqueFiles.push(canonical);
      }

      if (uniqueFiles.length === 0) {
        const label = d.description;
        console.warn(`[coordinator] WARN: dropping deliverable "${label}" after dedup — all target files were duplicates of earlier deliverables`);
        this.appendRejectedCandidates(active, [
          { path: label, reason: "duplicate deliverable: all target files duplicated earlier work" },
        ]);
        decisions.push(`  drop deliverable "${label}" (all target files were duplicates)`);
        didFilter = true;
        continue;
      }

      deduped.push({ ...d, targetFiles: uniqueFiles });
    }

    // ── PHASE 3.5 — Source inference for test-only deliverables ─────────
    // When every surviving target is a test file, the builder has no
    // real implementation to operate on — the resulting graph would
    // either be empty (if filtering also dropped the implementation)
    // or limited to test-file edits, which leaves the actual source
    // bug unfixed. Phase 12: if all deliverable targets are test
    // files, infer the implementation file each one pairs with via
    // findImplForTest and add it as a sibling deliverable. The
    // implementation must exist on disk (findImplForTest verifies)
    // and not already be in scope.
    //
    // Skipped for the explicit "test" category — the user is
    // genuinely asking to write tests, so we should not force
    // unrelated source edits into the manifest.
    if (deduped.length > 0 && analysis.category !== "test") {
      const allTargets = deduped.flatMap((d) => d.targetFiles);
      const allTests = allTargets.length > 0 && allTargets.every((f) => this.isTestFile(f));
      if (allTests) {
        const inferred: string[] = [];
        for (const t of allTargets) {
          const impl = findImplForTest(t, active.projectRoot);
          if (!impl) continue;
          const abs = resolve(active.projectRoot, impl);
          if (seenPaths.has(abs)) continue;
          seenPaths.add(abs);
          inferred.push(impl);
        }
        if (inferred.length > 0) {
          deduped.unshift({
            type: "modify" as const,
            description: `Source implementation file(s) inferred from test target(s)`,
            targetFiles: inferred,
          });
          for (const impl of inferred) {
            decisions.push(`  infer ${impl} (implementation paired with test-only deliverable)`);
          }
          console.log(
            `[coordinator] prepareDeliverablesForGraph: P12 inferred ${inferred.length} source file(s) from test-only deliverables: ${inferred.join(", ")}`,
          );
          didFilter = true;
        }
      }
    }

    // ── PHASE 4 — Test pair injection ───────────────────────────────────
    // For implementation files that have existing test files, inject the
    // test as an optional deliverable so verification is more complete.
    // Only injects tests that EXIST on disk — does not create phantom targets.
    //
    // Bugfix tasks opt out: the bug lives in the source file and should
    // be fixed there. Injecting a test pair causes the builder to spend
    // its shot on the test file (or mutate the test alongside the
    // source), which is exactly the "modified only test/utils.test.ts"
    // failure mode observed on stress-01/02/09/11..14. Feature and
    // refactor tasks are unaffected — they benefit from the test-pair
    // verification coverage.
    //
    // Primary signal: the charter's own category classifier
    // (analysis.category === "bugfix"). This is the authoritative
    // label already computed in Phase 1 and logged as `category=bugfix`.
    // The isBugfixLikePrompt heuristic is kept as a belt-and-suspenders
    // second check — both must agree that it's NOT bugfix for
    // injection to proceed.
    const isBugfixCategory = analysis.category === "bugfix";
    const isBugfixPrompt = isBugfixLikePrompt(active.intent.userRequest);
    const isBugfix = isBugfixCategory || isBugfixPrompt;
    // Scope lock veto — when the user said "do not modify anything
    // else", injecting an adjacent test file is exactly the burn-in-01
    // 1-file → 9-files failure mode. The charter-level fix
    // (CharterGenerator.buildDeliverables) blocks one path; this
    // blocks the parallel coordinator path that runs even when the
    // charter only emitted a single deliverable.
    const scopeLockedForInjection = active.intent.charter.scopeLock != null;
    if (scopeLockedForInjection) {
      console.log(
        `[coordinator] prepareDeliverablesForGraph: scopeLock active — skipping Phase 4 test-pair injection ` +
        `(allowedFiles: ${active.intent.charter.scopeLock?.allowedFiles.join(", ") ?? "<none>"})`,
      );
    }
    if (!explicitTestRequest && !isBugfix && !scopeLockedForInjection) {
      const allTargetFiles = deduped.flatMap((d) => d.targetFiles);
      const missingTests = findMissingTestFiles(allTargetFiles, active.projectRoot);
      if (missingTests.length > 0) {
        // Skip test files already selected by the charter with role="test" —
        // re-injecting them here causes scope-bleed: the git-diff-verifier
        // flags the test as an "unexpected reference change" because it was
        // added by the injector but not expected by the charter's manifest.
        const charterTestPaths = new Set(
          Array.from(
            (active.intent.charter as { selectedFiles?: readonly { path: string }[] }).selectedFiles ?? [],
          )
            .filter((f: { path: string }) => /(test|spec|__mocks?__)/i.test(f.path))
            .map((f: { path: string }) => resolve(active.projectRoot, f.path)),
        );
        const testFiles = missingTests
          .map((p) => p.testPath!)
          .filter(
            (t) =>
              !seenPaths.has(resolve(active.projectRoot, t)) &&
              !charterTestPaths.has(resolve(active.projectRoot, t)),
          );
        if (testFiles.length > 0) {
          deduped.push({
            type: "modify",
            description: `Test pairs for changed implementation files`,
            targetFiles: testFiles,
          });
          for (const t of testFiles) {
            seenPaths.add(resolve(active.projectRoot, t));
            decisions.push(`  inject ${t} (test pair for implementation file)`);
          }
          console.log(`[coordinator] prepareDeliverablesForGraph: injected ${testFiles.length} test pair(s)`);
        }
      }
    } else if (isBugfix) {
      console.log(
        `[coordinator] prepareDeliverablesForGraph: skipping test-pair injection (category=${analysis.category}, promptMatch=${isBugfixPrompt}) — focus on source file`,
      );
    }

    // ── PHASE 4.5 — Bugfix belt-and-suspenders test-file stripper ──────
    // Even with test-pair injection disabled, a test file can still
    // reach the deliverables via:
    //   - charter target extraction if the prompt names a test file
    //   - memory-backed clusterFiles flowing into context (rare)
    //   - a future injection path we haven't seen yet
    // For bugfix-shaped tasks, the contract is "fix the source file";
    // a test file appearing as a deliverable is always a leak. Strip
    // any deliverable whose targetFiles are all test files, and
    // filter test files out of mixed deliverables. If a deliverable
    // loses all its targets it's dropped with a decision note.
    if (isBugfix && !explicitTestRequest) {
      const before = deduped.length;
      const stripped: Deliverable[] = [];
      const preservedUserNamed: string[] = [];
      // A test file is eligible to be stripped ONLY when it was auto-injected
      // (Phase 4 test-pair injection or any future inferred path). User-named
      // test files — i.e. paths the user wrote directly into the prompt and
      // that survived charter target extraction — are never silently dropped
      // here. Case 1 (1efad650) was the canonical regression: the user
      // explicitly asked for a test in core/run-summary.test.ts, the regex
      // missed the singular phrasing, and this stripper deleted the test
      // deliverable. The fix keeps any test file matched by `isExplicit`.
      const isAutoStrippable = (f: string): boolean =>
        isTestInjectionFile(f) && !isExplicit(f);
      for (const d of deduped) {
        const nonTest = d.targetFiles.filter((f) => !isAutoStrippable(f));
        const keptUserTests = d.targetFiles.filter((f) => isTestInjectionFile(f) && isExplicit(f));
        preservedUserNamed.push(...keptUserTests);
        if (nonTest.length === 0) {
          decisions.push(`  strip deliverable "${d.description}" (bugfix task: all targets were auto-injected test files; none user-named)`);
          // Remove stripped files from seenPaths so a legitimate test
          // is never blocked on a later run that DOES want tests.
          for (const f of d.targetFiles) {
            seenPaths.delete(resolve(active.projectRoot, f));
          }
          continue;
        }
        if (nonTest.length < d.targetFiles.length) {
          const dropped = d.targetFiles.filter((f) => isAutoStrippable(f));
          decisions.push(`  bugfix test-strip: drop auto-injected ${dropped.join(", ")} from "${d.description}" (none user-named)`);
          for (const f of dropped) {
            seenPaths.delete(resolve(active.projectRoot, f));
          }
          stripped.push({ ...d, targetFiles: nonTest });
        } else {
          stripped.push(d);
        }
      }
      if (preservedUserNamed.length > 0) {
        console.log(
          `[coordinator] prepareDeliverablesForGraph: bugfix test-strip preserved ${preservedUserNamed.length} user-named test file(s): ${this.uniqueStrings(preservedUserNamed).join(", ")}`,
        );
      }
      if (stripped.length !== before) {
        console.log(
          `[coordinator] prepareDeliverablesForGraph: bugfix test-strip removed ${before - stripped.length} deliverable(s)`,
        );
        didFilter = true;
      }
      deduped.length = 0;
      deduped.push(...stripped);
    }

    // ── PHASE 4.6 — Defense-in-depth: user-named target tripwire ────────
    // Any path the user named in the prompt that exists on disk MUST be
    // present in the final deliverable manifest. The Phase 4.5 fix above
    // closes the known leak, but we treat this as an invariant: if a
    // user-named target ever falls out of `deduped` (via this code path
    // or any future filter) we record it on the ActiveRun so the merge
    // gate can refuse to merge with a `coordinator:user-target-stripped`
    // critical finding. Not having this finding fire is the success case.
    const finalTargets = new Set(deduped.flatMap((d) => d.targetFiles));
    for (const userTarget of analysis.targets) {
      const canonical = canonicalizePath(userTarget);
      if (!canonical) continue;
      if (finalTargets.has(canonical)) continue;
      if (
        this.isTestFile(canonical) &&
        explicitTestRequest &&
        this.extractExplicitTestPathMentions(analysis.raw).includes(canonical)
      ) {
        if (active.userNamedStrippedTargets.includes(canonical)) continue;
        active.userNamedStrippedTargets.push(canonical);
        console.warn(
          `[coordinator] prepareDeliverablesForGraph: TRIPWIRE — explicit test-authoring target ${canonical} fell out of deliverables. Merge gate will block.`,
        );
        continue;
      }
      // Skip user-named targets that don't exist on disk — Phase 2 drops
      // those intentionally, and submitWithGates already returns
      // needs_clarification for prompts whose only target is missing, so
      // reaching here means it's an *additional* missing target which
      // does not belong on the trip-wire.
      if (!this.fileExists(canonical, active.projectRoot)) continue;
      if (active.userNamedStrippedTargets.includes(canonical)) continue;
      active.userNamedStrippedTargets.push(canonical);
      console.warn(
        `[coordinator] prepareDeliverablesForGraph: TRIPWIRE — user-named target ${canonical} fell out of deliverables. Merge gate will block.`,
      );
    }

    // ── Scope-lock allowlist intersection ────────────────────────────────
    // Final defensive pass: if the charter has a scopeLock, the
    // graph dispatch must NEVER include a file outside allowedFiles.
    // This catches anything that snuck in via Phase 4 test-pair
    // injection (already gated above), Phase 4.5 belt-and-suspenders
    // stripping (which preserves user-named test files), or any
    // future expansion path. We trim each deliverable's targetFiles
    // to the allowlist and drop deliverables that empty out.
    const scopeLock = active.intent.charter.scopeLock;
    if (scopeLock) {
      const allowed = new Set(
        scopeLock.allowedFiles.map((f) => resolve(active.projectRoot, f)),
      );
      const beforeCount = deduped.length;
      const filtered: Deliverable[] = [];
      for (const d of deduped) {
        const kept = d.targetFiles.filter((f) =>
          allowed.has(resolve(active.projectRoot, f)),
        );
        const dropped = d.targetFiles.filter(
          (f) => !allowed.has(resolve(active.projectRoot, f)),
        );
        if (dropped.length > 0) {
          decisions.push(
            `  scope-lock: drop ${dropped.join(", ")} from "${d.description}" — ` +
            `not in allowedFiles (${scopeLock.allowedFiles.join(", ")})`,
          );
          for (const f of dropped) {
            seenPaths.delete(resolve(active.projectRoot, f));
          }
        }
        if (kept.length > 0) {
          filtered.push({ ...d, targetFiles: kept });
        } else {
          decisions.push(
            `  scope-lock: strip deliverable "${d.description}" — every target was outside allowedFiles`,
          );
        }
      }
      if (filtered.length !== beforeCount) {
        didFilter = true;
      }
      deduped = filtered;
    }

    console.log(`[coordinator] prepareDeliverablesForGraph: ${deduped.length} deliverable(s) after filter+dedup+test-inject`);
    for (const decision of decisions) {
      console.log(`[coordinator]${decision}`);
    }

    if (deduped.length === 0 && totalBefore > 0) {
      console.warn(
        `[coordinator] prepareDeliverablesForGraph: every deliverable was filtered out; ` +
        `refusing to resurrect original targets. Decisions: ${decisions.join("; ")}`,
      );
      if (hadDirectoryTargets) {
        console.warn(
          `[coordinator] prepareDeliverablesForGraph: directory expansion removed every dispatch target; ` +
          `Builder will not receive a bare directory target.`,
        );
      }
    }

    if (decisions.length > 0) {
      recordDecision(active.run, {
        description: `Filtered deliverables (${totalBefore} → ${deduped.length})`,
        madeBy: "coordinator",
        taskId: null,
        alternatives: ["Keep original deliverables unchanged"],
        rationale: decisions.join(" | "),
      });
    }

    if (didFilter || deduped.length !== totalBefore) {
      try {
        active.intent = reviseIntent(active.intent, {
          reason: "Filtered, deduplicated, and dropped empty deliverables",
          charter: { deliverables: deduped },
        });
        console.log(`[coordinator] prepareDeliverablesForGraph: intent revised to v${active.intent.version} with ${deduped.length} deliverable(s)`);

        // CRITICAL: also sync the ChangeSet so its manifest stays in sync with
        // the revised intent. The ChangeSet was built from the original
        // charterTargets before filtering; without this, the integration-judge
        // and git-diff-verifier will expect the phantom (filtered-out) files
        // to be modified and will block the merge gate even when execution succeeded.
        const filteredFiles = deduped.flatMap((d) => d.targetFiles);
        const revisedChangeSet = createChangeSet(
          active.intent,
          filteredFiles,
          undefined, // importGraph not available here; use heuristic inference
          active.projectRoot,
        );
        // Preserve wave invariants and sharedInvariants from the original ChangeSet
        // since they were already computed correctly; only sync filesInScope and
        // acceptance criteria from the revised intent's deliverables.
        active.changeSet = Object.freeze({
          ...revisedChangeSet,
          invariants: active.changeSet.invariants,
          sharedInvariants: active.changeSet.sharedInvariants,
        });
        console.log(`[coordinator] prepareDeliverablesForGraph: ChangeSet synced — ${filteredFiles.length} file(s) in scope (phantom files removed)`);
        active.scopeClassification = classifyScope(active.normalizedInput, filteredFiles);
        active.plan = this.shouldPlanForScope(active.scopeClassification)
          ? planChangeSet(active.changeSet, active.normalizedInput)
          : undefined;
        active.blastRadius = estimateBlastRadius({
          scopeClassification: active.scopeClassification,
          charterFileCount: filteredFiles.length,
          prompt: active.normalizedInput,
        });
        console.log(
          `[coordinator] prepareDeliverablesForGraph: scope refreshed → ${active.scopeClassification.type} ` +
          `(blast=${active.scopeClassification.blastRadius}, plan=${active.plan ? active.plan.waves.length : 0} wave(s))`,
        );
      } catch (err) {
        console.error(`[coordinator] prepareDeliverablesForGraph: reviseIntent FAILED — ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
    }

    return deduped;
  }

  /**
   * Return the smallest wave id that contains at least one of the
   * given files, or null if no wave matches (single-file runs or
   * deliverables whose files fell outside the plan).
   */
  /**
   * Wave gating: when the run has a plan with wavesRequired governance,
   * filter builder nodes so only those belonging to waves whose upstream
   * dependencies have completed are dispatched. Non-builder nodes are
   * always passed through — they are pipeline-stage nodes (scout, critic,
   * verifier, integrator) and don't belong to waves.
   *
   * When no plan or no wavesRequired governance, returns all nodes unchanged.
   */
  private applyWaveGating(active: ActiveRun, dispatchable: TaskNode[]): TaskNode[] {
    const plan = active.plan;
    const governance = active.scopeClassification?.governance;
    if (!plan || !governance?.wavesRequired) return dispatchable;

    // Determine which waves are complete — a wave is complete only when
    // every builder node belonging to it reached "completed". A failed
    // node (whether recovery is in flight, exhausted, or yet to start)
    // means the wave is NOT complete and downstream waves must wait.
    // The previous predicate (completed || failed) leaked downstream
    // dispatch when an upstream node briefly entered the "failed"
    // status between recovery cycles — see core/coordinator-multi-step.test.ts
    // Test 2 for the diagnostic that surfaced this.
    //
    // Waves whose status has been explicitly set to "failed" or "halted"
    // (by reconcileWaveStatuses after executeGraph exits) are also
    // treated as not-complete so downstream gating remains in force
    // even if all of their nodes happen to be in the "completed" set
    // (which can occur when reconcile runs on already-completed
    // downstream waves whose upstream later reached a terminal failure).
    const completedWaveIds = new Set<number>();
    for (const wave of plan.waves) {
      if (wave.status === "failed" || wave.status === "halted") continue;
      const waveBuilderNodes = active.graph.nodes.filter(
        (n) => n.workerType === "builder" && n.metadata.waveId === wave.id,
      );
      if (waveBuilderNodes.length === 0 || waveBuilderNodes.every((n) => n.status === "completed")) {
        completedWaveIds.add(wave.id);
      }
    }

    return dispatchable.filter((node) => {
      if (node.workerType !== "builder") return true;
      const waveId = typeof node.metadata.waveId === "number" ? node.metadata.waveId : null;
      if (waveId == null) return true; // no wave assignment — pass through

      const wave = plan.waves.find((w) => w.id === waveId);
      if (!wave) return true;

      // Check all upstream waves are complete
      for (const depWaveId of wave.dependsOn) {
        if (!completedWaveIds.has(depWaveId)) {
          return false; // upstream wave not yet complete — hold back
        }
      }
      return true;
    });
  }

  /**
   * Reconcile per-wave status from the graph's terminal node statuses
   * once executeGraph has exited. Mirrors the lifecycle ladder
   * documented in multi-file-planner: pending → passed | failed |
   * halted | skipped.
   *
   *   - any builder node failed  → wave.status = "failed", downstream
   *     waves haltDownstreamWaves'd
   *   - all builder nodes completed → wave.status = "passed"
   *   - waves that have already been halted (because an earlier failed
   *     wave halted them) are left as "halted"
   *   - waves with zero builder nodes were already marked "skipped" at
   *     plan-creation time and are left untouched
   *
   * Called once after executeGraph returns. Order matters: failed
   * waves first, halt second, passed last — so a downstream wave whose
   * nodes happened to complete before its upstream failed still ends
   * up "halted" rather than "passed". With applyWaveGating fixed to
   * require every() === "completed", the downstream-completed scenario
   * should be unreachable, but the order keeps the receipt honest if a
   * future change relaxes that gate.
   */
  private reconcileWaveStatuses(active: ActiveRun): void {
    const plan = active.plan;
    if (!plan) return;

    // Pass 1: mark waves with any failed node as failed, halt downstream.
    for (const wave of plan.waves) {
      if (wave.status !== "pending") continue;
      const waveBuilderNodes = active.graph.nodes.filter(
        (n) => n.workerType === "builder" && n.metadata.waveId === wave.id,
      );
      if (waveBuilderNodes.length === 0) continue;
      if (waveBuilderNodes.some((n) => n.status === "failed")) {
        wave.status = "failed";
        haltDownstreamWaves(plan, wave.id);
      }
    }

    // Pass 2: any wave still "pending" with all nodes "completed" is "passed".
    for (const wave of plan.waves) {
      if (wave.status !== "pending") continue;
      const waveBuilderNodes = active.graph.nodes.filter(
        (n) => n.workerType === "builder" && n.metadata.waveId === wave.id,
      );
      if (waveBuilderNodes.length === 0) continue;
      if (waveBuilderNodes.every((n) => n.status === "completed")) {
        wave.status = "passed";
      }
    }
  }

  private resolveWaveForFiles(
    plan: Plan | undefined,
    files: readonly string[],
  ): number | null {
    if (!plan) return null;
    let bestWave: number | null = null;
    for (const wave of plan.waves) {
      const waveSet = new Set(wave.files);
      if (files.some((f) => waveSet.has(f))) {
        if (bestWave == null || wave.id < bestWave) bestWave = wave.id;
      }
    }
    return bestWave;
  }

  private userExplicitlyAskedForTests(request: string): boolean {
    if (!request || typeof request !== "string") return false;
    const searchable = request.replace(/[/-]+/g, " ");
    // Plural / phrase markers — original surface that was already covered.
    if (/\b(add tests|update tests|write tests|new tests|test file|test files|spec file|spec files|tests)\b/i.test(searchable)) {
      return true;
    }
    if (/\btest\s+coverage\b/i.test(searchable)) {
      return true;
    }
    // Singular imperative variants like "add a test", "add one focused test",
    // "update the test", "write a unit test for X". The user wrote a real
    // test request even when the noun stays singular — Case 1 (1efad650)
    // hit exactly this gap with "Add one focused test in core/run-summary.test.ts"
    // and the coordinator dropped the test deliverable because the regex
    // only matched the plural "tests".
    if (/\b(add|write|create|implement|generate|author|update|modify|cover\s+with)\s+(?:a\s+|an\s+|one\s+|the\s+|new\s+|more\s+|additional\s+|focused\s+|narrow\s+|small\s+|unit\s+|integration\s+|e2e\s+|end\s+to\s+end\s+)*tests?\b/i.test(searchable)) {
      return true;
    }
    if (/\b(add|write|create|implement|generate|author|update|modify)\s+(?:a\s+|an\s+|one\s+|the\s+|new\s+|more\s+|additional\s+|focused\s+|narrow\s+|small\s+|unit\s+|integration\s+|e2e\s+|end\s+to\s+end\s+)*spec\b/i.test(searchable)) {
      return true;
    }
    // Direct path mention of a test/spec file — if the user wrote a path
    // ending in .test.{ts,tsx,js,jsx,mjs,cjs} or .spec.{...}, that is an
    // explicit ask regardless of surrounding phrasing.
    if (this.extractExplicitTestPathMentions(request).length > 0) {
      return true;
    }
    return false;
  }

  private extractExplicitTestPathMentions(request: string): string[] {
    if (!request || typeof request !== "string") return [];
    const matches = request.match(/(?:^|[\s"'`(])((?:\.{1,2}\/|\/)?[\w@.-][\w@./-]*\.(?:test|spec)\.[mc]?[jt]sx?)(?=$|[\s"'`),.;:!?])/gi) ?? [];
    const paths = matches
      .map((match) => match.trim().replace(/^["'`(]+/, "").replace(/[)"'`,.;:!?]+$/, ""))
      .filter(Boolean);
    return this.uniqueStrings(paths);
  }

  private isTestFile(filePath: string): boolean {
    return /\.(test|spec)\.[mc]?[jt]sx?$/.test(filePath);
  }

  /**
   * Check if a file exists relative to the supplied projectRoot. Takes
   * projectRoot as a parameter (rather than reading this.config.projectRoot)
   * so per-task overrides via active.projectRoot work correctly.
   */
  private fileExists(filePath: string, projectRoot: string): boolean {
    return existsSync(resolve(projectRoot, filePath));
  }

  // ─── Execution Engine ──────────────────────────────────────────────

  private async executeGraph(active: ActiveRun): Promise<void> {
    const { graph, run, intent } = active;
    let rehearsalRound = 0;
    let iteration = 0;

    console.log(`[coordinator] executeGraph: entering — graph has ${graph.nodes.length} nodes, isComplete=${isGraphComplete(graph)} hasFailedNodes=${hasFailedNodes(graph)}`);

    if (isGraphComplete(graph)) {
      console.warn(`[coordinator] executeGraph: graph is ALREADY COMPLETE on entry — loop will not execute. Node statuses: ${graph.nodes.map(n => `${n.workerType}=${n.status}`).join(", ")}`);
    }

    const graphStartTime = Date.now();

    while (!isGraphComplete(graph) && !active.cancelled) {
      iteration++;

      // ── Execution limits ────────────────────────────────────────
      if (iteration > this.config.maxGraphIterations) {
        const msg = `execution.limits: max graph iterations (${this.config.maxGraphIterations}) exceeded`;
        console.error(`[coordinator] ${msg}`);
        failRun(run, msg);
        await this.persistReceiptCheckpoint(active, {
          at: new Date().toISOString(),
          type: "failure_occurred",
          status: "EXECUTION_ERROR",
          phase: run.phase,
          summary: msg,
          details: { limit: "maxGraphIterations", value: this.config.maxGraphIterations, actual: iteration },
        });
        break;
      }
      const elapsedSec = (Date.now() - graphStartTime) / 1000;
      // Check per-run cost budget
      const currentCost = active.run.totalCost?.estimatedCostUsd ?? 0;
      if (this.config.maxRunCostUsd != null && currentCost > this.config.maxRunCostUsd) {
        const msg = `execution.limits: run cost ($${currentCost.toFixed(2)}) exceeds budget ($${this.config.maxRunCostUsd})`;
        console.warn(`[coordinator] ${msg}`);
        active.cancelled = true;
        failRun(active.run, msg);
        await this.persistReceiptCheckpoint(active, {
          at: new Date().toISOString(),
          type: "failure_occurred",
          status: "EXECUTION_ERROR",
          phase: active.run.phase,
          summary: msg,
          details: { limit: "maxRunCostUsd", value: this.config.maxRunCostUsd, actual: currentCost },
        });
        break;
      }

      if (elapsedSec > this.config.maxRunTimeoutSec) {
        const msg = `execution.limits: run timeout (${this.config.maxRunTimeoutSec}s) exceeded at ${Math.round(elapsedSec)}s`;
        console.error(`[coordinator] ${msg}`);
        failRun(run, msg);
        await this.persistReceiptCheckpoint(active, {
          at: new Date().toISOString(),
          type: "failure_occurred",
          status: "EXECUTION_ERROR",
          phase: run.phase,
          summary: msg,
          details: { limit: "maxRunTimeoutSec", value: this.config.maxRunTimeoutSec, actual: Math.round(elapsedSec) },
        });
        break;
      }

      const dispatchable = getDispatchableNodes(graph);
      console.log(`[coordinator] executeGraph: iteration ${iteration} — ${dispatchable.length} dispatchable, isComplete=${isGraphComplete(graph)} hasFailedNodes=${hasFailedNodes(graph)}`);

      if (dispatchable.length === 0) {
        if (hasFailedNodes(graph)) {
          console.log(`[coordinator] executeGraph: 0 dispatchable + has failed nodes → attempting recovery`);
          const recovered = await this.attemptRecovery(active);
          if (!recovered) {
            console.log(`[coordinator] executeGraph: recovery returned false — breaking loop`);
            break;
          }
          continue;
        }
        console.error(`[coordinator] executeGraph: DEADLOCK — 0 dispatchable, 0 failed. Node statuses: ${graph.nodes.map(n => `${n.workerType}=${n.status}`).join(", ")}`);
        failRun(run, "Task graph deadlocked: no dispatchable nodes");
        break;
      }

      // Wave enforcement: when governance requires waves, only dispatch
      // builder nodes belonging to waves whose upstream waves have completed.
      // Non-builder nodes (scout, critic, verifier, integrator) are not
      // wave-gated — they always dispatch when topologically ready.
      const waveGated = this.applyWaveGating(active, dispatchable);
      if (waveGated.length === 0 && dispatchable.length > 0) {
        // All dispatchable nodes were wave-gated — this means upstream
        // waves haven't completed yet. Wait for current wave to finish.
        console.log(`[coordinator] executeGraph: all ${dispatchable.length} dispatchable node(s) wave-gated — waiting for current wave`);
        continue;
      }

      const phases = waveGated.map((n) => n.workerType);
      console.log(`[coordinator] executeGraph: dispatching ${waveGated.length} node(s) of type(s) [${phases.join(", ")}]${waveGated.length < dispatchable.length ? ` (${dispatchable.length - waveGated.length} wave-gated)` : ""}`);
      if (phases.includes("scout") && run.phase === "scouting") {
        // already in scouting
      } else if (phases.includes("builder")) {
        if (run.phase !== "building") advancePhase(run, "building");
      } else if (phases.includes("critic")) {
        if (run.phase !== "reviewing") advancePhase(run, "reviewing");
      } else if (phases.includes("verifier")) {
        if (run.phase !== "verifying") advancePhase(run, "verifying");
      } else if (phases.includes("integrator")) {
        if (run.phase !== "integrating") advancePhase(run, "integrating");
      }

      const stageTimeoutMs = this.config.maxStageTimeoutSec * 1000;
      const results = await Promise.all(
        waveGated.map(async (node) => {
          const stageStart = Date.now();
          // Drain any prior in-flight dispatch for this node before
          // launching a fresh one. Prevents the "recovery overlaps a
          // timed-out attempt" race that produced ENOENT and dual
          // writeFile contention in earlier live runs.
          const prior = active.pendingDispatches.get(node.id);
          if (prior) {
            console.warn(
              `[coordinator] drain: prior dispatch for node ${node.id.slice(0, 6)} still in flight — awaiting before re-dispatch`,
            );
            await prior.catch(() => undefined);
          }
          // SAFETY: Promise.race with a timeout creates a dangling promise.
          // When the timeout wins, dispatchNode() keeps running. If it later
          // rejects, that rejection was previously unhandled — crashing the
          // process ~4 minutes in. Fix: attach a .catch() to the dispatch
          // promise so its rejection is always handled regardless of which
          // side of the race wins.
          const dispatchPromise = this.dispatchNode(active, node);
          active.pendingDispatches.set(node.id, dispatchPromise);
          let timeoutHandle: ReturnType<typeof setTimeout>;
          let timedOut = false;
          const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(
              () => {
                timedOut = true;
                // Mark the current generation (= node.runTaskId, set by
                // dispatchNode at task creation) as cancelled so any late
                // settlement of dispatchPromise will discard its result.
                if (node.runTaskId) active.cancelledGenerations.add(node.runTaskId);
                // Worker-typed classification prefix so downstream
                // observability (receipts, checkpoints, log greps) can
                // tell a critic timeout apart from a builder/scout/etc
                // timeout without parsing the rest of the message. The
                // [<workerType>_timeout] form is grep-stable across log
                // backends; Builder output already lives on
                // active.changes by the time the critic dispatches, so
                // this synthetic failure does not discard upstream work.
                const classificationTag = `[${node.workerType}_timeout] `;
                reject(new Error(`${classificationTag}execution.limits: stage timeout (${this.config.maxStageTimeoutSec}s) exceeded for ${node.workerType} ${node.id.slice(0, 6)}`));
              },
              stageTimeoutMs,
            );
          });
          const result = await Promise.race([
            dispatchPromise,
            timeoutPromise,
          ]).then(
            (value) => { clearTimeout(timeoutHandle!); return value; },
            (err) => { clearTimeout(timeoutHandle!); throw err; },
          ).catch((err): { node: TaskNode; result: WorkerResult } => {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[coordinator] ${msg}`);
            if (timedOut) {
              this.persistReceiptCheckpoint(active, {
                at: new Date().toISOString(),
                type: "worker_step",
                status: "EXECUTING_IN_WORKSPACE",
                phase: run.phase,
                summary: `[${node.workerType}_timeout] stage-timeout cancelled ${node.workerType} ${node.id.slice(0, 6)}`,
                details: {
                  cancelledGenerationId: node.runTaskId ?? null,
                  workerType: node.workerType,
                  nodeId: node.id,
                  stageTimeoutSec: this.config.maxStageTimeoutSec,
                  classification: `${node.workerType}_timeout`,
                },
              }).catch(() => undefined);
            }
            return {
              node,
              result: {
                taskId: node.runTaskId ?? node.id,
                workerType: node.workerType,
                success: false,
                confidence: 0,
                output: { kind: node.workerType } as WorkerResult["output"],
                touchedFiles: [],
                issues: [{ severity: "error" as const, message: msg }],
                assumptions: [],
                cost: { model: "", inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
                durationMs: Date.now() - stageStart,
              },
            };
          });
          // Defuse the dangling dispatch promise: if the timeout won the
          // race, dispatchNode() is still running. When it eventually
          // settles, swallow its result/error so it doesn't become an
          // unhandled rejection that crashes the process.
          dispatchPromise
            .catch((danglingErr) => {
              console.warn(
                `[coordinator] defused dangling dispatch for ${node.workerType} ${node.id.slice(0, 6)}: ${danglingErr instanceof Error ? danglingErr.message : String(danglingErr)}`,
              );
            })
            .finally(() => {
              if (active.pendingDispatches.get(node.id) === dispatchPromise) {
                active.pendingDispatches.delete(node.id);
              }
            });
          return result;
        })
      );

      let waveSucceeded = 0;
      let waveFailed = 0;
      const waveFailureMessages: string[] = [];
      for (const { node, result } of results) {
        if (result.success) {
          markCompleted(graph, node.id);
          this.collectChanges(active, result);
          waveSucceeded += 1;
          // Enrich the completion event for Builder nodes with the actual
          // FileChange array so the UI can stream the +/- diff live.
          // Workers are constructed without an eventBus in server/index.ts,
          // so their internal this.eventBus?.emit calls silently drop —
          // this generic event is the one the UI actually receives.
          const builderPayload: Record<string, unknown> = {};
          if (node.workerType === "builder" && result.output.kind === "builder") {
            const changes = result.output.changes ?? [];
            const first = changes[0];
            if (first) {
              builderPayload.file = first.path;
              builderPayload.path = first.path;
              builderPayload.operation = first.operation;
            }
            // Concatenate every file's unified diff so a multi-file
            // Builder (rare, but possible on a single deliverable) can
            // stream all hunks in one event. The UI keys by
            // "diff --git a/<path>" so duplicates replace rather than
            // double-append.
            const combined = changes
              .map((c) => (typeof c.diff === "string" ? c.diff : ""))
              .filter((s) => s.trim().length > 0)
              .join("\n");
            if (combined.trim()) {
              builderPayload.diff = combined;
            }
            builderPayload.changes = changes.map((c) => ({
              path: c.path,
              operation: c.operation,
              diff: c.diff ?? "",
            }));
          }
          this.emit({
            type: workerCompleteEventType(node.workerType as WorkerType),
            payload: {
              runId: active.run.id,
              taskId: node.id,
              confidence: result.confidence,
              ...builderPayload,
            },
          });
        } else {
          console.warn(`[coordinator] executeGraph: marking node ${node.id.slice(0, 6)} (${node.workerType}) as FAILED — issue: ${result.issues[0]?.message ?? "(no message)"}`);
          markFailed(graph, node.id);
          waveFailed += 1;
          waveFailureMessages.push(`${node.workerType}(${node.id.slice(0, 6)}): ${result.issues[0]?.message ?? "(no message)"}`);
          this.emit({
            type: "task_failed",
            payload: { runId: active.run.id, taskId: node.id, error: result.issues[0]?.message },
          });
        }

        for (const assumption of result.assumptions) {
          recordAssumption(run, {
            statement: assumption,
            acceptedBy: "coordinator",
            taskId: node.runTaskId,
          });
        }
      }

      // Partial-wave failure isolation: when a dispatch batch had a
      // mix of completed and failed workers, emit an explicit partial-
      // failure signal and persist a checkpoint so the receipt doesn't
      // have to infer "something went wrong" from the task-failed
      // stream alone. Sibling workers have already been collected
      // via the per-node catch above — there is no mid-flight
      // cancellation; this is purely observability.
      if (waveFailed > 0 && waveSucceeded > 0 && results.length > 1) {
        const summary = `wave partial failure: ${waveSucceeded} succeeded, ${waveFailed} failed (${phases.join(", ")})`;
        console.warn(`[coordinator] ${summary}`);
        this.emit({
          type: "wave_partial_failure",
          payload: {
            runId: active.run.id,
            succeeded: waveSucceeded,
            failed: waveFailed,
            workerTypes: phases,
            failureMessages: waveFailureMessages.slice(0, 5),
          },
        });
        await this.persistReceiptCheckpoint(active, {
          at: new Date().toISOString(),
          type: "worker_step",
          status: "EXECUTING_IN_WORKSPACE",
          phase: run.phase,
          summary,
          details: {
            succeeded: waveSucceeded,
            failed: waveFailed,
            workerTypes: phases,
            failureMessages: waveFailureMessages.slice(0, 5),
          },
        });
      }

      // GAP 4 — Confidence-based escalation: if a builder completed
      // with low confidence, retry with a better model (capped at 1
      // escalation per run). The escalation result is logged and
      // added to the run receipt via the workerResults array.
      for (const { node, result } of results) {
        if (
          node.workerType === "builder" &&
          result.success &&
          typeof result.confidence === "number" &&
          result.confidence < 0.6 &&
          active.runInvocationContext.escalationCount < 1
        ) {
          console.log(
            `[coordinator] GAP4: builder ${node.id.slice(0, 6)} confidence=${(result.confidence * 100).toFixed(0)}% — attempting escalation`,
          );
          const escalation = await escalateOnLowConfidence(
            result.confidence,
            {
              provider: "anthropic",
              model: "claude-sonnet-4-6",
              prompt: active.normalizedInput,
              systemPrompt: `You are a senior software engineer. The previous attempt had low confidence (${(result.confidence * 100).toFixed(0)}%). Review and improve the output.`,
              runId: active.run.id,
            },
            active.runInvocationContext,
          );
          if (escalation.escalated && escalation.result) {
            console.log(
              `[coordinator] GAP4: escalation succeeded — cost=$${escalation.result.costUsd.toFixed(6)}`,
            );
            recordDecision(run, {
              description: `Confidence escalation: builder ${node.id.slice(0, 6)} at ${(result.confidence * 100).toFixed(0)}% → retried with ${escalation.escalationModel}`,
              madeBy: "coordinator",
              taskId: node.runTaskId,
              alternatives: ["Accept low-confidence result"],
              rationale: escalation.reason,
            });
          } else {
            console.log(`[coordinator] GAP4: escalation skipped/failed — ${escalation.reason}`);
          }
        }
      }

      const criticResults = results.filter((r) => r.node.workerType === "critic");
      for (const { result } of criticResults) {
        if (
          result.output.kind === "critic" &&
          result.output.verdict === "request-changes" &&
          rehearsalRound < this.config.maxRehearsalRounds
        ) {
          rehearsalRound++;
          console.log(`[coordinator] executeGraph: rehearsal round ${rehearsalRound}/${this.config.maxRehearsalRounds} — Critic requested changes`);
          this.emit({
            type: "critic_review",
            payload: {
              runId: active.run.id,
              verdict: "request-changes",
              round: rehearsalRound,
              confidence: result.confidence,
            },
          });
          recordDecision(run, {
            description: `Rehearsal round ${rehearsalRound}: Critic requested changes`,
            madeBy: "coordinator",
            taskId: null,
            alternatives: ["Accept as-is", "Abort run"],
            rationale: "Critic identified issues; re-running builders with feedback",
          });
        }
      }

      await this.evaluateCheckpoints(active);
    }

    console.log(`[coordinator] executeGraph: loop exited after ${iteration} iteration(s) — isComplete=${isGraphComplete(graph)} hasFailedNodes=${hasFailedNodes(graph)} cancelled=${active.cancelled}`);
  }

  private normalizeRunPath(path: string): string {
    return path.replace(/\\/g, "/").replace(/^\.\//, "");
  }

  private changedBuilderFiles(result: WorkerResult): string[] {
    if (result.output.kind !== "builder") return [];
    return [...new Set(result.output.changes.map((change) => this.normalizeRunPath(change.path)))].sort();
  }

  private builderChangesByPath(result: WorkerResult): Map<string, FileChange[]> {
    const changes = new Map<string, FileChange[]>();
    if (result.output.kind !== "builder") return changes;
    for (const change of result.output.changes) {
      const path = this.normalizeRunPath(change.path);
      const existing = changes.get(path) ?? [];
      existing.push(change);
      changes.set(path, existing);
    }
    return changes;
  }

  private fileChangeHasEffectiveContent(change: FileChange): boolean {
    if (change.operation === "create" || change.operation === "delete") return true;
    if (typeof change.originalContent === "string" && typeof change.content === "string") {
      return change.originalContent !== change.content;
    }
    if (typeof change.diff === "string" && change.diff.trim().length > 0) {
      return change.diff
        .split(/\r?\n/)
        .some((line) =>
          (line.startsWith("+") && !line.startsWith("+++")) ||
          (line.startsWith("-") && !line.startsWith("---")),
        );
    }
    return true;
  }

  private requiredBuilderDeliverables(active: ActiveRun, node: TaskNode): string[] {
    const nodeTargets = new Set(node.targetFiles.map((file) => this.normalizeRunPath(file)));
    return active.changeSet.filesInScope
      .filter((file) => file.mutationExpected)
      .map((file) => this.normalizeRunPath(file.path))
      .filter((file) => nodeTargets.size === 0 || nodeTargets.has(file))
      .filter((file, index, files) => files.indexOf(file) === index)
      .sort();
  }

  private missingRequiredBuilderDeliverables(
    active: ActiveRun,
    node: TaskNode,
    result: WorkerResult,
  ): string[] {
    if (!result.success || result.output.kind !== "builder") return [];
    const changed = new Set(this.changedBuilderFiles(result));
    return this.requiredBuilderDeliverables(active, node)
      .filter((file) => !changed.has(file));
  }

  private async noEffectiveRequiredBuilderDeliverables(
    active: ActiveRun,
    node: TaskNode,
    result: WorkerResult,
  ): Promise<string[]> {
    if (!result.success || result.output.kind !== "builder") return [];
    const changed = this.builderChangesByPath(result);
    const noEffective: string[] = [];
    for (const file of this.requiredBuilderDeliverables(active, node)) {
      const changes = changed.get(file);
      if (!changes || changes.length === 0) continue;
      const structuralChange = changes.some((change) => change.operation === "create" || change.operation === "delete");
      if (structuralChange) continue;
      const contentLooksEffective = changes.some((change) => this.fileChangeHasEffectiveContent(change));

      if (!contentLooksEffective) {
        try {
          await exec("git", ["diff", "--quiet", "--", file], { cwd: active.projectRoot });
        } catch {
          continue;
        }
        noEffective.push(file);
        continue;
      }

      try {
        await exec("git", ["diff", "--quiet", "--", file], { cwd: active.projectRoot });
        noEffective.push(file);
      } catch {
        continue;
      }
    }
    return noEffective.sort();
  }

  private missingRequiredBuilderFailure(
    result: WorkerResult,
    requiredFiles: readonly string[],
    missingRequired: readonly string[],
  ): WorkerResult {
    const message =
      `missing_required_deliverable: Builder did not modify required file(s): ` +
      `${missingRequired.join(", ")}. Required files for this dispatch: ${requiredFiles.join(", ")}.`;
    return {
      ...result,
      success: false,
      confidence: 0,
      issues: [
        { severity: "error" as const, message },
        ...result.issues,
      ],
      output: {
        kind: "builder" as const,
        changes: [],
        decisions: result.output.kind === "builder" ? result.output.decisions : [],
        needsCriticReview: true,
      },
      touchedFiles: result.touchedFiles.filter((touch) => touch.operation === "read"),
    };
  }

  private noEffectiveBuilderFailure(
    result: WorkerResult,
    requiredFiles: readonly string[],
    noEffectiveFiles: readonly string[],
  ): WorkerResult {
    const message =
      `content_identical_output: Builder reported required file(s) but produced no effective diff: ` +
      `${noEffectiveFiles.join(", ")}. Required files for this dispatch: ${requiredFiles.join(", ")}.`;
    return {
      ...result,
      success: false,
      confidence: 0,
      issues: [
        { severity: "error" as const, message },
        ...result.issues,
      ],
      output: {
        kind: "builder" as const,
        changes: [],
        decisions: result.output.kind === "builder" ? result.output.decisions : [],
        needsCriticReview: true,
      },
      touchedFiles: result.touchedFiles.filter((touch) => touch.operation === "read"),
    };
  }

  private async dispatchNode(
    active: ActiveRun,
    node: TaskNode
  ): Promise<{ node: TaskNode; result: WorkerResult }> {
    const { run, intent, graph } = active;

    console.log(`[coordinator] dispatchNode: ${node.workerType} (${node.id.slice(0, 6)}) — ${node.targetFiles.length} target file(s)`);

    const runTask = addTask(run, {
      workerType: node.workerType,
      description: node.label,
      targetFiles: [...node.targetFiles],
      parentTaskId: null,
    });
    markDispatched(graph, node.id, runTask.id);
    startTask(run, runTask.id, node.workerType);

    this.emit({
      type: "task_started",
      payload: { runId: active.run.id, taskId: node.id, workerType: node.workerType },
    });
    await this.persistReceiptWorkerEvent(active, {
      at: new Date().toISOString(),
      workerType: node.workerType,
      taskId: runTask.id,
      status: "started",
      summary: node.label,
      confidence: null,
      costUsd: 0,
      filesTouched: [...node.targetFiles],
      issues: [],
    });

    // Use the per-submit ContextAssembler from active so the per-task
    // projectRoot is honored.
    const contextTargets = this.builderContextTargets(active, node, "initial");
    if (
      node.workerType === "builder" &&
      contextTargets.length > node.targetFiles.length
    ) {
      console.log(
        `[coordinator] dispatchNode: widened builder context from ${node.targetFiles.length} to ` +
        `${contextTargets.length} file(s): ${contextTargets.join(", ")}`,
      );
    }
    const context = await active.contextAssembler.assemble([...contextTargets]);
    if (node.workerType === "builder" && !active.implementationBrief) {
      active.implementationBrief = buildMinimalImplementationBrief({
        intent: active.intent,
        rawUserPrompt: active.rawUserPrompt,
        normalizedPrompt: active.normalizedInput,
        error: "Builder dispatch reached execution without a prepared implementation brief",
        analysis: active.analysis,
        charter: active.intent.charter,
        scope: active.scopeClassification,
        dispatchableFiles: node.targetFiles,
        rejectedCandidates: active.rejectedCandidates,
      });
      this.receiptStore.patchRun(active.run.id, {
        implementationBrief: briefToReceiptJson(active.implementationBrief),
      }).catch(() => {});
    }
    if (
      node.workerType === "builder" &&
      active.implementationBrief &&
      context.rejectedCandidates.length > 0
    ) {
      active.implementationBrief = briefWithRejectedCandidates(
        active.implementationBrief,
        context.rejectedCandidates,
      );
      this.receiptStore.patchRun(active.run.id, {
        implementationBrief: briefToReceiptJson(active.implementationBrief),
      }).catch(() => {});
    }

    let routingDecision = this.trustRouter.route(runTask, intent, context);
    node.assignedTier = routingDecision.tier;
    console.log(`[coordinator] dispatchNode: ${node.workerType} routed to tier=${routingDecision.tier}`);
    const initialTier = routingDecision.tier;
    const routingEscalations: ReceiptRoutingEscalation[] = [];

    // Capability-floor enforcement: compare the chosen tier against the
    // minimum the Implementation Brief says this task needs. On a
    // Builder, a broad/architectural task routed to the fast tier is
    // very likely to produce a weak diff; bump to at least the brief's
    // floor so the model has a fair shot. For Critic/Verifier/etc the
    // floor is advisory — we only log, not mutate, to avoid silently
    // blowing cost budgets on review passes.
    if (node.workerType === "builder" && active.implementationBrief) {
      const floor = capabilityFloorForBrief(active.implementationBrief);
      const tierOrder = ["fast", "standard", "premium"] as const;
      const currentIdx = tierOrder.indexOf(routingDecision.tier);
      const floorIdx = tierOrder.indexOf(floor.floor);
      if (currentIdx < floorIdx) {
        const previousTier = routingDecision.tier;
        console.warn(
          `[coordinator] capability-floor: builder tier=${routingDecision.tier} below floor=${floor.floor} (${floor.reason}) — escalating`,
        );
        const escalatedAssignment = this.trustRouter.buildAssignment(
          { ...routingDecision, tier: floor.floor },
          runTask,
          intent,
          context,
          [],
        );
        // Preserve the escalation decision on the node + emit so receipts show it.
        routingDecision = { ...routingDecision, tier: floor.floor };
        node.assignedTier = floor.floor;
        if (active.capabilityFloorApplied) {
          active.capabilityFloorApplied = {
            ...active.capabilityFloorApplied,
            escalated: true,
          };
        }
        void escalatedAssignment; // buildDispatchAssignment rebuilds below
        routingEscalations.push({
          at: new Date().toISOString(),
          from: previousTier,
          to: floor.floor,
          reason: "capability-floor",
          detail: floor.reason,
        });
        this.emit({
          type: "escalation_triggered",
          payload: { runId: active.run.id, taskId: node.id, from: previousTier, to: floor.floor },
        });
      }
    }

    // Persist the routing decision now that capability-floor has had its say.
    // Tier on the receipt entry is the *initial* router pick; the
    // capability-floor escalation (if any) appears in escalations[].
    // Subsequent weak-output retries append further escalations to the
    // same row (mergeRoutingDecisions in receipt-store handles dedupe by
    // taskId). Best-effort write — receipt persistence must never block
    // the dispatch path.
    const initialRouting: ReceiptRoutingDecision = {
      at: new Date().toISOString(),
      taskId: runTask.id,
      workerType: node.workerType,
      tier: initialTier,
      rationale: routingDecision.rationale,
      complexityScore: routingDecision.complexity.score,
      blastRadiusLevel: routingDecision.blastRadius.level,
      riskSignals: routingDecision.blastRadius.riskSignals,
      estimatedCostUsd: routingDecision.estimatedCostUsd,
      tokenBudget: routingDecision.tokenBudget,
      criticReviewRequired: routingDecision.requiresCriticReview,
      escalations: routingEscalations,
    };
    this.receiptStore
      .patchRun(active.run.id, { appendRouting: [initialRouting] })
      .catch(() => undefined);

    this.emit({
      type: "worker_assigned",
      payload: { runId: active.run.id, taskId: node.id, tier: routingDecision.tier, workerType: node.workerType },
    });

    const escalation = active.graph.escalationBoundaries.find((b) => b.nodeId === node.id);
    if (escalation) {
      const tierOrder = ["fast", "standard", "premium"] as const;
      const currentIdx = tierOrder.indexOf(routingDecision.tier);
      const minIdx = tierOrder.indexOf(escalation.minimumTier);
      if (currentIdx < minIdx) {
        this.emit({
          type: "escalation_triggered",
          payload: { runId: active.run.id, taskId: node.id, from: routingDecision.tier, to: escalation.minimumTier },
        });
      }
    }

    const upstreamResults = active.workerResults.filter((r) =>
      graph.edges.some((e) => e.to === node.id && e.from === graph.nodes.find((n) => n.runTaskId === r.taskId)?.id)
    );

    const recentContext = this.resolveRecentContext(active, node);
    const assignment: WorkerAssignment = buildDispatchAssignment({
      decision: routingDecision,
      task: runTask,
      intent,
      context,
      upstreamResults,
      runState: run,
      changes: active.changes,
      workerResults: active.workerResults,
      projectRoot: active.projectRoot,
      sourceRepo: active.sourceRepo,
      recentContext,
      implementationBrief: active.implementationBrief,
      signal: active.runAbortController.signal,
      fastPath: active.fastPath || undefined,
      buildAssignment: (decision, task, intent, context, upstreamResults) =>
        this.trustRouter.buildAssignment(decision, task, intent, context, upstreamResults),
    });

    // ── Phase D: per-lane model dispatch for the primary builder ────
    // When the lane config specifies a primary provider/model and the
    // mode is not primary_only (which uses whatever the registry has),
    // create a transient lane-pinned builder so the primary lane
    // actually executes on the configured model instead of the
    // registry default. Non-builder nodes always use the registry.
    let worker = this.workerRegistry.getWorker(node.workerType as WorkerType);
    if (
      node.workerType === "builder" &&
      active.laneConfig.mode !== "primary_only" &&
      active.laneConfig.primary?.provider &&
      active.laneConfig.primary?.model
    ) {
      const factory = this.config.laneBuilderFactory ?? createBuilderForLane;
      const pinnedPrimary = factory({
        projectRoot: active.projectRoot,
        provider: active.laneConfig.primary.provider,
        model: active.laneConfig.primary.model,
        runState: active.run,
      });
      if (pinnedPrimary) {
        worker = pinnedPrimary;
        console.log(
          `[coordinator] dispatchNode: primary builder pinned to ` +
          `${active.laneConfig.primary.provider}/${active.laneConfig.primary.model} ` +
          `(lane=${active.laneConfig.primary.lane}, mode=${active.laneConfig.mode})`,
        );
      } else {
        console.warn(
          `[coordinator] dispatchNode: lane-config.primary.provider="${active.laneConfig.primary.provider}" ` +
          `unsupported — primary builder falls back to registry default`,
        );
      }
    }
    if (!worker) {
      console.error(`[coordinator] dispatchNode: NO WORKER REGISTERED for type "${node.workerType}". This is a hidden silent-failure path — runPreBuildCoherence may have used hasWorker() which disagrees with getWorker().`);
      const failResult: WorkerResult = {
        workerType: node.workerType as WorkerType,
        taskId: runTask.id,
        success: false,
        output: { kind: "scout", dependencies: [], patterns: [], riskAssessment: { level: "low", factors: [], mitigations: [] }, suggestedApproach: "" },
        issues: [{ severity: "error", message: `No worker registered for type "${node.workerType}"` }],
        cost: { model: "", inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
        confidence: 0,
        touchedFiles: [],
        assumptions: [],
        durationMs: 0,
      };
      completeTask(run, runTask.id, { success: false, output: failResult.issues[0].message, artifacts: [], issues: failResult.issues });
      active.workerResults.push(failResult);
      return { node, result: failResult };
    }

    const syntheticFailure = (message: string): WorkerResult => ({
      workerType: node.workerType as WorkerType,
      taskId: runTask.id,
      success: false,
      output: { kind: "scout", dependencies: [], patterns: [], riskAssessment: { level: "low", factors: [], mitigations: [] }, suggestedApproach: "" },
      issues: [{ severity: "error", message }],
      cost: { model: "", inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
      confidence: 0,
      touchedFiles: [],
      assumptions: [],
      durationMs: 0,
    });

    // ── Deterministic transform pre-pass ────────────────────────────
    // For builder nodes, try a regex+brace-counter transform before
    // calling the LLM. If the task shape is recognized AND the file
    // matches a supported pattern, the transform applies a clean,
    // minimal patch and we synthesize a successful BuilderResult.
    // Otherwise we fall through to worker.execute() with the brief.
    let deterministic: DeterministicBuilderResult | null = null;
    let result: WorkerResult;
    if (node.workerType === "builder") {
      try {
        deterministic = await tryDeterministicBuilder({
          projectRoot: active.projectRoot,
          userRequest: active.intent.userRequest ?? active.normalizedInput,
          targetFiles: [...node.targetFiles],
          brief: active.implementationBrief ?? null,
          tier: routingDecision.tier,
          generationId: runTask.id,
        });
      } catch (detErr) {
        console.warn(
          `[coordinator] deterministic transform threw: ${detErr instanceof Error ? detErr.message : String(detErr)} — falling through to LLM Builder`,
        );
        deterministic = null;
      }
    }

    if (deterministic && deterministic.kind === "applied") {
      const appliedFiles = deterministic.applied;
      const deterministicModel = appliedFiles.length === 1
        ? `deterministic/${appliedFiles[0].transform.transformType}`
        : `deterministic/${appliedFiles.map((a) => a.transform.transformType).join("+")}`;
      console.log(
        `[coordinator] deterministic builder: ${deterministic.summary} — skipping LLM Builder for this dispatch`,
      );
      if (deterministic.targetRoles && deterministic.targetRoles.length > 0) {
        active.changeSet = applyFileMutationRoles(active.changeSet, deterministic.targetRoles);
        if (active.plan) {
          active.plan = planChangeSet(active.changeSet, active.normalizedInput);
        }
      }
      // Persist a per-target builder attempt record + a transform receipt entry.
      const attemptRecords = appliedFiles.map((a) => a.attemptRecord);
      this.receiptStore.patchRun(active.run.id, {
        appendBuilderAttempts: attemptRecords as unknown as readonly unknown[],
      }).catch(() => undefined);
      await this.persistReceiptCheckpoint(active, {
        at: new Date().toISOString(),
        type: "worker_step",
        status: "EXECUTING_IN_WORKSPACE",
        phase: run.phase,
        summary: `deterministic transform applied: ${deterministic.summary}`,
        details: {
          taskShape: deterministic.taskShape,
          applied: appliedFiles.map((a) => ({
            file: a.file,
            transformType: a.transform.transformType,
            matchedPattern: a.transform.matchedPattern,
            insertedSnippetSummary: a.transform.insertedSnippetSummary,
            exportsBefore: a.transform.exportDiff.original,
            exportsAfter: a.transform.exportDiff.proposed,
            exportsMissing: a.transform.exportDiff.missing,
            exportsAdded: a.transform.exportDiff.added,
            notes: a.transform.notes,
          })),
          skippedTargets: deterministic.skipped.map((s) => ({
            file: s.file,
            reasonCode: s.reasonCode,
            reason: s.reason,
          })),
          targetRoles: active.changeSet.filesInScope.map((file) => ({
            file: file.path,
            role: file.mutationRole,
            mutationExpected: file.mutationExpected,
            reason: file.mutationReason,
          })),
        },
      });

      // Synthesize a successful BuilderResult from the applied changes.
      const changes = appliedFiles.map((a) => ({
        path: a.file,
        operation: "modify" as const,
        diff: a.transform.diff,
        originalContent: a.transform.originalContent,
        content: a.transform.updatedContent,
      }));
      const summaryContract = {
        file: appliedFiles[0]?.file ?? "",
        scopeFiles: appliedFiles.map((a) => a.file),
        siblingFiles: appliedFiles.slice(1).map((a) => a.file),
        mode: appliedFiles.length > 1 ? "coordinated-multi-file" as const : "single-file" as const,
        goal: deterministic.summary,
        constraints: [],
        forbiddenChanges: [],
        interfaceRules: ["deterministic transform — no LLM was invoked"],
      };
      const decisions = appliedFiles.map((a) => ({
        description: `Deterministic transform: ${a.transform.transformType} on ${a.file}`,
        rationale: a.transform.notes,
        alternatives: ["Fall back to LLM Builder"],
      }));
      result = {
        workerType: "builder",
        taskId: runTask.id,
        success: true,
        output: {
          kind: "builder",
          changes,
          decisions,
          needsCriticReview: false,
          contract: summaryContract,
          prompt: `[deterministic transform — no model prompt]`,
          rawModelResponse: `[deterministic transform — no model response]`,
          providerFindings: [],
          attemptRecords,
        } as unknown as WorkerResult["output"],
        issues: [],
        cost: { model: deterministicModel, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
        confidence: 0.95,
        touchedFiles: appliedFiles.flatMap((a) => [
          { path: a.file, operation: "read" as const },
          { path: a.file, operation: "modify" as const },
        ]),
        assumptions: [],
        durationMs: 1,
      };
      this.emit({
        type: "builder_complete",
        payload: {
          runId: active.run.id,
          taskId: node.id,
          file: appliedFiles[0]?.file,
          path: appliedFiles[0]?.file,
          operation: "modify",
          model: deterministicModel,
          provider: "deterministic",
          costUsd: 0,
          tokensIn: 0,
          tokensOut: 0,
          fellBack: false,
          sectionMode: false,
          confidence: 0.95,
          deterministic: true,
          diff: changes.map((c) => c.diff).join("\n"),
        },
      });
    } else {
      if (deterministic && deterministic.kind === "skipped" && deterministic.skipped.length > 0) {
        const skipSummary = deterministic.skipped
          .map((s) => `${s.file}:${s.reasonCode}`)
          .join(" | ");
        console.log(
          `[coordinator] deterministic transform skipped (${deterministic.reason}); skipped targets: ${skipSummary} — falling through to LLM Builder`,
        );
        await this.persistReceiptCheckpoint(active, {
          at: new Date().toISOString(),
          type: "worker_step",
          status: "EXECUTING_IN_WORKSPACE",
          phase: run.phase,
          summary: `deterministic transform skipped: ${deterministic.reason}`,
          details: {
            taskShape: deterministic.taskShape,
            skipped: deterministic.skipped.map((s) => ({
              file: s.file,
              reasonCode: s.reasonCode,
              reason: s.reason,
            })),
          },
        });
      }
      try {
        result = await worker.execute(assignment);
        console.log(`[coordinator] dispatchNode: ${node.workerType} returned success=${result.success} confidence=${result.confidence} touchedFiles=${result.touchedFiles.length} issues=${result.issues.length}`);
      } catch (err) {
        const errMessage = err instanceof Error ? err.message : String(err);
        console.error(`[coordinator] dispatchNode: ${node.workerType} EXECUTE THREW — ${errMessage}`);
        if (err instanceof Error && err.stack) {
          console.error(`[coordinator] dispatchNode: stack:\n${err.stack}`);
        }
        result = syntheticFailure(`Worker threw: ${errMessage}`);
      }
      await this.persistProviderAttempts(active, runTask.id, result);
    }

    // ── Weak-output recovery ─────────────────────────────────────────
    // Attempt 1 uses the routed tier. Attempt 2 sharpens the brief on
    // the same tier. If that still fails and a stronger tier resolves
    // to a distinct model, attempt 3 escalates to that stronger tier.
    if (
      node.workerType === "builder" &&
      !result.success &&
      active.implementationBrief
    ) {
      const builderConfig = loadModelConfigFromDisk(active.sourceRepo);
      let currentTier = assignment.tier;
      while (!result.success && active.weakOutputRetries < 2) {
        const errMsg = result.issues[0]?.message ?? "";
        const finding = classifyWeakOutput({ builderError: errMsg, changeCount: 0 });
        if (!finding.retriable || finding.reason === "unknown") {
          console.log(
            `[coordinator] weak-output recovery: not retriable (reason=${finding.reason}) — surfacing failure as-is`,
          );
          break;
        }

        let retryTier = currentTier;
        let retryMode = "same-model";
        if (active.weakOutputRetries >= 1) {
          const stronger = findNextStrongerBuilderTier(builderConfig, currentTier);
          if (!stronger) {
            console.log(
              `[coordinator] weak-output recovery: attempt 3 unavailable — no stronger distinct builder tier after ${currentTier}`,
            );
            break;
          }
          retryTier = stronger.tier;
          retryMode = `stronger-model ${stronger.identity}`;
          node.assignedTier = stronger.tier;
          this.emit({
            type: "escalation_triggered",
            payload: { runId: active.run.id, taskId: node.id, from: currentTier, to: stronger.tier },
          });
          // Record on the persisted routing row for this task. Same-task
          // escalations merge into the existing entry's escalations[]
          // via mergeRoutingDecisions.
          this.receiptStore
            .patchRun(active.run.id, {
              appendRouting: [{
                at: new Date().toISOString(),
                taskId: runTask.id,
                workerType: node.workerType,
                // tier and other fields here are placeholders — the
                // merger ignores them when an entry already exists for
                // this taskId; only escalations[] are appended.
                tier: stronger.tier,
                rationale: "weak-output retry escalation",
                complexityScore: 0,
                blastRadiusLevel: "",
                riskSignals: [],
                estimatedCostUsd: 0,
                tokenBudget: 0,
                criticReviewRequired: false,
                escalations: [{
                  at: new Date().toISOString(),
                  from: currentTier,
                  to: stronger.tier,
                  reason: "weak-output-retry",
                  detail: stronger.identity,
                }],
              }],
            })
            .catch(() => undefined);
        }

        active.weakOutputRetries += 1;
        const retryHint = retryTier === currentTier
          ? finding.retryHint
          : `${finding.retryHint} Stronger model assigned for this final retry.`;
        let retryBrief = briefWithRetryHint(active.implementationBrief, retryHint);
        let retryContext = assignment.context;
        const retryContextTargets = this.builderContextTargets(active, node, "retry");
        if (retryContextTargets.length > 0) {
          retryContext = await active.contextAssembler.assemble([...retryContextTargets]);
          if (retryContext.rejectedCandidates.length > 0) {
            retryBrief = briefWithRejectedCandidates(retryBrief, retryContext.rejectedCandidates);
          }
        }
        active.implementationBrief = retryBrief;
        const retryAssignment: WorkerAssignment = {
          ...assignment,
          tier: retryTier,
          context: retryContext,
          implementationBrief: retryBrief,
        };
        this.emit({
          type: "system_event",
          payload: {
            runId: active.run.id,
            checkpointLabel: "weak_output_retry",
            summary:
              `weak-output retry ${retryBrief.attempt} (${finding.reason}, ${retryMode}): ` +
              `${errMsg.slice(0, 100)}`,
          },
        });
        this.receiptStore.patchRun(active.run.id, {
          implementationBrief: briefToReceiptJson(retryBrief),
        }).catch(() => {});
        try {
          const retryResult = await worker.execute(retryAssignment);
          console.log(
            `[coordinator] weak-output retry attempt=${retryBrief.attempt} tier=${retryTier} ` +
            `success=${retryResult.success} confidence=${retryResult.confidence} reason=${finding.reason}`,
          );
          result = retryResult;
          currentTier = retryTier;
        } catch (retryErr) {
          const rmsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          console.warn(`[coordinator] weak-output retry attempt=${retryBrief.attempt} threw: ${rmsg}`);
          result = syntheticFailure(`Retry failed: ${rmsg} (original: ${errMsg})`);
          currentTier = retryTier;
        }
        await this.persistProviderAttempts(active, runTask.id, result);
      }
    }

    // ── Required-deliverable completeness recovery ──────────────────
    // A Builder can technically "succeed" while only editing one side of
    // an explicitly requested source+test pair. Catch that before the
    // partial result is accepted into active.changes, retry once with the
    // exact missing path(s), and otherwise fail with a specific reason.
    if (node.workerType === "builder" && active.implementationBrief) {
      let missingRequired = this.missingRequiredBuilderDeliverables(active, node, result);
      if (result.success && missingRequired.length > 0) {
        const requiredFiles = this.requiredBuilderDeliverables(active, node);
        console.warn(
          `[coordinator] missing_required_deliverable: builder ${node.id.slice(0, 6)} missed ` +
          `${missingRequired.join(", ")}`,
        );

        if (active.weakOutputRetries < 2) {
          active.weakOutputRetries += 1;
          const retryHint =
            `The previous Builder attempt was incomplete. It changed only ` +
            `${this.changedBuilderFiles(result).join(", ") || "no files"}, but this task requires edits to ` +
            `${requiredFiles.join(", ")}. Retry now and modify every missing required file exactly: ` +
            `${missingRequired.join(", ")}. Do not return a test-only or source-only patch.`;
          const retryBrief = briefWithRetryHint(active.implementationBrief, retryHint);
          active.implementationBrief = retryBrief;
          this.receiptStore.patchRun(active.run.id, {
            implementationBrief: briefToReceiptJson(retryBrief),
          }).catch(() => {});
          this.emit({
            type: "system_event",
            payload: {
              runId: active.run.id,
              checkpointLabel: "missing_required_deliverable_retry",
              summary: `retry builder for missing required file(s): ${missingRequired.join(", ")}`,
            },
          });

          try {
            const retryResult = await worker.execute({
              ...assignment,
              implementationBrief: retryBrief,
            });
            await this.persistProviderAttempts(active, runTask.id, retryResult);
            result = retryResult;
            missingRequired = this.missingRequiredBuilderDeliverables(active, node, result);
            console.log(
              `[coordinator] missing-required retry attempt=${retryBrief.attempt} ` +
              `success=${result.success} remaining=${missingRequired.join(", ") || "none"}`,
            );
          } catch (retryErr) {
            const rmsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
            result = syntheticFailure(
              `missing_required_deliverable: retry failed while attempting missing required file(s) ` +
              `${missingRequired.join(", ")}: ${rmsg}`,
            );
            missingRequired = this.missingRequiredBuilderDeliverables(active, node, result);
          }
        }

        if (result.success && missingRequired.length > 0) {
          result = this.missingRequiredBuilderFailure(
            result,
            requiredFiles,
            missingRequired,
          );
        }
      }

      if (result.success && missingRequired.length === 0) {
        const requiredFiles = this.requiredBuilderDeliverables(active, node);
        let noEffectiveFiles = await this.noEffectiveRequiredBuilderDeliverables(active, node, result);
        if (noEffectiveFiles.length > 0) {
          console.warn(
            `[coordinator] content_identical_output: builder ${node.id.slice(0, 6)} produced no effective diff for ` +
            `${noEffectiveFiles.join(", ")}`,
          );

          if (active.weakOutputRetries < 2) {
            active.weakOutputRetries += 1;
            const retryHint =
              `Your previous output produced no effective diff. It reported required file(s), but the workspace ` +
              `content did not change. Required files: ${requiredFiles.join(", ")}. Retry now with concrete ` +
              `source and test changes in every required file: ${noEffectiveFiles.join(", ")}. Do not return ` +
              `content-identical output.`;
            const retryBrief = briefWithRetryHint(active.implementationBrief, retryHint);
            active.implementationBrief = retryBrief;
            this.receiptStore.patchRun(active.run.id, {
              implementationBrief: briefToReceiptJson(retryBrief),
            }).catch(() => {});
            this.emit({
              type: "system_event",
              payload: {
                runId: active.run.id,
                checkpointLabel: "content_identical_output_retry",
                summary: `retry builder for no-effective required file(s): ${noEffectiveFiles.join(", ")}`,
              },
            });

            try {
              const retryResult = await worker.execute({
                ...assignment,
                implementationBrief: retryBrief,
              });
              await this.persistProviderAttempts(active, runTask.id, retryResult);
              result = retryResult;
              missingRequired = this.missingRequiredBuilderDeliverables(active, node, result);
              noEffectiveFiles = missingRequired.length === 0
                ? await this.noEffectiveRequiredBuilderDeliverables(active, node, result)
                : [];
              console.log(
                `[coordinator] content-identical retry attempt=${retryBrief.attempt} ` +
                `success=${result.success} remaining=${noEffectiveFiles.join(", ") || "none"} ` +
                `missing=${missingRequired.join(", ") || "none"}`,
              );
            } catch (retryErr) {
              const rmsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
              result = syntheticFailure(
                `content_identical_output: retry failed while attempting concrete required change(s) ` +
                `${noEffectiveFiles.join(", ")}: ${rmsg}`,
              );
              missingRequired = this.missingRequiredBuilderDeliverables(active, node, result);
              noEffectiveFiles = [];
            }
          }

          if (result.success && missingRequired.length > 0) {
            result = this.missingRequiredBuilderFailure(
              result,
              requiredFiles,
              missingRequired,
            );
          } else if (result.success && noEffectiveFiles.length > 0) {
            result = this.noEffectiveBuilderFailure(
              result,
              requiredFiles,
              noEffectiveFiles,
            );
          }
        }
      }
    }

    const taskResult: TaskResult = {
      success: result.success,
      output: JSON.stringify(result.output),
      artifacts: result.touchedFiles.map((f) => f.path),
      issues: [...result.issues],
    };
    completeTask(run, runTask.id, taskResult, result.cost);

    for (const touch of result.touchedFiles) {
      recordFileTouch(run, {
        filePath: touch.path,
        operation: touch.operation,
        taskId: runTask.id,
      });
    }

    // Stale-result guard: if this dispatch's generation was cancelled
    // mid-flight (typically by the stage-timeout race), discard the
    // late result rather than applying it. Per-attempt diagnostics are
    // still persisted (so cost / exports / patch-mode are visible in
    // the receipt) but the records are stamped stale=true and the
    // result does NOT join active.workerResults / active.changes.
    const isStale = active.cancelledGenerations.has(runTask.id);
    if (isStale) {
      console.warn(
        `[coordinator] dispatchNode: discarding stale result for ${node.workerType} ${node.id.slice(0, 6)} (generation ${runTask.id.slice(0, 8)} was cancelled)`,
      );
      const lateAttemptRecords =
        node.workerType === "builder" && result.output && (result.output as unknown as { attemptRecords?: unknown[] }).attemptRecords;
      if (Array.isArray(lateAttemptRecords) && lateAttemptRecords.length > 0) {
        const stamped = lateAttemptRecords.map((r) => ({ ...(r as Record<string, unknown>), stale: true }));
        await this.receiptStore.patchRun(active.run.id, {
          appendBuilderAttempts: stamped,
        }).catch(() => undefined);
      }
      await this.persistReceiptWorkerEvent(active, {
        at: new Date().toISOString(),
        workerType: node.workerType,
        taskId: runTask.id,
        status: "failed",
        summary: `Late settlement after cancellation — result discarded (gen ${runTask.id.slice(0, 8)})`,
        confidence: 0,
        costUsd: 0,
        filesTouched: [],
        issues: ["stale-result: dispatch superseded by cancellation"],
      });
      // Synthesize a failure result so the dispatch's caller (Promise.race
      // already exited via timeout, but the late settlement path lands here
      // when the coordinator processes the result map late). Returning a
      // structurally-valid failure result keeps downstream logic simple
      // without applying the patch.
      const stale: WorkerResult = {
        workerType: node.workerType as WorkerType,
        taskId: runTask.id,
        success: false,
        output: { kind: node.workerType } as WorkerResult["output"],
        issues: [{ severity: "error", message: "stale-result: dispatch was cancelled before completion" }],
        cost: { model: result.cost?.model ?? "", inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
        confidence: 0,
        touchedFiles: [],
        assumptions: [],
        durationMs: 0,
      };
      return { node, result: stale };
    }

    active.workerResults.push(result);
    await this.persistReceiptWorkerEvent(active, {
      at: new Date().toISOString(),
      workerType: node.workerType,
      taskId: runTask.id,
      status: result.success ? "completed" : "failed",
      summary: result.success
        ? `${node.workerType} completed`
        : result.issues[0]?.message ?? `${node.workerType} failed`,
      confidence: result.confidence,
      costUsd: Number(result.cost?.estimatedCostUsd ?? 0),
      filesTouched: result.touchedFiles.map((touch) => touch.path),
      issues: result.issues.map((issue) => issue.message),
    });
    // Persist Builder per-attempt diagnostics (cost/model/exports/patch
    // mode) so the receipt records every model call — not just the
    // successful patches. Records survive guard rejection via
    // BuilderAttemptError; here we just append whatever the result
    // carried.
    const attemptRecords =
      node.workerType === "builder" && result.output && (result.output as unknown as { attemptRecords?: unknown[] }).attemptRecords;
    if (Array.isArray(attemptRecords) && attemptRecords.length > 0) {
      await this.receiptStore.patchRun(active.run.id, {
        appendBuilderAttempts: attemptRecords as readonly unknown[],
      }).catch((e) => {
        console.warn(`[coordinator] receipt persist of builder attempts failed: ${e instanceof Error ? e.message : String(e)}`);
      });
    }
    return { node, result };
  }

  // ─── Pre-Build Coherence ───────────────────────────────────────────

  private async runPreBuildCoherence(active: ActiveRun): Promise<void> {
    const { run, intent, graph } = active;

    console.log(`[coordinator] runPreBuildCoherence: entering — ${intent.charter.deliverables.length} deliverables, ${graph.nodes.length} graph nodes`);
    this.emit({ type: "coherence_check_started", payload: { runId: active.run.id, phase: "pre-build" } });

    const checks = [];

    // Path-shape normalization: intent.charter.deliverables carries paths as
    // emitted by the charter extractor (may be absolute), while graph.nodes
    // carry canonicalized (worktree-relative) paths produced by
    // prepareDeliverablesForGraph. Strip the sourceRepo prefix before the
    // includes() check so the comparison is apples-to-apples.
    const canonicalize = (f: string): string => {
      if (active.sourceRepo && f.startsWith(active.sourceRepo)) {
        return f.slice(active.sourceRepo.length).replace(/^[\\/]+/, "");
      }
      return f;
    };

    for (const deliverable of intent.charter.deliverables) {
      // Placeholder deliverables (no targetFiles) were already dropped by
      // prepareDeliverablesForGraph and cannot possibly be "covered" by a
      // graph node. Skip them here rather than fail the coherence gate —
      // the extracted-target gate in submitWithGates already rejects runs
      // with zero real targets.
      if (deliverable.targetFiles.length === 0) {
        console.log(`[coordinator] runPreBuildCoherence: skipping placeholder deliverable "${deliverable.description}" (no target files)`);
        continue;
      }
      const canonicalDeliverableFiles = deliverable.targetFiles.map(canonicalize);
      const hasNode = graph.nodes.some((n) =>
        n.targetFiles.some((f) => canonicalDeliverableFiles.includes(canonicalize(f)))
      );
      checks.push({
        name: `Deliverable coverage: ${deliverable.description}`,
        passed: hasNode,
        message: hasNode ? "Covered by task graph" : "No task node covers this deliverable",
      });
      console.log(`[coordinator] runPreBuildCoherence: check "deliverable coverage: ${deliverable.description}" → ${hasNode ? "PASS" : "FAIL"}`);
    }

    try {
      topologicalSort(graph);
      checks.push({ name: "Graph acyclicity", passed: true, message: "DAG verified" });
      console.log(`[coordinator] runPreBuildCoherence: check "graph acyclicity" → PASS`);
    } catch {
      checks.push({ name: "Graph acyclicity", passed: false, message: "Cycle detected in task graph" });
      console.error(`[coordinator] runPreBuildCoherence: check "graph acyclicity" → FAIL (cycle detected)`);
    }

    const requiredTypes = [...new Set(graph.nodes.map((n) => n.workerType))];
    for (const type of requiredTypes) {
      const available = this.workerRegistry.hasWorker(type as WorkerType);
      checks.push({
        name: `Worker availability: ${type}`,
        passed: available,
        message: available ? "Worker registered" : `No worker for "${type}"`,
      });
      console.log(`[coordinator] runPreBuildCoherence: check "worker availability: ${type}" → ${available ? "PASS" : "FAIL"}`);
    }

    const allPassed = checks.every((c) => c.passed);
    recordCoherenceCheck(run, { phase: "pre-build", passed: allPassed, checks });

    if (allPassed) {
      console.log(`[coordinator] runPreBuildCoherence: ALL ${checks.length} checks passed`);
      this.emit({ type: "coherence_check_passed", payload: { runId: active.run.id, phase: "pre-build" } });
    } else {
      const failedChecks = checks.filter((c) => !c.passed);
      console.error(`[coordinator] runPreBuildCoherence: ${failedChecks.length} of ${checks.length} checks FAILED — ${failedChecks.map((c) => c.message).join("; ")}`);
      this.emit({ type: "coherence_check_failed", payload: { runId: active.run.id, phase: "pre-build", checks } });
      throw new CoordinatorError(
        `Pre-build coherence failed: ${failedChecks.map((c) => c.message).join("; ")}`
      );
    }
  }

  // ─── Checkpoint Evaluation ─────────────────────────────────────────

  private async evaluateCheckpoints(active: ActiveRun): Promise<void> {
    const { graph, run } = active;

    for (const checkpoint of graph.checkpoints) {
      if (checkpoint.status !== "pending") continue;

      const allUpstreamDone = checkpoint.upstreamNodeIds.every((id) => {
        const node = graph.nodes.find((n) => n.id === id);
        return node && (node.status === "completed" || node.status === "skipped");
      });

      if (!allUpstreamDone) continue;

      checkpoint.status = "evaluating";
      let passed = true;

      for (const check of checkpoint.checks) {
        if (check.type === "coherence") {
          // Use the per-submit judge from active so the per-task
          // projectRoot is honored.
          const partialReport = active.judge.judge(
            active.intent,
            run,
            active.changes,
            active.workerResults,
            "checkpoint"
          );
          if (!partialReport.passed && check.required) {
            passed = false;
          }
        }
      }

      checkpoint.status = passed ? "passed" : "failed";

      if (!passed) {
        this.emit({
          type: "coherence_check_failed",
          payload: { runId: active.run.id, checkpoint: checkpoint.label },
        });
      }
    }
  }

  // ─── Recovery ──────────────────────────────────────────────────────

  private async attemptRecovery(active: ActiveRun): Promise<boolean> {
    const failedNodes = active.graph.nodes.filter((n) => n.status === "failed");
    if (failedNodes.length === 0) {
      console.log(`[coordinator] attemptRecovery: no failed nodes — nothing to recover`);
      return false;
    }

    const recoveryAttempts = active.run.decisions.filter(
      (d) => d.description.startsWith("Recovery attempt") || d.description.startsWith("Recovery:"),
    ).length;

    console.log(`[coordinator] attemptRecovery: ${failedNodes.length} failed node(s), attempt ${recoveryAttempts + 1}/${this.config.maxRecoveryAttempts}`);

    if (recoveryAttempts >= this.config.maxRecoveryAttempts) {
      console.warn(`[coordinator] attemptRecovery: max recovery attempts (${this.config.maxRecoveryAttempts}) reached — giving up`);
      this.emit({
        type: "recovery_attempted",
        payload: { runId: active.run.id, success: false, reason: "Max recovery attempts reached" },
      });
      return false;
    }

    // Use the global RecoveryEngine singleton for circuit breaker persistence
    const { getGlobalRecoveryEngine } = await import("./recovery-engine.js");
    const engine = getGlobalRecoveryEngine();

    // Check global circuit breaker before attempting recovery
    if (engine.isCircuitTripped()) {
      const budget = engine.getGlobalBudget();
      console.warn(`[coordinator] attemptRecovery: GLOBAL CIRCUIT BREAKER TRIPPED — ${budget.tripReason}`);
      this.emit({
        type: "recovery_attempted",
        payload: { runId: active.run.id, success: false, reason: "Global circuit breaker: " + (budget.tripReason ?? "tripped") },
      });
      return false;
    }
    const costBudget = {
      currentTier: 0,
      maxTier: 2,
      fundedTier: 2,
      spentUsd: active.run.totalCost?.estimatedCostUsd ?? 0,
      remainingUsd: 1.0 - (active.run.totalCost?.estimatedCostUsd ?? 0),
    };

    this.emit({
      type: "recovery_attempted",
      payload: { runId: active.run.id, attempt: recoveryAttempts + 1 },
    });

    let anyRecovered = false;
    let recoveryCostUsd = 0;
    for (const node of failedNodes) {
      // Build failure signals from the node's result
      const result = active.workerResults.find(
        (wr) => wr.taskId === node.runTaskId || wr.taskId === node.id,
      );
      const failureSignals = result?.issues?.map((i) => i.message) ?? [];
      const recoveryResult = {
        success: false,
        failureSignals,
        verificationPassed: false,
        contractSatisfied: true,
        coherencePassed: true,
      };

      const failureType = engine.analyzeFailure(recoveryResult);
      const strategy = engine.selectStrategy(failureType, active.run, costBudget);

      console.log(
        `[coordinator] attemptRecovery: node ${node.id.slice(0, 6)} (${node.workerType}) — ` +
        `failure=${failureType} strategy=${strategy.name} costDelta=${strategy.costTierDelta}`,
      );

      recordDecision(active.run, {
        description: `Recovery: ${strategy.name} for ${node.workerType} node ${node.id.slice(0, 6)} (failure: ${failureType})`,
        madeBy: "coordinator",
        taskId: node.runTaskId,
        alternatives: ["Abort run", "Skip failed tasks"],
        rationale: strategy.rationale,
      });

      if (strategy.requiresHumanReview) {
        console.log(`[coordinator] attemptRecovery: strategy requires human review — skipping node ${node.id.slice(0, 6)}`);
        continue;
      }

      // Reset the failed node so it can be re-dispatched
      (node as any).status = "planned";
      const escalationTier = strategy.costTierDelta > 0 ? "premium" : "standard";
      addEscalationBoundary(
        active.graph,
        node.id,
        escalationTier,
        `Recovery: ${strategy.name} after ${failureType}`,
        "coordinator"
      );
      markReady(active.graph, node.id);
      anyRecovered = true;
    }

    // Record recovery attempt against global budget
    engine.recordRecoveryAttempt(recoveryCostUsd);
    const budget = engine.getGlobalBudget();
    if (budget.tripped) {
      console.warn(`[coordinator] CIRCUIT BREAKER TRIPPED after this recovery: ${budget.tripReason}`);
    }

    return anyRecovered;
  }

  // ─── Wave-aware Context Gate (P3) ──────────────────────────────────

  /**
   * Choose which GatedContext (if any) to hand to a worker during
   * dispatch.
   *
   *   - Scout             — base project-memory gate (broad, pre-wave).
   *   - Builder with plan — wave-aware gate that includes only the
   *                         invariants touching this wave and at most
   *                         a handful of sibling files from the same
   *                         wave. Minimal-context discipline: nothing
   *                         from later waves, nothing from elsewhere
   *                         in the repo.
   *   - Everything else   — no recentContext. The context assembler
   *                         already pulls the actual file contents;
   *                         layering memory hints on top is wasteful.
   *
   * The inclusionLog is written to the coordinator journal so a
   * reviewer can see exactly which invariants and siblings were
   * injected and why.
   */
  private resolveRecentContext(
    active: ActiveRun,
    node: TaskNode,
  ): GatedContext | undefined {
    if (node.workerType === "scout") {
      return active.gatedContext;
    }

    if (node.workerType !== "builder") {
      return undefined;
    }

    if (!active.plan) {
      return undefined;
    }

    const waveId = typeof node.metadata.waveId === "number" ? node.metadata.waveId : null;
    if (waveId == null) return undefined;

    const wave = active.plan.waves.find((w) => w.id === waveId);
    if (!wave) return undefined;

    const gated = gateContextForWave({
      memory: active.projectMemory,
      prompt: active.normalizedInput,
      changeSet: active.changeSet,
      wave,
      targetFiles: node.targetFiles,
    });
    const merged = mergeGatedContext(gated, {
      ...(active.gatedContext.clusterFiles ? { clusterFiles: active.gatedContext.clusterFiles } : {}),
      ...(active.gatedContext.landmines ? { landmines: active.gatedContext.landmines } : {}),
      ...(active.gatedContext.safeApproaches ? { safeApproaches: active.gatedContext.safeApproaches } : {}),
      ...(active.gatedContext.memoryNotes ? { memoryNotes: active.gatedContext.memoryNotes } : {}),
      ...(active.gatedContext.suggestedNextSteps ? { suggestedNextSteps: active.gatedContext.suggestedNextSteps } : {}),
      ...(active.gatedContext.strictVerification !== undefined ? { strictVerification: active.gatedContext.strictVerification } : {}),
    });

    const log = merged.inclusionLog ?? [];
    if (log.length > 0) {
      console.log(
        `[coordinator] wave-gate (wave ${wave.id} ${wave.name}, node ${node.id.slice(0, 6)}): ${log.length} item(s) injected`,
      );
      for (const line of log) {
        console.log(`[coordinator] wave-gate   ${line}`);
      }
    } else {
      console.log(
        `[coordinator] wave-gate (wave ${wave.id} ${wave.name}, node ${node.id.slice(0, 6)}): minimal — no invariants or siblings required`,
      );
    }

    return merged;
  }

  // ─── Per-wave Verification (P2) ────────────────────────────────────

  /**
   * Run the VerificationPipeline once per wave in the plan, filtered to
   * the wave's files. Results are accumulated on active.waveVerifications
   * so Phase 9's merge gate can attribute failures to the wave that
   * produced them.
   *
   * Contract:
   *   - Waves with zero changed files still get a synthetic pass
   *     receipt via verifyWave(), so the UI can show the wave as
   *     "nothing to verify" rather than silently absent.
   *   - A failing wave does NOT short-circuit the loop — we collect
   *     every wave's receipt so reviewers can see the full picture.
   *   - A wave with verdict === "fail" is emitted as merge_blocked
   *     so the Lumen stream shows the block in real time, not only
   *     after the final gate.
   */
  private async verifyCompletedWaves(active: ActiveRun): Promise<void> {
    if (!active.plan) return;

    for (const wave of active.plan.waves) {
      const receipt = await this.verificationPipelineFor(active).verifyWave(
        active.intent,
        active.run,
        wave,
        active.changes,
        active.workerResults,
        active.changeSet,
      );
      active.waveVerifications.push(receipt);
      console.log(
        `[coordinator] wave ${wave.id} (${wave.name}): ${receipt.summary} — files=${
          receipt.scope && receipt.scope.kind === "wave" ? receipt.scope.fileCount : 0
        }`,
      );

      if (receipt.verdict === "fail") {
        this.emit({
          type: "merge_blocked",
          payload: {
            runId: active.run.id,
            reason: receipt.summary,
            wave: { id: wave.id, name: wave.name },
            blockers: receipt.blockers,
          },
        });
      }
    }
  }

  /**
   * Collect wave verification findings for the merge gate.
   *   - verdict "fail"              → critical (blocks commit)
   *   - verdict "pass-with-warnings" → advisory (surfaced but does not block)
   *   - verdict "pass"              → no finding
   */
  private waveFailureFindings(active: ActiveRun): MergeFinding[] {
    const findings: MergeFinding[] = [];
    for (const receipt of active.waveVerifications) {
      if (receipt.verdict === "pass") continue;
      const scope = receipt.scope;
      const waveId = scope && scope.kind === "wave" ? scope.waveId : 0;
      const waveName = scope && scope.kind === "wave" ? scope.waveName : "unknown";

      if (receipt.verdict === "pass-with-warnings") {
        findings.push({
          source: "verification-pipeline",
          severity: "advisory",
          code: `verification:wave-${waveId}-warnings`,
          message: `Wave ${waveId} (${waveName}) passed with warnings: ${receipt.summary}`,
          files: Array.from(
            new Set(
              receipt.allIssues
                .map((i) => i.file)
                .filter((f): f is string => Boolean(f)),
            ),
          ),
        });
        continue;
      }
      findings.push({
        source: "verification-pipeline",
        severity: "critical",
        code: `verification:wave-${waveId}`,
        message: `Wave ${waveId} (${waveName}) verification failed: ${receipt.summary}`,
        files: Array.from(
          new Set(
            receipt.allIssues
              .map((i) => i.file)
              .filter((f): f is string => Boolean(f)),
          ),
        ),
      });
    }
    return findings;
  }

  /**
   * Translate GitDiffVerifier results into merge-gate findings.
   * Missing required files and undeclared changes are critical.
   * Discrepancy ratios below 1.0 are advisory.
   */
  private gitDiffFindings(result: GitDiffResult | null): MergeFinding[] {
    if (!result) return [];
    const findings: MergeFinding[] = [];

    // If git diff itself failed (confirmationRatio=0 and no files), surface
    // it as advisory — we can't confirm truth but shouldn't block on infra failure.
    if (result.confirmationRatio === 0 && result.actualChangedFiles.length === 0 && result.summary.includes("failed")) {
      findings.push({
        source: "change-set-gate",
        severity: "advisory",
        code: "git-diff:unavailable",
        message: `Git diff verification unavailable: ${result.summary}`,
      });
      return findings;
    }

    if (result.expectedButUnchanged.length > 0) {
      findings.push({
        source: "change-set-gate",
        severity: "critical",
        code: "git-diff:expected-unchanged",
        message: `${result.expectedButUnchanged.length} manifest file(s) expected to change but unchanged on disk: ${result.expectedButUnchanged.slice(0, 5).join(", ")}${result.expectedButUnchanged.length > 5 ? "…" : ""}`,
        files: result.expectedButUnchanged,
      });
    }

    if (result.undeclaredChanges.length > 0) {
      findings.push({
        source: "change-set-gate",
        severity: "critical",
        code: "git-diff:undeclared-changes",
        message: `${result.undeclaredChanges.length} file(s) changed on disk but not declared in manifest: ${result.undeclaredChanges.slice(0, 5).join(", ")}${result.undeclaredChanges.length > 5 ? "…" : ""}`,
        files: result.undeclaredChanges,
      });
    }

    if (result.unexpectedReferenceChanges.length > 0) {
      findings.push({
        source: "change-set-gate",
        severity: "critical",
        code: "git-diff:unexpected-reference-change",
        message: `${result.unexpectedReferenceChanges.length} reference/context file(s) changed unexpectedly: ${result.unexpectedReferenceChanges.slice(0, 5).join(", ")}${result.unexpectedReferenceChanges.length > 5 ? "…" : ""}`,
        files: result.unexpectedReferenceChanges,
      });
    }

    if (result.passed) {
      findings.push({
        source: "change-set-gate",
        severity: "advisory",
        code: "git-diff:confirmed",
        message: `Git diff confirmed: ${result.confirmed.length}/${result.confirmed.length + result.expectedButUnchanged.length} manifest files verified on disk`,
      });
    }

    return findings;
  }

  /**
   * Bugfix must-modify rule (post-Phase-11).
   *
   * A task whose user request looks bugfix-shaped (see
   * `isBugfixLikePrompt`) must actually modify at least one non-test
   * source file. If the builder's on-disk changes consist only of
   * test files — or nothing at all — the run silently "succeeded"
   * without touching the broken code, which is exactly the failure
   * mode we want to surface. Returns a critical merge finding so the
   * merge-gate blocks with a concrete, machine-matchable reason
   * (`bugfix-target-not-modified`). Feature / refactor tasks are not
   * affected — they legitimately touch test-only or config-only
   * surfaces.
   *
   * Uses `gitDiffResult.actualChangedFiles` (the authoritative
   * post-apply on-disk truth) and the shared `isTestInjectionFile`
   * predicate so the source/test split stays consistent with the
   * git-diff verifier's existing rules.
   */
  private bugfixTargetFindings(
    userRequest: string,
    gitDiffResult: GitDiffResult | null,
  ): MergeFinding[] {
    if (!isBugfixLikePrompt(userRequest)) return [];
    // If we couldn't run git diff, stay silent — the merge gate
    // already has a `git-diff:unavailable` advisory for that case,
    // and firing this critical finding on unknown input would
    // false-positive on infra failures.
    if (!gitDiffResult) return [];
    const actual = gitDiffResult.actualChangedFiles;
    const sourceChanged = actual.filter((f) => !isTestInjectionFile(f));
    if (sourceChanged.length > 0) return [];
    const detail = actual.length === 0
      ? "no files were modified on disk"
      : `only test file(s) were modified: ${actual.slice(0, 3).join(", ")}${actual.length > 3 ? "…" : ""}`;
    return [
      {
        source: "coordinator",
        severity: "critical",
        code: "bugfix-target-not-modified",
        message: `bugfix_target_not_modified — user request looks like a bugfix but ${detail}. A bugfix must modify at least one non-test source file.`,
        files: [...actual],
      },
    ];
  }

  /**
   * Defense-in-depth gate finding: any user-named target that fell out
   * of the deliverable manifest during `prepareDeliverablesForGraph` is
   * surfaced here as a critical merge finding. The Phase 4.5 fix in the
   * prepare pass keeps this array empty in normal operation — this gate
   * exists so a future regression that strips a user-named target can't
   * silently sail past approval the way Case 1 (1efad650) did.
   */
  private userTargetFindings(active: ActiveRun): MergeFinding[] {
    if (active.userNamedStrippedTargets.length === 0) return [];
    const list = active.userNamedStrippedTargets;
    return [{
      source: "coordinator",
      severity: "critical",
      code: "user-target-stripped",
      message: `user_target_stripped — ${list.length} user-named target(s) were dropped from deliverables before build: ${list.slice(0, 5).join(", ")}${list.length > 5 ? "…" : ""}. The user explicitly named these files; refusing to merge without them.`,
      files: [...list],
    }];
  }

  // ─── Merge Gate Helpers ────────────────────────────────────────────

  /**
   * Fold extra findings into an existing MergeDecision and recompute
   * the derived fields (critical/advisory arrays, action, primary
   * block reason, summary). Used to splice wave-failure findings into
   * the base decision without rerunning decideMerge.
   */
  private mergeInFindings(
    base: MergeDecision,
    extras: readonly MergeFinding[],
  ): MergeDecision {
    const findings = [...base.findings, ...extras];
    const critical = findings.filter((f) => f.severity === "critical");
    const advisory = findings.filter((f) => f.severity === "advisory");
    const action: MergeDecision["action"] = critical.length === 0 ? "apply" : "block";
    const primaryBlockReason =
      critical[0]?.message ?? base.primaryBlockReason ?? "";
    const summary =
      action === "apply"
        ? `MERGE APPROVED — ${advisory.length} advisory finding(s), 0 critical`
        : `MERGE BLOCKED — ${critical.length} critical, ${advisory.length} advisory`;
    return {
      action,
      findings,
      critical,
      advisory,
      primaryBlockReason,
      summary,
    };
  }

  /**
   * Print the merge decision in structured form so reviewers reading
   * the journal can see every finding the gate considered. Never
   * swallowed — critical findings are logged at `error` level so they
   * stand out in the journal.
   */
  private logMergeDecision(decision: MergeDecision): void {
    console.log(`[coordinator] merge-gate: ${decision.summary}`);
    for (const finding of decision.findings) {
      const line = `[coordinator] merge-gate:   ${finding.severity.toUpperCase()} ${finding.source} ${finding.code} — ${finding.message}`;
      if (finding.severity === "critical") {
        console.error(line);
      } else {
        console.log(line);
      }
    }
  }

  /**
   * Persist the merge decision as a RunState decision so it appears in
   * the receipt and run history. Uses a single decision entry with a
   * rationale that joins every finding — enough context for a reviewer
   * to understand why commit was blocked without going back to the
   * journal.
   */
  private recordMergeDecision(active: ActiveRun, decision: MergeDecision): void {
    const rationaleLines = decision.findings.map(
      (f) => `${f.severity}:${f.source}:${f.code} — ${f.message}`,
    );
    recordDecision(active.run, {
      description: `Merge gate: ${decision.action}`,
      madeBy: "coordinator",
      taskId: null,
      alternatives:
        decision.action === "block"
          ? ["Force commit (disabled — critical findings)"]
          : ["Block commit"],
      rationale:
        rationaleLines.length > 0
          ? rationaleLines.join(" | ")
          : decision.summary,
    });
  }

  /**
   * Restore on-disk file contents for any FileChange where we have the
   * originalContent captured. Builder writes happen inline during
   * execute(); when the MergeGate blocks, we need to leave the repo in
   * the state the user started with — an aborted build should not
   * leave half-applied files behind.
   *
   * Files without captured originals can't be restored — we log them
   * explicitly so the operator knows which files need manual review.
   * Newly-created files (operation === "create") are removed outright.
   */
  // ─── Approval Gate API ──────────────────────────────────────────────

  /**
   * Approve a run that is paused in "awaiting_approval" state.
   * Completes the commit and returns the final receipt.
   * This implements the DOCTRINE requirement for human-in-the-loop.
   */
  async approveRun(runId: string): Promise<{ ok: boolean; commitSha?: string; error?: string }> {
    const active = this.pendingApproval.get(runId);
    if (!active) return { ok: false, error: `No pending approval for run ${runId}` };

    console.log(`[coordinator] APPROVAL RECEIVED for run ${runId} — committing...`);
    this.pendingApproval.delete(runId);

    try {
      const commitSha = await this.gitCommit(active);
      if (commitSha) {
        advancePhase(active.run, "complete");
        console.log(`[coordinator] APPROVED COMMIT ${commitSha.slice(0, 8)} for run ${runId}`);
        this.emit({ type: "commit_created", payload: { runId, sha: commitSha } });

        // Generate the patch artifact NOW — the workspace has the new commit
        // and is about to be cleaned up. promoteToSource reads diff +
        // changedFiles + commitSha off finalReceipt.patchArtifact, and the
        // auto-promote path captures this at coordinator.ts ~2015 via
        // generatePatch(active.workspace). The approval path was missing
        // that capture (run 4b3ec065 surfaced it as "No commit SHA —
        // nothing to promote"). Mirror the auto-promote pattern here so
        // both paths produce the same artifact shape for promoteToSource.
        let patchArtifact: PatchArtifact | null = null;
        if (active.workspace) {
          try {
            patchArtifact = await generatePatch(active.workspace);
            active.patchArtifact = patchArtifact;
            console.log(
              `[coordinator] approval patch artifact: ${patchArtifact.changedFiles.length} file(s), ` +
              `${patchArtifact.diff.length} bytes, commit=${patchArtifact.commitSha?.slice(0, 8) ?? "none"}`,
            );
          } catch (err) {
            console.warn(
              `[coordinator] approval patch generation failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }

        // Merge patchArtifact + commitSha into the persisted finalReceipt
        // BEFORE workspace cleanup. We persisted the full awaitReceipt at
        // the awaiting_approval gate, so finalReceipt is non-null here for
        // any run that paused at that gate. For runs that were persisted
        // by an older Aedis version (pre-fix) finalReceipt may be null —
        // log it and skip rather than fabricating a partial receipt that
        // would lie about which gates ran.
        const persisted = await this.receiptStore.getRun(runId);
        const existingFinal = persisted?.finalReceipt ?? null;
        const mergedFinal: RunReceipt | null = existingFinal
          ? { ...existingFinal, patchArtifact, commitSha }
          : null;
        if (!mergedFinal) {
          console.warn(
            `[coordinator] approveRun: finalReceipt missing for run ${runId} — promotion will fall back to workspace path or fail honestly`,
          );
        }

        void this.receiptStore.patchRun(runId, {
          status: "READY_FOR_PROMOTION",
          taskSummary: `Approved and committed: ${commitSha.slice(0, 8)}`,
          completedAt: new Date().toISOString(),
          ...(mergedFinal ? { finalReceipt: mergedFinal } : {}),
        });
        return { ok: true, commitSha };
      } else {
        // Commit failed after approval — explicit commit_failed terminal state
        advancePhase(active.run, "commit_failed");
        active.run.failureReason = "Merge gate approved but git commit failed after human approval";
        await this.rollbackChanges(active, { action: "block", findings: [], critical: [], advisory: [], primaryBlockReason: "commit failed", summary: "commit failed" });
        console.error(`[coordinator] APPROVED but commit failed for run ${runId} — rolled back, marked commit_failed`);
        void this.receiptStore.patchRun(runId, {
          status: "EXECUTION_ERROR",
          taskSummary: "Commit failed after approval — changes rolled back",
          completedAt: new Date().toISOString(),
          appendErrors: ["Commit failed after human approval — changes rolled back"],
        });
        return { ok: false, error: "Commit failed after approval — changes rolled back" };
      }
    } catch (err) {
      advancePhase(active.run, "commit_failed");
      active.run.failureReason = `Commit threw during approval: ${String(err instanceof Error ? err.message : err)}`;
      void this.receiptStore.patchRun(runId, {
        status: "EXECUTION_ERROR",
        taskSummary: active.run.failureReason,
        completedAt: new Date().toISOString(),
      });
      return { ok: false, error: active.run.failureReason };
    } finally {
      // Workspace cleanup after approval/rejection is processed
      await this.cleanupWorkspaceForApproval(active);
      this.activeRuns.delete(runId);
    }
  }

  /**
   * Reject a run that is paused in "awaiting_approval" state.
   * Rolls back all changes and marks the run as failed.
   *
   * `opts.reason` overrides the default "rejected by human" reason —
   * used by rejectExpiredApprovals to surface approval-timeout
   * causality on the receipt. `opts.auto` flips the log line so the
   * operator can grep auto-rejections in the server log.
   */
  async rejectRun(
    runId: string,
    opts: { reason?: string; auto?: boolean } = {},
  ): Promise<{ ok: boolean; error?: string }> {
    const active = this.pendingApproval.get(runId);
    if (!active) return { ok: false, error: `No pending approval for run ${runId}` };

    const reason = opts.reason ?? "Rejected by human during approval gate";
    const isAuto = opts.auto === true;
    const summary = isAuto
      ? `AUTO-REJECTED — ${reason}`
      : "REJECTED — human rejected during approval gate";

    console.log(
      isAuto
        ? `[coordinator] AUTO-REJECT for run ${runId} — ${reason} — rolling back...`
        : `[coordinator] REJECTION received for run ${runId} — rolling back...`,
    );
    this.pendingApproval.delete(runId);

    // Roll back all builder changes symmetrically (create/modify/delete)
    await this.rollbackChanges(active, {
      action: "block",
      findings: [],
      critical: [{
        source: "coordinator",
        severity: "critical",
        code: isAuto ? "coordinator:auto-rejected" : "coordinator:rejected",
        message: reason,
      }],
      advisory: [],
      primaryBlockReason: reason,
      summary,
    });

    // Set the explicit rejected terminal state
    advancePhase(active.run, "rejected");
    active.run.failureReason = reason;

    recordDecision(active.run, {
      description: isAuto
        ? "Run auto-rejected (approval timed out)"
        : "Run rejected by human during approval",
      madeBy: isAuto ? "system" : "human",
      taskId: null,
      alternatives: isAuto ? ["Approve before timeout"] : ["Approve and commit"],
      rationale: isAuto
        ? `Auto-rejected by approval-timeout sweeper. ${reason}. All changes rolled back.`
        : "Human rejected the run at the approval gate. All changes rolled back.",
    });

    // Persist a terminal-shaped receipt: phase, runSummary, and a merged
    // finalReceipt with verdict="failed" so consumers reading the receipt
    // see the rejected state instead of the stale awaiting_approval shape
    // left behind by the await-gate persist. Mirrors the cancel flow in
    // cancelPendingApprovalRun so cancel and reject leave consistent
    // terminal receipts.
    const persisted = await this.receiptStore.getRun(runId);
    const runSummary = getRunSummary(active.run);
    const mergedFinalReceipt = persisted?.finalReceipt
      ? { ...persisted.finalReceipt, verdict: "failed" as const, summary: runSummary }
      : undefined;

    await this.receiptStore.patchRun(runId, {
      status: "REJECTED",
      taskSummary: isAuto
        ? `Auto-rejected — ${reason}`
        : "Rejected by human — all changes rolled back",
      phase: active.run.phase,
      completedAt: new Date().toISOString(),
      runSummary,
      ...(mergedFinalReceipt ? { finalReceipt: mergedFinalReceipt } : {}),
      appendErrors: [reason],
    });

    console.log(`[coordinator] Run ${runId} rejected and rolled back — terminal state: rejected`);
    this.emit({
      type: "run_complete",
      payload: {
        runId,
        verdict: "failed",
        executionVerified: false,
        executionReason: reason,
        classification: null,
      },
    });

    // Workspace cleanup after rejection
    await this.cleanupWorkspaceForApproval(active);
    this.activeRuns.delete(runId);

    return { ok: true };
  }

  /**
   * Bulk-reject every pending approval whose age exceeds `timeoutMs`.
   * Returns the list of run ids that were auto-rejected. Each rejected
   * run goes through the same rollback path as a manual rejection;
   * source repo stays untouched, workspaces are cleaned, receipts
   * carry the explicit "approval timed out after X" reason.
   *
   * Pure on the no-op path: when nothing has expired, returns
   * `{ count: 0, runIds: [] }` without touching any state. Safe to
   * call on a fixed timer.
   */
  async rejectExpiredApprovals(
    timeoutMs: number,
    nowMs: number = Date.now(),
  ): Promise<{ count: number; runIds: readonly string[] }> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return { count: 0, runIds: [] };
    }
    // Snapshot first — rejectRun mutates pendingApproval, so iterating
    // it directly while rejecting would skip entries.
    const expired: string[] = [];
    for (const [runId, active] of this.pendingApproval) {
      const since = active.awaitingApprovalSinceMs;
      if (typeof since !== "number") continue;
      if (nowMs - since >= timeoutMs) expired.push(runId);
    }
    if (expired.length === 0) return { count: 0, runIds: [] };
    const hours = (timeoutMs / (60 * 60 * 1000)).toFixed(1).replace(/\.0$/, "");
    const reason = `approval timed out after ${hours} hour${hours === "1" ? "" : "s"}`;
    const rejected: string[] = [];
    for (const runId of expired) {
      const result = await this.rejectRun(runId, { reason, auto: true });
      if (result.ok) rejected.push(runId);
    }
    if (rejected.length > 0) {
      console.log(
        `[coordinator] approval-timeout sweep: auto-rejected ${rejected.length} run(s) older than ${hours}h — ${rejected.join(", ")}`,
      );
    }
    return { count: rejected.length, runIds: rejected };
  }

  /** Get list of runs awaiting approval */
  getPendingApprovals(): Array<{ runId: string; changeCount: number; files: string[] }> {
    const result: Array<{ runId: string; changeCount: number; files: string[] }> = [];
    for (const [runId, active] of this.pendingApproval) {
      result.push({
        runId,
        changeCount: active.changes.length,
        files: active.changes.map(c => c.path),
      });
    }
    return result;
  }

  /**
   * Clean up workspace after approveRun/rejectRun completes.
   * Separated from the submit() finally block because the approval
   * path needs the workspace to survive until the user acts.
   */
  private async cleanupWorkspaceForApproval(active: ActiveRun): Promise<void> {
    if (!active.workspace) return;
    const cleanup = await discardWorkspace(active.workspace);
    active.workspaceCleanup = cleanup;
    if (!cleanup.success) {
      console.error(
        `[coordinator] CLEANUP_ERROR (post-approval): ${active.workspace.workspacePath} — ${cleanup.error}`,
      );
      // Leave workspace.cleanedUp=false on the receipt so startup
      // recovery can retry the rm on next boot.
      try {
        await this.receiptStore.patchRun(active.run.id, {
          status: "CLEANUP_ERROR",
          appendErrors: [`Workspace cleanup failed after approval: ${cleanup.error}`],
        });
      } catch { /* best-effort */ }
    } else {
      console.log(
        `[coordinator] workspace cleaned up (post-approval): method=${cleanup.method} (${cleanup.durationMs}ms)`,
      );
      // Mirror the submit-path behavior: mark the persisted workspace
      // ref as cleanedUp so startup recovery knows this path is
      // already gone and never attempts to remove it again.
      try {
        await this.receiptStore.patchRun(active.run.id, {
          workspace: {
            workspacePath: active.workspace.workspacePath,
            sourceRepo: active.workspace.sourceRepo,
            sourceCommitSha: active.workspace.sourceCommitSha,
            method: active.workspace.method,
            createdAt: active.workspace.createdAt,
            worktreeBranch: active.workspace.worktreeBranch,
            cleanedUp: true,
          },
        });
      } catch (err) {
        console.warn(
          `[coordinator] patch post-approval cleanedUp=true failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  private async rollbackChanges(active: ActiveRun, decision: MergeDecision): Promise<void> {
    if (active.changes.length === 0) {
      console.log(`[coordinator] rollbackChanges: no changes to roll back`);
      return;
    }

    const { writeFile, unlink } = await import("fs/promises");
    let restored = 0;
    let deleted = 0;
    const unrestorable: string[] = [];

    for (const change of active.changes) {
      const absPath = resolve(active.projectRoot, change.path);
      try {
        if (change.operation === "create") {
          if (existsSync(absPath)) {
            await unlink(absPath);
            deleted++;
          }
          continue;
        }

        if (change.originalContent !== undefined) {
          await writeFile(absPath, change.originalContent, "utf-8");
          restored++;
        } else if (change.operation === "delete") {
          // File was deleted but no originalContent captured. Try to
          // recover from git so the user doesn't lose the file.
          try {
            const { stdout } = await exec("git", ["show", `HEAD:${change.path}`], { cwd: active.projectRoot });
            await writeFile(absPath, stdout, "utf-8");
            restored++;
            console.warn(`[coordinator] rollbackChanges: restored deleted file ${change.path} from git HEAD`);
          } catch {
            unrestorable.push(change.path);
          }
        } else {
          unrestorable.push(change.path);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[coordinator] rollbackChanges: failed to restore ${change.path}: ${msg}`);
        unrestorable.push(change.path);
      }
    }

    console.warn(
      `[coordinator] rollbackChanges: merge-gate blocked commit — restored ${restored} file(s), removed ${deleted} created file(s), ${unrestorable.length} unrestorable`,
    );

    if (unrestorable.length > 0) {
      recordDecision(active.run, {
        description: `Rollback left ${unrestorable.length} file(s) in builder-modified state`,
        madeBy: "coordinator",
        taskId: null,
        alternatives: ["Manual revert required"],
        rationale: `No originalContent captured for: ${unrestorable.join(", ")}. Merge block reason: ${decision.primaryBlockReason}`,
      });
    }

    // Verify the repo is actually clean after rollback. Git restore can
    // fail silently (permissions, locked files, race conditions) leaving
    // the working tree in a dirty state that the user doesn't expect.
    try {
      const { stdout: statusOut } = await exec("git", ["status", "--porcelain"], { cwd: active.projectRoot });
      const dirtyFiles = statusOut.trim().split("\n").filter(Boolean);
      if (dirtyFiles.length > 0) {
        console.error(
          `[coordinator] ROLLBACK INCOMPLETE — ${dirtyFiles.length} file(s) still dirty after rollback:`,
        );
        for (const line of dirtyFiles.slice(0, 10)) {
          console.error(`[coordinator]   ${line}`);
        }
        recordDecision(active.run, {
          description: `Rollback verification FAILED — ${dirtyFiles.length} file(s) still dirty`,
          madeBy: "coordinator",
          taskId: null,
          alternatives: ["Manual git restore required"],
          rationale: `git status --porcelain showed: ${dirtyFiles.slice(0, 5).join(", ")}`,
        });
        void this.receiptStore.patchRun(active.run.id, {
          status: "EXECUTION_ERROR",
          appendErrors: [`Rollback incomplete — ${dirtyFiles.length} file(s) still dirty`],
        });
      } else {
        console.log(`[coordinator] rollbackChanges: verified clean — no uncommitted changes`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[coordinator] rollbackChanges: git status check failed (non-fatal): ${msg}`);
    }
  }

  // ─── Git Operations ────────────────────────────────────────────────

  private async gitCommit(active: ActiveRun): Promise<string | null> {
    try {
      // Pre-commit safety: verify changed files contain source code, not raw diff text.
      const corruptedFiles: string[] = [];
      for (const change of active.changes) {
        if (!change.content) continue;
        if (DiffApplier.looksLikeRawDiff(change.content)) {
          corruptedFiles.push(change.path);
        }
      }

      if (corruptedFiles.length > 0) {
        console.error(`[Coordinator] SAFETY: ${corruptedFiles.length} files contain raw diff text, restoring originals`);
        for (const change of active.changes) {
          if (corruptedFiles.includes(change.path) && change.originalContent) {
            // Resolve restore path against active.projectRoot so the
            // restore writes to the correct repo.
            const absPath = resolve(active.projectRoot, change.path);
            const { writeFile } = await import("fs/promises");
            await writeFile(absPath, change.originalContent, "utf-8");
            console.error(`[Coordinator]   Restored: ${change.path}`);
          }
        }
        // Unstage the restored files so a later git operation does not
        // accidentally commit the (now-reverted) content.
        const restoredPaths = corruptedFiles
          .filter((p) => active.changes.some((c) => c.path === p && c.originalContent))
          .map((p) => resolve(active.projectRoot, p));
        if (restoredPaths.length > 0) {
          try {
            await exec("git", ["reset", "HEAD", "--", ...restoredPaths], { cwd: active.projectRoot });
          } catch (resetErr) {
            console.warn(
              `[Coordinator] SAFETY: git reset after restore failed: ${resetErr instanceof Error ? resetErr.message : String(resetErr)}`,
            );
          }
        }
        recordDecision(active.run, {
          description: `Blocked commit: ${corruptedFiles.length} files contained raw diff text instead of patched source`,
          madeBy: "coordinator",
          taskId: null,
          alternatives: ["Force commit anyway"],
          rationale: `Corrupted files: ${corruptedFiles.join(", ")}`,
        });
        return null;
      }

      // Build a concise commit subject. The charter objective embeds the
      // entire user prompt verbatim ("Configure: Add a one-line JSDoc
      // comment /** token-count helpers */ at the very top of
      // utils/tokens.ts"), which produces 100+ char subject lines that
      // git tools and PRs truncate badly. Prefer a compact
      // "<verb> N file(s): <sample path>" line, fall back to a trimmed
      // objective. Full prompt lives in the body.
      const uniqueFiles = Array.from(new Set(active.changes.map((c) => c.path).filter(Boolean)));
      const dominantOp = active.changes.length > 0
        ? (active.changes.find((c) => c.operation === "create") ? "create"
          : active.changes.find((c) => c.operation === "delete") ? "delete"
          : "modify")
        : "update";
      const SUBJECT_MAX = 60;
      let subject: string;
      if (uniqueFiles.length === 1) {
        subject = `${dominantOp} ${uniqueFiles[0]}`;
      } else if (uniqueFiles.length > 1) {
        const first = uniqueFiles[0];
        subject = `${dominantOp} ${uniqueFiles.length} files (${first}…)`;
      } else {
        const obj = active.intent.charter.objective;
        const idx = obj.indexOf(":");
        subject = idx >= 0 ? obj.slice(idx + 1).trim() : obj;
      }
      if (subject.length > SUBJECT_MAX) subject = subject.slice(0, SUBJECT_MAX - 1) + "…";
      const userReq = (active.intent.userRequest ?? "").trim();
      const bodyLines = [
        `aedis: ${subject}`,
        "",
        userReq ? `Request: ${userReq}` : null,
        `Run: ${active.run.id}`,
        `Intent: ${active.intent.id} v${active.intent.version}`,
      ].filter((l): l is string => l !== null);
      const message = bodyLines.join("\n");

      // All git commands run with cwd=active.projectRoot so they target
      // the per-task effective root rather than the API server's cwd.
      // This is the difference between committing to the right repo vs.
      // committing to /mnt/ai/aedis accidentally.
      // Stage only the files Aedis changed — NOT `git add -A` which would
      // sweep in unrelated uncommitted files from the working tree.
      const changedPaths = active.changes.map((c) => resolve(active.projectRoot, c.path));
      if (changedPaths.length === 0) {
        console.warn(`[coordinator] gitCommit: no changed paths to stage — skipping commit`);
        return null;
      }
      await exec("git", ["add", "--", ...changedPaths], { cwd: active.projectRoot });
      await exec("git", ["commit", "-m", message], { cwd: active.projectRoot });

      const { stdout } = await exec("git", ["rev-parse", "HEAD"], { cwd: active.projectRoot });
      return stdout.trim();
    } catch (err) {
      recordDecision(active.run, {
        description: "Git commit failed",
        madeBy: "coordinator",
        taskId: null,
        alternatives: [],
        rationale: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Promote workspace changes to the source repository.
   * This is the final step in the promotion workflow.
   * The source repo is NEVER mutated during execution.
   */
  /**
   * Run tsc against the source repo and return a Set of error
   * signatures keyed by `<file>:<line>:<rule>:<message>`. Used by the
   * promote-time gate to distinguish NEW typecheck errors from
   * pre-existing ones — a tsc-breaking promote (run b7109c0b) flagged
   * this gap when receipt.runOutcome compiled clean against the source
   * repo at verifier time and only failed once the workspace patch
   * landed in source.
   *
   * Returns null when there is no TypeScript project to check (no
   * tsconfig.build.json AND no tsconfig.json) — non-TS source repos
   * shouldn't trip this gate at all.
   */
  private async tscErrorSignatures(sourceRepo: string): Promise<Set<string> | null> {
    const buildTsconfig = resolve(sourceRepo, "tsconfig.build.json");
    const fallbackTsconfig = resolve(sourceRepo, "tsconfig.json");
    let projectFlag: string[] = [];
    if (existsSync(buildTsconfig)) {
      projectFlag = ["-p", "tsconfig.build.json"];
    } else if (existsSync(fallbackTsconfig)) {
      projectFlag = ["-p", "tsconfig.json"];
    } else {
      return null;
    }
    try {
      await exec("npx", ["tsc", "--noEmit", ...projectFlag], {
        cwd: sourceRepo,
        timeout: 120_000,
      });
      return new Set<string>();
    } catch (err) {
      const stdout: string = (err as { stdout?: string })?.stdout ?? "";
      const issues = parseTscOutput(stdout);
      return new Set(
        issues.map((i) => `${i.file ?? "?"}:${i.line ?? "?"}:${i.rule ?? "?"}:${i.message}`),
      );
    }
  }

  /**
   * Hard typecheck gate run AFTER `git apply` and BEFORE `git commit`
   * during promoteToSource. Compares the post-apply tsc error set
   * against `before` (captured at the start of promoteToSource) and
   * refuses to commit if any error appears in the post set that is
   * NOT in the before set. Reverts the working tree on refusal so
   * promoteToSource leaves the source repo clean.
   *
   * Returns { ok: true } on clean / no-tsconfig / no-new-errors.
   * Returns { ok: false, error: "..." } when at least one new error
   * was introduced — caller should propagate the error and skip the
   * commit step.
   */
  private async typecheckPromoteGate(
    sourceRepo: string,
    before: Set<string> | null,
    paths: readonly string[],
  ): Promise<{ ok: true } | { ok: false; error: string; newErrors: string[] }> {
    if (before === null) return { ok: true };
    const after = await this.tscErrorSignatures(sourceRepo);
    if (after === null) return { ok: true };
    const newErrors = [...after].filter((e) => !before.has(e));
    if (newErrors.length === 0) return { ok: true };
    const summary = newErrors.slice(0, 3).join(" | ") + (newErrors.length > 3 ? " | …" : "");
    return {
      ok: false,
      newErrors,
      error: `Promote refused: ${newErrors.length} new TypeScript error(s) introduced — ${summary}`,
    };
  }

  private async rollbackAppliedPromotionPatch(
    sourceRepo: string,
    patchPath: string,
    changedFiles: readonly string[],
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      await exec("git", ["apply", "-R", patchPath], { cwd: sourceRepo });
    } catch (err) {
      const reverseMsg = err instanceof Error ? err.message : String(err);
      try {
        const files = filterRuntimeArtifacts(changedFiles).map((f) => resolve(sourceRepo, f));
        if (files.length > 0) {
          await exec("git", ["checkout", "HEAD", "--", ...files], { cwd: sourceRepo }).catch(() => undefined);
          await exec("git", ["clean", "-f", "--", ...files], { cwd: sourceRepo }).catch(() => undefined);
        }
      } catch { /* best-effort fallback */ }
      try {
        const { stdout } = await exec("git", ["status", "--porcelain"], { cwd: sourceRepo });
        const dirty = stdout.trim();
        if (dirty) {
          return { ok: false, error: `${reverseMsg}; source repo still dirty: ${dirty.split("\n").slice(0, 5).join(", ")}` };
        }
      } catch (statusErr) {
        return { ok: false, error: `${reverseMsg}; status check failed: ${statusErr instanceof Error ? statusErr.message : String(statusErr)}` };
      }
    }
    return { ok: true };
  }

  private async recordPromotionFailure(
    runId: string,
    error: string,
    rollbackSucceeded: boolean,
  ): Promise<void> {
    await this.receiptStore.patchRun(runId, {
      status: rollbackSucceeded ? "EXECUTION_ERROR" : "CLEANUP_ERROR",
      taskSummary: rollbackSucceeded
        ? "Promotion failed — source rollback completed"
        : "Promotion failed — source rollback failed",
      appendErrors: [error],
    }).catch((err) => {
      console.warn(`[coordinator] recordPromotionFailure failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  // ─── Shadow Workspace API ──────────────────────────────────────────
  //
  // Shadow workspaces are alternate sandboxes attached to an active
  // run, used for candidate comparison (alternate model, retry
  // isolation). They are deliberately a NARROW surface:
  //   - createShadowWorkspaceForRun: register a new shadow for an
  //     existing active run; returns the handle.
  //   - runShadowBuilder: dispatch a Builder once in a shadow
  //     workspace, capture a patch artifact, record the result as a
  //     Candidate. Skips Critic/Verifier/Integrator on purpose — the
  //     primary path is the only one that can promote, so the cheap
  //     path is enough to compare diffs without building the full
  //     graph twice.
  //   - getRunCandidates / selectBestRunCandidate: read-only views
  //     of candidates accumulated for a run.
  //
  // None of these functions can promote. The promoteToSource safety
  // guard refuses any receipt whose workspace.role !== "primary".

  /**
   * Create and register a shadow workspace for an active run. The
   * shadow is cloned from the same sourceRepo as the primary, lives
   * at a separate /tmp path (prefix "aedis-ws-shadow-N-…"), and is
   * recorded on active.workspaces under the returned workspaceId.
   *
   * Throws if the run is not active or the primary workspace is
   * absent (we need its sourceRepo as the clone source).
   */
  async createShadowWorkspaceForRun(runId: string): Promise<WorkspaceEntry> {
    const active = this.activeRuns.get(runId);
    if (!active) {
      throw new CoordinatorError(`createShadowWorkspaceForRun: no active run ${runId}`);
    }
    if (!active.workspace) {
      throw new CoordinatorError(
        `createShadowWorkspaceForRun: run ${runId} has no primary workspace — shadow needs a primary to clone from`,
      );
    }
    // Allocate the next shadow index. Stable order: shadow-1, shadow-2, …
    const existingShadowCount = [...active.workspaces.values()].filter(
      (w) => w.role === "shadow",
    ).length;
    const shadowIndex = existingShadowCount + 1;
    const entry = await createShadowWorkspace(
      active.workspace.sourceRepo,
      runId,
      shadowIndex,
    );
    active.workspaces.set(entry.workspaceId, entry);
    console.log(
      `[coordinator] shadow workspace ${entry.workspaceId} created at ${entry.handle.workspacePath} ` +
      `(source=${entry.handle.sourceRepo} sha=${entry.handle.sourceCommitSha.slice(0, 8)})`,
    );
    return entry;
  }

  /**
   * Dispatch a Builder once in a shadow workspace and record the
   * result as a Candidate. The Builder is the registered builder
   * worker by default; callers can pass a different builder
   * (alternate-model attempt) via opts.builder.
   *
   * Returns the recorded Candidate. The candidate's patchArtifact is
   * captured via generatePatch from the shadow workspace; verifier
   * verdict is null (verification is not run on the shadow path —
   * the primary path remains the only verified-and-promotable one).
   *
   * SAFETY: this method never calls promoteToSource and never writes
   * to the source repo. The shadow workspace is the only mutation
   * surface.
   */
  async runShadowBuilder(
    runId: string,
    opts: {
      builder?: BaseWorker;
      assignmentOverride?: Partial<WorkerAssignment>;
      // Lane metadata — recorded onto the resulting Candidate so the
      // local-vs-cloud selection policy and operator-facing receipts
      // can attribute the candidate to a lane/provider/model. Optional
      // for backward compat: callers who don't care about lane
      // metadata still get a working shadow candidate (no lane tag).
      lane?: import("./candidate.js").Lane;
      provider?: string;
      model?: string;
    } = {},
  ): Promise<Candidate> {
    const active = this.activeRuns.get(runId);
    if (!active) {
      throw new CoordinatorError(`runShadowBuilder: no active run ${runId}`);
    }
    // Find or create a shadow workspace. First-shadow-by-default for
    // simple callers; multi-shadow callers can call
    // createShadowWorkspaceForRun directly and then runShadowBuilder.
    let shadow: WorkspaceEntry | undefined = [...active.workspaces.values()].find(
      (w) => w.role === "shadow",
    );
    if (!shadow) {
      shadow = await this.createShadowWorkspaceForRun(runId);
    }

    const builder = opts.builder ?? this.workerRegistry.getWorker("builder");
    if (!builder) {
      throw new CoordinatorError("runShadowBuilder: no builder worker registered");
    }

    // Build a minimal assignment scoped to the shadow workspace. The
    // primary's intent + targetFiles are reused; the projectRoot is
    // the shadow path so the builder writes there. Caller can
    // override fields via assignmentOverride for alternate-model
    // attempts that need a different tier / brief / token budget.
    const baseAssignment = this.buildShadowAssignment(active, shadow);
    const assignment: WorkerAssignment = { ...baseAssignment, ...opts.assignmentOverride };

    const t0 = Date.now();
    let result;
    let status: CandidateStatus = "pending";
    let reason = "";
    try {
      result = await builder.execute(assignment);
      status = result.success ? "passed" : "failed";
      reason = result.success
        ? "shadow builder produced changes"
        : (result.issues[0]?.message ?? "shadow builder failed");
    } catch (err) {
      status = "failed";
      reason = `shadow builder threw: ${err instanceof Error ? err.message : String(err)}`;
      result = null;
    }
    const latencyMs = Date.now() - t0;
    const costUsd = result?.cost?.estimatedCostUsd ?? 0;

    // Cost attribution: accrue the shadow dispatch into run.totalCost
    // so the run total includes the shadow's spend. Without this, the
    // sum of candidate costs > run total, which makes post-hoc analysis
    // lie about either per-candidate cost or run total. The shadow's
    // cost is purely additive — the primary path already finished
    // accruing before runShadowBuilder fires.
    if (result?.cost) {
      active.run.totalCost = {
        model: result.cost.model || active.run.totalCost.model,
        inputTokens: active.run.totalCost.inputTokens + result.cost.inputTokens,
        outputTokens: active.run.totalCost.outputTokens + result.cost.outputTokens,
        estimatedCostUsd: active.run.totalCost.estimatedCostUsd + result.cost.estimatedCostUsd,
      };
    }

    let patchArtifact: PatchArtifact | null = null;
    try {
      patchArtifact = await generatePatch(shadow.handle);
    } catch (err) {
      console.warn(
        `[coordinator] shadow generatePatch failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Lane attribution honesty: `intentModel` is what the lane asked
    // for; `actualModel` / `modelUsed` is what `WorkerResult.cost.model`
    // reports actually answered. Lane purity (pinnedModel + null
    // fallback at the factory) makes them structurally identical for
    // pinned shadow builders; the fields stay distinct so a non-pinned
    // shadow (legacy chain) can still surface divergence.
    const intentModel = opts.model;
    const actualModel = result?.cost?.model || undefined;
    const providerUsed =
      actualModel && actualModel === intentModel ? opts.provider : undefined;

    const candidate: Candidate = {
      workspaceId: shadow.workspaceId,
      role: "shadow",
      workspacePath: shadow.handle.workspacePath,
      patchArtifact,
      verifierVerdict: null,
      criticalFindings: 0,
      costUsd,
      latencyMs,
      status,
      reason,
      // Lane metadata — only populated when the caller passed it.
      // Selection policy treats undefined as "lane unknown" and
      // doesn't penalize the candidate; tagged lanes participate in
      // the local-on-tie tiebreaker.
      ...(opts.lane !== undefined ? { lane: opts.lane } : {}),
      ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(intentModel !== undefined ? { intentModel } : {}),
      ...(actualModel ? { actualModel, modelUsed: actualModel } : {}),
      ...(providerUsed ? { providerUsed } : {}),
    };
    active.candidates.push(candidate);
    console.log(
      `[coordinator] shadow candidate recorded: workspaceId=${candidate.workspaceId} ` +
      `status=${candidate.status} cost=$${costUsd.toFixed(4)} latency=${latencyMs}ms ` +
      `patchBytes=${patchArtifact?.diff?.length ?? 0}` +
      (opts.lane ? ` lane=${opts.lane}` : "") +
      (opts.provider && opts.model ? ` intent=${opts.provider}/${opts.model}` : "") +
      (actualModel && actualModel !== intentModel ? ` actual=${actualModel}` : ""),
    );
    return candidate;
  }

  /**
   * Build a WorkerAssignment scoped to a shadow workspace. Re-uses
   * the run's intent, gated context, and target files; replaces
   * projectRoot with the shadow path. Defaults are conservative
   * (fast tier, modest token budget) so a simple alternate-model
   * call needs no extra wiring.
   */
  private buildShadowAssignment(active: ActiveRun, shadow: WorkspaceEntry): WorkerAssignment {
    const targetFiles = active.changeSet?.filesInScope?.map((f) => f.path) ?? [];
    const task: RunTask = {
      id: `${active.run.id}-${shadow.workspaceId}`,
      parentTaskId: null,
      workerType: "builder",
      description: `[shadow] ${active.intent.charter.objective}`,
      targetFiles,
      status: "active",
      assignedTo: null,
      result: null,
      startedAt: new Date().toISOString(),
      completedAt: null,
      costAccrued: null,
    };
    return {
      task,
      intent: active.intent,
      context: { layers: [] } as unknown as WorkerAssignment["context"],
      upstreamResults: [],
      tier: "fast",
      tokenBudget: 2048,
      runState: active.run,
      changes: [...active.changes],
      workerResults: [],
      projectRoot: shadow.handle.workspacePath,
      sourceRepo: shadow.handle.sourceRepo,
      recentContext: active.gatedContext,
      implementationBrief: undefined,
      signal: active.runAbortController.signal,
    } as WorkerAssignment;
  }

  /**
   * Read-only view of all candidates recorded for a run (primary +
   * shadows). The primary candidate is appended by
   * recordPrimaryCandidate just before the approval gate; shadow
   * candidates are appended by runShadowBuilder.
   */
  getRunCandidates(runId: string): readonly Candidate[] {
    const active = this.activeRuns.get(runId);
    return active ? [...active.candidates] : [];
  }

  /**
   * Build a primary Candidate from the run's current state and append
   * it to active.candidates. Idempotent — calling twice on the same
   * run replaces the previous primary entry rather than duplicating
   * it. Used by the local_then_cloud fallback path so the primary
   * lane's outcome is recorded as a comparable Candidate.
   *
   * SAFETY: this method does not mutate anything outside
   * active.candidates. The primary workspace, receipt, and verifier
   * state are read-only from here.
   */
  recordPrimaryCandidate(
    active: ActiveRun,
    inputs: {
      mergeDecision: MergeDecision | null;
      verificationReceipt: VerificationReceipt | null;
      lane?: import("./candidate.js").Lane;
      provider?: string;
      model?: string;
    },
  ): Candidate {
    const status: CandidateStatus = inputs.mergeDecision?.action === "apply" ? "passed" : "failed";
    const reason = inputs.mergeDecision?.summary ?? "primary lane completed";
    const costUsd = active.run.totalCost?.estimatedCostUsd ?? 0;
    const latencyMs = Date.now() - new Date(active.run.startedAt).getTime();
    const criticalFindings = inputs.mergeDecision?.critical?.length ?? 0;
    const advisoryFindings = inputs.mergeDecision?.advisory?.length ?? 0;
    const verifierVerdict = inputs.verificationReceipt?.verdict ?? null;

    // Quality signals derived from the verification receipt's stage
    // outcomes. Stages may be absent on early-exit paths — leave the
    // optional flags undefined rather than guessing false, so the
    // selection policy treats them as "unknown" instead of disqualifying.
    // Test stages don't have a dedicated VerificationStage value yet
    // — they're surfaced by name via the custom-hook stage. Match on
    // both the canonical stage and the name to capture either shape.
    let testsPassed: boolean | undefined;
    let typecheckPassed: boolean | undefined;
    if (inputs.verificationReceipt?.stages) {
      for (const stage of inputs.verificationReceipt.stages) {
        if (stage.stage === "typecheck") typecheckPassed = stage.passed;
        const nameLower = stage.name?.toLowerCase() ?? "";
        if (nameLower.includes("test")) testsPassed = stage.passed;
      }
    }

    // Lane attribution honesty: `intentModel` is what the lane asked
    // for; `actualModel` / `modelUsed` is what the BUILDER's WorkerResult
    // says actually produced the diff. Reading from active.run.totalCost
    // was wrong — that field gets overwritten by every accrueCost
    // (scout / critic / verifier / integrator), so by the time the
    // primary candidate is recorded the model field reflects whichever
    // worker ran LAST, not the builder. The fix: pluck the builder's
    // own WorkerResult.
    const intentModel = inputs.model;
    const builderResult = active.workerResults.find(
      (r) => r.workerType === "builder",
    );
    const actualModel = builderResult?.cost?.model || undefined;
    // For lane-pinned builders the chain is structurally a single
    // entry (pinnedModel + fallbackModel: null), so providerUsed is
    // identical to the lane's intent provider when actualModel matches
    // intentModel. When they diverge (non-pinned legacy chain), we
    // can't know the provider without extending CostEntry — leave it
    // undefined rather than guessing.
    const providerUsed =
      actualModel && actualModel === intentModel ? inputs.provider : undefined;

    const candidate: Candidate = {
      workspaceId: "primary",
      role: "primary",
      workspacePath: active.workspace?.workspacePath ?? active.projectRoot,
      patchArtifact: active.patchArtifact ?? null,
      verifierVerdict,
      criticalFindings,
      advisoryFindings,
      costUsd,
      latencyMs,
      status,
      reason,
      ...(inputs.lane !== undefined ? { lane: inputs.lane } : {}),
      ...(inputs.provider !== undefined ? { provider: inputs.provider } : {}),
      ...(inputs.model !== undefined ? { model: inputs.model } : {}),
      ...(intentModel !== undefined ? { intentModel } : {}),
      ...(actualModel ? { actualModel, modelUsed: actualModel } : {}),
      ...(providerUsed ? { providerUsed } : {}),
      ...(testsPassed !== undefined ? { testsPassed } : {}),
      ...(typecheckPassed !== undefined ? { typecheckPassed } : {}),
      changedFiles: active.changes.map((c) => c.path),
    };

    // Idempotent: replace any prior primary entry rather than push.
    const existing = active.candidates.findIndex((c) => c.workspaceId === "primary");
    if (existing >= 0) active.candidates[existing] = candidate;
    else active.candidates.push(candidate);
    return candidate;
  }

  /**
   * `local_then_cloud` fallback executor. Runs the shadow lane (with
   * the configured shadow provider/model) when the primary candidate
   * disqualifies AND the lane config asks for cloud-fallback. Returns
   * the shadow Candidate, or null when no shadow ran (primary
   * qualified, mode is primary_only, or no shadow assignment).
   *
   * SAFETY:
   *   - Never runs in parallel — primary lane is fully complete before
   *     this fires.
   *   - Reads `active.laneConfig`; the policy decision is local.
   *   - Calls runShadowBuilder which already enforces the
   *     "shadow-never-promotes" invariant; no new write paths.
   */
  async maybeRunFallbackShadow(active: ActiveRun): Promise<Candidate | null> {
    if (active.laneConfig.mode !== "local_then_cloud") return null;
    if (!laneConfigRunsShadow(active.laneConfig)) return null;

    // Defensive dispatch gate — these modes are scaffolded but not yet
    // dispatched by the main lane routing. If one somehow reaches here,
    // treat it as an explicit no-op rather than silently falling through
    // to local_then_cloud behavior.
    const UNREACHABLE_MODES = ["cloud_with_local_check", "local_vs_cloud"] as const;
    if (UNREACHABLE_MODES.includes(active.laneConfig.mode as typeof UNREACHABLE_MODES[number])) {
      console.warn(
        `[coordinator] maybeRunFallbackShadow: mode=${active.laneConfig.mode} is scaffolded but not yet dispatched — skipping fallback`,
      );
      return null;
    }

    // Find the primary candidate this fallback evaluates against.
    const primary = active.candidates.find((c) => c.workspaceId === "primary");
    if (!primary) {
      console.warn(
        `[coordinator] maybeRunFallbackShadow: no primary candidate recorded for run ${active.run.id}; skipping fallback`,
      );
      return null;
    }
    if (candidateDisqualification(primary) === null) {
      // Primary qualifies — local_then_cloud's whole point is to skip
      // the cloud lane in this case. No-op.
      console.log(
        `[coordinator] local_then_cloud: primary qualified (status=${primary.status}); shadow lane skipped`,
      );
      return null;
    }

    const shadowAssignment = active.laneConfig.shadow;
    if (!shadowAssignment) return null;

    // ── Phase D: pin the shadow Builder to lane-config.shadow's
    // (provider, model). Constructed transient — no registry mutation,
    // no model-config.json on-disk side effects, no cross-run leakage.
    // If the configured provider isn't in the supported Provider
    // union, fall back to the registry's default Builder so a typo in
    // lane-config.json doesn't crash the run; the candidate manifest
    // still records the intended lane labels for diagnosis.
    //
    // The factory is injectable via `config.laneBuilderFactory` so
    // tests can substitute a stub builder without touching the
    // WorkerRegistry or making real network calls.
    const factory = this.config.laneBuilderFactory ?? createBuilderForLane;
    const laneBuilder = factory({
      projectRoot: active.projectRoot,
      provider: shadowAssignment.provider,
      model: shadowAssignment.model,
      runState: active.run,
    });
    if (!laneBuilder) {
      console.warn(
        `[coordinator] local_then_cloud: lane-config.shadow.provider="${shadowAssignment.provider}" is not a supported Provider — ` +
        `shadow lane will dispatch the registered default Builder. Fix lane-config.json or expand SUPPORTED_PROVIDERS.`,
      );
    }
    // Cost-surfacing log (Phase D minimal cost guard). A second model
    // invocation costs real money; the operator should see exactly
    // which provider/model is about to be charged before the call.
    // Full budget enforcement is deferred — this line is the entire
    // cost guard for now.
    console.log(
      `[coordinator] local_then_cloud: primary disqualified (${candidateDisqualification(primary)}) — ` +
      `dispatching SHADOW LANE on ${shadowAssignment.provider}/${shadowAssignment.model} ` +
      `(lane=${shadowAssignment.lane}, run=${active.run.id.slice(0, 8)}); ` +
      `this is a SECOND model call — operator-visible cost will be charged to this run.`,
    );
    return await this.runShadowBuilder(active.run.id, {
      ...(laneBuilder ? { builder: laneBuilder } : {}),
      lane: shadowAssignment.lane,
      provider: shadowAssignment.provider,
      model: shadowAssignment.model,
    });
  }

  /**
   * Build the persistable candidate manifest for the receipt. Pure
   * projection from active.candidates — strips workspace paths and
   * patch artifacts (those live elsewhere on the receipt) so the
   * manifest stays compact and stable across receipt readers.
   */
  buildCandidateManifest(active: ActiveRun): readonly CandidateManifestEntry[] {
    return active.candidates.map((c): CandidateManifestEntry => ({
      workspaceId: c.workspaceId,
      role: c.role,
      ...(c.lane !== undefined ? { lane: c.lane } : {}),
      ...(c.provider !== undefined ? { provider: c.provider } : {}),
      ...(c.model !== undefined ? { model: c.model } : {}),
      ...(c.intentModel !== undefined ? { intentModel: c.intentModel } : {}),
      ...(c.actualModel !== undefined ? { actualModel: c.actualModel } : {}),
      ...(c.modelUsed !== undefined ? { modelUsed: c.modelUsed } : {}),
      ...(c.providerUsed !== undefined ? { providerUsed: c.providerUsed } : {}),
      status: c.status,
      disqualification: candidateDisqualification(c),
      costUsd: c.costUsd,
      latencyMs: c.latencyMs,
      verifierVerdict: c.verifierVerdict,
      reason: c.reason,
    }));
  }

  /**
   * Pick the best candidate for the approval gate, or null when no
   * candidate qualifies. Pure-function selectBestCandidate does the
   * actual decision; this is a per-run convenience wrapper.
   */
  selectBestRunCandidate(runId: string): Candidate | null {
    return selectBestCandidate(this.getRunCandidates(runId));
  }

  /**
   * Discard non-selected SHADOW workspaces for a run. The primary
   * workspace is NEVER touched here — its lifecycle is owned by the
   * normal submit/approval/promote path. This method only cleans
   * shadow workspaces that lost candidate selection so disk doesn't
   * fill up with abandoned alternates.
   *
   * `selectedWorkspaceId` is the winning candidate's workspaceId.
   * Pass null/undefined to discard ALL shadow workspaces (e.g.
   * primary won and no shadow needs to survive).
   *
   * Returns the list of discarded workspaceIds. Best-effort: if a
   * single discard fails it is logged and the rest still proceed.
   */
  async cleanupLosingCandidates(
    runId: string,
    selectedWorkspaceId?: string | null,
  ): Promise<readonly string[]> {
    const active = this.activeRuns.get(runId);
    if (!active) return [];
    const discarded: string[] = [];
    for (const [workspaceId, entry] of active.workspaces) {
      // Never touch the primary — its lifecycle belongs to the main
      // submit/approve/promote flow.
      if (entry.role !== "shadow") continue;
      // Skip the selected one — that's the winner; its cleanup
      // happens later via the same path the primary uses (caller's
      // responsibility once the candidate has been promoted/rejected).
      if (selectedWorkspaceId && workspaceId === selectedWorkspaceId) continue;
      try {
        const result = await discardWorkspace(entry.handle);
        if (result.success) {
          console.log(
            `[coordinator] losing candidate cleanup: ${workspaceId} discarded ` +
            `(method=${result.method}, ${result.durationMs}ms)`,
          );
          discarded.push(workspaceId);
          active.workspaces.delete(workspaceId);
        } else {
          console.warn(
            `[coordinator] losing candidate cleanup FAILED for ${workspaceId}: ${result.error}`,
          );
        }
      } catch (err) {
        console.warn(
          `[coordinator] losing candidate cleanup threw for ${workspaceId}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return discarded;
  }

  async promoteToSource(runId: string, sourceRepoPath?: string): Promise<{ ok: boolean; commitSha?: string; error?: string }> {
    const receipt = await this.receiptStore.getRun(runId);
    if (!receipt) return { ok: false, error: "No receipt found for run " + runId };

    const finalReceipt = (receipt as any).finalReceipt;

    // Multi-workspace safety guard. Only "primary" workspaces may
    // promote — shadow workspaces exist for alternate Builder attempts
    // and must NEVER write to the source repo. Default to "primary"
    // when the role field is missing (legacy receipts written before
    // shadow support landed).
    const persistentWorkspaceRole =
      (receipt as any)?.workspace?.role ?? finalReceipt?.workspace?.role ?? "primary";
    if (persistentWorkspaceRole !== "primary") {
      const msg =
        `Promote refused: workspace role is "${persistentWorkspaceRole}" — only primary workspaces may promote. ` +
        `Shadow workspaces produce candidates for comparison and never write to the source repo.`;
      console.error(`[coordinator] PROMOTE BLOCKED for ${runId}: ${msg}`);
      return { ok: false, error: msg };
    }

    const patchArtifact = finalReceipt?.patchArtifact as { diff?: string; changedFiles?: string[]; commitSha?: string | null } | undefined;
    // Source-repo resolution. The persistent receipt's TOP-LEVEL
    // sourceRepo is null for any run currently in this codebase — only
    // finalReceipt.sourceRepo and workspace.sourceRepo carry the value
    // (set in buildReceipt at ~line 5898 and at workspace creation).
    // Run 6bf45418 surfaced the gap: POST /tasks/:id/promote with no
    // body fell straight through to this.config.projectRoot
    // (/mnt/ai/aedis) and tried to git-apply an absent-pianist patch
    // there, failing with "app.py: does not exist in index." Walk the
    // chain in trust order so the explicit body wins, then anything the
    // receipt itself recorded, and only last fall back to the
    // coordinator's project root.
    const persistentWorkspaceSourceRepo = (receipt as any)?.workspace?.sourceRepo;
    const finalReceiptSourceRepo = finalReceipt?.sourceRepo;
    const finalReceiptWorkspaceSourceRepo = finalReceipt?.workspace?.sourceRepo;
    const sourceRepo =
      sourceRepoPath ??
      (receipt as any).sourceRepo ??
      finalReceiptSourceRepo ??
      finalReceiptWorkspaceSourceRepo ??
      persistentWorkspaceSourceRepo ??
      this.config.projectRoot;

    // Try patch artifact first (survives workspace cleanup)
    if (patchArtifact?.diff && patchArtifact.diff.trim()) {
      const patchDiff = patchArtifact.diff;
      return withRepoLock(resolve(sourceRepo, ".aedis", "promotion"), async () => {
        const alreadyPromoted = await this.refuseAlreadyPromoted(runId);
        if (alreadyPromoted) return alreadyPromoted;
        const promoteTscBaseline = await this.tscErrorSignatures(sourceRepo);
        const { writeFile: writeTmp, unlink: rmTmp } = await import("node:fs/promises");
        const patchTmp = resolve(sourceRepo, `.aedis-promote-${runId.replace(/[^a-zA-Z0-9_-]/g, "_")}-${randomUUID()}.patch.tmp`);
        let applied = false;
        try {
        await writeTmp(patchTmp, patchDiff, "utf-8");
        try {
          await exec("git", ["apply", patchTmp], { cwd: sourceRepo });
        } catch {
          await exec("git", ["apply", "--3way", patchTmp], { cwd: sourceRepo });
        }
        applied = true;

        // Promote-time typecheck gate: refuse to commit if the patch
        // introduced any NEW tsc error compared to promoteTscBaseline.
        // Run b7109c0b's `receipt.runOutcome` regression slipped past
        // the verifier-time hook because that hook runs in the source
        // repo's cwd, not the workspace's — so the workspace
        // modification was invisible at verifier time. This gate runs
        // tsc against the source repo AFTER the patch has been
        // applied, so the would-be-promoted state is what gets
        // checked.
        const candidatePaths = filterRuntimeArtifacts(patchArtifact.changedFiles ?? [])
          .map((f) => resolve(sourceRepo, f));
        const gateResult = await this.typecheckPromoteGate(
          sourceRepo,
          promoteTscBaseline,
          candidatePaths,
        );
        if (!gateResult.ok) {
          console.error(`[coordinator] PROMOTE (patch) REFUSED for ${runId}: ${gateResult.error}`);
          const rollback = await this.rollbackAppliedPromotionPatch(sourceRepo, patchTmp, patchArtifact.changedFiles ?? []);
          const error = rollback.ok
            ? `${gateResult.error}; promotion rollback completed`
            : `${gateResult.error}; promotion rollback FAILED: ${rollback.error}`;
          await this.recordPromotionFailure(runId, error, rollback.ok);
          return { ok: false, error };
        }

        // Defense-in-depth: even though generatePatch already filters
        // runtime artifacts, re-filter here in case a receipt produced
        // by an older Aedis version carries unfiltered changedFiles.
        const files = filterRuntimeArtifacts(patchArtifact.changedFiles ?? []);
        if (files.length > 0) {
          await exec("git", ["add", "--", ...files.map((f) => resolve(sourceRepo, f))], { cwd: sourceRepo });
        } else if ((patchArtifact.changedFiles ?? []).length === 0) {
          // Only fall back to "git add -A" when the receipt explicitly
          // had no file list — never sweep all changes blindly when the
          // filter dropped everything (that means the patch was *only*
          // runtime artifacts and there is nothing legitimate to stage).
          await exec("git", ["add", "-A", "--", ".", ...PROMOTION_EXCLUDE_PATHSPECS], { cwd: sourceRepo });
        }

        const SUBJECT_MAX = 60;
        const changedCount = (patchArtifact.changedFiles ?? []).length;
        const firstFile = (patchArtifact.changedFiles ?? [])[0];
        let subject: string;
        if (changedCount === 1 && firstFile) subject = `modify ${firstFile}`;
        else if (changedCount > 1 && firstFile) subject = `modify ${changedCount} files (${firstFile}…)`;
        else subject = (receipt.prompt ?? receipt.taskSummary ?? "update").slice(0, SUBJECT_MAX);
        if (subject.length > SUBJECT_MAX) subject = subject.slice(0, SUBJECT_MAX - 1) + "…";
        const userReq = (receipt.prompt ?? "").trim();
        const msgLines = [
          `aedis: ${subject}`,
          "",
          userReq ? `Request: ${userReq}` : null,
          `Run: ${runId}`,
        ].filter((l): l is string => l !== null);
        const msg = msgLines.join("\n");
        await exec("git", ["commit", "-m", msg], { cwd: sourceRepo });
        const { stdout: sourceSha } = await exec("git", ["rev-parse", "HEAD"], { cwd: sourceRepo });
        await this.receiptStore.patchRun(runId, { status: "PROMOTED", taskSummary: "Promoted to source: " + sourceSha.trim().slice(0, 8) });
        console.log("[coordinator] PROMOTED run " + runId + " -> " + sourceSha.trim().slice(0, 8) + " via patch artifact");
        return { ok: true, commitSha: sourceSha.trim() };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[coordinator] PROMOTE (patch) FAILED for " + runId + ": " + msg);
        if (applied) {
          const rollback = await this.rollbackAppliedPromotionPatch(sourceRepo, patchTmp, patchArtifact.changedFiles ?? []);
          const error = rollback.ok
            ? `Patch promotion failed: ${msg}; promotion rollback completed`
            : `Patch promotion failed: ${msg}; promotion rollback FAILED: ${rollback.error}`;
          await this.recordPromotionFailure(runId, error, rollback.ok);
          return { ok: false, error };
        }
        const error = "Patch apply failed: " + msg;
        await this.recordPromotionFailure(runId, error, true);
        return { ok: false, error };
      } finally {
        await rmTmp(patchTmp).catch(() => {});
      }
      });
    }

    // Fallback: workspace-based promotion (if workspace still exists)
    const workspacePath = (receipt as any)?.workspace?.workspacePath as string | undefined
      ?? (receipt as any)?.finalReceipt?.workspace?.workspacePath as string | undefined;
    const commitSha = patchArtifact?.commitSha ?? (receipt as any).commitSha ?? finalReceipt?.commitSha ?? null;

    if (!workspacePath) return { ok: false, error: "No patch artifact and no workspace path in receipt" };
    if (!commitSha) return { ok: false, error: "No commit SHA — nothing to promote" };

    const { existsSync } = await import("node:fs");
    if (!existsSync(workspacePath)) return { ok: false, error: "Workspace not found: " + workspacePath + " and no patch artifact saved" };

    return withRepoLock(resolve(sourceRepo, ".aedis", "promotion"), async () => {
      const alreadyPromoted = await this.refuseAlreadyPromoted(runId);
      if (alreadyPromoted) return alreadyPromoted;
      const promoteTscBaseline = await this.tscErrorSignatures(sourceRepo);
      const { writeFile: writeTmp, unlink: rmTmp } = await import("node:fs/promises");
      const patchTmp = resolve(sourceRepo, `.aedis-promote-${runId.replace(/[^a-zA-Z0-9_-]/g, "_")}-${randomUUID()}.patch.tmp`);
      let applied = false;
      let files: string[] = [];
      try {
        const { stdout: patch } = await exec("git", ["format-patch", "--stdout", commitSha + "^.." + commitSha], { cwd: workspacePath });
        if (!patch.trim()) return { ok: false, error: "Empty patch — nothing to promote" };

        await writeTmp(patchTmp, patch, "utf-8");
        try {
          await exec("git", ["apply", patchTmp], { cwd: sourceRepo });
        } catch {
          await exec("git", ["apply", "--3way", patchTmp], { cwd: sourceRepo });
        }
        applied = true;

        const { stdout: diffOut } = await exec(
          "git",
          ["diff", "--name-only", "HEAD", "--", ".", ...PROMOTION_EXCLUDE_PATHSPECS],
          { cwd: workspacePath },
        );
        files = filterRuntimeArtifacts(diffOut.trim().split("\n").filter(Boolean));

      // Promote-time typecheck gate (workspace-fallback path). Same
      // contract as the patch-artifact path above: refuse to commit if
      // the apply introduced any NEW tsc error compared to baseline.
      const candidatePaths = files.map((f) => resolve(sourceRepo, f));
      const gateResult = await this.typecheckPromoteGate(
        sourceRepo,
        promoteTscBaseline,
        candidatePaths,
      );
      if (!gateResult.ok) {
        console.error(`[coordinator] PROMOTE (workspace) REFUSED for ${runId}: ${gateResult.error}`);
        const rollback = await this.rollbackAppliedPromotionPatch(sourceRepo, patchTmp, files);
        const error = rollback.ok
          ? `${gateResult.error}; promotion rollback completed`
          : `${gateResult.error}; promotion rollback FAILED: ${rollback.error}`;
        await this.recordPromotionFailure(runId, error, rollback.ok);
        return { ok: false, error };
      }

      if (files.length > 0) {
        await exec("git", ["add", "--", ...files.map((f) => resolve(sourceRepo, f))], { cwd: sourceRepo });
      }

      const msg = "aedis: " + (receipt.taskSummary ?? "Aedis run " + runId) + "\n\nPromoted from workspace: " + workspacePath + "\nOriginal run: " + runId;
      await exec("git", ["commit", "-m", msg], { cwd: sourceRepo });

      const { stdout: sourceSha } = await exec("git", ["rev-parse", "HEAD"], { cwd: sourceRepo });
      await this.receiptStore.patchRun(runId, {
        status: "READY_FOR_PROMOTION",
        taskSummary: "Promoted to source: " + sourceSha.trim().slice(0, 8),
      });

      console.log("[coordinator] PROMOTED run " + runId + " -> " + sourceSha.trim().slice(0, 8) + " in " + sourceRepo);
      return { ok: true, commitSha: sourceSha.trim() };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[coordinator] PROMOTE FAILED for " + runId + ": " + msg);
      if (applied) {
        const rollback = await this.rollbackAppliedPromotionPatch(sourceRepo, patchTmp, files);
        const error = rollback.ok
          ? `${msg}; promotion rollback completed`
          : `${msg}; promotion rollback FAILED: ${rollback.error}`;
        await this.recordPromotionFailure(runId, error, rollback.ok);
        return { ok: false, error };
      }
      await this.recordPromotionFailure(runId, msg, true);
      return { ok: false, error: msg };
    } finally {
      await rmTmp(patchTmp).catch(() => {});
    }
    });
  }

  private async refuseAlreadyPromoted(runId: string): Promise<{ ok: false; error: string } | null> {
    const latest = await this.receiptStore.getRun(runId);
    if (latest?.status !== "PROMOTED") return null;
    return {
      ok: false,
      error: "Run is already promoted; refresh run status before retrying promotion",
    };
  }

  // ─── Change Collection ─────────────────────────────────────────────

  private collectChanges(active: ActiveRun, result: WorkerResult): void {
    const incoming =
      result.output.kind === "builder"
        ? result.output.changes
        : result.output.kind === "integrator"
          ? result.output.finalChanges
          : null;
    if (!incoming) return;
    // Defense-in-depth scope-lock filter: even though Phase 4 / Phase
    // 4.5 already trimmed deliverables, a worker that misreports
    // changes (or any future expansion path) must not be able to
    // smuggle a mutation past the allowlist. Drop changes here too —
    // they won't reach the judge, merge gate, or receipt counts.
    const lock = active.intent.charter.scopeLock;
    const filtered = lock
      ? incoming.filter((c) => {
          const allowed = new Set(
            lock.allowedFiles.map((f) => resolve(active.projectRoot, f)),
          );
          const inScope = allowed.has(resolve(active.projectRoot, c.path));
          if (!inScope) {
            console.warn(
              `[coordinator] scope-lock: dropping out-of-scope change ${c.path} (allowed: ${lock.allowedFiles.join(", ")})`,
            );
          }
          return inScope;
        })
      : [...incoming];
    if (result.output.kind === "builder") {
      active.changes.push(...filtered);
    } else {
      active.changes = filtered;
    }
  }

  private async persistReceiptCheckpoint(
    active: ActiveRun,
    checkpoint: ReceiptCheckpoint,
    extra: ReceiptPatch = {},
  ): Promise<void> {
    await this.receiptStore.patchRun(active.run.id, {
      ...extra,
      intentId: active.intent.id,
      prompt: active.rawUserPrompt,
      taskSummary: active.rawUserPrompt,
      status: checkpoint.status,
      phase: checkpoint.phase,
      totalCost: active.run.totalCost,
      filesTouched: active.run.filesTouched.map((touch) => ({
        path: touch.filePath,
        operation: touch.operation,
        taskId: touch.taskId,
        timestamp: touch.timestamp,
      })),
      changesSummary: active.changes.map((change) => ({
        path: change.path,
        operation: change.operation,
      })),
      runSummary: getRunSummary(active.run),
      graphSummary: getGraphSummary(active.graph),
      appendCheckpoints: [checkpoint, ...(extra.appendCheckpoints ?? [])],
    });
  }

  /**
   * Persist provider-fallback attempts (the chain log from
   * invokeModelWithFallback) returned by Builder/Critic on the run
   * receipt. The model invoker already classifies cancelled attempts
   * distinctly and does NOT increment the circuit breaker for them, so
   * passing them straight through preserves that semantics in receipts.
   * Each invocation gets its own slice; the retry path produces
   * separate attempts so calling this twice (initial + weak-output
   * retry) does not double-count.
   */
  private async persistProviderAttempts(
    active: ActiveRun,
    taskId: string,
    result: WorkerResult,
  ): Promise<void> {
    const attempts = result.providerAttempts;
    if (!attempts || attempts.length === 0) return;
    const at = new Date().toISOString();
    const transformed: ReceiptProviderAttempt[] = attempts.map((a, index) => ({
      at,
      taskId,
      attemptIndex: index,
      provider: a.provider,
      model: a.model,
      outcome: a.outcome,
      durationMs: a.durationMs,
      costUsd: a.costUsd,
      ...(a.tokensIn !== undefined ? { tokensIn: a.tokensIn } : {}),
      ...(a.tokensOut !== undefined ? { tokensOut: a.tokensOut } : {}),
      ...(a.errorMsg !== undefined ? { errorMsg: a.errorMsg } : {}),
    }));
    const cbSkips = transformed
      .filter((entry) => entry.outcome === "skipped_circuit_breaker")
      .map((entry) => ({
        at: entry.at,
        taskId: entry.taskId,
        provider: entry.provider,
        model: entry.model,
      }));
    await this.receiptStore
      .patchRun(active.run.id, {
        appendProviderAttempts: transformed,
        ...(cbSkips.length > 0 ? { appendCircuitBreakerSkips: cbSkips } : {}),
      })
      .catch((err) => {
        console.warn(
          `[coordinator] persistProviderAttempts: patchRun failed — ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }

  private async persistReceiptWorkerEvent(
    active: ActiveRun,
    event: ReceiptWorkerEvent,
  ): Promise<void> {
    await this.persistReceiptCheckpoint(
      active,
      {
        at: event.at,
        type: "worker_step",
        status: active.run.phase === "failed" ? "FAILED" : "RUNNING",
        phase: active.run.phase,
        summary: event.summary,
        details: {
          workerType: event.workerType,
          taskId: event.taskId,
          status: event.status,
        },
      },
      {
        appendWorkerEvents: [event],
      },
    );
  }

  private async persistFinalReceipt(active: ActiveRun, receipt: RunReceipt): Promise<void> {
    const classification = receipt.humanSummary?.classification ?? null;
    const status = persistentStatusForReceipt(receipt);
    await this.receiptStore.patchRun(active.run.id, {
      intentId: active.intent.id,
      prompt: active.rawUserPrompt,
      taskSummary:
        receipt.humanSummary?.headline ??
        active.rawUserPrompt,
      status,
      phase: active.run.phase,
      completedAt: active.run.completedAt,
      finalClassification: classification,
      totalCost: receipt.totalCost,
      confidence: {
        overall: receipt.humanSummary?.confidence.overall ?? null,
        planning: receipt.humanSummary?.confidence.planning ?? null,
        execution: receipt.humanSummary?.confidence.execution ?? null,
        verification: receipt.humanSummary?.confidence.verification ?? null,
      },
      filesTouched: active.run.filesTouched.map((touch) => ({
        path: touch.filePath,
        operation: touch.operation,
        taskId: touch.taskId,
        timestamp: touch.timestamp,
      })),
      changesSummary: active.changes.map((change) => ({
        path: change.path,
        operation: change.operation,
      })),
      verificationResults: {
        final: receipt.verificationReceipt,
        waves: [...receipt.waveVerifications],
      },
      graphSummary: receipt.graphSummary,
      runSummary: receipt.summary,
      humanSummary: receipt.humanSummary,
      finalReceipt: receipt,
      appendErrors: active.run.failureReason ? [active.run.failureReason] : [],
      appendCheckpoints: [
        {
          at: receipt.timestamp,
          type: "run_completed",
          status,
          phase: active.run.phase,
          summary: receipt.humanSummary?.headline ?? receipt.verdict,
        },
      ],
    });
  }

  // ─── Receipt Building ─────────────────────────────────────────────

  private buildReceipt(
    active: ActiveRun,
    verificationReceipt: VerificationReceipt | null,
    judgmentReport: JudgmentReport | null,
    commitSha: string | null,
    durationMs: number,
    mergeDecision: MergeDecision | null = null,
    executionDecision: ExecutionGateDecision | null = null,
    verdictOverride: RunReceipt["verdict"] | null = null,
  ): RunReceipt {
    // Aggregate cost from worker results.
    let inputTokens = 0;
    let outputTokens = 0;
    let estimatedCostUsd = 0;
    let model = active.run.totalCost?.model ?? "";

    for (const wr of active.workerResults) {
      const c = wr.cost as
        | { model?: string; inputTokens?: number; outputTokens?: number; estimatedCostUsd?: number }
        | undefined;
      if (!c || typeof c !== "object") continue;
      if (typeof c.inputTokens === "number") inputTokens += c.inputTokens;
      if (typeof c.outputTokens === "number") outputTokens += c.outputTokens;
      if (typeof c.estimatedCostUsd === "number") estimatedCostUsd += c.estimatedCostUsd;
      if (!model && typeof c.model === "string") model = c.model;
    }

    if (active.workerResults.length > 0) {
      console.log(
        `[coordinator] aggregateCost (WorkerResult.cost direct): ` +
        `${active.workerResults.length} worker result(s) → ` +
        `$${estimatedCostUsd.toFixed(6)} (${inputTokens}/${outputTokens} tokens)`
      );
    }

    if (estimatedCostUsd === 0) {
      const runId = active.run.id;
      const runStartMs = Date.now() - durationMs;
      const log = getCallLog();
      let fallbackCost = 0;
      let fallbackIn = 0;
      let fallbackOut = 0;
      let fallbackModel = "";
      let entriesUsed = 0;
      for (const entry of log) {
        // Prefer runId-scoped filtering to avoid cross-run cost bleed
        // when multiple runs execute concurrently. Fall back to the
        // wall-clock window only for legacy entries without a runId.
        const matchesRun = entry.runId
          ? entry.runId === runId
          : new Date(entry.timestamp).getTime() >= runStartMs;
        if (matchesRun) {
          fallbackCost += entry.costUsd;
          fallbackIn += entry.tokensIn;
          fallbackOut += entry.tokensOut;
          if (!fallbackModel && entry.model) fallbackModel = entry.model;
          entriesUsed++;
        }
      }
      if (entriesUsed > 0 && fallbackCost > 0) {
        console.log(
          `[coordinator] aggregateCost fallback: WorkerResult.cost was 0, ` +
          `pulled $${fallbackCost.toFixed(6)} from model-invoker call log ` +
          `(${entriesUsed} entries for run ${runId.slice(0, 8)})`
        );
        estimatedCostUsd = fallbackCost;
        inputTokens = fallbackIn;
        outputTokens = fallbackOut;
        if (!model) model = fallbackModel;
      } else if ((active.run.totalCost?.estimatedCostUsd ?? 0) === 0) {
        console.warn(
          `[coordinator] aggregateCost: no cost data anywhere — ` +
          `WorkerResult.cost was 0 for all ${active.workerResults.length} ` +
          `workers, model-invoker call log has ${entriesUsed} entry/entries ` +
          `for run ${runId.slice(0, 8)}. Receipt will report $0.000000.`
        );
      }
    }

    const aggregatedCost = estimatedCostUsd > (active.run.totalCost?.estimatedCostUsd ?? 0)
      ? { model: model || "unknown", inputTokens, outputTokens, estimatedCostUsd }
      : active.run.totalCost;

    // Determine the verdict: prefer the override passed by submit()
    // (which has already applied execution-gate truth enforcement),
    // fall back to determineVerdict for legacy/test callers.
    const rawVerdict = this.determineVerdict(active, verificationReceipt, judgmentReport, mergeDecision);
    const verdict: RunReceipt["verdict"] =
      verdictOverride ??
      (executionDecision && !executionDecision.executionVerified && (rawVerdict === "success" || rawVerdict === "partial")
        ? "failed"
        : rawVerdict);

    // ── Confidence gate ────────────────────────────────────────────
    // Compute a discrete confidence label from the gate signals.
    const criticIterations = active.run.decisions.filter(
      (d) => d.description.startsWith("Rehearsal round"),
    ).length;
    const adversarialFindings = collectAdversarialFindingsForConfidence(
      active.workerResults,
      executionDecision ?? null,
      judgmentReport ?? null,
    );
    const confidenceGate = scoreConfidence({
      testsPassed: verificationReceipt?.verdict !== "fail",
      integrationPassed: judgmentReport?.passed ?? false,
      criticIterations,
      impactLevel: active.scopeClassification?.type === "architectural" ? "high"
        : (active.changeSet.filesInScope.length > 1 ? "medium" : "low"),
      adversarialFindings,
    });
    console.log(
      `[coordinator] confidence.gate: level=${confidenceGate.level} reasons=[${confidenceGate.reasons.join("; ")}]`,
    );

    // Phase 8.5 — operator-facing escalation signal. When an
    // `escalate`-severity adversarial finding fired (e.g. an injection
    // directive was detected in scout-harvested text), surface it as
    // both a prominent log line and a dedicated event so the UI /
    // WebSocket consumer / human operator can react. The run still
    // completes normally — we detect, downgrade, and escalate, we do
    // not refuse — but the escalation signal is now consumed rather
    // than silently dropped.
    if (confidenceGate.escalationRecommended) {
      const escalateFindings = adversarialFindings
        .filter((f) => f.severity === "escalate")
        .map((f) => `${f.code}${f.ref ? `@${f.ref}` : ""}`);
      console.warn(
        `[coordinator] ESCALATION RECOMMENDED — run=${active.run.id} findings=[${escalateFindings.join(", ")}] reasons="${confidenceGate.reasons.join("; ")}"`,
      );
      this.emit({
        type: "adversarial_escalation",
        payload: {
          runId: active.run.id,
          findings: escalateFindings,
          reasons: confidenceGate.reasons,
        },
      });
    }

    const actualChangedForTargets = new Set(
      active.gitDiffResult?.actualChangedFiles ??
      active.changes.map((change) => change.path),
    );
    const targetRoles = active.changeSet.filesInScope.map((file) => ({
      file: file.path,
      role: file.mutationRole,
      mutationExpected: file.mutationExpected,
      actualChanged: actualChangedForTargets.has(file.path),
      reason: file.mutationReason,
    }));

    // Build the receipt without humanSummary first, then compose
    // the summary from the receipt itself (the summary generator
    // reads receipt fields like executionVerified, executionEvidence,
    // graphSummary, etc. — keeping receipts the source of truth).
    const baseReceipt: RunReceipt = {
      id: randomUUID(),
      runId: active.run.id,
      intentId: active.intent.id,
      timestamp: new Date().toISOString(),
      verdict,
      summary: {
        ...getRunSummary(active.run),
        ...(active.plan ? { waveSummary: summarizeWaveOutcomes(active.plan) } : {}),
      },
      graphSummary: getGraphSummary(active.graph),
      verificationReceipt,
      waveVerifications: [...active.waveVerifications],
      judgmentReport,
      mergeDecision,
      totalCost: aggregatedCost,
      commitSha,
      durationMs,
      executionVerified: executionDecision?.executionVerified ?? false,
      executionGateReason:
        executionDecision?.reason ??
        "Execution gate was not evaluated for this run",
      executionEvidence: executionDecision ? [...executionDecision.evidence] : [],
      executionReceipts: executionDecision ? [...executionDecision.workerReceipts] : [],
      humanSummary: null,
      blastRadius: active.blastRadius ?? null,
      escalation: active.runInvocationContext.escalationCount > 0
        ? {
            triggered: true,
            fromConfidence: 0,
            toModel: "claude-sonnet-4-6",
            reason: `${active.runInvocationContext.escalationCount} escalation(s) triggered due to low builder confidence`,
          }
        : null,
      evaluation: null,
      patchArtifact: active.patchArtifact ?? null,
      workspaceCleanup: active.workspaceCleanup ?? null,
      sourceRepo: active.sourceRepo ?? null,
      sourceCommitSha: active.workspace?.sourceCommitSha ?? null,
      targetRoles,
      confidenceGate,
      fastPath: active.fastPath || undefined,
      // Candidate manifest (Phase B). Only emitted when at least one
      // candidate was recorded — keeps receipts emitted on legacy /
      // primary_only runs byte-identical to pre-Phase-B receipts.
      ...(active.candidates.length > 0
        ? {
            candidates: this.buildCandidateManifest(active),
            selectedCandidateWorkspaceId:
              selectBestCandidate(active.candidates)?.workspaceId ?? null,
            laneMode: active.laneConfig.mode,
          }
        : {}),
    };

    // Compose the human-readable summary from the receipt we just
    // built. Pure function — see core/run-summary.ts.
    const averageWorkerConfidence = this.averageWorkerConfidence(active.workerResults);
    const humanSummary = this.composeHumanSummary(active, baseReceipt, averageWorkerConfidence);
    console.log(
      `[coordinator] run summary: classification=${humanSummary.classification} ` +
      `confidence=${Math.round(humanSummary.confidence.overall * 100)}% ` +
      `files=${humanSummary.filesTouchedCount} blast=${humanSummary.blastRadius.level}`,
    );
    console.log(`[coordinator] run summary headline: ${humanSummary.headline}`);

    return {
      ...baseReceipt,
      humanSummary,
    };
  }

  /**
   * Average worker confidence across all worker results in the
   * current run. Used as an optional boost/penalty signal in the
   * confidence scoring breakdown. Returns 0 when there are no
   * worker results yet (pre-build coherence failure path) so the
   * scorer can fall back to its gate-only path.
   */
  private averageWorkerConfidence(results: readonly WorkerResult[]): number {
    if (results.length === 0) return 0;
    let total = 0;
    let count = 0;
    for (const r of results) {
      if (typeof r.confidence === "number") {
        total += r.confidence;
        count += 1;
      }
    }
    return count > 0 ? total / count : 0;
  }

  /**
   * Alert policy:
   *   - Inputs: last 10 receipt index entries; if fewer than 5 exist
   *     the detector abstains (returns null).
   *   - Signals (each independent):
   *       1. overconfident-this-run: confidence ≥ 0.7 AND Crucibulum
   *          evaluation score < 0.5 on the current run.
   *       2. low-success-rate: success ratio < 0.4 across the last ≥8
   *          runs (where "success" = VERIFIED_PASS /
   *          READY_FOR_PROMOTION / COMPLETE).
   *       3. streaking-failures: 3+ of the last 5 runs are
   *          VERIFIED_FAIL or CRUCIBULUM_FAIL.
   *   - Severity: "significant" if ≥2 signals fire, "mild" otherwise.
   *   - Lifecycle:
   *       - A snapshot is written to `active.trustRegressionAlert`
   *         when signals fire, attached to the RunSummary/receipt,
   *         and emitted as a WebSocket `trust_regression` event.
   *       - The snapshot persists on the receipt — consumers can
   *         rediscover the state after restart or late subscribe
   *         without relying on a transient event.
   *       - A run with no signals clears nothing; older alerts live
   *         on their own receipts. The dashboard consumes receipts
   *         over a sliding window, so "clearing" means newer receipts
   *         no longer carry an alert.
   *   - Never blocks a run; this is strictly observational.
   *   - Detector failure is non-fatal.
   */
  private async detectTrustRegression(active: ActiveRun, receipt: RunReceipt): Promise<TrustRegressionSnapshot | null> {
    try {
      const recentRuns = await this.receiptStore.listRuns(10);
      // Cold-start guard: need at least 8 runs with meaningful verdicts
      // to distinguish "still calibrating" from "real regression". The
      // old threshold of 5 fired on every fresh project because the
      // first few runs naturally fail while models/config stabilize.
      if (recentRuns.length < 8) return null;

      const signals: string[] = [];
      const confidence = receipt.humanSummary?.confidence?.overall ?? 0;
      const evalScore = receipt.evaluation?.aggregate?.averageScore != null
        ? receipt.evaluation.aggregate.averageScore / 100
        : null;

      if (confidence >= 0.7 && evalScore != null && evalScore < 0.5) {
        signals.push("overconfident: confidence " + (confidence * 100).toFixed(0) + "% but evaluation " + (evalScore * 100).toFixed(0) + "%");
      }

      const recentVerdicts = recentRuns.slice(0, 10).map((r) => r.status);
      // Count PROMOTED as success — auto-promoted runs are the pipeline's
      // strongest signal that things worked correctly.
      const SUCCESS_STATUSES = new Set([
        "VERIFIED_PASS", "READY_FOR_PROMOTION", "COMPLETE", "PROMOTED",
      ]);
      // Provider/infra failures are not code quality regressions — exclude
      // them from the denominator so a bad ollama day doesn't trigger false
      // regression alerts.
      const INFRA_STATUSES = new Set([
        "INTERRUPTED", "CLEANUP_ERROR",
      ]);
      const meaningfulVerdicts = recentVerdicts.filter((s) => !INFRA_STATUSES.has(s));
      const recentSuccesses = meaningfulVerdicts.filter((s) => SUCCESS_STATUSES.has(s)).length;
      const successRate = meaningfulVerdicts.length > 0 ? recentSuccesses / meaningfulVerdicts.length : 1;
      if (meaningfulVerdicts.length >= 8 && successRate < 0.3) {
        signals.push("low success rate: " + (successRate * 100).toFixed(0) + "% across last " + meaningfulVerdicts.length + " meaningful runs");
      }

      const recentFails = recentRuns.slice(0, 5).filter(
        (r) => r.status === "VERIFIED_FAIL" || r.status === "CRUCIBULUM_FAIL",
      ).length;
      if (recentFails >= 4) {
        signals.push(recentFails + " verification failures in last 5 runs");
      }

      if (signals.length === 0) return null;

      const snapshot: TrustRegressionSnapshot = {
        severity: signals.length >= 2 ? "significant" : "mild",
        signals,
        at: new Date().toISOString(),
        firedOnThisRun: true,
      };

      this.emit({
        type: "trust_regression",
        payload: {
          runId: active.run.id,
          signals: snapshot.signals,
          severity: snapshot.severity,
          at: snapshot.at,
          recommendation: "Review trust dashboard before approving more runs",
        },
      });
      console.warn("[coordinator] TRUST REGRESSION (" + snapshot.severity + "): " + signals.join("; "));
      return snapshot;
    } catch (err) {
      // Detection failure is non-fatal — never block a run for this
      console.debug("[coordinator] trust regression detection failed: " + (err instanceof Error ? err.message : String(err)));
      return null;
    }
  }

  /**
   * Compute calibrated confidence thresholds from the project memory's
   * historical trust data. Returns null when insufficient data.
   */
  private computeCalibratedThresholds(active: ActiveRun): import("./confidence-scoring.js").CalibratedThresholds | undefined {
    const memory = active.projectMemory;
    if (!memory || memory.taskPatterns.length === 0) return undefined;

    // Weighted average overconfidence rate across all archetypes
    let totalObserved = 0;
    let weightedOverconf = 0;
    for (const p of memory.taskPatterns) {
      totalObserved += p.observedRuns;
      weightedOverconf += p.overconfidenceRate * p.observedRuns;
    }
    const overconfidenceRate = totalObserved > 0 ? weightedOverconf / totalObserved : 0;
    const evaluatedRuns = memory.recentTasks.filter((t) => t.evaluationScore != null).length;

    return calibrateThresholds(overconfidenceRate, 0, evaluatedRuns);
  }

  private composeHumanSummary(
    active: ActiveRun,
    receipt: RunReceipt,
    averageWorkerConfidence: number = this.averageWorkerConfidence(active.workerResults),
    trustRegressionAlert: TrustRegressionAlert | null = null,
  ): RunSummary {
    return generateRunSummary({
      receipt,
      userPrompt: active.rawUserPrompt || active.normalizedInput,
      scopeClassification: active.scopeClassification ?? null,
      changes: active.changes.map((c) => ({ path: c.path, operation: c.operation })),
      averageWorkerConfidence,
      gitDiffConfirmationRatio: active.gitDiffResult?.confirmationRatio,
      gitDiffResult: active.gitDiffResult,
      requiredFiles: active.changeSet.filesInScope
        .filter((file) => file.mutationExpected)
        .map((file) => file.path),
      projectRoot: active.projectRoot,
      patternWarnings: active.patternWarnings,
      historicalInsights: active.historicalInsights,
      confidenceDampening: active.confidenceDampening,
      strictMode: active.gatedContext.strictVerification === true || this.config.verificationConfig?.strictMode === true || shouldRecommendStrictMode(active.projectMemory, { prompt: active.normalizedInput, scopeType: active.scopeClassification?.type }),
      historicalReliabilityTier: active.historicalReliabilityTier,
      calibratedThresholds: this.computeCalibratedThresholds(active),
      contextInclusionLog: active.gatedContext.inclusionLog ?? [],
      trustRegressionAlert,
    });
  }

  private verificationPipelineFor(active: ActiveRun): VerificationPipeline {
    const strictMode = active.gatedContext.strictVerification === true || this.config.verificationConfig?.strictMode === true;
    if (!strictMode) return this.verifier;
    return new VerificationPipeline({
      ...this.config.verificationConfig,
      strictMode: true,
    });
  }

  /**
   * Emit the appropriate execution event so the UI can render real
   * state. "execution_verified" is fired when the gate saw at least
   * one piece of verifiable evidence; "execution_failed" is fired
   * otherwise (no-op, cancelled, or errored).
   */
  private emitExecutionEvent(runId: string, decision: ExecutionGateDecision): void {
    if (decision.executionVerified) {
      this.emit({
        type: "execution_verified",
        payload: {
          runId,
          reason: decision.reason,
          counts: decision.counts,
          evidence: decision.evidence,
          receipts: decision.workerReceipts,
        },
      });
      return;
    }
    this.emit({
      type: "execution_failed",
      payload: {
        runId,
        reason: decision.reason,
        verdict: decision.verdict,
        errorMessage: decision.errorMessage,
        counts: decision.counts,
        evidence: decision.evidence,
        receipts: decision.workerReceipts,
      },
    });
  }

  /**
   * Emit the human-readable run summary as its own event so Lumen
   * and other subscribers have a single hook for "here is the
   * plain-English story of this run." Always fires alongside
   * run_complete. Pure serialization — no computation done here.
   */
  private emitRunSummary(runId: string, receipt: RunReceipt): void {
    const payload = buildRunSummaryPayload(runId, receipt);
    if (!payload) return;
    this.emit({
      type: "run_summary",
      payload,
    });
  }

  private logExecutionDecision(decision: ExecutionGateDecision): void {
    console.log(
      `[coordinator] execution-gate: verdict=${decision.verdict} ` +
      `verified=${decision.executionVerified} ` +
      `evidence=${decision.counts.evidenceItems} ` +
      `(created=${decision.counts.filesCreated} modified=${decision.counts.filesModified} deleted=${decision.counts.filesDeleted}) ` +
      `reason="${decision.reason}"`,
    );
    if (!decision.executionVerified && decision.errorMessage) {
      console.error(`[coordinator] execution-gate: errored — ${decision.errorMessage}`);
    }
  }

  private async persistMemoryArtifacts(
    active: ActiveRun,
    rawInput: string,
    normalizedInput: string,
    receipt: RunReceipt,
    verificationReceipt: VerificationReceipt | null,
    mergeDecision: MergeDecision | null,
    repairAudit: RepairAuditResult | null,
    commitSha: string | null,
  ): Promise<string[]> {
    const filesTouched = this.uniqueStrings([
      ...active.changes.map((change) => change.path),
      ...active.run.filesTouched.map((touch) => touch.filePath),
    ]);
    // Write memory to the SOURCE repo, not the workspace.
    // The workspace is disposable — memory must persist across runs.
    await recordTask(active.sourceRepo, {
      prompt: rawInput,
      normalizedPrompt: normalizedInput,
      verdict: receipt.verdict,
      commitSha,
      cost: receipt.totalCost.estimatedCostUsd,
      timestamp: receipt.timestamp,
      filesTouched,
      scopeType: active.scopeClassification?.type,
      complexityTier: active.scopeClassification ? String(active.scopeClassification.blastRadius) : undefined,
      resultSummary: receipt.summary.phase,
      verificationVerdict: verificationReceipt?.verdict,
      failureSummary: mergeDecision?.primaryBlockReason || active.run.failureReason || undefined,
      successPattern: receipt.verdict === "success" ? "Scoped fix passed commit and verification gates." : undefined,
      affectedSystems: this.uniqueStrings(filesTouched.map((file) => file.split("/")[0] ?? "").filter(Boolean)),
      changeTypes: this.uniqueStrings(active.changes.map((change) => change.operation)),
      taskTypeKey: deriveTaskTypeKey(normalizedInput, active.scopeClassification?.type),
      plannedFilesCount: active.changeSet.filesInScope.length,
      missingFiles: active.gitDiffResult?.expectedButUnchanged ?? [],
      undeclaredFiles: active.gitDiffResult?.undeclaredChanges ?? [],
      verificationCoverageRatio: verificationReceipt?.coverageRatio ?? null,
      validatedRatio: verificationReceipt?.validatedRatio ?? null,
      // Evaluation feedback — thread Crucibulum results into pattern memory
      aedisConfidence: receipt.humanSummary?.confidence?.overall ?? null,
      evaluationScore: receipt.evaluation?.aggregate?.averageScore ?? null,
      evaluationPassed: receipt.evaluation?.aggregate?.overallPass ?? null,
      disagreementDirection: receipt.evaluation?.disagreement?.direction ?? null,
    });

    const memoryAdapter = await getAedisMemoryAdapter();
    if (!memoryAdapter) return [];
    // Write memory to the SOURCE repo, not the workspace.
    const result = await memoryAdapter.persistRunMemory({
      projectRoot: active.sourceRepo,
      rawInput,
      normalizedPrompt: normalizedInput,
      scopeClassification: active.scopeClassification,
      projectMemory: active.projectMemory,
      run: active.run,
      receipt,
      changes: active.changes,
      workerResults: active.workerResults,
      verificationReceipt,
      mergeDecision,
      repairAudit,
      commitSha,
    });
    return result.suggestions;
  }

  private determineVerdict(
    active: ActiveRun,
    verificationReceipt: VerificationReceipt | null,
    judgmentReport: JudgmentReport | null,
    mergeDecision: MergeDecision | null = null,
  ): RunReceipt["verdict"] {
    return determineRunVerdict({
      cancelled: active.cancelled,
      runPhase: active.run.phase,
      mergeAction: mergeDecision?.action ?? null,
      verificationVerdict: verificationReceipt?.verdict ?? null,
      judgmentPassed: judgmentReport?.passed ?? null,
      hasFailedNodes: hasFailedNodes(active.graph),
    });
  }

  private async abortWorkspaceRun(input: {
    run: RunState;
    intentId: string;
    prompt: string;
    blastRadius: BlastRadiusEstimate | null;
    sourceRepo: string;
    sourceRootExistsAtStart: boolean;
    cause: string;
    startTime: number;
  }): Promise<RunReceipt> {
    const abortReason =
      `Workspace creation failed and requireWorkspace=true — run aborted ` +
      `without mutating the source repo. Cause: ${input.cause}`;
    failRun(input.run, abortReason);

    const receiptRoot = resolve(this.receiptStore.rootDir);
    const sourceRoot = resolve(input.sourceRepo);
    const receiptRootTouchesMissingSource =
      !input.sourceRootExistsAtStart &&
      (receiptRoot === sourceRoot || receiptRoot.startsWith(`${sourceRoot}/`));

    if (!receiptRootTouchesMissingSource) {
      await this.receiptStore.patchRun(input.run.id, {
        intentId: input.intentId,
        prompt: input.prompt,
        taskSummary: abortReason,
        status: "EXECUTION_ERROR",
        phase: input.run.phase,
        completedAt: new Date().toISOString(),
        appendErrors: [abortReason],
        appendCheckpoints: [{
          at: new Date().toISOString(),
          type: "failure_occurred",
          status: "EXECUTION_ERROR",
          phase: input.run.phase,
          summary: "Workspace creation failed — run aborted before any repo mutation",
          details: { cause: input.cause },
        }],
      });
    } else {
      console.warn(
        `[coordinator] skipping abort receipt persistence because receipt root is inside missing source path: ${this.receiptStore.rootDir}`,
      );
    }

    this.emit({
      type: "merge_blocked",
      payload: { runId: input.run.id, blockers: [abortReason] },
    });
    this.emit({
      type: "run_complete",
      payload: {
        runId: input.run.id,
        verdict: "failed",
        executionVerified: false,
        executionReason: abortReason,
        classification: null,
      },
    });

    return {
      id: randomUUID(),
      runId: input.run.id,
      intentId: input.intentId,
      timestamp: new Date().toISOString(),
      verdict: "failed",
      summary: getRunSummary(input.run),
      graphSummary: getGraphSummary(createTaskGraph(input.intentId)),
      verificationReceipt: null,
      waveVerifications: [],
      judgmentReport: null,
      mergeDecision: null,
      totalCost: { model: "", inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
      commitSha: null,
      durationMs: Date.now() - input.startTime,
      memorySuggestions: [],
      executionVerified: false,
      executionGateReason: abortReason,
      executionEvidence: [],
      executionReceipts: [],
      humanSummary: null,
      blastRadius: input.blastRadius,
      evaluation: null,
      patchArtifact: null,
      workspaceCleanup: null,
      sourceRepo: input.sourceRepo,
      sourceCommitSha: null,
      targetRoles: [],
      confidenceGate: null,
    };
  }

  // ─── Repo Hub Index (GAP 3) ─────────────────────────────────────────

  /**
   * Build a lightweight repo import-connectivity index by scanning
   * TypeScript/JavaScript files for import statements and counting
   * how many files import each target. Returns the top N most-imported
   * files sorted by import count descending.
   */
  private async buildRepoHubIndex(
    projectRoot: string,
  ): Promise<{ file: string; importedByCount: number }[]> {
    // Cache check — reuse if within 5 minutes. Repo structure doesn't
    // change within a single Aedis session frequently enough to warrant
    // re-scanning on every submit.
    const HUB_INDEX_TTL_MS = 5 * 60 * 1000;
    const cached = this.hubIndexCache.get(projectRoot);
    if (cached && Date.now() - cached.timestamp < HUB_INDEX_TTL_MS) {
      console.log(`[coordinator] buildRepoHubIndex: cache hit for ${projectRoot} (age ${Math.round((Date.now() - cached.timestamp) / 1000)}s)`);
      return cached.result;
    }
    const { readdir, readFile } = await import("fs/promises");
    const { join, relative } = await import("path");

    const importCounts = new Map<string, number>();

    async function walkDir(dir: string): Promise<string[]> {
      const files: string[] = [];
      try {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") continue;
          const fullPath = join(dir, entry.name);
          if (entry.isDirectory()) {
            files.push(...await walkDir(fullPath));
          } else if (/\.[tj]sx?$/.test(entry.name)) {
            files.push(fullPath);
          }
        }
      } catch { /* ignore permission errors */ }
      return files;
    }

    const allFiles = await walkDir(projectRoot);
    const importPattern = /(?:from\s+['"]|import\s+['"]|require\s*\(\s*['"])([^'"]+)['"]/g;

    for (const filePath of allFiles) {
      try {
        const content = await readFile(filePath, "utf-8");
        let match: RegExpExecArray | null;
        while ((match = importPattern.exec(content)) !== null) {
          const importPath = match[1];
          if (!importPath || importPath.startsWith(".")) {
            // Resolve relative imports to a canonical path
            const resolvedDir = join(filePath, "..");
            let resolved = join(resolvedDir, importPath);
            // Strip .js extension used in ESM imports
            resolved = resolved.replace(/\.js$/, ".ts");
            const rel = relative(projectRoot, resolved);
            importCounts.set(rel, (importCounts.get(rel) ?? 0) + 1);
          } else {
            // External package — skip
          }
        }
      } catch { /* skip unreadable files */ }
    }

    const result = [...importCounts.entries()]
      .map(([file, count]) => ({ file, importedByCount: count }))
      .sort((a, b) => b.importedByCount - a.importedByCount)
      .slice(0, 10);

    // Cache the result
    this.hubIndexCache.set(projectRoot, { result, timestamp: Date.now() });
    return result;
  }

  // ─── Event Helpers ─────────────────────────────────────────────────

  private emit(event: AedisEvent): void {
    this.eventBus?.emit(event);
  }

}

// ─── Internal State ──────────────────────────────────────────────────

interface ActiveRun {
  intent: IntentObject;
  run: RunState;
  graph: TaskGraphState;
  changes: FileChange[];
  workerResults: WorkerResult[];
  cancelled: boolean;
  /**
   * Wall-clock ms since epoch when the run entered AWAITING_APPROVAL.
   * Set in the await-gate immediately before pendingApproval registration;
   * undefined for runs that never paused for approval. Read by
   * rejectExpiredApprovals to age abandoned approvals.
   */
  awaitingApprovalSinceMs?: number;
  /**
   * Effective project root for this run. In isolated workspace mode,
   * this points to the WORKSPACE path, not the source repo. All file
   * mutations, git operations, and worker dispatches target this path.
   *
   * The original source repo path is stored in `sourceRepo`.
   */
  projectRoot: string;
  /**
   * Original source repo path. NEVER written to during a run.
   * Used only for: memory loading, context assembly reads, and
   * recording the source in receipts.
   */
  sourceRepo: string;
  /**
   * Workspace handle for isolated execution. Null when workspace
   * creation is disabled or failed (legacy fallback mode).
   *
   * Backward-compat anchor for code that pre-dates the multi-workspace
   * model. Always points at the primary workspace; shadow workspaces
   * are reachable via `workspaces` below.
   */
  workspace: WorkspaceHandle | null;
  /**
   * All workspaces attached to this run, keyed by stable workspaceId
   * ("primary", "shadow-1", …). The primary entry mirrors `workspace`
   * above. Shadow entries are added by createShadowWorkspaceForRun.
   * WorkspaceEntry wraps a vanilla WorkspaceHandle with role + id —
   * those are coordinator-side concerns that don't belong on the
   * workspace-manager handle itself.
   */
  workspaces: Map<string, WorkspaceEntry>;
  /**
   * Per-workspace Builder candidates. The primary candidate is
   * recorded by recordPrimaryCandidate when the run reaches a
   * promotable state; shadow candidates are recorded by
   * runShadowBuilder. Selection (selectBestCandidate) consumes this.
   */
  candidates: import("./candidate.js").Candidate[];
  /**
   * Lane policy resolved at submit() time. Loaded from
   * `.aedis/lane-config.json` via loadLaneConfigFromDisk; falls back
   * to DEFAULT_LANE_CONFIG (primary_only) when no file exists. The
   * `local_then_cloud` mode is the only non-primary mode wired
   * through the production pipeline today; everything else
   * type-checks but the dispatch path is still primary-only.
   */
  laneConfig: import("./lane-config.js").LaneConfig;
  /** Gated project memory relevant to the current prompt, for Scout context. */
  gatedContext: GatedContext;
  /**
   * Raw ProjectMemory loaded at submit() time. Held so per-builder
   * dispatch can re-gate with a wave filter (see
   * resolveRecentContext). We do not re-read from disk per dispatch
   * because memory changes during a run are rare and the cost of
   * re-reading adds up across large graphs.
   */
  projectMemory: Awaited<ReturnType<typeof loadMemory>>;
  /** Request analysis from the charter pass. Reused when rebuilding fallback briefs. */
  analysis: RequestAnalysis;
  /** Normalized prompt from PHASE 1. Used for wave-aware gating. */
  normalizedInput: string;
  memorySuggestions: string[];
  /**
   * Per-submit ContextAssembler constructed in submit() with the per-task
   * projectRoot. Used by dispatchNode to assemble context for each worker.
   * Not a class field on Coordinator because the projectRoot may differ
   * per submission.
   */
  contextAssembler: ContextAssembler;
  /**
   * Per-submit IntegrationJudge constructed in submit() with the per-task
   * projectRoot. Used by Phase 8 (post-build) and evaluateCheckpoints
   * (per-checkpoint mini-judge). Not a class field on Coordinator because
   * the projectRoot affects checkIntentAlignment path normalization.
   */
  judge: IntegrationJudge;
  /**
   * Scope classification produced after PHASE 1 (charter). Captures
   * type / blastRadius / decompose recommendation so downstream phases
   * (and post-run analysis) can react to oversized requests without
   * re-running the classifier. Set in submit() between charter generation
   * and intent locking.
   */
  scopeClassification?: ScopeClassification | null;
  /**
   * ChangeSet built from the locked intent and the charter's target files.
   * Carries filesInScope, dependency relationships, shared invariants,
   * acceptance criteria, and a coherence verdict — everything downstream
   * planners need to reason about the change as a unit. Set in submit()
   * after PHASE 2 (intent locked) and attached during ActiveRun
   * construction.
  */
  changeSet: ChangeSet;
  plan?: Plan;
  /**
   * Engineer-grade work order built after charter/scope/plan exist and
   * before Builder dispatch. Passed into every worker assignment so the
   * Builder sees selected files + rationale, rejected candidates, staged
   * plan, non-goals, verification commands, and (on retries) a
   * sharpened retry hint. Mutable to allow weak-output recovery to
   * rebuild it with an updated retryHint/attempt.
   */
  implementationBrief?: ImplementationBrief;
  /**
   * Number of weak-output retries already used this run. Capped at 2:
   * one sharpened retry on the same tier, then one stronger-tier retry
   * if a distinct stronger model is configured.
   */
  weakOutputRetries: number;
  /**
   * Generation IDs (=runTask.id) of dispatches that were cancelled
   * mid-flight, typically by a stage-timeout race. dispatchNode checks
   * this set after worker.execute returns; if its generation is here,
   * the result is treated as stale: per-attempt diagnostics are still
   * persisted (cost survives) but marked stale=true, and the result is
   * not applied to workerResults / changes / graph state.
   */
  cancelledGenerations: Set<string>;
  /**
   * Active dispatches in flight, keyed by node.id. Used to drain a
   * timed-out dispatch before a recovery retry starts on the same node.
   * Prevents the "two dispatches racing on the same workspace" failure
   * mode that produced ENOENT in earlier live runs.
   */
  pendingDispatches: Map<string, Promise<unknown>>;
  /** Files or paths considered and dropped during planning/context selection. */
  rejectedCandidates: RejectedCandidate[];
  /**
   * Defense-in-depth tripwire: paths the user named in the prompt that
   * existed on disk but fell out of the final deliverable manifest after
   * `prepareDeliverablesForGraph`. Populated by Phase 4.6 of the prepare
   * pass. The merge gate emits a `coordinator:user-target-stripped`
   * critical finding for each entry, refusing to merge when the user's
   * own target list isn't honored. The fix that motivated this field
   * (Case 1, 1efad650) keeps the array empty in normal operation; this
   * is a regression net for future filter changes.
   */
  userNamedStrippedTargets: string[];
  /**
   * When true, this run was detected as a trivial single-file edit and
   * uses the fast execution path: no integrator, heuristic-only critic,
   * limited scout scope. Verifier + typecheck still run.
   */
  fastPath: boolean;
  /**
   * Per-run AbortController. cancel(runId) calls .abort() on this so
   * in-flight provider HTTP requests are dropped immediately instead
   * of running to completion. Threaded into every WorkerAssignment
   * via buildDispatchAssignment, then into invokeModelWithFallback.
   * Stale-result guards remain as a backstop for late settlements.
   */
  runAbortController: AbortController;
  /** Tracks which capability floor we've enforced, for receipt transparency. */
  capabilityFloorApplied?: {
    readonly floor: "fast" | "standard" | "premium";
    readonly reason: string;
    readonly configured: "fast" | "standard" | "premium";
    readonly escalated: boolean;
  };
  /**
   * Receipts from per-wave verification (P2). One entry per wave of
   * the plan that actually had changes to verify. Empty when no plan
   * or when no wave had files. Feeds into the MergeGate so a failing
   * wave becomes a critical blocking finding attributed to that wave.
   */
  waveVerifications: VerificationReceipt[];
  /**
   * Raw user prompt captured at submit() time. The run summary uses
   * this for the "what was attempted" field so the user sees their
   * original request back, not the normalized one.
   */
  rawUserPrompt: string;
  /**
   * Planning-time blast radius estimate computed after scope
   * classification. Attached to the RunReceipt and included in the
   * run summary for after-run comparison.
   */
  blastRadius: BlastRadiusEstimate | null;
  /** Per-run invocation context for confidence-based escalation (GAP 4). */
  runInvocationContext: RunInvocationContext;
  /** GitDiffVerifier result from phase 9d. Null when not run. */
  gitDiffResult: GitDiffResult | null;
  /** Promotion-ready patch artifact. Generated after successful execution. */
  patchArtifact: PatchArtifact | null;
  /** Workspace cleanup result. Populated in finally block. */
  workspaceCleanup: WorkspaceCleanupResult | null;
  /** Lightweight historical warnings inferred from prior similar runs. */
  patternWarnings: string[];
  /** Historical insights for the explanation layer. */
  historicalInsights: string[];
  /** Confidence dampening factor from pattern history (0.8-1.0). */
  confidenceDampening: number;
  /** Historical reliability tier for the matched task archetype. */
  historicalReliabilityTier: "reliable" | "risky" | "caution" | "unknown" | null;
}
