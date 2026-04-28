/**
 * Health route — System readiness check.
 *
 * GET /health — Reports system status:
 *   - Server uptime
 *   - Crucibulum connection status
 *   - Worker availability per role
 *   - Port status
 *   - WebSocket client count
 */

import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import type { ServerContext } from "../index.js";
import type { WorkerType } from "../../workers/base.js";

// ─── Routes ──────────────────────────────────────────────────────────

export const healthRoutes: FastifyPluginAsync = async (fastify) => {
  const ctx = (): ServerContext => fastify.ctx;

  const WORKER_TYPES: WorkerType[] = ["scout", "builder", "critic", "verifier", "integrator"];

  /**
   * GET /health — Full system health check.
   */
  fastify.get(
    "/health",
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const context = ctx();

      // Worker availability
      const workerStatus: Record<string, { available: boolean; count: number }> = {};
      let allWorkersAvailable = true;

      for (const type of WORKER_TYPES) {
        const workers = context.workerRegistry.getWorkers(type);
        workerStatus[type] = {
          available: workers.length > 0,
          count: workers.length,
        };
        if (workers.length === 0) allWorkersAvailable = false;
      }

      // Uptime
      const startedAt = new Date(context.startedAt);
      const uptimeMs = Date.now() - startedAt.getTime();

      // WebSocket clients
      const wsClients = context.eventBus.clientCount();

      // Overall status
      const status = allWorkersAvailable ? "healthy" : "degraded";

      // Runtime safety policy — derived snapshot. Lets `aedis doctor`
      // and TUI users see exactly what the running server is allowed
      // to do without having to read env vars or coordinator config.
      const policy = context.getRuntimePolicy();

      // Auth mode — exposes the runtime auth configuration so the doctor
      // and TUI can surface auth status without re-implementing the logic.
      // Never includes secrets. The `mode` field is human-readable.
      const authEnabled = !context.config.disableAuth;
      const auth: {
        readonly enabled: boolean;
        readonly mode: "tailscale-only" | "open";
        readonly tailscaleOnly: boolean;
      } = {
        enabled: authEnabled,
        mode: authEnabled ? "tailscale-only" : "open",
        tailscaleOnly: authEnabled,
      };

      reply.send({
        status,
        timestamp: new Date().toISOString(),
        uptime_ms: uptimeMs,
        uptime_seconds: Math.floor(uptimeMs / 1000),
        uptime_human: formatUptime(uptimeMs),
        port: context.config.port,
        policy,
        pid: context.pid,
        startedAt: context.startedAt,
        build: {
          version: context.build.version,
          commit: context.build.commit,
          commitShort: context.build.commitShort,
          buildTime: context.build.buildTime,
          source: context.build.source,
        },
        workers: workerStatus,
        all_workers_available: allWorkersAvailable,
        websocket: {
          connected_clients: wsClients,
          endpoint: `/ws`,
        },
        auth,
        crucibulum: {
          connected: false, // TODO: wire up when Crucibulum is integrated
          last_sync: null,
        },
        // Legacy field — kept for back-compat with old burn-in / TUI
        // readers that pluck `version` directly. Mirrors `build.version`.
        version: context.build.version,
      });
    }
  );

  /**
   * GET /ready — Lightweight readiness probe for load balancers.
   */
  fastify.get(
    "/ready",
    async (_request: FastifyRequest, reply: FastifyReply) => {
      reply.send({ ready: true });
    }
  );
};

// ─── Helpers ─────────────────────────────────────────────────────────

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
  if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}
