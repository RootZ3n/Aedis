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
import { existsSync } from "fs";

import {
  createIntent,
  reviseIntent,
  validateIntent,
  type IntentObject,
  type CreateIntentParams,
  type Assumption,
  type Deliverable,
} from "./intent.js";
import { getCallLog } from "./model-invoker.js";
import { captureAndAnalyze } from "./vision.js";
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
} from "./receipt-store.js";
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
import {
  VerificationPipeline,
  type VerificationPipelineConfig,
  type VerificationReceipt,
} from "./verification-pipeline.js";
import { loadMemory, recordTask } from "./project-memory.js";
import {
  gateContext,
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
import { generateRunSummary, type RunSummary } from "./run-summary.js";
import { buildRunSummaryPayload, persistentStatusForReceipt } from "./coordinator-audit.js";
import { buildDispatchAssignment, workerCompleteEventType } from "./coordinator-dispatch.js";
import { determineRunVerdict } from "./coordinator-lifecycle.js";
import { estimateBlastRadius, type BlastRadiusEstimate } from "./blast-radius.js";
import { normalizePrompt } from "./prompt-normalizer.js";
import { classifyScope, type ScopeClassification } from "./scope-classifier.js";
import { createChangeSet, type ChangeSet } from "./change-set.js";
import { extractInvariants } from "./invariant-extractor.js";
import { planChangeSet, type Plan, type PlanWave } from "./multi-file-planner.js";
import { runRepairPass, type RepairResult } from "./repair-pass.js";
import {
  decideMerge,
  groupFindingsBySource,
  type MergeDecision,
  type MergeFinding,
} from "./merge-gate.js";
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
  /** Git branch to work on (created if needed) */
  workBranch: string;
  /** CharterGenerator config overrides */
  charterConfig?: Partial<CharterGeneratorConfig>;
  /** Verification configuration, including required external hooks. */
  verificationConfig?: Partial<VerificationPipelineConfig>;
}

const DEFAULT_CONFIG: CoordinatorConfig = {
  projectRoot: process.cwd(),
  maxRehearsalRounds: 3,
  maxRecoveryAttempts: 2,
  autoCommit: true,
  workBranch: "aedis/run",
};

export interface TaskSubmission {
  /** Raw user request (natural language) */
  input: string;
  /** Durable run ID assigned before execution begins. */
  runId?: string;
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
  readonly summary: ReturnType<typeof getRunSummary>;
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
}

// ─── Coordinator ─────────────────────────────────────────────────────

export class Coordinator {
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

  /** Active runs indexed by run ID */
  private activeRuns = new Map<string, ActiveRun>();

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
  }

  // ─── Public API ────────────────────────────────────────────────────

  /**
   * Submit a task and run the full build pipeline.
   * Returns a RunReceipt when complete.
   */
  async submit(submission: TaskSubmission): Promise<RunReceipt> {
    const startTime = Date.now();
    let commitSha: string | null = null;
    let verificationReceipt: VerificationReceipt | null = null;
    let judgmentReport: JudgmentReport | null = null;
    let repairResult: RepairResult | null = null;
    const input = submission.input;

    console.log(`[coordinator] ═══ submit() entry — input="${submission.input.slice(0, 80)}${submission.input.length > 80 ? "…" : ""}"`);

    // Resolve effective projectRoot for this submission. The Coordinator's
    // own config.projectRoot is the boot-time default; per-task submissions
    // can override via TaskSubmission.projectRoot. Workers receive the
    // effective root via assignment.projectRoot in dispatchNode.
    const effectiveProjectRoot = submission.projectRoot ?? this.config.projectRoot;
    console.log(
      `[coordinator] effective projectRoot for this submission: ${effectiveProjectRoot}` +
      (submission.projectRoot ? " (overridden via submission)" : " (Coordinator default)")
    );
    const projectMemory = await loadMemory(effectiveProjectRoot);
    let gatedContext = gateContext(projectMemory, input);
    console.log("[coordinator] gated context:", JSON.stringify(gatedContext));
    const normalizedInput = await normalizePrompt(input, gatedContext, effectiveProjectRoot);

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
    this.emit({ type: "run_started", payload: { runId: submission.runId ?? null, input: normalizedInput } });

    const analysis = this.charterGen.analyzeRequest(normalizedInput);
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
    const scopeClassification = classifyScope(normalizedInput, charterTargets);
    console.log(
      `[coordinator] scope: ${scopeClassification.type} blastRadius=${scopeClassification.blastRadius} decompose=${scopeClassification.recommendDecompose}`
    );
    if (scopeClassification.recommendDecompose) {
      console.warn("[coordinator] WARN: large scope detected — consider decomposing this task.");
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
    const baseChangeSet = createChangeSet(intent, charterTargets);
    const invariants = await extractInvariants(charterTargets, effectiveProjectRoot);
    const changeSet: ChangeSet = Object.freeze({
      ...baseChangeSet,
      invariants: Object.freeze(invariants),
    });
    console.log(`[coordinator] invariants: ${invariants.length} cross-file alignment constraints found.`);
    const plan =
      scopeClassification.type === "multi-file" || scopeClassification.type === "architectural"
        ? planChangeSet(changeSet, normalizedInput)
        : undefined;
    if (plan) {
      console.log(`[coordinator] multi-file plan: ${plan.waves.length} wave(s).`);
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

    // Phase 3: RunState
    console.log(`[coordinator] PHASE 3: RunState — creating`);
    const run = createRunState(intent.id, submission.runId);

    const active: ActiveRun = {
      intent,
      run,
      graph: createTaskGraph(intent.id),
      changes: [],
      workerResults: [],
      cancelled: false,
      projectRoot: effectiveProjectRoot,
      gatedContext,
      projectMemory,
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
    };
    this.activeRuns.set(run.id, active);
    console.log(`[coordinator] PHASE 3 done — run ${run.id} created, registered as active (projectRoot=${active.projectRoot})`);
    console.log(`[coordinator] changeSet created: ${charterTargets.length} file(s), scope=${active.scopeClassification?.type ?? "unknown"}`);
    await this.receiptStore.beginRun({
      runId: run.id,
      intentId: intent.id,
      prompt: input,
      taskSummary: input,
      startedAt: run.startedAt,
      phase: run.phase,
    });

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
        payload: { runId: run.id, summary: summaryAfterBuild },
      });
      await this.persistReceiptCheckpoint(active, {
        at: new Date().toISOString(),
        type: "planner_finished",
        status: "RUNNING",
        phase: run.phase,
        summary: `Planner built ${active.graph.nodes.length} task node(s)`,
        details: { graphSummary: summaryAfterBuild },
      });

      // Phase 5: Pre-Build Coherence
      console.log(`[coordinator] PHASE 5: Pre-Build Coherence — entering`);
      advancePhase(run, "scouting");
      await this.runPreBuildCoherence(active);
      console.log(`[coordinator] PHASE 5 done — coherence passed`);

      // Phase 6–7: Execute (Scout → Build → Rehearsal Loop)
      console.log(`[coordinator] PHASE 6: ExecuteGraph — entering with ${active.graph.nodes.length} node(s)`);
      await this.executeGraph(active);
      console.log(`[coordinator] PHASE 6 done — graph state: ${JSON.stringify(getGraphSummary(active.graph))}`);
      console.log(`[coordinator] PHASE 6 trace — builder nodes processed: ${active.graph.nodes.filter(n => n.workerType === 'builder').length}`);

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
        this.emit({ type: "integration_check", payload: { runId: run.id, phase: "post-build" } });
        judgmentReport = active.judge.judge(
          active.intent,
          run,
          active.changes,
          active.workerResults,
          "pre-apply"
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
            payload: { runId: run.id, blockers: judgmentReport.blockers },
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
        console.log(
          `[coordinator] PHASE 9: Verification — entering (${isMultiFile ? "change-set" : "single-file"} scope)`,
        );
        verificationReceipt = isMultiFile
          ? await this.verifier.verifyChangeSet(
              active.intent,
              run,
              active.changeSet,
              active.changes,
              active.workerResults,
            )
          : await this.verifier.verify(
              active.intent,
              run,
              active.changes,
              active.workerResults,
            );
        console.log(`[coordinator] PHASE 9 done — verdict=${verificationReceipt.verdict} summary=${verificationReceipt.summary}`);
        await this.persistReceiptCheckpoint(active, {
          at: new Date().toISOString(),
          type: "verification_result",
          status: "RUNNING",
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

      // Phase 9b: change-set gate (invariants + repair-pass) — only
      // meaningful for multi-file runs. Output is fed into the
      // MergeGate alongside judgment and verification.
      let changeSetGateInput:
        | Parameters<typeof decideMerge>[0]["changeSetGate"]
        | undefined;

      if (active.changeSet.filesInScope.length > 1) {
        const plan = active.plan ?? planChangeSet(active.changeSet, normalizedInput);
        const invariants = active.changeSet.invariants.length > 0
          ? [...active.changeSet.invariants]
          : await extractInvariants(
              active.changeSet.filesInScope.map((entry) => entry.path),
              active.projectRoot,
            );
        repairResult = await runRepairPass(active.changeSet, active.projectRoot);

        const allWavesComplete = isGraphComplete(active.graph) && !hasFailedNodes(active.graph);
        const invariantsSatisfied =
          active.changeSet.coherenceVerdict.coherent &&
          (invariants.length > 0 || plan.waves.every((wave) => wave.files.length <= 1));

        changeSetGateInput = {
          changeSet: active.changeSet,
          allWavesComplete,
          invariantsSatisfied,
          invariantCount: invariants.length,
          repairPass: repairResult,
        };
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
      const mergeDecision: MergeDecision =
        waveFailures.length === 0
          ? baseDecision
          : this.mergeInFindings(baseDecision, waveFailures);
      this.logMergeDecision(mergeDecision);
      this.recordMergeDecision(active, mergeDecision);

      if (mergeDecision.action === "block") {
        this.emit({
          type: "merge_blocked",
          payload: {
            runId: run.id,
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
          status: "FAILED",
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
            runId: run.id,
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

      // Phase 10: Commit
      const changeCount = Math.max(active.changes.length, active.run.filesTouched.length);
      const canCommit =
        this.config.autoCommit &&
        !active.cancelled &&
        changeCount > 0 &&
        mergeDecision.action === "apply";

      if (canCommit) {
        console.log(`[coordinator] PHASE 10: committing ${changeCount} change(s) (active.changes=${active.changes.length}, filesTouched=${active.run.filesTouched.length}) in ${active.projectRoot}...`);
        commitSha = await this.gitCommit(active);
        if (commitSha) {
          console.log(`[coordinator] PHASE 10 done — commit ${commitSha.slice(0, 8)} created`);
          this.emit({ type: "commit_created", payload: { runId: run.id, sha: commitSha } });
        } else {
          console.warn(`[coordinator] PHASE 10 — gitCommit returned null — see prior errors or recordDecision entries`);
        }
      } else if (this.config.autoCommit && !active.cancelled) {
        console.log(`[coordinator] PHASE 10 SKIPPED — no changes to commit (active.changes=0, filesTouched=0)`);
      } else {
        console.log(`[coordinator] PHASE 10 SKIPPED — autoCommit=${this.config.autoCommit} cancelled=${active.cancelled} changeCount=${changeCount}`);
      }

      if (repairResult) {
        console.log(
          `[coordinator] repair-pass: ${repairResult.repairsAttempted} attempted, ${repairResult.repairsApplied} applied, ${repairResult.issues.length} issues`
        );
      }

      if (process.env.AEDIS_VISION === "true") {
        try {
          const visionResult = await captureAndAnalyze(
            "http://localhost:18796",
            "describe the current run status and any visible errors",
          );
          console.log(
            `[coordinator] vision check: ${visionResult.slice(0, 200)}`
          );
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
        runId: run.id,
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

      // Finalize
      console.log(`[coordinator] FINALIZE — verdict=${verdictAfterGate} (pre-gate=${verdict} executionVerified=${executionDecision.executionVerified} cancelled=${active.cancelled} phase=${run.phase} hasFailedNodes=${hasFailedNodes(active.graph)} workerResults=${active.workerResults.length})`);

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
        repairResult,
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

      console.log(`[coordinator] ═══ submit() exit — verdict=${verdictAfterGate} duration=${Date.now() - startTime}ms`);
      this.emit({ type: "run_complete", payload: { runId: run.id, verdict: verdictAfterGate, executionVerified: executionDecision.executionVerified, executionReason: executionDecision.reason, classification: finalReceipt.humanSummary?.classification ?? null } });
      this.emit({ type: "run_receipt", payload: { runId: run.id, receiptId: finalReceipt.id, receipt: finalReceipt } });

      return finalReceipt;
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

      failRun(run, errMessage);

      // Execution gate on the exception path — a thrown error is
      // always an "errored" verdict and can never flip to success.
      // The gate still collects whatever evidence exists (partial
      // file writes, etc.) so the receipt tells the truth about
      // what got done before the failure.
      const executionDecision = evaluateExecutionGate({
        runId: run.id,
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
        repairResult,
        null,
      );
      const finalReceipt: RunReceipt = active.memorySuggestions.length > 0
        ? { ...receipt, memorySuggestions: [...active.memorySuggestions] }
        : receipt;
      await this.persistFinalReceipt(active, finalReceipt);

      this.emitExecutionEvent(run.id, executionDecision);
      this.emitRunSummary(run.id, finalReceipt);
      console.log(`[coordinator] ═══ submit() exit (failed) — verdict=${receipt.verdict} duration=${Date.now() - startTime}ms`);
      this.emit({ type: "run_complete", payload: { runId: run.id, verdict: "failed", executionVerified: false, executionReason: executionDecision.reason, error: errMessage, classification: finalReceipt.humanSummary?.classification ?? null } });
      this.emit({ type: "run_receipt", payload: { runId: run.id, receiptId: finalReceipt.id, receipt: finalReceipt } });
      return finalReceipt;
    } finally {
      this.activeRuns.delete(run.id);
    }
  }

  /**
   * Cancel a running task.
   */
  cancel(runId: string): boolean {
    const active = this.activeRuns.get(runId);
    if (!active) return false;
    active.cancelled = true;
    abortRun(active.run, "Cancelled by user");
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
   * Get status of an active run.
   */
  getRunStatus(runId: string): { run: RunState; graph: TaskGraphState } | null {
    const active = this.activeRuns.get(runId);
    if (!active) return null;
    return { run: active.run, graph: active.graph };
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

    const scoutNode = addNode(graph, {
      label: "Scout: gather context and assess risk",
      workerType: "scout",
      targetFiles,
      metadata: { category: analysis.category, scopeEstimate: analysis.scopeEstimate },
    });
    console.log(`[coordinator] buildTaskGraph: scout node added (${scoutNode.id.slice(0, 6)})`);

    const builderNodes: TaskNode[] = [];
    for (const deliverable of deliverables) {
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

  private prepareDeliverablesForGraph(
    active: ActiveRun,
    analysis: RequestAnalysis
  ): readonly Deliverable[] {
    const explicitTestRequest = this.userExplicitlyAskedForTests(analysis.raw);

    const explicitlyMentioned = new Set<string>();
    for (const target of analysis.targets) {
      const trimmed = target.trim();
      if (!trimmed) continue;
      explicitlyMentioned.add(trimmed);
      explicitlyMentioned.add(trimmed.replace(/^.*\//, ""));
    }
    const isExplicit = (file: string): boolean =>
      explicitlyMentioned.has(file) || explicitlyMentioned.has(file.replace(/^.*\//, ""));

    const totalBefore = active.intent.charter.deliverables.length;
    const decisions: string[] = [];
    let didFilter = false;

    console.log(`[coordinator] prepareDeliverablesForGraph: ${totalBefore} deliverable(s) before filter (projectRoot=${active.projectRoot})`);

    // ── PHASE 1 — Upstream empty guard ──────────────────────────────────
    const guarded: Deliverable[] = [];
    for (const d of active.intent.charter.deliverables) {
      if (!d.targetFiles || d.targetFiles.length === 0) {
        const label = d.description;
        console.warn(`[coordinator] WARN: dropping deliverable "${label}" upstream — no target files (charter placeholder or upstream bug)`);
        decisions.push(`  drop deliverable "${label}" (no target files at all — upstream guard)`);
        didFilter = true;
        continue;
      }
      guarded.push(d);
    }

    // ── PHASE 2 — Test/non-existent filter ──────────────────────────────
    const filtered: Deliverable[] = [];
    for (const deliverable of guarded) {
      const verifiedTargets = deliverable.targetFiles.filter((file) => {
        if (!file) {
          decisions.push(`  drop empty file path in deliverable "${deliverable.description}"`);
          return false;
        }

        if (file.startsWith(".aedis/") || file.endsWith(".json")) {
          console.log(`[coordinator] dropping system file from deliverables: ${file}`);
          decisions.push(`  drop ${file} (system file excluded from deliverables)`);
          didFilter = true;
          return false;
        }

        const exists = this.fileExists(file, active.projectRoot);
        const isTest = this.isTestFile(file);
        const wasExplicit = isExplicit(file);

        if (wasExplicit) {
          decisions.push(`  keep ${file} (explicitly mentioned in request)`);
          return true;
        }

        if (isTest && !explicitTestRequest && !exists) {
          decisions.push(`  drop ${file} (auto-generated test for non-existent file)`);
          didFilter = true;
          return false;
        }

        decisions.push(`  keep ${file}${exists ? "" : " (will be created)"}`);
        return true;
      });

      if (deliverable.targetFiles.length > 0 && verifiedTargets.length === 0) {
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
    const deduped: Deliverable[] = [];
    for (const d of filtered) {
      const uniqueFiles: string[] = [];
      for (const f of d.targetFiles) {
        // Resolve against active.projectRoot (the per-task effective root)
        // so dedup honors the per-task projectRoot rather than the
        // Coordinator's boot-time default.
        const abs = resolve(active.projectRoot, f);
        if (seenPaths.has(abs)) {
          decisions.push(`  dedupe ${f} (already covered by earlier deliverable as ${abs})`);
          didFilter = true;
          continue;
        }
        seenPaths.add(abs);
        uniqueFiles.push(f);
      }

      if (uniqueFiles.length === 0) {
        const label = d.description;
        console.warn(`[coordinator] WARN: dropping deliverable "${label}" after dedup — all target files were duplicates of earlier deliverables`);
        decisions.push(`  drop deliverable "${label}" (all target files were duplicates)`);
        didFilter = true;
        continue;
      }

      deduped.push({ ...d, targetFiles: uniqueFiles });
    }

    console.log(`[coordinator] prepareDeliverablesForGraph: ${deduped.length} deliverable(s) after filter+dedup`);
    for (const decision of decisions) {
      console.log(`[coordinator]${decision}`);
    }

    if (deduped.length === 0 && totalBefore > 0) {
      console.warn(
        `[coordinator] SAFETY NET TRIPPED: filter would have produced 0 deliverables from ${totalBefore}; ` +
        `returning original deliverables unchanged to avoid empty task graph. ` +
        `Decisions: ${decisions.join("; ")}`
      );
      recordDecision(active.run, {
        description: `Safety net: filter zeroed out ${totalBefore} deliverable(s); kept originals`,
        madeBy: "coordinator",
        taskId: null,
        alternatives: ["Allow empty graph and fail downstream"],
        rationale: decisions.join(" | "),
      });
      return active.intent.charter.deliverables;
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
    return /\b(add tests|test file|test files|tests)\b/i.test(request);
  }

  private isTestFile(filePath: string): boolean {
    return /\.(test|spec)\.(ts|tsx|js|jsx)$/.test(filePath);
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

    while (!isGraphComplete(graph) && !active.cancelled) {
      iteration++;
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

      const phases = dispatchable.map((n) => n.workerType);
      console.log(`[coordinator] executeGraph: dispatching ${dispatchable.length} node(s) of type(s) [${phases.join(", ")}]`);
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

      const results = await Promise.all(
        dispatchable.map((node) => this.dispatchNode(active, node))
      );

      for (const { node, result } of results) {
        if (result.success) {
          markCompleted(graph, node.id);
          this.collectChanges(active, result);
          this.emit({
            type: workerCompleteEventType(node.workerType as WorkerType),
            payload: { runId: run.id, taskId: node.id, confidence: result.confidence },
          });
        } else {
          console.warn(`[coordinator] executeGraph: marking node ${node.id.slice(0, 6)} (${node.workerType}) as FAILED — issue: ${result.issues[0]?.message ?? "(no message)"}`);
          markFailed(graph, node.id);
          this.emit({
            type: "task_failed",
            payload: { runId: run.id, taskId: node.id, error: result.issues[0]?.message },
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
              runId: run.id,
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
      payload: { runId: run.id, taskId: node.id, workerType: node.workerType },
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
    const context = await active.contextAssembler.assemble([...node.targetFiles]);

    const routingDecision = this.trustRouter.route(runTask, intent, context);
    node.assignedTier = routingDecision.tier;
    console.log(`[coordinator] dispatchNode: ${node.workerType} routed to tier=${routingDecision.tier}`);

    this.emit({
      type: "worker_assigned",
      payload: { runId: run.id, taskId: node.id, tier: routingDecision.tier, workerType: node.workerType },
    });

    const escalation = active.graph.escalationBoundaries.find((b) => b.nodeId === node.id);
    if (escalation) {
      const tierOrder = ["fast", "standard", "premium"] as const;
      const currentIdx = tierOrder.indexOf(routingDecision.tier);
      const minIdx = tierOrder.indexOf(escalation.minimumTier);
      if (currentIdx < minIdx) {
        this.emit({
          type: "escalation_triggered",
          payload: { runId: run.id, taskId: node.id, from: routingDecision.tier, to: escalation.minimumTier },
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
      recentContext,
      buildAssignment: (decision, task, intent, context, upstreamResults) =>
        this.trustRouter.buildAssignment(decision, task, intent, context, upstreamResults),
    });

    const worker = this.workerRegistry.getWorker(node.workerType as WorkerType);
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

    let result: WorkerResult;
    try {
      result = await worker.execute(assignment);
      console.log(`[coordinator] dispatchNode: ${node.workerType} returned success=${result.success} confidence=${result.confidence} touchedFiles=${result.touchedFiles.length} issues=${result.issues.length}`);
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err);
      console.error(`[coordinator] dispatchNode: ${node.workerType} EXECUTE THREW — ${errMessage}`);
      if (err instanceof Error && err.stack) {
        console.error(`[coordinator] dispatchNode: stack:\n${err.stack}`);
      }
      result = {
        workerType: node.workerType as WorkerType,
        taskId: runTask.id,
        success: false,
        output: { kind: "scout", dependencies: [], patterns: [], riskAssessment: { level: "low", factors: [], mitigations: [] }, suggestedApproach: "" },
        issues: [{ severity: "error", message: `Worker threw: ${errMessage}` }],
        cost: { model: "", inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
        confidence: 0,
        touchedFiles: [],
        assumptions: [],
        durationMs: 0,
      };
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
    return { node, result };
  }

  // ─── Pre-Build Coherence ───────────────────────────────────────────

  private async runPreBuildCoherence(active: ActiveRun): Promise<void> {
    const { run, intent, graph } = active;

    console.log(`[coordinator] runPreBuildCoherence: entering — ${intent.charter.deliverables.length} deliverables, ${graph.nodes.length} graph nodes`);
    this.emit({ type: "coherence_check_started", payload: { runId: run.id, phase: "pre-build" } });

    const checks = [];

    for (const deliverable of intent.charter.deliverables) {
      const hasNode = graph.nodes.some((n) =>
        n.targetFiles.some((f) => deliverable.targetFiles.includes(f))
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
      this.emit({ type: "coherence_check_passed", payload: { runId: run.id, phase: "pre-build" } });
    } else {
      const failedChecks = checks.filter((c) => !c.passed);
      console.error(`[coordinator] runPreBuildCoherence: ${failedChecks.length} of ${checks.length} checks FAILED — ${failedChecks.map((c) => c.message).join("; ")}`);
      this.emit({ type: "coherence_check_failed", payload: { runId: run.id, phase: "pre-build", checks } });
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
          payload: { runId: run.id, checkpoint: checkpoint.label },
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
      (d) => d.description.startsWith("Recovery attempt")
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

    this.emit({
      type: "recovery_attempted",
      payload: { runId: active.run.id, attempt: recoveryAttempts + 1 },
    });

    recordDecision(active.run, {
      description: `Recovery attempt ${recoveryAttempts + 1} for ${failedNodes.length} failed nodes`,
      madeBy: "coordinator",
      taskId: null,
      alternatives: ["Abort run", "Skip failed tasks"],
      rationale: "Attempting recovery before declaring failure",
    });

    for (const node of failedNodes) {
      (node as any).status = "planned";
      addEscalationBoundary(
        active.graph,
        node.id,
        "premium",
        "Escalated after failure — recovery attempt",
        "coordinator"
      );
      markReady(active.graph, node.id);
    }

    return true;
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
      const receipt = await this.verifier.verifyWave(
        active.intent,
        active.run,
        wave,
        active.changes,
        active.workerResults,
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
   * Collect failing wave receipts as synthetic merge findings. These
   * join the regular findings inside decideMerge so a failing wave
   * always produces a critical block.
   */
  private waveFailureFindings(active: ActiveRun): MergeFinding[] {
    const findings: MergeFinding[] = [];
    for (const receipt of active.waveVerifications) {
      if (receipt.verdict !== "fail") continue;
      const scope = receipt.scope;
      const waveId = scope && scope.kind === "wave" ? scope.waveId : 0;
      const waveName = scope && scope.kind === "wave" ? scope.waveName : "unknown";
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
        recordDecision(active.run, {
          description: `Blocked commit: ${corruptedFiles.length} files contained raw diff text instead of patched source`,
          madeBy: "coordinator",
          taskId: null,
          alternatives: ["Force commit anyway"],
          rationale: `Corrupted files: ${corruptedFiles.join(", ")}`,
        });
        return null;
      }

      const message = `aedis: ${active.intent.charter.objective}\n\nRun: ${active.run.id}\nIntent: ${active.intent.id} v${active.intent.version}`;

      // All git commands run with cwd=active.projectRoot so they target
      // the per-task effective root rather than the API server's cwd.
      // This is the difference between committing to the right repo vs.
      // committing to /mnt/ai/Zendorium accidentally.
      await exec("git", ["add", "-A"], { cwd: active.projectRoot });
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

  // ─── Change Collection ─────────────────────────────────────────────

  private collectChanges(active: ActiveRun, result: WorkerResult): void {
    if (result.output.kind === "builder") {
      active.changes.push(...result.output.changes);
    } else if (result.output.kind === "integrator") {
      active.changes = [...result.output.finalChanges];
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
      const runStartMs = Date.now() - durationMs;
      const log = getCallLog();
      let fallbackCost = 0;
      let fallbackIn = 0;
      let fallbackOut = 0;
      let fallbackModel = "";
      let entriesUsed = 0;
      for (const entry of log) {
        const entryMs = new Date(entry.timestamp).getTime();
        if (entryMs >= runStartMs) {
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
          `(${entriesUsed} entries within ${durationMs}ms run window)`
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
          `in the ${durationMs}ms run window. Receipt will report $0.000000.`
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
      summary: getRunSummary(active.run),
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
    };

    // Compose the human-readable summary from the receipt we just
    // built. Pure function — see core/run-summary.ts.
    const averageWorkerConfidence = this.averageWorkerConfidence(active.workerResults);
    const humanSummary = generateRunSummary({
      receipt: baseReceipt,
      userPrompt: active.rawUserPrompt || active.normalizedInput,
      scopeClassification: active.scopeClassification ?? null,
      changes: active.changes.map((c) => ({ path: c.path, operation: c.operation })),
      averageWorkerConfidence,
    });
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
    repairResult: RepairResult | null,
    commitSha: string | null,
  ): Promise<string[]> {
    const filesTouched = uniqueStrings([
      ...active.changes.map((change) => change.path),
      ...active.run.filesTouched.map((touch) => touch.filePath),
    ]);
    await recordTask(active.projectRoot, {
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
      affectedSystems: uniqueStrings(filesTouched.map((file) => file.split("/")[0] ?? "").filter(Boolean)),
      changeTypes: uniqueStrings(active.changes.map((change) => change.operation)),
    });

    const memoryAdapter = await getAedisMemoryAdapter();
    if (!memoryAdapter) return [];
    const result = await memoryAdapter.persistRunMemory({
      projectRoot: active.projectRoot,
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
      repairResult,
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
   * Effective project root for this submission. Resolved as
   * `submission.projectRoot ?? this.config.projectRoot` at the top of
   * submit(). Used by:
   *   - dispatchNode (attached to assignment.projectRoot)
   *   - prepareDeliverablesForGraph (path resolution for dedup)
   *   - fileExists (existence check for deliverable files)
   *   - gitCommit (cwd for git commands)
   *   - the per-submit ContextAssembler and IntegrationJudge constructed
   *     in submit() with this projectRoot
   */
  projectRoot: string;
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
}

// ─── Errors ──────────────────────────────────────────────────────────

export class CoordinatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoordinatorError";
  }
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}
