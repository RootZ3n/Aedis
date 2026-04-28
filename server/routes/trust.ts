/**
 * Trust Dashboard API — Aedis trust observability surface.
 *
 * Endpoints:
 *   GET /trust/dashboard — Full trust dashboard (vitals, trends, archetypes, calibration)
 *   GET /trust/vitals    — Just the vitals card (lightweight)
 *   GET /trust/history   — Raw trust history entries for custom analysis
 */

import type { FastifyPluginAsync } from "fastify";

import {
  buildTrustDashboard,
  extractTrustEntry,
} from "../../core/trust-dashboard.js";
import { loadMemory } from "../../core/project-memory.js";
import type { RunReceipt } from "../../core/coordinator.js";
import type { ReceiptStore } from "../../core/receipt-store.js";

export const trustRoutes: FastifyPluginAsync = async (fastify) => {

  /**
   * GET /trust/dashboard — Full trust dashboard.
   * Query params:
   *   limit — max runs to analyze (default 50, max 100)
   */
  fastify.get<{ Querystring: { limit?: string } }>(
    "/dashboard",
    async (request, reply) => {
      try {
        const limit = Math.min(Math.max(parseInt(request.query.limit ?? "50", 10) || 50, 1), 100);

        const index = await fastify.ctx.receiptStore.listRuns(limit);
        const receipts = await loadReceipts(fastify.ctx.receiptStore, index);
        const memory = await loadMemory(fastify.ctx.config.projectRoot, fastify.ctx.config.stateRoot);
        const dashboard = buildTrustDashboard(receipts, memory);

        reply.send(dashboard);
      } catch (err) {
        reply.status(500).send({
          error: "Trust dashboard unavailable",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  /**
   * GET /trust/vitals — Lightweight vitals-only endpoint.
   */
  fastify.get(
    "/vitals",
    async (_request, reply) => {
      try {
        const index = await fastify.ctx.receiptStore.listRuns(20);
        const receipts = await loadReceipts(fastify.ctx.receiptStore, index);
        const memory = await loadMemory(fastify.ctx.config.projectRoot, fastify.ctx.config.stateRoot);
        const dashboard = buildTrustDashboard(receipts, memory);

        reply.send(dashboard.vitals);
      } catch (err) {
        reply.status(500).send({
          error: "Trust vitals unavailable",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  /**
   * GET /trust/history — Raw trust history entries.
   * Query params:
   *   limit — max entries (default 30, max 100)
   */
  fastify.get<{ Querystring: { limit?: string } }>(
    "/history",
    async (request, reply) => {
      try {
        const limit = Math.min(Math.max(parseInt(request.query.limit ?? "30", 10) || 30, 1), 100);

        const index = await fastify.ctx.receiptStore.listRuns(limit);
        const receipts = await loadReceipts(fastify.ctx.receiptStore, index);
        const entries = receipts.map(extractTrustEntry);

        reply.send({ entries, total: entries.length });
      } catch (err) {
        reply.status(500).send({
          error: "Trust history unavailable",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );
};

// ─── Helpers ────────────────────────────────────────────────────────

async function loadReceipts(
  receiptStore: ReceiptStore,
  index: readonly { runId: string }[],
): Promise<RunReceipt[]> {
  const receipts: RunReceipt[] = [];
  for (const entry of index) {
    try {
      const persistedRun = await receiptStore.getRun(entry.runId);
      if (persistedRun?.finalReceipt) {
        receipts.push(persistedRun.finalReceipt);
      }
    } catch {
      // Skip unreadable receipts
    }
  }
  return receipts;
}
