/**
 * Metrics route — Metrics + External API Layer v1.
 *
 * GET /metrics — aggregate snapshot across every tracked run.
 *
 * Read-only. Delegates all aggregation to core/metrics.ts so the
 * route handler stays thin and the pure function can be unit
 * tested without Fastify.
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { computeMetrics, type TrackedRunLike } from "../../core/metrics.js";
import { getAllTrackedRuns } from "./tasks.js";

export const metricsRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /metrics — Aggregate metrics across every tracked run.
   *
   * Reads from the tracked-run registry populated by POST /tasks
   * and POST /tasks/loqui/unified. Unfinished runs are counted
   * under `inFlightRuns`; only terminal runs contribute to
   * `successRate`. Cost / file / confidence averages exclude
   * unfinished runs so an idle queue does not dilute the numbers.
   */
  fastify.get(
    "/",
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const tracked = getAllTrackedRuns() as unknown as readonly TrackedRunLike[];
      const persistedIndex = await fastify.ctx.receiptStore.listRuns(1000);
      const persistedRuns = await Promise.all(
        persistedIndex.map(async (entry): Promise<TrackedRunLike | null> => {
          const persisted = await fastify.ctx.receiptStore.getRun(entry.runId);
          if (!persisted) return null;
          const task = await fastify.ctx.receiptStore.getTaskByRunId(entry.runId);
          return {
            taskId: task?.taskId ?? persisted.runId,
            runId: persisted.runId,
            status:
              persisted.status === "RUNNING" || persisted.status === "EXECUTING_IN_WORKSPACE" || persisted.status === "PROPOSED" || persisted.status === "VERIFICATION_PENDING"
                ? "running"
                : persisted.status === "COMPLETE" || persisted.status === "VERIFIED_PASS" || persisted.status === "READY_FOR_PROMOTION"
                  ? "complete"
                  : persisted.status === "ABORTED" || persisted.status === "INTERRUPTED"
                    ? "cancelled"
                    : "failed",
            prompt: task?.prompt ?? persisted.prompt,
            submittedAt: task?.submittedAt ?? persisted.startedAt ?? persisted.createdAt,
            completedAt: persisted.completedAt,
            receipt: persisted.finalReceipt,
            error: persisted.errors[0] ?? task?.error ?? null,
            stateCategory:
              persisted.status === "RUNNING" || persisted.status === "EXECUTING_IN_WORKSPACE" || persisted.status === "PROPOSED" || persisted.status === "VERIFICATION_PENDING"
                ? "in-flight"
                : persisted.status === "CRASHED" || persisted.status === "EXECUTION_ERROR" || persisted.status === "CLEANUP_ERROR"
                  ? "crashed"
                  : persisted.status === "COMPLETE" || persisted.status === "VERIFIED_PASS" || persisted.status === "READY_FOR_PROMOTION"
                    ? "completed"
                    : persisted.status === "DISAGREEMENT_HOLD"
                      ? "blocked"
                      : "failed",
          };
        }),
      );

      const byRunId = new Map<string, TrackedRunLike>();
      for (const run of persistedRuns) {
        if (!run?.runId) continue;
        byRunId.set(run.runId, run);
      }
      for (const run of tracked) {
        if (!run.runId) continue;
        byRunId.set(run.runId, run);
      }

      const snapshot = computeMetrics([...byRunId.values()]);
      reply.send(snapshot);
    }
  );
};
