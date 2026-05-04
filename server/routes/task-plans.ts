/**
 * Task-plan routes — driver for the multi-step "continue-until-done"
 * execution loop.
 *
 *   POST   /task-plans                 — Create a new plan with explicit subtasks
 *   GET    /task-plans                 — List plans (newest first)
 *   GET    /task-plans/:id             — Plan detail + final summary
 *   POST   /task-plans/:id/start       — Begin loop execution (async)
 *   POST   /task-plans/:id/continue    — Resume after pause / blocker (async)
 *   POST   /task-plans/:id/cancel      — Cancel the loop (idempotent)
 *   POST   /task-plans/:id/skip        — Skip a specific subtask
 *
 * Async semantics:
 *   `start` and `continue` schedule loop execution on the server
 *   process and return 202 Accepted immediately. The loop persists
 *   plan state on every transition; clients poll `GET /task-plans/:id`
 *   to observe progress. A future enhancement would push WS events.
 *
 * SAFETY:
 *   The route layer adds NO new safety logic. It only orchestrates
 *   `coordinator.submit()` calls, each of which goes through the full
 *   Velum / target-discovery / workspace / verification / approval
 *   pipeline. Approval pauses surface as `status: "paused"` and the
 *   loop driver halts. The route never invokes promotion.
 */

import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";

import type { ServerContext } from "../index.js";
import {
  createTaskPlan,
  buildFinalSummary,
  validateCreateTaskPlanInput,
  type CreateTaskPlanInput,
  type TaskPlan,
} from "../../core/task-plan.js";
import { TaskPlanStore } from "../../core/task-plan-store.js";
import {
  TaskLoopRunner,
  type CoordinatorLike,
  type ReceiptStoreReader,
  type TaskPlanEventPayload,
} from "../../core/task-loop.js";

// ─── Module-scoped runner ───────────────────────────────────────────
//
// One runner per process. Routes claim it via `getRunner(ctx)` so the
// in-flight tracking + cancellation state is shared across requests.
//
// NOTE: this is server-singleton state on purpose. A request that
// `cancel`s a plan must reach the same runner that is running it.
let runnerInstance: TaskLoopRunner | null = null;
let storeInstance: TaskPlanStore | null = null;

// Track in-flight loop runs so concurrent `start` / `continue` calls
// for the same plan don't race. Resolves when the loop iteration
// settles (paused, terminal, or budget-stopped).
const inFlightLoops = new Map<string, Promise<TaskPlan>>();

/**
 * Reset the module-scoped runner + store singletons. Test-only —
 * the production server creates exactly one runner per process. Tests
 * that build multiple fastify apps with different state roots call
 * this between cases so the second app gets a fresh runner instead
 * of reusing the first app's state-root.
 */
export function __resetTaskPlanSingletonsForTests(): void {
  runnerInstance = null;
  storeInstance = null;
  inFlightLoops.clear();
}

/**
 * Lazy-init the per-process store + runner. Wired into the
 * coordinator + receipt store from the server context. On boot,
 * `restoreOnBoot` reconciles any plan that was running when the
 * process died.
 */
async function getRunner(ctx: ServerContext): Promise<{ store: TaskPlanStore; runner: TaskLoopRunner }> {
  if (runnerInstance && storeInstance) {
    return { store: storeInstance, runner: runnerInstance };
  }
  const store = new TaskPlanStore({ stateRoot: ctx.config.stateRoot });
  await store.restoreOnBoot(new Date().toISOString());
  storeInstance = store;
  const coordinatorAdapter: CoordinatorLike = {
    submit: (s) => ctx.coordinator.submit(s),
    cancel: (runId) => {
      void ctx.coordinator.cancel(runId);
    },
  };
  const receiptAdapter: ReceiptStoreReader = {
    getRun: async (runId) => {
      const run = await ctx.receiptStore.getRun(runId);
      if (!run) return null;
      return { status: String(run.status ?? "") };
    },
  };
  runnerInstance = new TaskLoopRunner({
    store,
    coordinator: coordinatorAdapter,
    receiptStore: receiptAdapter,
    // Bridge loop transitions onto the WebSocket bus so the UI can
    // refresh in real time. The bus wraps every emit as
    // {type, payload, timestamp, seq} (see server/websocket.ts), so
    // the UI must unwrap `payload` before reading the event fields.
    emit: (payload: TaskPlanEventPayload) => {
      ctx.eventBus.emit({
        type: "task_plan_event",
        payload: { ...payload },
      });
    },
  });
  return { store, runner: runnerInstance };
}

/** Test-only — drop module state so each test can boot fresh. */
export function _resetTaskPlanRouterStateForTests(): void {
  runnerInstance = null;
  storeInstance = null;
  inFlightLoops.clear();
}

// ─── Route schemas ──────────────────────────────────────────────────

interface CreatePlanBody {
  objective?: string;
  repoPath?: string;
  subtasks?: { title?: string; prompt?: string }[];
  budget?: Partial<{
    maxSubtasks: number;
    maxAttemptsPerSubtask: number;
    maxRepairAttempts: number;
    maxRuntimeMs: number;
    maxCostUsd: number;
    maxConsecutiveFailures: number;
  }>;
}

interface PlanIdParams {
  id: string;
}

interface SkipBody {
  subtaskId?: string;
}

// ─── Routes ─────────────────────────────────────────────────────────

export const taskPlanRoutes: FastifyPluginAsync = async (fastify) => {
  const ctx = (): ServerContext => fastify.ctx;

  /**
   * POST /task-plans — create a plan with explicit subtasks.
   *
   * The caller (UI / CLI / a future LLM-planner endpoint) is
   * responsible for breaking the objective into subtasks. We
   * intentionally don't auto-decompose here: a vague objective
   * must not be silently expanded into a broad list of edits.
   */
  fastify.post<{ Body: CreatePlanBody }>(
    "/",
    async (request: FastifyRequest<{ Body: CreatePlanBody }>, reply: FastifyReply) => {
      const body = request.body ?? {};
      const input: CreateTaskPlanInput = {
        objective: String(body.objective ?? "").trim(),
        repoPath: String(body.repoPath ?? "").trim(),
        subtasks: Array.isArray(body.subtasks)
          ? body.subtasks.map((s) => ({
              title: typeof s?.title === "string" ? s.title : undefined,
              prompt: typeof s?.prompt === "string" ? s.prompt : "",
            }))
          : [],
        ...(body.budget ? { budget: body.budget } : {}),
      };
      const validation = validateCreateTaskPlanInput(input);
      if (!validation.ok) {
        reply.code(400).send({ error: "Validation failed", errors: validation.errors });
        return;
      }
      if (!existsSync(input.repoPath)) {
        reply.code(400).send({
          error: "Bad request",
          message: `repoPath does not exist on this host: ${input.repoPath}`,
        });
        return;
      }
      const { store } = await getRunner(ctx());
      const plan = createTaskPlan(input, {
        taskPlanId: `plan_${randomUUID().slice(0, 12)}`,
        now: new Date().toISOString(),
      });
      await store.create(plan);
      // Surface plan creation on the WS bus so a UI client that's
      // already connected can refresh its plan list without polling.
      ctx().eventBus.emit({
        type: "task_plan_event",
        payload: {
          kind: "plan_created",
          taskPlanId: plan.taskPlanId,
          status: plan.status,
          currentSubtaskId: null,
          progress: { completed: 0, total: plan.subtasks.length },
          stopReason: "",
          message: `Task plan created with ${plan.subtasks.length} subtask(s). Aedis will start safe work automatically.`,
          updatedAt: plan.updatedAt,
        },
      });
      reply.code(201).send({
        task_plan_id: plan.taskPlanId,
        plan,
      });
    },
  );

  fastify.get("/", async (_request: FastifyRequest, reply: FastifyReply) => {
    const { store } = await getRunner(ctx());
    const plans = await store.list();
    reply.send({
      plans: plans.map(summarizeForList),
      total: plans.length,
    });
  });

  fastify.get<{ Params: PlanIdParams }>(
    "/:id",
    async (request: FastifyRequest<{ Params: PlanIdParams }>, reply: FastifyReply) => {
      const { id } = request.params;
      const { store } = await getRunner(ctx());
      const plan = await store.load(id);
      if (!plan) {
        reply.code(404).send({ error: "Not found", message: `No plan with id ${id}` });
        return;
      }
      reply.send({
        task_plan_id: plan.taskPlanId,
        plan,
        summary: buildFinalSummary(plan),
      });
    },
  );

  fastify.post<{ Params: PlanIdParams }>(
    "/:id/start",
    async (request: FastifyRequest<{ Params: PlanIdParams }>, reply: FastifyReply) => {
      const { id } = request.params;
      const { store, runner } = await getRunner(ctx());
      const plan = await store.load(id);
      if (!plan) {
        reply.code(404).send({ error: "Not found", message: `No plan with id ${id}` });
        return;
      }
      if (plan.status !== "pending") {
        reply.code(409).send({
          error: "Conflict",
          message: `Plan ${id} status is ${plan.status}; use /continue to resume.`,
        });
        return;
      }
      // Schedule loop execution in the background. The route
      // returns 202 immediately; the operator polls GET /:id.
      scheduleLoop(runner, id);
      reply.code(202).send({
        task_plan_id: id,
        status: "running",
        message: "Loop scheduled. Poll GET /task-plans/:id for progress.",
      });
    },
  );

  fastify.post<{ Params: PlanIdParams }>(
    "/:id/continue",
    async (request: FastifyRequest<{ Params: PlanIdParams }>, reply: FastifyReply) => {
      const { id } = request.params;
      const { store, runner } = await getRunner(ctx());
      const plan = await store.load(id);
      if (!plan) {
        reply.code(404).send({ error: "Not found", message: `No plan with id ${id}` });
        return;
      }
      // Accept resume from any non-terminal state. `cancelled`,
      // `completed`, `failed` are terminal — refuse to resume them.
      if (plan.status === "completed" || plan.status === "cancelled" || plan.status === "failed") {
        reply.code(409).send({
          error: "Conflict",
          message: `Plan ${id} is terminal (${plan.status}); cannot continue.`,
        });
        return;
      }
      scheduleLoop(runner, id);
      reply.code(202).send({
        task_plan_id: id,
        status: "running",
        message: "Loop resumed. Poll GET /task-plans/:id for progress.",
      });
    },
  );

  fastify.post<{ Params: PlanIdParams }>(
    "/:id/cancel",
    async (request: FastifyRequest<{ Params: PlanIdParams }>, reply: FastifyReply) => {
      const { id } = request.params;
      const { store, runner } = await getRunner(ctx());
      const plan = await store.load(id);
      if (!plan) {
        reply.code(404).send({ error: "Not found", message: `No plan with id ${id}` });
        return;
      }
      await runner.cancel(id);
      const updated = await store.load(id);
      reply.send({
        task_plan_id: id,
        status: updated?.status ?? "cancelled",
        message: "Cancellation registered. Inspect the plan for the truthful state.",
      });
    },
  );

  fastify.post<{
    Params: PlanIdParams & { subtaskId: string };
    Body: { action?: string };
  }>(
    "/:id/subtasks/:subtaskId/timeout-recovery",
    async (request, reply) => {
      const { id, subtaskId } = request.params as { id: string; subtaskId: string };
      const action = String(request.body?.action ?? "").trim();
      const valid = ["retry_with_fallback", "retry_same_model", "skip_stage", "cancel_run"] as const;
      type Action = typeof valid[number];
      if (!valid.includes(action as Action)) {
        reply.code(400).send({
          error: "Bad request",
          message: `action must be one of ${valid.join(", ")}; got "${action}"`,
        });
        return;
      }
      const { runner } = await getRunner(ctx());
      try {
        const plan = await runner.applyTimeoutDecision(id, subtaskId, action as Action);
        reply.send({
          task_plan_id: id,
          subtask_id: subtaskId,
          action,
          plan,
          message: `Timeout decision "${action}" applied to ${subtaskId}. POST /task-plans/${id}/continue to resume.`,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const code = /not found/i.test(msg) ? 404 : /needs_clarification|state/i.test(msg) ? 409 : 400;
        reply.code(code).send({ error: code === 404 ? "Not found" : "Conflict", message: msg });
      }
    },
  );

  fastify.post<{
    Params: PlanIdParams & { subtaskId: string };
    Body: { target?: string };
  }>(
    "/:id/subtasks/:subtaskId/attach-target",
    async (request, reply) => {
      const { id, subtaskId } = request.params as { id: string; subtaskId: string };
      const target = String(request.body?.target ?? "").trim();
      if (!subtaskId) {
        reply.code(400).send({ error: "Bad request", message: "subtaskId required" });
        return;
      }
      if (!target) {
        reply.code(400).send({ error: "Bad request", message: "target file path required" });
        return;
      }
      const { runner } = await getRunner(ctx());
      try {
        const plan = await runner.attachTargetToSubtask(id, subtaskId, target);
        reply.send({
          task_plan_id: id,
          subtask_id: subtaskId,
          plan,
          message:
            `Target ${target} attached to ${subtaskId}. ` +
            `POST /task-plans/${id}/continue to resume the loop.`,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const code = /not found/i.test(msg) ? 404 : /needs_clarification|non-empty/i.test(msg) ? 409 : 400;
        reply.code(code).send({ error: code === 404 ? "Not found" : "Conflict", message: msg });
      }
    },
  );

  fastify.post<{ Params: PlanIdParams; Body: SkipBody }>(
    "/:id/skip",
    async (request, reply) => {
      const { id } = request.params;
      const subtaskId = String(request.body?.subtaskId ?? "").trim();
      if (!subtaskId) {
        reply.code(400).send({ error: "Bad request", message: "subtaskId required" });
        return;
      }
      const { runner } = await getRunner(ctx());
      try {
        const updated = await runner.skipSubtask(id, subtaskId);
        reply.send({ task_plan_id: id, plan: updated });
      } catch (err) {
        reply.code(404).send({
          error: "Not found",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );
};

// ─── Helpers ─────────────────────────────────────────────────────────

function scheduleLoop(runner: TaskLoopRunner, planId: string): void {
  // De-dupe: if a loop is already running for this plan, attach to
  // it instead of starting a second one. The runner's persistence
  // ensures both callers see the same end state.
  if (inFlightLoops.has(planId)) return;
  const promise = runner.run(planId).catch((err) => {
    console.error(
      `[task-plans] loop crashed for plan ${planId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  });
  inFlightLoops.set(planId, promise);
  promise.finally(() => {
    inFlightLoops.delete(planId);
  });
}

function summarizeForList(plan: TaskPlan): unknown {
  const counts = plan.subtasks.reduce(
    (acc, s) => {
      acc.total += 1;
      if (s.status === "completed" || s.status === "repaired") acc.completed += 1;
      else if (s.status === "failed") acc.failed += 1;
      else if (s.status === "skipped") acc.skipped += 1;
      else if (s.status === "blocked") acc.blocked += 1;
      else if (s.status === "needs_clarification") acc.needsClarification += 1;
      else acc.pending += 1;
      return acc;
    },
    { total: 0, completed: 0, failed: 0, skipped: 0, blocked: 0, pending: 0, needsClarification: 0 },
  );
  return {
    task_plan_id: plan.taskPlanId,
    objective: plan.objective,
    status: plan.status,
    stop_reason: plan.stopReason || null,
    counts,
    cost_usd: plan.spent.totalCostUsd,
    runtime_ms: plan.spent.totalRuntimeMs,
    created_at: plan.createdAt,
    updated_at: plan.updatedAt,
  };
}
