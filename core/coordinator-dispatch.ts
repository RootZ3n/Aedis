import type { GatedContext } from "./context-gate.js";
import type { IntentObject } from "./intent.js";
import type { RunState, RunTask } from "./runstate.js";
import type { AssembledContext } from "./context-assembler.js";
import type { RoutingDecision } from "../router/trust-router.js";
import type { WorkerAssignment, WorkerResult, WorkerType } from "../workers/base.js";
import type { AedisEvent } from "../server/websocket.js";

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

  return {
    ...baseAssignment,
    runState: input.runState,
    changes: [...input.changes] as WorkerAssignment["changes"],
    workerResults: [...input.workerResults],
    projectRoot: input.projectRoot,
    sourceRepo: input.sourceRepo,
    recentContext: input.recentContext,
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
