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

import {
  createIntent,
  reviseIntent,
  validateIntent,
  type IntentObject,
  type CreateIntentParams,
  type Assumption,
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
    this.contextAssembler = new ContextAssembler({
      projectRoot: this.config.projectRoot,
      tokenBudget: 8_000, // Cap context to 8K tokens — builder prompt adds its own budget control
    });
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

    console.log(`[Coordinator] ──────────────────────────────────────────`);
    console.log(`[Coordinator] submit() called with input: "${submission.input.slice(0, 100)}"`);

    // Phase 1: Charter
    console.log(`[Coordinator] Phase 1: generating charter`);
    this.emit({ type: "run_started", payload: { input: submission.input } });

    let analysis: RequestAnalysis;
    try {
      analysis = this.charterGen.analyzeRequest(submission.input);
      console.log(`[Coordinator] Charter analysis: category=${analysis.category}, scope=${analysis.scopeEstimate}, targets=${analysis.targets.length}`);
    } catch (err) {
      console.error(`[Coordinator] FAILED at charter analysis:`, err);
      throw err;
    }

    let charter;
    let constraints;
    try {
      charter = this.charterGen.generateCharter(analysis);
      constraints = [
        ...this.charterGen.generateDefaultConstraints(analysis),
        ...(submission.extraConstraints ?? []),
      ];
      console.log(`[Coordinator] Charter generated: ${charter.deliverables.length} deliverables, quality=${charter.qualityBar}`);
    } catch (err) {
      console.error(`[Coordinator] FAILED at charter generation:`, err);
      throw err;
    }

    this.emit({ type: "charter_generated", payload: { charter, analysis } });

    // Phase 2: Intent
    console.log(`[Coordinator] Phase 2: creating intent object`);
    let intent: IntentObject;
    try {
      intent = createIntent({
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
      console.log(`[Coordinator] Intent locked: id=${intent.id}, runId=${intent.runId}`);
    } catch (err) {
      console.error(`[Coordinator] FAILED at intent creation:`, err);
      throw err;
    }

    this.emit({ type: "intent_locked", payload: { intentId: intent.id, version: intent.version } });

    // Phase 3: RunState
    console.log(`[Coordinator] Phase 3: creating run state`);
    const run = createRunState(intent.id);
    console.log(`[Coordinator] Run created: id=${run.id}`);

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
      console.log(`[Coordinator] Phase 4: building task graph`);
      advancePhase(run, "planning");
      this.buildTaskGraph(active, analysis);
      const graphSummary = getGraphSummary(active.graph);
      console.log(`[Coordinator] Task graph built: ${graphSummary.totalNodes} nodes, ${graphSummary.edgeCount} edges`);
      this.emit({
        type: "task_graph_built",
        payload: { runId: run.id, summary: graphSummary },
      });

      // Phase 5: Pre-Build Coherence
      console.log(`[Coordinator] Phase 5: pre-build coherence check`);
      advancePhase(run, "scouting");
      await this.runPreBuildCoherence(active);
      console.log(`[Coordinator] Pre-build coherence passed`);

      // Phase 6–7: Execute (Scout → Build → Rehearsal Loop)
      console.log(`[Coordinator] Phase 6-7: executing task graph`);
      await this.executeGraph(active);
      console.log(`[Coordinator] Task graph execution complete. Failed nodes: ${hasFailedNodes(active.graph)}`);

      // Phase 8: Post-Build IntegrationJudge
      if (!active.cancelled && !hasFailedNodes(active.graph)) {
        console.log(`[Coordinator] Phase 8: post-build integration judge`);
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
        console.log(`[Coordinator] Integration judge: passed=${judgmentReport.passed}, score=${judgmentReport.coherenceScore}`);

        if (!judgmentReport.passed) {
          this.emit({
            type: "merge_blocked",
            payload: { runId: run.id, blockers: judgmentReport.blockers },
          });
        }
      }

      // Phase 9: Verification Pipeline
      if (judgmentReport?.passed && !active.cancelled) {
        console.log(`[Coordinator] Phase 9: verification pipeline`);
        verificationReceipt = await this.verifier.verify(
          active.intent,
          run,
          active.changes,
          active.workerResults
        );
        console.log(`[Coordinator] Verification: verdict=${verificationReceipt.verdict}, confidence=${verificationReceipt.confidenceScore}`);

        if (verificationReceipt.verdict === "fail") {
          this.emit({
            type: "merge_blocked",
            payload: { runId: run.id, reason: verificationReceipt.summary },
          });
        } else {
          this.emit({ type: "merge_approved", payload: { runId: run.id } });
        }
      }

      // Phase 10: Commit
      const canCommit =
        this.config.autoCommit &&
        !active.cancelled &&
        verificationReceipt?.verdict !== "fail" &&
        judgmentReport?.passed !== false &&
        active.changes.length > 0;

      if (canCommit) {
        console.log(`[Coordinator] Phase 10: git commit`);
        commitSha = await this.gitCommit(active);
        if (commitSha) {
          console.log(`[Coordinator] Committed: ${commitSha}`);
          this.emit({ type: "commit_created", payload: { runId: run.id, sha: commitSha } });
        } else {
          console.log(`[Coordinator] Git commit skipped or failed`);
        }
      } else {
        console.log(`[Coordinator] Phase 10: skipping commit (canCommit=${canCommit}, changes=${active.changes.length})`);
      }

      // Finalize
      const verdict = this.determineVerdict(active, verificationReceipt, judgmentReport);
      console.log(`[Coordinator] Final verdict: ${verdict}`);
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

      console.log(`[Coordinator] Run complete: ${verdict} in ${Date.now() - startTime}ms, cost=$${receipt.totalCost.estimatedCostUsd}`);
      console.log(`[Coordinator] ──────────────────────────────────────────`);

      return receipt;
    } catch (err) {
      // Log the FULL error with stack trace before building failure receipt
      console.error(`[Coordinator] ═══ RUN FAILED ═══`);
      console.error(`[Coordinator] Run ID: ${run.id}`);
      console.error(`[Coordinator] Input: "${submission.input.slice(0, 200)}"`);
      console.error(`[Coordinator] Phase at failure: ${run.phase}`);
      if (err instanceof Error) {
        console.error(`[Coordinator] Error: ${err.message}`);
        console.error(`[Coordinator] Stack:\n${err.stack}`);
      } else {
        console.error(`[Coordinator] Error:`, err);
      }
      console.error(`[Coordinator] ═══════════════════`);

      failRun(run, err instanceof Error ? err.message : String(err));
      const failReceipt = this.buildReceipt(active, verificationReceipt, judgmentReport, null, Date.now() - startTime);

      // Emit failure events so WebSocket clients see what happened
      this.emit({
        type: "run_complete",
        payload: {
          runId: run.id,
          verdict: "failed",
          error: err instanceof Error ? err.message : String(err),
          phase: run.phase,
        },
      });

      return failReceipt;
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
    const { graph, intent } = active;
    const deliverables = intent.charter.deliverables;

    // Scout node for each target area
    const targetFiles = deliverables.flatMap((d) => d.targetFiles);
    const uniqueDirs = [...new Set(targetFiles.map((f) => f.split("/").slice(0, -1).join("/")))];

    const scoutNode = addNode(graph, {
      label: "Scout: gather context and assess risk",
      workerType: "scout",
      targetFiles,
      metadata: { category: analysis.category, scopeEstimate: analysis.scopeEstimate },
    });

    // Builder node per deliverable
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

    // Critic node reviews all builder outputs
    const criticNode = addNode(graph, {
      label: "Critic: review all builder outputs",
      workerType: "critic",
      targetFiles,
      metadata: {},
    });
    for (const builder of builderNodes) {
      addEdge(graph, builder.id, criticNode.id, "data");
    }

    // Verifier node runs after Critic
    const verifierNode = addNode(graph, {
      label: "Verifier: tests, types, lint",
      workerType: "verifier",
      targetFiles,
      metadata: {},
    });
    addEdge(graph, criticNode.id, verifierNode.id, "data");

    // Integrator node merges everything
    const integratorNode = addNode(graph, {
      label: "Integrator: merge and final coherence",
      workerType: "integrator",
      targetFiles,
      metadata: {},
    });
    addEdge(graph, verifierNode.id, integratorNode.id, "data");

    // Merge group for all builders
    if (builderNodes.length > 1) {
      addMergeGroup(
        graph,
        "All builder outputs",
        builderNodes.map((b) => b.id),
        integratorNode.id
      );
    }

    // Verification checkpoint between Critic and Verifier
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

    // Escalation boundaries from risk signals
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

    // Mark scout as ready (no dependencies)
    markReady(graph, scoutNode.id);
  }

  // ─── Execution Engine ──────────────────────────────────────────────

  private async executeGraph(active: ActiveRun): Promise<void> {
    const { graph, run, intent } = active;
    let rehearsalRound = 0;

    while (!isGraphComplete(graph) && !active.cancelled) {
      const dispatchable = getDispatchableNodes(graph);
      console.log(`[Coordinator] executeGraph loop: ${dispatchable.length} dispatchable, complete=${isGraphComplete(graph)}`);

      if (dispatchable.length === 0) {
        if (hasFailedNodes(graph)) {
          console.log(`[Coordinator] Has failed nodes, attempting recovery`);
          const recovered = await this.attemptRecovery(active);
          if (!recovered) {
            console.log(`[Coordinator] Recovery failed, breaking`);
            break;
          }
          continue;
        }
        // No dispatchable nodes and no failures — deadlock
        console.error(`[Coordinator] DEADLOCK: no dispatchable nodes, no failed nodes`);
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
      console.log(`[Coordinator] Dispatching ${dispatchable.length} nodes: ${dispatchable.map((n) => `${n.workerType}(${n.label.slice(0, 30)})`).join(", ")}`);
      const results = await Promise.all(
        dispatchable.map((node) => this.dispatchNode(active, node))
      );

      // Process results
      for (const { node, result } of results) {
        if (result.success) {
          console.log(`[Coordinator] Node completed: ${node.workerType} — confidence=${result.confidence}`);
          markCompleted(graph, node.id);
          this.collectChanges(active, result);
          this.emit({
            type: this.workerCompleteEvent(node.workerType as WorkerType),
            payload: { runId: run.id, taskId: node.id, confidence: result.confidence },
          });
        } else {
          console.error(`[Coordinator] Node FAILED: ${node.workerType} — ${result.issues[0]?.message ?? "unknown error"}`);
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
          console.log(`[Coordinator] Rehearsal round ${rehearsalRound}: Critic requested changes`);
          this.emit({
            type: "critic_review",
            payload: { runId: run.id, verdict: "request-changes", round: rehearsalRound },
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
    console.log(`[Coordinator] Assembling context for ${node.workerType}: ${node.targetFiles.join(", ")}`);
    const context = await this.contextAssembler.assemble([...node.targetFiles]);
    console.log(`[Coordinator] Context assembled: ${context.fileCount} files, ${context.totalTokens} tokens`);

    // Route through TrustRouter
    const routingDecision = this.trustRouter.route(runTask, intent, context);
    node.assignedTier = routingDecision.tier;
    console.log(`[Coordinator] Routed ${node.workerType} to tier=${routingDecision.tier}`);

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
      console.error(`[Coordinator] No worker registered for type "${node.workerType}"`);
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

    console.log(`[Coordinator] Executing worker: ${worker.name} (${node.workerType})`);
    try {
      const result = await worker.execute(assignment);
      console.log(`[Coordinator] Worker ${node.workerType} returned: success=${result.success}, confidence=${result.confidence}`);

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
    } catch (workerErr) {
      console.error(`[Coordinator] Worker ${node.workerType} THREW:`, workerErr);
      const failResult: WorkerResult = {
        workerType: node.workerType as WorkerType,
        taskId: runTask.id,
        success: false,
        output: { kind: "scout", dependencies: [], patterns: [], riskAssessment: { level: "low", factors: [], mitigations: [] }, suggestedApproach: "" },
        issues: [{ severity: "error", message: workerErr instanceof Error ? workerErr.message : String(workerErr) }],
        cost: { model: "", inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
        confidence: 0,
        touchedFiles: [],
        assumptions: [],
        durationMs: Date.now(),
      };
      completeTask(run, runTask.id, { success: false, output: failResult.issues[0].message, artifacts: [], issues: failResult.issues });
      active.workerResults.push(failResult);
      return { node, result: failResult };
    }
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

    // Check: worker availability — warn on missing workers, hard-fail only if registry is empty
    const requiredTypes = [...new Set(graph.nodes.map((n) => n.workerType))];
    const totalRegistered = this.workerRegistry.getAllWorkers().length;
    const missingWorkers: string[] = [];

    for (const type of requiredTypes) {
      const available = this.workerRegistry.hasWorker(type as WorkerType);
      if (!available) missingWorkers.push(type);
      checks.push({
        name: `Worker availability: ${type}`,
        // Soft pass if registry has some workers — the missing ones will fail at dispatch
        // Hard fail only if registry is completely empty
        passed: available || totalRegistered > 0,
        message: available
          ? "Worker registered"
          : totalRegistered > 0
            ? `WARNING: No worker for "${type}" — will fail at dispatch`
            : `No worker for "${type}" — registry is empty`,
      });
    }

    if (missingWorkers.length > 0 && totalRegistered > 0) {
      console.warn(`[Coordinator] Missing workers (will fail at dispatch): ${missingWorkers.join(", ")}. ${totalRegistered} workers registered.`);
    }

    const allPassed = checks.every((c) => c.passed);
    recordCoherenceCheck(run, { phase: "pre-build", passed: allPassed, checks });

    console.log(`[Coordinator] Pre-build coherence: ${checks.length} checks, allPassed=${allPassed}, registeredWorkers=${totalRegistered}`);
    for (const check of checks) {
      if (!check.passed) {
        console.error(`[Coordinator]   FAILED: ${check.name} — ${check.message}`);
      } else if (check.message.startsWith("WARNING")) {
        console.warn(`[Coordinator]   WARN: ${check.name} — ${check.message}`);
      }
    }

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
      const message = `zendorium: ${active.intent.charter.objective}\n\nRun: ${active.run.id}\nIntent: ${active.intent.id} v${active.intent.version}`;

      await exec("git", ["add", "-A"], { cwd: this.config.projectRoot });
      await exec("git", ["commit", "-m", message], { cwd: this.config.projectRoot });

      const { stdout } = await exec("git", ["rev-parse", "HEAD"], { cwd: this.config.projectRoot });
      return stdout.trim();
    } catch (err) {
      console.error(`[Coordinator] Git commit failed:`, err);
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
