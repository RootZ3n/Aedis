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
    // must flow through the WorkerAssignment instead — see the inline
    // resolution in execute() which reads assignment.runState first and
    // falls back to this constructor field. The constructor field is
    // preserved for tests and stand-alone harnesses that bypass the
    // registry and pass a RunState explicitly.
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
      // Resolve the active RunState. Coordinator.dispatchNode populates
      // assignment.runState (now a typed optional field on WorkerAssignment)
      // for every production dispatch. Falls back to this.runState which
      // is the constructor-time field used by tests and stand-alone
      // harnesses that bypass the registry.
      const runState = assignment.runState ?? this.runState;
      if (!runState) {
        throw new Error("Verifier requires RunState to record receipts and checks");
      }

      // Resolve the file changes for this verification run. The Verifier
      // needs the full FileChange[] (path + operation + diff + content).
      // Coordinator.dispatchNode populates assignment.changes (a snapshot
      // of active.changes) for every production dispatch — that's the
      // canonical source because the Verifier's direct upstream in the
      // task graph is Critic, not Builder, so the upstreamResults walk
      // for `output.kind === "builder"` returns empty in production. The
      // upstreamResults walk is preserved as a fallback for tests and
      // alternate graph topologies that wire Builder directly to Verifier.
      const attachedChanges = assignment.changes;
      const changes: FileChange[] = (attachedChanges && attachedChanges.length > 0)
        ? [...attachedChanges]
        : assignment.upstreamResults.flatMap((result) =>
            result.output.kind === "builder" ? [...result.output.changes] : [],
          );
      if (changes.length === 0) {
        throw new Error(
          "Verifier requires builder changes but found none — neither " +
          "Coordinator-attached assignment.changes (active.changes) nor any " +
          "upstreamResults of kind 'builder'. Check that " +
          "Coordinator.dispatchNode populates assignment.changes, " +
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

  private toIssues(receipt: VerificationReceipt): Issue[] {
    return receipt.allIssues.map((issue) => ({
      severity: issue.severity === "blocker" ? "critical" : issue.severity === "error" ? "error" : issue.severity === "warning" ? "warning" : "info",
      message: issue.message,
      file: issue.file,
      line: issue.line,
    }));
  }
}
