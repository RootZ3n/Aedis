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
      const runs = getAllTrackedRuns() as unknown as readonly TrackedRunLike[];
      const snapshot = computeMetrics(runs);
      reply.send(snapshot);
    }
  );
};
