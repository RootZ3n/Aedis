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

// ─── In-memory run tracker (bridges POST → Coordinator → WS) ────────

interface TrackedRun {
  taskId: string;
  runId: string | null;
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

// ─── Routes ──────────────────────────────────────────────────────────

export const taskRoutes: FastifyPluginAsync = async (fastify) => {
  const ctx = (): ServerContext => fastify.ctx;

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
   * POST /tasks — Submit a new build task.
   *
   * Calls coordinator.submit() and tracks the run.
   * Returns immediately with task_id. The run executes async.
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

      const taskId = `task_${randomUUID().slice(0, 8)}`;
      const tracked: TrackedRun = {
        taskId,
        runId: null,
        status: "queued",
        prompt: prompt.trim(),
        submittedAt: new Date().toISOString(),
        completedAt: null,
        receipt: null,
        error: null,
      };
      trackedRuns.set(taskId, tracked);

      // Emit queued event immediately so WebSocket subscribers see it
      ctx().eventBus.emit({
        type: "run_started",
        payload: { taskId, prompt: tracked.prompt, status: "queued", repoPath: repoPath ?? null },
      });

      // Fire coordinator — runs async, updates tracked state.
      // Pass repoPath through as projectRoot so the Coordinator and
      // workers operate against the requested repo, not against the API
      // server's cwd. When repoPath is undefined, projectRoot is omitted
      // from the submission and the Coordinator falls back to its
      // config.projectRoot default.
      console.log(`[tasks] calling coordinator.submit for taskId=${taskId} (projectRoot=${repoPath ?? "(default)"})...`);
      ctx().coordinator.submit({
        input: tracked.prompt,
        exclusions: request.body.exclusions,
        ...(repoPath ? { projectRoot: repoPath } : {}),
      }).then((receipt) => {
        console.log(`[tasks] coordinator.submit resolved: taskId=${taskId}, verdict=${receipt.verdict}, cost=$${receipt.totalCost.estimatedCostUsd}`);
        tracked.runId = receipt.runId;
        tracked.status = receipt.verdict === "success" ? "complete" : receipt.verdict === "aborted" ? "cancelled" : "failed";
        tracked.completedAt = new Date().toISOString();
        tracked.receipt = receipt;

        ctx().eventBus.emit({
          type: "run_complete",
          payload: {
            taskId,
            runId: receipt.runId,
            verdict: receipt.verdict,
            totalCostUsd: receipt.totalCost.estimatedCostUsd,
            durationMs: receipt.durationMs,
          },
        });

        ctx().eventBus.emit({
          type: "receipt_generated",
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

        ctx().eventBus.emit({
          type: "run_complete",
          payload: {
            taskId,
            verdict: "failed",
            error: tracked.error,
          },
        });
      });

      reply.code(202).send({
        task_id: taskId,
        status: "queued",
        prompt: tracked.prompt,
        repo_path: repoPath ?? null,
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
        // Check if coordinator has an active run we can query
        const activeRun = tracked.runId ? ctx().coordinator.getRunStatus(tracked.runId) : null;

        reply.send({
          task_id: tracked.taskId,
          run_id: tracked.runId,
          status: tracked.status,
          prompt: tracked.prompt,
          submitted_at: tracked.submittedAt,
          completed_at: tracked.completedAt,
          error: tracked.error,
          active_run: activeRun ? {
            phase: activeRun.run.phase,
            task_count: activeRun.run.tasks.length,
            total_cost: activeRun.run.totalCost,
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
      const isComplete = lastEvent.type === "run_complete" || lastEvent.type === "receipt_generated";

      reply.send({
        task_id: id,
        status: isComplete ? "complete" : "running",
        phase: lastEvent.type,
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
        reply.send({ task_id: id, receipt: tracked.receipt });
        return;
      }

      // Fallback to event history
      const recentEvents = ctx().eventBus.recentEvents(200);
      const receiptEvent = recentEvents.find(
        (e) =>
          e.type === "receipt_generated" &&
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
          reply.send({ task_id: id, status: "cancelled", message: "Run cancellation requested" });
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
