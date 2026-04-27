import type { GatedContext } from "./context-gate.js";
import type { IntentObject } from "./intent.js";
import type { RunState, RunTask } from "./runstate.js";
import type { AssembledContext } from "./context-assembler.js";
import type { RoutingDecision } from "../router/trust-router.js";
import type { WorkerAssignment, WorkerResult, WorkerType } from "../workers/base.js";
import type { AedisEvent } from "../server/websocket.js";
import type { ImplementationBrief } from "./implementation-brief.js";
import { validateFileChangeArray } from "../workers/base.js";

export function buildDispatchAssignment(input: {
  decision: RoutingDecision;
  task: RunTask;
  intent: IntentObject;
  context: AssembledContext;
  upstreamResults: readonly WorkerResult[];
  runState: RunState;
  changes: readonly unknown[];
  workerResults: readonly WorkerResult[];
  projectRoot: string;
  sourceRepo: string;
  recentContext: GatedContext | undefined;
  implementationBrief: ImplementationBrief | undefined;
  /**
   * Per-run cancellation signal. Coordinator builds one AbortController
   * per ActiveRun and passes its signal here for every dispatch — when
   * cancel(runId) is called, every concurrent worker call sees the
   * abort. Optional so test harnesses without a coordinator can omit it.
   */
  signal?: AbortSignal;
  fastPath?: boolean;
  buildAssignment: (
    decision: RoutingDecision,
    task: RunTask,
    intent: IntentObject,
    context: AssembledContext,
    upstreamResults: readonly WorkerResult[],
  ) => WorkerAssignment,
}): WorkerAssignment {
  const baseAssignment = input.buildAssignment(
    input.decision,
    input.task,
    input.intent,
    input.context,
    input.upstreamResults,
  );

  // Validate changes at dispatch time so bad data fails fast
  // rather than silently reaching Verifier or other downstream
  // workers as a falsy unknown[] cast.
  let validatedChanges: WorkerAssignment["changes"] | undefined = undefined;
  if (input.changes !== undefined && input.changes !== null) {
    validateFileChangeArray(input.changes, "dispatchAssignment.changes");
    validatedChanges = input.changes as WorkerAssignment["changes"];
  }

  return {
    ...baseAssignment,
    runState: input.runState,
    changes: validatedChanges,
    workerResults: [...input.workerResults],
    projectRoot: input.projectRoot,
    sourceRepo: input.sourceRepo,
    recentContext: input.recentContext,
    implementationBrief: input.implementationBrief,
    signal: input.signal,
    ...(input.fastPath ? { fastPath: true } : {}),
  };
}

export function workerCompleteEventType(type: WorkerType): AedisEvent["type"] {
  const map: Record<WorkerType, AedisEvent["type"]> = {
    scout: "scout_complete",
    builder: "builder_complete",
    critic: "critic_review",
    verifier: "verifier_check",
    integrator: "task_complete",
  };
  return map[type];
}
