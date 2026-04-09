/**
 * Task routes — Submit, query, and cancel build tasks.
 *
 * POST /tasks       — Submit a new task, returns { task_id, run_id }
 * GET  /tasks/:id   — Status + current run state
 * GET  /tasks/:id/receipts — Full receipt bundle
 * DELETE /tasks/:id — Cancel a running task
 */

import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import type { ServerContext } from "../index.js";

// ─── Request/Response Schemas ────────────────────────────────────────

interface SubmitBody {
  input: string;
  exclusions?: string[];
  quality_bar?: "minimal" | "standard" | "hardened";
}

interface TaskParams {
  id: string;
}

// ─── Routes ──────────────────────────────────────────────────────────

export const taskRoutes: FastifyPluginAsync = async (fastify) => {
  const ctx = (): ServerContext => fastify.ctx;

  /**
   * POST /tasks — Submit a new build task.
   */
  fastify.post<{ Body: SubmitBody }>(
    "/",
    {
      schema: {
        body: {
          type: "object",
          required: ["input"],
          properties: {
            input: { type: "string", minLength: 1 },
            exclusions: { type: "array", items: { type: "string" } },
            quality_bar: { type: "string", enum: ["minimal", "standard", "hardened"] },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Body: SubmitBody }>, reply: FastifyReply) => {
      const { input, exclusions, quality_bar } = request.body;

      // Submit to coordinator (non-blocking — returns immediately with IDs)
      const runPromise = ctx().coordinator.submit({
        input,
        exclusions,
      });

      // Generate tracking IDs immediately
      // The Coordinator will populate these during execution
      const taskId = `task_${Date.now().toString(36)}`;
      const runId = `run_${Date.now().toString(36)}`;

      // Fire and forget — client tracks via WebSocket or polling
      runPromise.then((receipt) => {
        ctx().eventBus.emit({
          type: "receipt_generated",
          payload: { taskId, runId: receipt.runId, receiptId: receipt.id },
        });
      }).catch((err) => {
        ctx().eventBus.emit({
          type: "run_complete",
          payload: {
            taskId,
            runId,
            verdict: "failed",
            error: err instanceof Error ? err.message : String(err),
          },
        });
      });

      reply.code(202).send({
        task_id: taskId,
        run_id: runId,
        status: "accepted",
        message: "Task submitted. Connect to /ws for live updates.",
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

      // Check active runs for this task
      // In a full implementation, this would query a persistence layer
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

      // Try to cancel via coordinator
      const cancelled = ctx().coordinator.cancel(id);

      if (cancelled) {
        reply.send({
          task_id: id,
          status: "cancelled",
          message: "Run cancellation requested",
        });
      } else {
        reply.code(404).send({
          error: "Not found",
          message: `No active run found with ID "${id}"`,
        });
      }
    }
  );
};
