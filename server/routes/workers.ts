/**
 * Worker routes — Query worker pools and status.
 *
 * GET /workers       — All worker pools with status
 * GET /workers/:role — Specific worker pool
 */

import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import type { ServerContext } from "../index.js";
import type { WorkerType } from "../../workers/base.js";

// ─── Request Schemas ─────────────────────────────────────────────────

interface WorkerParams {
  role: string;
}

// ─── Routes ──────────────────────────────────────────────────────────

export const workerRoutes: FastifyPluginAsync = async (fastify) => {
  const ctx = (): ServerContext => fastify.ctx;

  const WORKER_TYPES: WorkerType[] = ["scout", "builder", "critic", "verifier", "integrator"];

  /**
   * GET /workers — All worker pools with status.
   */
  fastify.get(
    "/",
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const registry = ctx().workerRegistry;

      const pools = WORKER_TYPES.map((type) => {
        const workers = registry.getWorkers(type);
        return {
          role: type,
          available: workers.length > 0,
          count: workers.length,
          workers: workers.map((w) => ({
            name: w.name,
            type: w.type,
          })),
        };
      });

      const totalWorkers = pools.reduce((sum, p) => sum + p.count, 0);
      const availableRoles = pools.filter((p) => p.available).length;

      reply.send({
        pools,
        summary: {
          total_workers: totalWorkers,
          available_roles: availableRoles,
          total_roles: WORKER_TYPES.length,
          fully_staffed: availableRoles === WORKER_TYPES.length,
        },
      });
    }
  );

  /**
   * GET /workers/:role — Specific worker pool details.
   */
  fastify.get<{ Params: WorkerParams }>(
    "/:role",
    async (request: FastifyRequest<{ Params: WorkerParams }>, reply: FastifyReply) => {
      const { role } = request.params;

      if (!WORKER_TYPES.includes(role as WorkerType)) {
        reply.code(400).send({
          error: "Invalid role",
          message: `Unknown worker role "${role}". Valid roles: ${WORKER_TYPES.join(", ")}`,
        });
        return;
      }

      const workers = ctx().workerRegistry.getWorkers(role as WorkerType);

      // Check recent activity for these workers
      const events = ctx().eventBus.recentEvents(100);
      const workerEvents = events.filter(
        (e) => (e.payload as any).workerType === role
      );

      reply.send({
        role,
        available: workers.length > 0,
        count: workers.length,
        workers: workers.map((w) => ({
          name: w.name,
          type: w.type,
        })),
        recent_activity: workerEvents.slice(-10).map((e) => ({
          type: e.type,
          timestamp: e.timestamp,
          run_id: (e.payload as any).runId,
        })),
      });
    }
  );
};
