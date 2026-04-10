/**
 * Coordinator — Master orchestrator for Zendorium build runs.
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
  type VerificationReceipt,
} from "./verification-pipeline.js";
import { TrustRouter, type TrustProfile, type RoutingDecision } from "../router/trust-router.js";
import {
  type BaseWorker,
  type WorkerAssignment,
  type WorkerResult,
  type WorkerType,
  type FileChange,
  WorkerRegistry,
} from "../workers/base.js";
import type { EventBus, ZendoriumEvent } from "../server/websocket.js";

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
}

const DEFAULT_CONFIG: CoordinatorConfig = {
  projectRoot: process.cwd(),
  maxRehearsalRounds: 3,
  maxRecoveryAttempts: 2,
  autoCommit: true,
  workBranch: "zendorium/run",
};

export interface TaskSubmission {
  /** Raw user request (natural language) */
  input: string;
  /** Optional pre-structured charter params (bypasses CharterGenerator) */
  charterOverride?: CreateIntentParams;
  /** Optional constraints to add */
  extraConstraints?: CreateIntentParams["constraints"];
  /** Optional exclusions */
  exclusions?: string[];
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
  readonly judgmentReport: JudgmentReport | null;
  readonly totalCost: CostEntry;
  readonly commitSha: string | null;
  readonly durationMs: number;
}

// ─── Coordinator ─────────────────────────────────────────────────────

export class Coordinator {
  private config: CoordinatorConfig;
  private charterGen: CharterGenerator;
  private contextAssembler: ContextAssembler;
  private judge: IntegrationJudge;
  private verifier: VerificationPipeline;
  private trustRouter: TrustRouter;
  private workerRegistry: WorkerRegistry;
  private eventBus: EventBus | null;

  /** Active runs indexed by run ID */
  private activeRuns = new Map<string, ActiveRun>();

  constructor(
    config: Partial<CoordinatorConfig>,
    trustProfile: TrustProfile,
    workerRegistry: WorkerRegistry,
    eventBus?: EventBus
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.charterGen = new CharterGenerator(this.config.charterConfig);
    this.contextAssembler = new ContextAssembler({ projectRoot: this.config.projectRoot });
    this.judge = new IntegrationJudge();
    this.verifier = new VerificationPipeline();
    this.trustRouter = new TrustRouter(trustProfile);
    this.workerRegistry = workerRegistry;
    this.eventBus = eventBus ?? null;
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

    // Phase 1: Charter
    this.emit({ type: "run_started", payload: { input: submission.input } });

    const analysis = this.charterGen.analyzeRequest(submission.input);
    const charter = this.charterGen.generateCharter(analysis);
    const constraints = [
      ...this.charterGen.generateDefaultConstraints(analysis),
      ...(submission.extraConstraints ?? []),
    ];

    this.emit({ type: "charter_generated", payload: { charter, analysis } });

    // Phase 2: Intent
    const intent = createIntent({
      runId: randomUUID(),
      userRequest: submission.input,
      charter,
      constraints,
      exclusions: submission.exclusions,
    });

    const intentErrors = validateIntent(intent);
    if (intentErrors.length > 0) {
      throw new CoordinatorError(`Invalid intent: ${intentErrors.join(", ")}`);
    }

    this.emit({ type: "intent_locked", payload: { intentId: intent.id, version: intent.version } });

    // Phase 3: RunState
    const run = createRunState(intent.id);

    const active: ActiveRun = {
      intent,
      run,
      graph: createTaskGraph(intent.id),
      changes: [],
      workerResults: [],
      cancelled: false,
    };
    this.activeRuns.set(run.id, active);

    try {
      // Phase 4: Build TaskGraph
      advancePhase(run, "planning");
      this.buildTaskGraph(active, analysis);
      this.emit({
        type: "task_graph_built",
        payload: { runId: run.id, summary: getGraphSummary(active.graph) },
      });

      // Phase 5: Pre-Build Coherence
      advancePhase(run, "scouting");
      await this.runPreBuildCoherence(active);

      // Phase 6–7: Execute (Scout → Build → Rehearsal Loop)
      await this.executeGraph(active);

      // Phase 8: Post-Build IntegrationJudge
      if (!active.cancelled && !hasFailedNodes(active.graph)) {
        this.emit({ type: "integration_check", payload: { runId: run.id, phase: "post-build" } });
        judgmentReport = this.judge.judge(
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

        if (!judgmentReport.passed) {
          this.emit({
            type: "merge_blocked",
            payload: { runId: run.id, blockers: judgmentReport.blockers },
          });
        }
      }

      // Phase 9: Verification Pipeline
      if (judgmentReport?.passed && !active.cancelled) {
        verificationReceipt = await this.verifier.verify(
          active.intent,
          run,
          active.changes,
          active.workerResults
        );

        if (verificationReceipt.verdict === "fail") {
          this.emit({
            type: "merge_blocked",
            payload: { runId: run.id, reason: verificationReceipt.summary },
          });
        } else {
          this.emit({ type: "merge_approved", payload: { runId: run.id } });
        }
      }

      // Phase 10: Commit — commit if there are real file changes,
      // even on partial verdict (some tasks succeeded, some failed)
      const canCommit =
        this.config.autoCommit &&
        !active.cancelled &&
        active.changes.length > 0;

      if (canCommit) {
        commitSha = await this.gitCommit(active);
        if (commitSha) {
          this.emit({ type: "commit_created", payload: { runId: run.id, sha: commitSha } });
        }
      }

      // Finalize
      const verdict = this.determineVerdict(active, verificationReceipt, judgmentReport);
      if (verdict === "success" || verdict === "partial") {
        advancePhase(run, "complete");
      } else {
        failRun(run, "Build did not pass all checks");
      }

      const receipt = this.buildReceipt(
        active,
        verificationReceipt,
        judgmentReport,
        commitSha,
        Date.now() - startTime
      );

      this.emit({ type: "run_complete", payload: { runId: run.id, verdict } });
      this.emit({ type: "receipt_generated", payload: { receiptId: receipt.id } });

      return receipt;
    } catch (err) {
      failRun(run, err instanceof Error ? err.message : String(err));
      return this.buildReceipt(active, verificationReceipt, judgmentReport, null, Date.now() - startTime);
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
    const { graph } = active;
    const deliverables = this.prepareDeliverablesForGraph(active, analysis);

    const targetFiles = deliverables.flatMap((d) => d.targetFiles);

    const scoutNode = addNode(graph, {
      label: "Scout: gather context and assess risk",
      workerType: "scout",
      targetFiles,
      metadata: { category: analysis.category, scopeEstimate: analysis.scopeEstimate },
    });

    const builderNodes: TaskNode[] = [];
    for (const deliverable of deliverables) {
      const builder = addNode(graph, {
        label: `Build: ${deliverable.description}`,
        workerType: "builder",
        targetFiles: deliverable.targetFiles,
        metadata: { deliverableType: deliverable.type },
      });
      addEdge(graph, scoutNode.id, builder.id, "data");
      builderNodes.push(builder);
    }

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

    if (analysis.riskSignals.length > 0) {
      for (const builder of builderNodes) {
        addEscalationBoundary(
          graph,
          builder.id,
          "standard",
          `Risk signals: ${analysis.riskSignals.join(", ")}`,
          "coordinator"
        );
      }
    }

    markReady(graph, scoutNode.id);
  }

  private prepareDeliverablesForGraph(
    active: ActiveRun,
    analysis: RequestAnalysis
  ): readonly Deliverable[] {
    const explicitTestRequest = this.userExplicitlyAskedForTests(analysis.raw);

    // Build a normalized set of explicitly-mentioned targets. Match by BOTH
    // exact path AND basename so a deliverable for "core/recovery-engine.ts"
    // matches a request that just said "recovery-engine.ts" (and vice versa).
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

    console.log(`[coordinator] prepareDeliverablesForGraph: ${totalBefore} deliverable(s) before filter`);

    // ── PHASE 1 — Upstream empty guard ──────────────────────────────────
    // Drop deliverables that arrive with no target files at all. These come
    // from charter's placeholder fallback (charter.ts:259) or from upstream
    // auto-generation paths that never populate targetFiles. Catching them
    // here means downstream phases never see "ghost" deliverables that would
    // produce empty builder nodes.
    const guarded: Deliverable[] = [];
    for (const d of active.intent.charter.deliverables) {
      if (!d.targetFiles || d.targetFiles.length === 0) {
        const label = d.id ?? "<unnamed>";
        console.warn(`[coordinator] WARN: dropping deliverable "${label}" upstream — no target files (charter placeholder or upstream bug)`);
        decisions.push(`  drop deliverable "${label}" (no target files at all — upstream guard)`);
        didFilter = true;
        continue;
      }
      guarded.push(d);
    }

    // ── PHASE 2 — Test/non-existent filter ──────────────────────────────
    // Rule 1: explicitly mentioned files are sacrosanct, kept unconditionally.
    // Rule 2: drop only auto-generated test tasks for non-existent files.
    // Everything else stays — workers may create non-existent files, and
    // tests for existing files may be legitimate follow-up work.
    const filtered: Deliverable[] = [];
    for (const deliverable of guarded) {
      const verifiedTargets = deliverable.targetFiles.filter((file) => {
        if (!file) {
          decisions.push(`  drop empty file path in deliverable "${deliverable.id ?? "<unnamed>"}"`);
          return false;
        }

        const exists = this.fileExists(file);
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
        decisions.push(`  drop deliverable "${deliverable.id ?? "<unnamed>"}" (all target files were filtered)`);
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
    // The same file may appear under multiple deliverables (e.g. one with
    // "/mnt/ai/Zendorium/core/recovery-engine.ts" and one with
    // "core/recovery-engine.ts"). Resolve each target file to an absolute
    // path against projectRoot, then skip files whose absolute path was
    // already seen by an earlier deliverable. First-occurrence wins.
    const seenPaths = new Set<string>();
    const deduped: Deliverable[] = [];
    for (const d of filtered) {
      const uniqueFiles: string[] = [];
      for (const f of d.targetFiles) {
        const abs = resolve(this.config.projectRoot, f);
        if (seenPaths.has(abs)) {
          decisions.push(`  dedupe ${f} (already covered by earlier deliverable as ${abs})`);
          didFilter = true;
          continue;
        }
        seenPaths.add(abs);
        uniqueFiles.push(f);
      }

      // ── PHASE 4 — Post-dedup empty guard ──
      // After dedup a deliverable may have lost all its target files.
      // Drop it with a warning rather than carry it forward as a no-op.
      if (uniqueFiles.length === 0) {
        const label = d.id ?? "<unnamed>";
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

    // SAFETY NET — the filter must NEVER zero out a non-empty input.
    // If it would, log a loud warning and return the original list unchanged.
    if (deduped.length === 0 && totalBefore > 0) {
      console.warn(
        `[coordinator] WARNING: filter would have produced 0 deliverables from ${totalBefore}; ` +
        `returning original deliverables unchanged to avoid empty task graph. ` +
        `Decisions: ${decisions.join("; ")}`
      );
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
      active.intent = reviseIntent(active.intent, {
        reason: "Filtered, deduplicated, and dropped empty deliverables",
        charter: { deliverables: deduped },
      });
    }

    return deduped;
  }

  private userExplicitlyAskedForTests(request: string): boolean {
    return /\b(add tests|test file|test files|tests)\b/i.test(request);
  }

  private isTestFile(filePath: string): boolean {
    return /\.(test|spec)\.(ts|tsx|js|jsx)$/.test(filePath);
  }

  private fileExists(filePath: string): boolean {
    return existsSync(resolve(this.config.projectRoot, filePath));
  }

  // ─── Execution Engine ──────────────────────────────────────────────

  private async executeGraph(active: ActiveRun): Promise<void> {
    const { graph, run, intent } = active;
    let rehearsalRound = 0;

    while (!isGraphComplete(graph) && !active.cancelled) {
      const dispatchable = getDispatchableNodes(graph);

      if (dispatchable.length === 0) {
        if (hasFailedNodes(graph)) {
          // Attempt recovery
          const recovered = await this.attemptRecovery(active);
          if (!recovered) break;
          continue;
        }
        // No dispatchable nodes and no failures — deadlock
        failRun(run, "Task graph deadlocked: no dispatchable nodes");
        break;
      }

      // Advance phase based on what we're dispatching
      const phases = dispatchable.map((n) => n.workerType);
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

      // Dispatch all ready nodes in parallel
      const results = await Promise.all(
        dispatchable.map((node) => this.dispatchNode(active, node))
      );

      // Process results
      for (const { node, result } of results) {
        if (result.success) {
          markCompleted(graph, node.id);
          this.collectChanges(active, result);
          this.emit({
            type: this.workerCompleteEvent(node.workerType as WorkerType),
            payload: { runId: run.id, taskId: node.id, confidence: result.confidence },
          });
        } else {
          markFailed(graph, node.id);
          this.emit({
            type: "task_failed",
            payload: { runId: run.id, taskId: node.id, error: result.issues[0]?.message },
          });
        }

        // Record assumptions from workers
        for (const assumption of result.assumptions) {
          recordAssumption(run, {
            statement: assumption,
            acceptedBy: "coordinator",
            taskId: node.runTaskId,
          });
        }
      }

      // Rehearsal loop: if Critic requested changes and we haven't exceeded rounds
      const criticResults = results.filter((r) => r.node.workerType === "critic");
      for (const { result } of criticResults) {
        if (
          result.output.kind === "critic" &&
          result.output.verdict === "request-changes" &&
          rehearsalRound < this.config.maxRehearsalRounds
        ) {
          rehearsalRound++;
          this.emit({
            type: "critic_review",
            payload: { runId: run.id, verdict: "request-changes", round: rehearsalRound },
          });
          // Re-queue builders with Critic feedback — handled by graph readiness
          recordDecision(run, {
            description: `Rehearsal round ${rehearsalRound}: Critic requested changes`,
            madeBy: "coordinator",
            taskId: null,
            alternatives: ["Accept as-is", "Abort run"],
            rationale: "Critic identified issues; re-running builders with feedback",
          });
        }
      }

      // Evaluate checkpoints
      await this.evaluateCheckpoints(active);
    }
  }

  private async dispatchNode(
    active: ActiveRun,
    node: TaskNode
  ): Promise<{ node: TaskNode; result: WorkerResult }> {
    const { run, intent, graph } = active;

    // Create RunTask
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

    // Assemble context
    const context = await this.contextAssembler.assemble([...node.targetFiles]);

    // Route through TrustRouter
    const routingDecision = this.trustRouter.route(runTask, intent, context);
    node.assignedTier = routingDecision.tier;

    this.emit({
      type: "worker_assigned",
      payload: { runId: run.id, taskId: node.id, tier: routingDecision.tier, workerType: node.workerType },
    });

    // Check escalation boundaries
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

    // Build assignment
    const upstreamResults = active.workerResults.filter((r) =>
      graph.edges.some((e) => e.to === node.id && e.from === graph.nodes.find((n) => n.runTaskId === r.taskId)?.id)
    );

    const assignment: WorkerAssignment = this.trustRouter.buildAssignment(
      routingDecision,
      runTask,
      intent,
      context,
      upstreamResults
    );

    // Find and execute worker
    const worker = this.workerRegistry.getWorker(node.workerType as WorkerType);
    if (!worker) {
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

    const result = await worker.execute(assignment);

    // Record to RunState
    const taskResult: TaskResult = {
      success: result.success,
      output: JSON.stringify(result.output),
      artifacts: result.touchedFiles.map((f) => f.path),
      issues: [...result.issues],
    };
    completeTask(run, runTask.id, taskResult, result.cost);

    // Record file touches
    for (const touch of result.touchedFiles) {
      recordFileTouch(run, {
        filePath: touch.path,
        operation: touch.operation,
        taskId: runTask.id,
      });
    }

    active.workerResults.push(result);
    return { node, result };
  }

  // ─── Pre-Build Coherence ───────────────────────────────────────────

  private async runPreBuildCoherence(active: ActiveRun): Promise<void> {
    const { run, intent, graph } = active;

    this.emit({ type: "coherence_check_started", payload: { runId: run.id, phase: "pre-build" } });

    const checks = [];

    // Check: all deliverables have corresponding graph nodes
    for (const deliverable of intent.charter.deliverables) {
      const hasNode = graph.nodes.some((n) =>
        n.targetFiles.some((f) => deliverable.targetFiles.includes(f))
      );
      checks.push({
        name: `Deliverable coverage: ${deliverable.description}`,
        passed: hasNode,
        message: hasNode ? "Covered by task graph" : "No task node covers this deliverable",
      });
    }

    // Check: graph is acyclic (already enforced, but verify)
    try {
      topologicalSort(graph);
      checks.push({ name: "Graph acyclicity", passed: true, message: "DAG verified" });
    } catch {
      checks.push({ name: "Graph acyclicity", passed: false, message: "Cycle detected in task graph" });
    }

    // Check: all worker types are available
    const requiredTypes = [...new Set(graph.nodes.map((n) => n.workerType))];
    for (const type of requiredTypes) {
      const available = this.workerRegistry.hasWorker(type as WorkerType);
      checks.push({
        name: `Worker availability: ${type}`,
        passed: available,
        message: available ? "Worker registered" : `No worker for "${type}"`,
      });
    }

    const allPassed = checks.every((c) => c.passed);
    recordCoherenceCheck(run, { phase: "pre-build", passed: allPassed, checks });

    if (allPassed) {
      this.emit({ type: "coherence_check_passed", payload: { runId: run.id, phase: "pre-build" } });
    } else {
      this.emit({ type: "coherence_check_failed", payload: { runId: run.id, phase: "pre-build", checks } });
      throw new CoordinatorError(
        `Pre-build coherence failed: ${checks.filter((c) => !c.passed).map((c) => c.message).join("; ")}`
      );
    }
  }

  // ─── Checkpoint Evaluation ─────────────────────────────────────────

  private async evaluateCheckpoints(active: ActiveRun): Promise<void> {
    const { graph, run } = active;

    for (const checkpoint of graph.checkpoints) {
      if (checkpoint.status !== "pending") continue;

      // Check if all upstream nodes are done
      const allUpstreamDone = checkpoint.upstreamNodeIds.every((id) => {
        const node = graph.nodes.find((n) => n.id === id);
        return node && (node.status === "completed" || node.status === "skipped");
      });

      if (!allUpstreamDone) continue;

      checkpoint.status = "evaluating";
      let passed = true;

      for (const check of checkpoint.checks) {
        if (check.type === "coherence") {
          // Run a mini integration check on work so far
          const partialReport = this.judge.judge(
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
        // Cost gates, approvals, etc. can be added here
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
    if (failedNodes.length === 0) return false;

    const recoveryAttempts = active.run.decisions.filter(
      (d) => d.description.startsWith("Recovery attempt")
    ).length;

    if (recoveryAttempts >= this.config.maxRecoveryAttempts) {
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

    // Simple recovery: re-queue failed nodes as ready with escalated tier
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

  // ─── Git Operations ────────────────────────────────────────────────

  private async gitCommit(active: ActiveRun): Promise<string | null> {
    try {
      // Pre-commit safety: verify changed files contain source code, not raw diff text.
      // If a file starts with "--- a/" it was not properly patched — restore from snapshot.
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
            const absPath = resolve(this.config.projectRoot, change.path);
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

      const message = `zendorium: ${active.intent.charter.objective}\n\nRun: ${active.run.id}\nIntent: ${active.intent.id} v${active.intent.version}`;

      await exec("git", ["add", "-A"], { cwd: this.config.projectRoot });
      await exec("git", ["commit", "-m", message], { cwd: this.config.projectRoot });

      const { stdout } = await exec("git", ["rev-parse", "HEAD"], { cwd: this.config.projectRoot });
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
      // Integrator replaces the full changeset
      active.changes = [...result.output.finalChanges];
    }
  }

  // ─── Receipt Building ─────────────────────────────────────────────

  private buildReceipt(
    active: ActiveRun,
    verificationReceipt: VerificationReceipt | null,
    judgmentReport: JudgmentReport | null,
    commitSha: string | null,
    durationMs: number
  ): RunReceipt {
    return {
      id: randomUUID(),
      runId: active.run.id,
      intentId: active.intent.id,
      timestamp: new Date().toISOString(),
      verdict: this.determineVerdict(active, verificationReceipt, judgmentReport),
      summary: getRunSummary(active.run),
      graphSummary: getGraphSummary(active.graph),
      verificationReceipt,
      judgmentReport,
      totalCost: active.run.totalCost,
      commitSha,
      durationMs,
    };
  }

  private determineVerdict(
    active: ActiveRun,
    verificationReceipt: VerificationReceipt | null,
    judgmentReport: JudgmentReport | null
  ): RunReceipt["verdict"] {
    if (active.cancelled) return "aborted";
    if (active.run.phase === "failed") return "failed";
    if (verificationReceipt?.verdict === "fail") return "failed";
    if (judgmentReport && !judgmentReport.passed) return "failed";
    if (verificationReceipt?.verdict === "pass-with-warnings") return "partial";
    if (hasFailedNodes(active.graph)) return "partial";
    return "success";
  }

  // ─── Event Helpers ─────────────────────────────────────────────────

  private emit(event: ZendoriumEvent): void {
    this.eventBus?.emit(event);
  }

  private workerCompleteEvent(type: WorkerType): ZendoriumEvent["type"] {
    const map: Record<WorkerType, ZendoriumEvent["type"]> = {
      scout: "scout_complete",
      builder: "builder_complete",
      critic: "critic_review",
      verifier: "verifier_check",
      integrator: "task_complete",
    };
    return map[type];
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
}

// ─── Errors ──────────────────────────────────────────────────────────

export class CoordinatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoordinatorError";
  }
}
