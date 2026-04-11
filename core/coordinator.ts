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
  readonly judgmentReport: JudgmentReport | null;
  readonly totalCost: CostEntry;
  readonly commitSha: string | null;
  readonly durationMs: number;
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
    // ContextAssembler and IntegrationJudge are constructed per-submit so
    // they can pick up per-task projectRoot overrides. The constructor
    // intentionally does not create boot-time defaults — there's no use
    // case for a "default" assembler or judge that uses the wrong root.
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
    this.emit({ type: "run_started", payload: { input: submission.input } });

    const analysis = this.charterGen.analyzeRequest(submission.input);
    const charter = this.charterGen.generateCharter(analysis);
    const constraints = [
      ...this.charterGen.generateDefaultConstraints(analysis),
      ...(submission.extraConstraints ?? []),
    ];
    console.log(`[coordinator] PHASE 1 done — category=${analysis.category} scope=${analysis.scopeEstimate} deliverables=${charter.deliverables.length} targets=[${analysis.targets.slice(0, 5).join(", ")}${analysis.targets.length > 5 ? "…" : ""}]`);

    this.emit({ type: "charter_generated", payload: { charter, analysis } });

    // Phase 2: Intent
    console.log(`[coordinator] PHASE 2: Intent — creating and validating`);
    const intent = createIntent({
      runId: randomUUID(),
      userRequest: submission.input,
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

    // Phase 3: RunState
    console.log(`[coordinator] PHASE 3: RunState — creating`);
    const run = createRunState(intent.id);

    const active: ActiveRun = {
      intent,
      run,
      graph: createTaskGraph(intent.id),
      changes: [],
      workerResults: [],
      cancelled: false,
      projectRoot: effectiveProjectRoot,
      contextAssembler,
      judge,
    };
    this.activeRuns.set(run.id, active);
    console.log(`[coordinator] PHASE 3 done — run ${run.id} created, registered as active (projectRoot=${active.projectRoot})`);

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
      if (judgmentReport?.passed && !active.cancelled) {
        console.log(`[coordinator] PHASE 9: Verification — entering`);
        verificationReceipt = await this.verifier.verify(
          active.intent,
          run,
          active.changes,
          active.workerResults
        );
        console.log(`[coordinator] PHASE 9 done — verdict=${verificationReceipt.verdict}`);

        if (verificationReceipt.verdict === "fail") {
          this.emit({
            type: "merge_blocked",
            payload: { runId: run.id, reason: verificationReceipt.summary },
          });
        } else {
          this.emit({ type: "merge_approved", payload: { runId: run.id } });
        }
      } else {
        console.log(`[coordinator] PHASE 9 SKIPPED — judgmentReport=${judgmentReport ? `passed=${judgmentReport.passed}` : "null"} cancelled=${active.cancelled}`);
      }

      // Phase 10: Commit
      const changeCount = Math.max(active.changes.length, active.run.filesTouched.length);
      const canCommit =
        this.config.autoCommit &&
        !active.cancelled &&
        changeCount > 0;

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

      // Finalize
      const verdict = this.determineVerdict(active, verificationReceipt, judgmentReport);
      console.log(`[coordinator] FINALIZE — verdict=${verdict} (cancelled=${active.cancelled} phase=${run.phase} hasFailedNodes=${hasFailedNodes(active.graph)} workerResults=${active.workerResults.length})`);

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

      console.log(`[coordinator] ═══ submit() exit — verdict=${verdict} duration=${Date.now() - startTime}ms`);
      this.emit({ type: "run_complete", payload: { runId: run.id, verdict } });
      this.emit({ type: "receipt_generated", payload: { receiptId: receipt.id } });

      return receipt;
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
      const receipt = this.buildReceipt(active, verificationReceipt, judgmentReport, null, Date.now() - startTime);
      console.log(`[coordinator] ═══ submit() exit (failed) — verdict=${receipt.verdict} duration=${Date.now() - startTime}ms`);
      return receipt;
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
      const builder = addNode(graph, {
        label: `Build: ${deliverable.description}`,
        workerType: "builder",
        targetFiles: deliverable.targetFiles,
        metadata: { deliverableType: deliverable.type },
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

    if (analysis.riskSignals.length > 0) {
      console.log(`[coordinator] buildTaskGraph: adding escalation boundaries for ${builderNodes.length} builder(s) due to risk signals: ${analysis.riskSignals.join(", ")}`);
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
            type: this.workerCompleteEvent(node.workerType as WorkerType),
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

    const baseAssignment = this.trustRouter.buildAssignment(
      routingDecision,
      runTask,
      intent,
      context,
      upstreamResults
    );

    // Decorate the base assignment with per-run state. These four fields
    // (runState, changes, workerResults, projectRoot) are declared as
    // optional on WorkerAssignment in workers/base.ts and are populated
    // here for every dispatch so workers can read them via direct field
    // access — no cast pattern required.
    //
    //   runState        — passed to VerifierWorker and IntegratorWorker
    //   changes         — running tally of Builder outputs
    //   workerResults   — every WorkerResult so far in dispatch order
    //   projectRoot     — per-task effective project root for Builder/
    //                     Scout/Critic/Integrator file ops and config
    //                     lookup. Without this, workers would always use
    //                     their constructor-time projectRoot (the API
    //                     server's cwd) regardless of which repo the
    //                     task targets.
    //
    // The arrays are shallow-copied at attach time so workers cannot
    // mutate the Coordinator's running tallies. The fields are declared
    // `readonly` on the interface, so we build the assignment via spread
    // (rather than mutating after construction) to respect the readonly
    // contract for the existing fields too.
    const assignment: WorkerAssignment = {
      ...baseAssignment,
      runState: run,
      changes: [...active.changes],
      workerResults: [...active.workerResults],
      projectRoot: active.projectRoot,
    };

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

  // ─── Receipt Building ─────────────────────────────────────────────

  private buildReceipt(
    active: ActiveRun,
    verificationReceipt: VerificationReceipt | null,
    judgmentReport: JudgmentReport | null,
    commitSha: string | null,
    durationMs: number
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
      totalCost: aggregatedCost,
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
}

// ─── Errors ──────────────────────────────────────────────────────────

export class CoordinatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoordinatorError";
  }
}
