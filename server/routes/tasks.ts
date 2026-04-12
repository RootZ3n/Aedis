/**
 * Task routes — Submit, query, and cancel build tasks.
 *
 * POST /tasks       — Submit a new task, returns { task_id, run_id }
 * GET  /tasks/:id   — Status + current run state
 * GET  /tasks/:id/receipts — Full receipt bundle
 * DELETE /tasks/:id — Cancel a running task
 */

import { randomUUID } from "crypto";
import { existsSync } from "fs";
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { askLoqui } from "../../core/loqui.js";
import { routeLoquiInput, type LoquiRouteDecision } from "../../core/loqui-router.js";
import type { LoquiIntentContext } from "../../core/loqui-intent.js";
import { generateDryRun } from "../../core/dry-run.js";
import type { ServerContext } from "../index.js";

// ─── Request/Response Schemas ────────────────────────────────────────

interface SubmitBody {
  /** Natural language prompt — also accepted as "input" */
  prompt?: string;
  input?: string;
  /** Repo path to operate on */
  repoPath?: string;
  exclusions?: string[];
  quality_bar?: "minimal" | "standard" | "hardened";
}

interface TaskParams {
  id: string;
}

interface LoquiBody {
  question: string;
  repoPath: string;
}

/**
 * Unified Loqui route request body. A single freeform input stream
 * that the classifier will route to build / answer / resume /
 * clarify. The `context` field is optional — the UI passes it when
 * it knows about a prior run so the classifier can emit resume_run
 * or status intents safely (see core/loqui-intent.ts Rule B).
 */
interface LoquiUnifiedBody {
  input: string;
  repoPath: string;
  context?: LoquiIntentContext;
}

// ─── In-memory run tracker (bridges POST → Coordinator → WS) ────────

interface TrackedRun {
  taskId: string;
  runId: string;
  status: "queued" | "running" | "complete" | "failed" | "cancelled";
  prompt: string;
  submittedAt: string;
  completedAt: string | null;
  receipt: unknown | null;
  error: string | null;
}

const trackedRuns = new Map<string, TrackedRun>();

export function getTrackedRun(taskId: string): TrackedRun | undefined {
  return trackedRuns.get(taskId);
}

/**
 * Snapshot of every tracked run, newest first. Read-only — returns
 * a fresh array so callers can iterate / sort / slice without
 * touching the internal Map. Used by the external API layer
 * (Metrics + External API v1) so /metrics, /runs, and /runs/:id
 * can aggregate across the same registry that /tasks writes to,
 * without importing the private Map or creating a second source
 * of truth.
 */
export function getAllTrackedRuns(): readonly TrackedRun[] {
  const out = [...trackedRuns.values()];
  out.sort((a, b) => (a.submittedAt < b.submittedAt ? 1 : -1));
  return out;
}

/** Exported type for the external API routes. */
export type { TrackedRun };

/**
 * Shared build-submit helper. Dispatches a build task through the
 * Coordinator and registers the tracked run state. Used by both the
 * legacy POST /tasks handler and the new unified POST /tasks/loqui
 * path so we get exactly one code path for "start a build." The
 * response shape (task_id + run_id + prompt + repo_path) is the same for
 * both, which keeps the UI's optimistic-run bookkeeping identical
 * whether the request came from the hero form or Loqui.
 */
async function submitBuildTask(
  ctx: ServerContext,
  prompt: string,
  repoPath: string | undefined,
  exclusions: string[] | undefined,
): Promise<{ taskId: string; runId: string; prompt: string; repoPath: string | null }> {
  const taskId = `task_${randomUUID().slice(0, 8)}`;
  const runId = randomUUID();
  const submittedAt = new Date().toISOString();
  const tracked: TrackedRun = {
    taskId,
    runId,
    status: "queued",
    prompt,
    submittedAt,
    completedAt: null,
    receipt: null,
    error: null,
  };
  trackedRuns.set(taskId, tracked);
  await ctx.receiptStore.registerTask({
    taskId,
    runId,
    prompt: tracked.prompt,
    submittedAt,
  });
  tracked.status = "running";
  void ctx.receiptStore.updateTask(taskId, { status: "running" });

  ctx.eventBus.emit({
    type: "run_started",
    payload: { taskId, runId, prompt: tracked.prompt, status: "running", repoPath: repoPath ?? null },
  });

  console.log(`[tasks] calling coordinator.submit for taskId=${taskId} (projectRoot=${repoPath ?? "(default)"})...`);
  ctx.coordinator.submit({
    runId,
    input: tracked.prompt,
    exclusions,
    ...(repoPath ? { projectRoot: repoPath } : {}),
  }).then((receipt) => {
    console.log(`[tasks] coordinator.submit resolved: taskId=${taskId}, verdict=${receipt.verdict}, cost=$${receipt.totalCost.estimatedCostUsd}`);
    tracked.runId = receipt.runId;
    tracked.status = receipt.verdict === "success" ? "complete" : receipt.verdict === "aborted" ? "cancelled" : "failed";
    tracked.completedAt = new Date().toISOString();
    tracked.receipt = receipt;
    void ctx.receiptStore.updateTask(taskId, {
      runId: receipt.runId,
      status: tracked.status,
      completedAt: tracked.completedAt,
      error: null,
    });

    ctx.eventBus.emit({
      type: "run_complete",
      payload: {
        taskId,
        runId: receipt.runId,
        verdict: receipt.verdict,
        totalCostUsd: receipt.totalCost.estimatedCostUsd,
        durationMs: receipt.durationMs,
        executionVerified: receipt.executionVerified,
        executionReason: receipt.executionGateReason,
      },
    });

    ctx.eventBus.emit({
      type: "run_receipt",
      payload: { taskId, runId: receipt.runId, receiptId: receipt.id, receipt },
    });
  }).catch((err) => {
    console.error("═══ COORDINATOR SUBMIT FAILED ═══");
    console.error("taskId:", taskId);
    console.error("prompt:", tracked.prompt.slice(0, 200));
    console.error("repoPath:", repoPath ?? "(default)");
    console.error("error:", err instanceof Error ? err.message : err);
    console.error("stack:", err instanceof Error ? err.stack : "");
    console.error("═════════════════════════════════");

    tracked.status = "failed";
    tracked.completedAt = new Date().toISOString();
    tracked.error = err instanceof Error ? err.message : String(err);
    void ctx.receiptStore.updateTask(taskId, {
      status: "failed",
      completedAt: tracked.completedAt,
      error: tracked.error,
    });

    ctx.eventBus.emit({
      type: "run_complete",
      payload: {
        taskId,
        runId,
        verdict: "failed",
        error: tracked.error,
        executionVerified: false,
      },
    });
  });

  return { taskId, runId, prompt, repoPath: repoPath ?? null };
}

/**
 * Find the most recent tracked run so the unified Loqui route can
 * reconstruct the "continuation" prompt for a resume_run intent.
 * Returns null when the session has no prior runs — the classifier
 * already guards against this but the handler double-checks so a
 * stale client context cannot spawn a resume against nothing.
 */
function findLatestTrackedRun(): TrackedRun | null {
  let latest: TrackedRun | null = null;
  for (const run of trackedRuns.values()) {
    if (!latest) {
      latest = run;
      continue;
    }
    if (run.submittedAt > latest.submittedAt) {
      latest = run;
    }
  }
  return latest;
}

async function findLatestKnownRun(ctx: ServerContext): Promise<{
  taskId: string | null;
  runId: string;
  prompt: string;
  status: string;
} | null> {
  const tracked = findLatestTrackedRun();
  if (tracked) {
    return {
      taskId: tracked.taskId,
      runId: tracked.runId,
      prompt: tracked.prompt,
      status: tracked.status,
    };
  }

  const recent = await ctx.receiptStore.listRuns(10);
  for (const entry of recent) {
    const receipt = await ctx.receiptStore.getRun(entry.runId);
    if (!receipt) continue;
    const task = await ctx.receiptStore.getTaskByRunId(entry.runId);
    return {
      taskId: task?.taskId ?? null,
      runId: entry.runId,
      prompt: task?.prompt ?? receipt.prompt,
      status: receipt.status,
    };
  }

  return null;
}

async function findKnownRunById(
  ctx: ServerContext,
  id: string | null | undefined,
): Promise<{
  taskId: string | null;
  runId: string;
  prompt: string;
  status: string;
} | null> {
  if (!id) return null;
  const task = await ctx.receiptStore.getTask(id);
  if (task) {
    const receipt = await ctx.receiptStore.getRun(task.runId);
    return {
      taskId: task.taskId,
      runId: task.runId,
      prompt: task.prompt || receipt?.prompt || "",
      status: receipt?.status ?? task.status,
    };
  }
  const byRun = await ctx.receiptStore.getTaskByRunId(id);
  if (byRun) {
    const receipt = await ctx.receiptStore.getRun(byRun.runId);
    return {
      taskId: byRun.taskId,
      runId: byRun.runId,
      prompt: byRun.prompt || receipt?.prompt || "",
      status: receipt?.status ?? byRun.status,
    };
  }
  const receipt = await ctx.receiptStore.getRun(id);
  if (receipt) {
    return {
      taskId: null,
      runId: receipt.runId,
      prompt: receipt.prompt,
      status: receipt.status,
    };
  }
  return null;
}

// ─── Routes ──────────────────────────────────────────────────────────

export const taskRoutes: FastifyPluginAsync = async (fastify) => {
  const ctx = (): ServerContext => fastify.ctx;

  function toTaskStatus(
    status: "RUNNING" | "COMPLETE" | "FAILED" | "ABORTED" | "CRASHED" | "INTERRUPTED",
  ): TrackedRun["status"] {
    switch (status) {
      case "RUNNING":
        return "running";
      case "COMPLETE":
        return "complete";
      case "ABORTED":
      case "INTERRUPTED":
        return "cancelled";
      case "CRASHED":
      case "FAILED":
      default:
        return "failed";
    }
  }

  fastify.post<{ Body: LoquiBody }>(
    "/loqui",
    {
      schema: {
        body: {
          type: "object",
          required: ["question", "repoPath"],
          properties: {
            question: { type: "string", minLength: 1 },
            repoPath: { type: "string", minLength: 1 },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Body: LoquiBody }>, reply: FastifyReply) => {
      const { question, repoPath } = request.body;

      if (!existsSync(repoPath)) {
        reply.code(400).send({
          error: "Bad request",
          message: `repoPath does not exist on this host: ${repoPath}`,
        });
        return;
      }

      const answer = await askLoqui(question, repoPath);
      reply.send({ answer });
    }
  );

  /**
   * POST /tasks/loqui/unified — Unified Loqui intent routing.
   *
   * Accepts one freeform input string, runs it through the
   * classifier + router, and dispatches to the correct backend path.
   * The UI sends every Loqui chat message here — there is no more
   * "mode" to pick at submit time.
   *
   * Response shape (always the same top-level wrapper):
   *   {
   *     route: "build" | "answer" | "clarify",
   *     intent, label, reason, confidence, signals,
   *     ...plus a route-specific payload:
   *       build   → { task_id, run_id, prompt, repo_path }
   *       answer  → { answer }
   *       clarify → { clarification }
   *   }
   *
   * The `signals` field exists so the UI (and later audit tooling)
   * can show *why* Loqui picked the route it picked — this preserves
   * the inspectability constraint from the execution-truth work.
   */
  fastify.post<{ Body: LoquiUnifiedBody }>(
    "/loqui/unified",
    {
      schema: {
        body: {
          type: "object",
          required: ["input", "repoPath"],
          properties: {
            input: { type: "string", minLength: 1 },
            repoPath: { type: "string", minLength: 1 },
            context: {
              type: "object",
              additionalProperties: true,
              properties: {
                activeRunId: { type: ["string", "null"] },
                lastRunId: { type: ["string", "null"] },
                lastRunVerdict: { type: ["string", "null"] },
                previousMessageWasBuild: { type: "boolean" },
              },
            },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Body: LoquiUnifiedBody }>, reply: FastifyReply) => {
      const { input, repoPath } = request.body;
      const routerContext: LoquiIntentContext = request.body.context ?? {};

      if (!existsSync(repoPath)) {
        reply.code(400).send({
          error: "Bad request",
          message: `repoPath does not exist on this host: ${repoPath}`,
        });
        return;
      }

      const decision: LoquiRouteDecision = routeLoquiInput({ input, context: routerContext });
      console.log(
        `[tasks] /loqui/unified: action=${decision.action} intent=${decision.intent} ` +
        `label=${decision.label} confidence=${decision.confidence.toFixed(2)} ` +
        `reason="${decision.reason}" signals=${decision.signals.length}`,
      );

      // Base envelope every response shares. Gives the UI a stable
      // shape to hang its intent badge / signal audit off of, no
      // matter which backend path actually ran.
      const envelope = {
        route: decision.action,
        intent: decision.intent,
        label: decision.label,
        reason: decision.reason,
        confidence: decision.confidence,
        signals: [...decision.signals],
        original_input: decision.originalInput,
      };

      switch (decision.action) {
        case "build": {
          const result = await submitBuildTask(ctx(), decision.effectivePrompt, repoPath, undefined);
          reply.code(202).send({
            ...envelope,
            task_id: result.taskId,
            run_id: result.runId,
            prompt: result.prompt,
            repo_path: result.repoPath,
            status: "running",
            message: "Build task submitted. Watch the worker grid and Lumen log for progress.",
          });
          return;
        }

        case "resume": {
          // Stitch the new input onto the most recent tracked run's
          // prompt so the Coordinator sees a self-contained request.
          // If no prior run exists on the server (e.g. because this
          // server was restarted since the UI learned about it), we
          // fall back to treating the input as a bare build rather
          // than failing — the user's intent to "continue" is clear
          // even if we don't have the history to reference.
          const requestedPriorId = routerContext.activeRunId ?? routerContext.lastRunId ?? null;
          const prior =
            await findKnownRunById(ctx(), requestedPriorId) ??
            await findLatestKnownRun(ctx());
          const stitched = prior
            ? `Continue the prior build (${prior.runId}): "${prior.prompt}". Follow-up instruction: ${decision.originalInput}`
            : decision.originalInput;
          const result = await submitBuildTask(ctx(), stitched, repoPath, undefined);
          reply.code(202).send({
            ...envelope,
            task_id: result.taskId,
            run_id: result.runId,
            prompt: result.prompt,
            repo_path: result.repoPath,
            resumed_from: prior?.runId ?? null,
            status: "running",
            message: prior
              ? `Resuming from ${prior.runId}. New build task submitted.`
              : "No prior run found in persisted history — submitted as a fresh build.",
          });
          return;
        }

        case "answer": {
          const answer = await askLoqui(decision.effectivePrompt, repoPath);
          reply.send({ ...envelope, answer });
          return;
        }

        case "dry_run": {
          // Preflight + Dry Run System v1 — grounded structured
          // plan produced by generateDryRun. Nothing is written,
          // no worker runs. The plan reuses every planning
          // primitive the Coordinator uses at runtime, so the
          // steps the user sees here match what would happen if
          // they submitted the same request for real.
          const plan = generateDryRun({ input: decision.originalInput, projectRoot: repoPath });
          reply.send({ ...envelope, plan });
          return;
        }

        case "clarify":
        default: {
          reply.send({ ...envelope, clarification: decision.clarification });
          return;
        }
      }
    }
  );

  /**
   * POST /tasks/dry-run — Direct dry-run entry point.
   *
   * Skips the classifier and produces a structured dry-run plan
   * from a raw prompt + repoPath. Used by API clients that
   * already know they want a plan (no natural-language gate).
   * Response shape mirrors the `dry_run` action from the
   * unified route: { plan: DryRunPlan }.
   */
  fastify.post<{ Body: { input: string; repoPath: string } }>(
    "/dry-run",
    {
      schema: {
        body: {
          type: "object",
          required: ["input", "repoPath"],
          properties: {
            input: { type: "string", minLength: 1 },
            repoPath: { type: "string", minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const { input, repoPath } = request.body;
      if (!existsSync(repoPath)) {
        reply.code(400).send({
          error: "Bad request",
          message: `repoPath does not exist on this host: ${repoPath}`,
        });
        return;
      }
      const plan = generateDryRun({ input, projectRoot: repoPath });
      reply.send({ plan });
    }
  );

  /**
   * POST /tasks — Submit a new build task.
   *
   * Calls coordinator.submit() and tracks the run.
   * Returns immediately with task_id + run_id. The run executes async.
   * Client should subscribe on WebSocket with { type: "subscribe", runId }.
   *
   * The optional `repoPath` field in the body lets the caller target a
   * specific local repo as the project root for this build. The Coordinator
   * uses it as the effective projectRoot — workers see it via
   * assignment.projectRoot, gitCommit runs with cwd=repoPath, and the
   * IntegrationJudge normalizes deliverable paths against it. When omitted,
   * the Coordinator falls back to its own boot-time config.projectRoot
   * (typically the API server's cwd).
   */
  fastify.post<{ Body: SubmitBody }>(
    "/",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            prompt: { type: "string", minLength: 1 },
            input: { type: "string", minLength: 1 },
            repoPath: { type: "string" },
            exclusions: { type: "array", items: { type: "string" } },
            quality_bar: { type: "string", enum: ["minimal", "standard", "hardened"] },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Body: SubmitBody }>, reply: FastifyReply) => {
      const prompt = request.body.prompt || request.body.input;
      const repoPath = request.body.repoPath;
      console.log("[tasks] POST /tasks received:", { prompt: prompt?.slice(0, 80), repoPath });

      if (!prompt || !prompt.trim()) {
        reply.code(400).send({
          error: "Bad request",
          message: "Either 'prompt' or 'input' field is required",
        });
        return;
      }

      // Validate repoPath if provided. The CLI does its own existsSync check
      // but we re-validate at the API boundary as defense-in-depth — a
      // misconfigured client (or a direct curl) might send a path that
      // doesn't exist on this host. Failing here gives a clear error
      // instead of letting the Coordinator throw mid-build.
      if (repoPath !== undefined && repoPath.length > 0) {
        if (!existsSync(repoPath)) {
          console.warn(`[tasks] rejecting POST: repoPath does not exist: ${repoPath}`);
          reply.code(400).send({
            error: "Bad request",
            message: `repoPath does not exist on this host: ${repoPath}`,
          });
          return;
        }
      }

      const result = await submitBuildTask(ctx(), prompt.trim(), repoPath, request.body.exclusions);

      reply.code(202).send({
        task_id: result.taskId,
        run_id: result.runId,
        status: "running",
        prompt: result.prompt,
        repo_path: result.repoPath,
        message: "Task submitted. Connect to /ws and subscribe to receive live updates.",
      });
    }
  );

  /**
   * GET /tasks/:id — Get task status and current run state.
   */
  fastify.get<{ Params: TaskParams }>(
    "/:id",
    async (request: FastifyRequest<{ Params: TaskParams }>, reply: FastifyReply) => {
      const { id } = request.params;
      const tracked = trackedRuns.get(id);

      if (tracked) {
        const activeRun = ctx().coordinator.getRunStatus(tracked.runId);
        const completedTasks = activeRun ? activeRun.run.tasks.filter((task) => task.status === "completed").length : 0;
        const failedTasks = activeRun ? activeRun.run.tasks.filter((task) => task.status === "failed").length : 0;

        reply.send({
          task_id: tracked.taskId,
          run_id: tracked.runId,
          status: tracked.status,
          prompt: tracked.prompt,
          submitted_at: tracked.submittedAt,
          completed_at: tracked.completedAt,
          error: tracked.error,
          active_run: Boolean(activeRun),
          progress: activeRun ? {
            phase: activeRun.run.phase,
            completed_tasks: completedTasks,
            failed_tasks: failedTasks,
            total_tasks: activeRun.run.tasks.length,
            total_cost: activeRun.run.totalCost,
          } : null,
        });
        return;
      }

      const persistedTask = await ctx().receiptStore.getTask(id) ?? await ctx().receiptStore.getTaskByRunId(id);
      if (persistedTask) {
        const persistedRun = await ctx().receiptStore.getRun(persistedTask.runId);
        const activeRun = ctx().coordinator.getRunStatus(persistedTask.runId);
        const completedTasks = activeRun ? activeRun.run.tasks.filter((task) => task.status === "completed").length : 0;
        const failedTasks = activeRun ? activeRun.run.tasks.filter((task) => task.status === "failed").length : 0;
        reply.send({
          task_id: persistedTask.taskId,
          run_id: persistedTask.runId,
          status: persistedRun ? toTaskStatus(persistedRun.status) : persistedTask.status,
          prompt: persistedTask.prompt,
          submitted_at: persistedTask.submittedAt,
          completed_at: persistedRun?.completedAt ?? persistedTask.completedAt,
          error: persistedRun?.errors[0] ?? persistedTask.error,
          active_run: Boolean(activeRun),
          progress: activeRun ? {
            phase: activeRun.run.phase,
            completed_tasks: completedTasks,
            failed_tasks: failedTasks,
            total_tasks: activeRun.run.tasks.length,
            total_cost: activeRun.run.totalCost,
          } : persistedRun ? {
            phase: persistedRun.phase,
            completed_tasks: persistedRun.workerEvents.filter((event) => event.status === "completed").length,
            failed_tasks: persistedRun.workerEvents.filter((event) => event.status === "failed").length,
            total_tasks: persistedRun.workerEvents.length,
            total_cost: persistedRun.totalCost,
          } : null,
        });
        return;
      }

      // Fallback: search event history
      const recentEvents = ctx().eventBus.recentEvents(100);
      const taskEvents = recentEvents.filter(
        (e) => (e.payload as any).taskId === id || (e.payload as any).runId === id
      );

      if (taskEvents.length === 0) {
        reply.code(404).send({
          error: "Not found",
          message: `No task or run found with ID "${id}"`,
        });
        return;
      }

      const lastEvent = taskEvents[taskEvents.length - 1];
      const isComplete = lastEvent.type === "run_complete" || lastEvent.type === "run_receipt";
      const runId = (lastEvent.payload as any).runId ?? id;

      reply.send({
        task_id: id,
        run_id: runId,
        status: isComplete ? "complete" : "running",
        phase: lastEvent.type,
        active_run: !isComplete,
        progress: null,
        last_event: lastEvent,
        event_count: taskEvents.length,
        events: taskEvents,
      });
    }
  );

  /**
   * GET /tasks/:id/receipts — Get the full receipt bundle for a completed task.
   */
  fastify.get<{ Params: TaskParams }>(
    "/:id/receipts",
    async (request: FastifyRequest<{ Params: TaskParams }>, reply: FastifyReply) => {
      const { id } = request.params;

      // Check tracked runs first
      const tracked = trackedRuns.get(id);
      if (tracked?.receipt) {
        reply.send({ task_id: id, run_id: tracked.runId, receipt: tracked.receipt });
        return;
      }

      const task = await ctx().receiptStore.getTask(id) ?? await ctx().receiptStore.getTaskByRunId(id);
      const persisted = await ctx().receiptStore.getRun(task?.runId ?? id);
      if (persisted) {
        reply.send({ task_id: task?.taskId ?? id, run_id: persisted.runId, receipt: persisted.finalReceipt ?? persisted });
        return;
      }

      // Fallback to event history
      const recentEvents = ctx().eventBus.recentEvents(200);
      const receiptEvent = recentEvents.find(
        (e) =>
          e.type === "run_receipt" &&
          ((e.payload as any).taskId === id || (e.payload as any).runId === id)
      );

      if (!receiptEvent) {
        reply.code(404).send({
          error: "Not found",
          message: `No receipt found for task "${id}". Task may still be running.`,
        });
        return;
      }

      reply.send({
        task_id: id,
        receipt: receiptEvent.payload,
      });
    }
  );

  /**
   * DELETE /tasks/:id — Cancel a running task.
   */
  fastify.delete<{ Params: TaskParams }>(
    "/:id",
    async (request: FastifyRequest<{ Params: TaskParams }>, reply: FastifyReply) => {
      const { id } = request.params;

      const tracked = trackedRuns.get(id);
      if (tracked && tracked.runId) {
        const cancelled = ctx().coordinator.cancel(tracked.runId);
        if (cancelled) {
          tracked.status = "cancelled";
          tracked.completedAt = new Date().toISOString();
          void ctx().receiptStore.updateTask(id, {
            status: "cancelled",
            completedAt: tracked.completedAt,
            error: "Cancelled by user",
          });
          reply.send({ task_id: id, status: "cancelled", message: "Run cancellation requested" });
          return;
        }
      }

      const persistedTask = await ctx().receiptStore.getTask(id) ?? await ctx().receiptStore.getTaskByRunId(id);
      if (persistedTask) {
        const cancelled = ctx().coordinator.cancel(persistedTask.runId);
        if (cancelled) {
          void ctx().receiptStore.updateTask(id, {
            status: "cancelled",
            completedAt: new Date().toISOString(),
            error: "Cancelled by user",
          });
          reply.send({ task_id: id, run_id: persistedTask.runId, status: "cancelled", message: "Run cancellation requested" });
          return;
        }
      }

      // Try cancelling by run ID directly
      const cancelled = ctx().coordinator.cancel(id);
      if (cancelled) {
        reply.send({ task_id: id, status: "cancelled", message: "Run cancellation requested" });
        return;
      }

      reply.code(404).send({
        error: "Not found",
        message: `No active run found with ID "${id}"`,
      });
    }
  );
};
