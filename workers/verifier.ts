import type { RunState, CostEntry, Issue } from "../core/runstate.js";
import { recordCoherenceCheck, recordDecision } from "../core/runstate.js";
import {
  VerificationPipeline,
  type ToolHook,
  type VerificationReceipt,
} from "../core/verification-pipeline.js";
import type { EventBus } from "../server/websocket.js";
import {
  AbstractWorker,
  type FileChange,
  type TestResult,
  type VerifierOutput,
  type WorkerAssignment,
  type WorkerResult,
} from "./base.js";

export interface VerifierResult extends WorkerResult {
  readonly output: VerifierOutput & {
    readonly confidenceScore: number;
    readonly receipt: VerificationReceipt;
    readonly checks: readonly {
      name: string;
      passed: boolean;
      summary: string;
    }[];
  };
}

export interface VerifierWorkerConfig {
  readonly eventBus?: EventBus;
  readonly runState?: RunState;
  readonly lintHook?: ToolHook;
  readonly typecheckHook?: ToolHook;
  readonly testHook?: ToolHook;
  readonly hooks?: readonly ToolHook[];
}

export class VerifierWorker extends AbstractWorker {
  readonly type = "verifier" as const;
  readonly name = "Verifier Worker";

  private readonly eventBus: EventBus | null;
  private readonly runState: RunState | null;
  private readonly pipeline: VerificationPipeline;

  constructor(config: VerifierWorkerConfig = {}) {
    super();
    this.eventBus = config.eventBus ?? null;
    // NOTE: this.runState is almost always null in production. Workers are
    // constructed once at boot via WorkerRegistry, BEFORE any run exists,
    // so config.runState is null at construction time. The per-run RunState
    // must flow through the WorkerAssignment instead — see resolveRunState
    // below. The constructor field is preserved for the rare path where a
    // VerifierWorker IS constructed per-run (tests, stand-alone harnesses
    // that bypass the registry).
    this.runState = config.runState ?? null;
    const hooks = [config.lintHook, config.typecheckHook, config.testHook, ...(config.hooks ?? [])].filter((hook): hook is ToolHook => Boolean(hook));
    this.pipeline = new VerificationPipeline({ hooks });
  }

  async estimateCost(_assignment: WorkerAssignment): Promise<CostEntry> {
    return { model: "verification", inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 };
  }

  async execute(assignment: WorkerAssignment): Promise<VerifierResult> {
    const startedAt = Date.now();
    try {
      // Resolve the active RunState from the assignment first, falling back
      // to the constructor field. Coordinator.dispatchNode attaches the
      // active run's RunState onto the assignment via structural typing
      // right after trustRouter.buildAssignment, so assignment-attached is
      // the canonical source for production runs.
      const runState = this.resolveRunState(assignment);
      if (!runState) {
        throw new Error("Verifier requires RunState to record receipts and checks");
      }

      // Resolve the file changes for this verification run. The Verifier
      // needs the full FileChange[] (path + operation + diff + content) to
      // verify against. The Verifier's direct upstream in the task graph
      // is Critic, NOT Builder, so the original upstreamResults walk
      // (which filters for output.kind === "builder") finds nothing in
      // production. The Coordinator attaches active.changes — its running
      // tally of Builder outputs — to the assignment via structural typing,
      // and that is the canonical source. See resolveChanges for details.
      const changes = this.resolveChanges(assignment);
      if (changes.length === 0) {
        throw new Error(
          "Verifier requires builder changes but found none — neither " +
          "Coordinator-attached assignment.changes (active.changes) nor any " +
          "upstreamResults of kind 'builder'. Check that " +
          "Coordinator.dispatchNode attaches active.changes to the assignment, " +
          "or that the task graph wires Builder output directly to Verifier."
        );
      }

      const receipt = await this.pipeline.verify(
        assignment.intent,
        runState,
        changes,
        assignment.upstreamResults,
      );

      const checks = receipt.stages.map((stage) => ({
        name: stage.name,
        passed: stage.passed,
        summary: stage.details,
      }));
      const testResults = receipt.stages
        .filter((stage) => stage.stage === "custom-hook" || stage.stage === "lint" || stage.stage === "typecheck")
        .map((stage) => ({
          name: stage.name,
          passed: stage.passed,
          durationMs: stage.durationMs,
          error: stage.passed ? undefined : stage.details,
        })) satisfies TestResult[];

      const output: VerifierResult["output"] = {
        kind: "verifier",
        testResults,
        typeCheckPassed: receipt.stages.every((stage) => stage.stage !== "typecheck" || stage.passed),
        lintPassed: receipt.stages.every((stage) => stage.stage !== "lint" || stage.passed),
        buildPassed: receipt.verdict !== "fail",
        passed: receipt.verdict !== "fail",
        confidenceScore: receipt.confidenceScore,
        receipt,
        checks,
      };

      recordCoherenceCheck(runState, {
        phase: "post-build",
        passed: receipt.verdict !== "fail",
        checks: checks.map((check) => ({ name: check.name, passed: check.passed, message: check.summary })),
      });
      recordDecision(runState, {
        description: `Verifier completed ${receipt.verdict}`,
        madeBy: this.name,
        taskId: assignment.task.id,
        alternatives: [],
        rationale: receipt.summary,
      });

      this.eventBus?.emit({
        type: "verifier_check",
        payload: {
          taskId: assignment.task.id,
          workerType: this.type,
          verdict: receipt.verdict,
          confidence: receipt.confidenceScore,
        },
      });

      return this.success(assignment, output, {
        cost: { model: "verification", inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
        confidence: receipt.confidenceScore,
        touchedFiles: changes.map((change) => ({ path: change.path, operation: "read" as const })),
        issues: this.toIssues(receipt),
        durationMs: Date.now() - startedAt,
      }) as VerifierResult;
    } catch (error) {
      this.eventBus?.emit({
        type: "task_failed",
        payload: {
          taskId: assignment.task.id,
          workerType: this.type,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      return this.failure(
        assignment,
        error instanceof Error ? error.message : String(error),
        { model: "verification", inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
        Date.now() - startedAt,
      ) as VerifierResult;
    }
  }

  protected emptyOutput(): VerifierOutput {
    return {
      kind: "verifier",
      testResults: [],
      typeCheckPassed: false,
      lintPassed: false,
      buildPassed: false,
      passed: false,
    };
  }

  /**
   * Resolve the RunState for this execution.
   *
   * Lookup order:
   *   1. assignment.runState — attached by Coordinator.dispatchNode right
   *      after building the assignment via trustRouter.buildAssignment.
   *      This is the per-run canonical source for production runs.
   *   2. this.runState — the constructor-time fallback. Almost always null
   *      in production because workers are constructed at boot before any
   *      run exists. Used by tests and stand-alone harnesses that pass a
   *      RunState explicitly to the constructor.
   *
   * Uses structural typing (the cast through `unknown`) so we don't need
   * to add a `runState` field to WorkerAssignment in workers/base.ts.
   * The Coordinator attaches the field via the same cast pattern, and
   * TypeScript's structural typing covers the read on this side.
   */
  private resolveRunState(assignment: WorkerAssignment): RunState | null {
    const attached = (assignment as unknown as { runState?: RunState }).runState;
    if (attached) return attached;
    return this.runState;
  }

  /**
   * Resolve the file changes that this Verifier should verify against.
   *
   * Lookup order:
   *   1. assignment.changes — attached by Coordinator.dispatchNode right
   *      after building the assignment. This is the canonical source for
   *      production runs because the Verifier's direct upstream in the
   *      task graph is Critic (not Builder), so the upstreamResults walk
   *      below cannot find Builder's changes — they live on `active.changes`
   *      on the Coordinator's ActiveRun, populated by collectChanges()
   *      after each Builder.execute() succeeds.
   *   2. assignment.upstreamResults walk — the original behavior. Works
   *      only when the task graph wires Builder DIRECTLY to Verifier
   *      (not the case in the standard pipeline scout→builder→critic→
   *      verifier→integrator, but preserved for tests, alternate graph
   *      topologies, or future graph rewrites that re-wire Builder→Verifier).
   *
   * Returns an empty array if neither source has any changes. The caller
   * is responsible for the throw — that way the error message can name
   * BOTH failure paths so the operator knows where to look.
   *
   * Uses structural typing (the cast through `unknown`) so we don't need
   * to add a `changes` field to WorkerAssignment in workers/base.ts.
   * The Coordinator attaches the field via the same cast pattern.
   */
  private resolveChanges(assignment: WorkerAssignment): FileChange[] {
    const attached = (assignment as unknown as { changes?: FileChange[] }).changes;
    if (attached && attached.length > 0) {
      return [...attached];
    }
    return assignment.upstreamResults.flatMap((result) =>
      result.output.kind === "builder" ? [...result.output.changes] : [],
    );
  }

  private toIssues(receipt: VerificationReceipt): Issue[] {
    return receipt.allIssues.map((issue) => ({
      severity: issue.severity === "blocker" ? "critical" : issue.severity === "error" ? "error" : issue.severity === "warning" ? "warning" : "info",
      message: issue.message,
      file: issue.file,
      line: issue.line,
    }));
  }
}
