/**
 * Memory routes — Debug/inspect project memory entries.
 *
 * GET  /memory              — List all entry IDs (summary)
 * GET  /memory/:id         — Get full entry with observations
 * POST /memory             — Create a new entry (for manual injection)
 * PUT  /memory/:id          — Update an entry
 * DELETE /memory/:id       — Flag an entry as expired (soft-delete)
 * GET  /memory/stats       — Storage stats (total, active, expired)
 * GET  /memory/query       — Query entries by tag
 */

import type { FastifyPluginAsync } from "fastify";
import { type ServerContext } from "../index.js";
import { ProjectMemoryStore } from "../../core/project-memory-store.js";

interface MemoryParams {
  id: string;
}

interface CreateMemoryBody {
  key: string;
  value: string;
  confidence: number;
  source: string;
  tags?: string[];
}

interface UpdateMemoryBody {
  value?: string;
  confidence?: number;
  tags?: string[];
  observation?: { taskId: string; confirmed: boolean };
}

interface QueryParams {
  tag?: string;
  taskTags?: string; // comma-separated tags for task-based retrieval
}

// ─── Routes ──────────────────────────────────────────────────────────

export const memoryRoutes: FastifyPluginAsync = async (fastify) => {
  const ctx = (): ServerContext => fastify.ctx;

  /**
   * GET /memory/stats — Storage statistics.
   */
  fastify.get("/stats", async (_request, reply) => {
    const projectRoot = ctx().config.projectRoot;
    const store = await ProjectMemoryStore.open(projectRoot, fastify.ctx.config.stateRoot);
    const stats = await store.stats();
    store.close();
    return reply.send({ ok: true, ...stats });
  });

  /**
   * GET /memory — List all entry IDs and a brief summary.
   * Optionally filter by tag.
   */
  fastify.get<{ Querystring: QueryParams }>(
    "/",
    async (request, reply) => {
      const projectRoot = ctx().config.projectRoot;
      const store = await ProjectMemoryStore.open(projectRoot, fastify.ctx.config.stateRoot);

      const { tag } = request.query;
      const entries = await store.listEntries({
        tag: tag ?? undefined,
        includeExpired: false,
      });

      const summaries = entries.map((e) => ({
        id: e.id,
        key: e.key,
        confidence: e.confidence,
        source: e.source,
        tags: e.tags,
        observationCount: e.observationCount,
        createdAt: e.createdAt,
        updatedAt: e.updatedAt,
        lastAccessedAt: e.lastAccessedAt,
        expired: e.expired,
        expiresAt: e.expiresAt,
      }));

      store.close();
      return reply.send({ ok: true, entries: summaries, total: summaries.length });
    }
  );

  /**
   * GET /memory/query — Retrieve entries relevant to a task (advisory hints).
   * taskTags: comma-separated list of tags to match.
   */
  fastify.get<{ Querystring: QueryParams }>(
    "/query",
    async (request, reply) => {
      const projectRoot = ctx().config.projectRoot;
      const store = await ProjectMemoryStore.open(projectRoot, fastify.ctx.config.stateRoot);

      const taskTags = request.query.taskTags
        ? request.query.taskTags.split(",").map((t) => t.trim())
        : [];

      if (taskTags.length === 0) {
        store.close();
        return reply.status(400).send({
          ok: false,
          error: "Provide taskTags (comma-separated) to query relevant memory",
        });
      }

      const entries = await store.getMemoryForTask(taskTags);

      // Format as prior knowledge hints
      const hints = entries.map((e) => ({
        key: e.key,
        value: e.value,
        confidence: e.confidence,
        source: e.source,
        tags: e.tags,
      }));

      store.close();
      return reply.send({
        ok: true,
        taskTags,
        hints,
        count: hints.length,
        advisory: true,
        note: "Memory entries are ADVISORY ONLY. Current source code always takes precedence.",
      });
    }
  );

  /**
   * GET /memory/:id — Get full entry including observations.
   */
  fastify.get<{ Params: MemoryParams }>(
    "/:id",
    async (request, reply) => {
      const projectRoot = ctx().config.projectRoot;
      const store = await ProjectMemoryStore.open(projectRoot, fastify.ctx.config.stateRoot);

      const file = await store.getEntryFile(request.params.id);
      store.close();

      if (!file) {
        return reply.status(404).send({ ok: false, error: "Entry not found" });
      }

      return reply.send({ ok: true, ...file });
    }
  );

  /**
   * POST /memory — Create a new memory entry (manual injection).
   */
  fastify.post<{ Body: CreateMemoryBody }>(
    "/",
    async (request, reply) => {
      const projectRoot = ctx().config.projectRoot;
      const { key, value, confidence, source, tags } = request.body ?? {};

      if (!key || value === undefined || confidence === undefined || !source) {
        return reply.status(400).send({
          ok: false,
          error: "Missing required fields: key, value, confidence, source",
        });
      }

      if (confidence < 0 || confidence > 1) {
        return reply.status(400).send({
          ok: false,
          error: "confidence must be between 0 and 1",
        });
      }

      const store = await ProjectMemoryStore.open(projectRoot, fastify.ctx.config.stateRoot);
      const entry = await store.createEntry({ key, value, confidence, source, tags });
      store.close();

      return reply.status(201).send({ ok: true, entry });
    }
  );

  /**
   * PUT /memory/:id — Update an entry's value, confidence, tags, or add observation.
   */
  fastify.put<{ Params: MemoryParams; Body: UpdateMemoryBody }>(
    "/:id",
    async (request, reply) => {
      const projectRoot = ctx().config.projectRoot;
      const store = await ProjectMemoryStore.open(projectRoot, fastify.ctx.config.stateRoot);

      const updated = await store.updateEntry(request.params.id, request.body ?? {});
      store.close();

      if (!updated) {
        return reply.status(404).send({ ok: false, error: "Entry not found" });
      }

      return reply.send({ ok: true, entry: updated });
    }
  );

  /**
   * DELETE /memory/:id — Flag an entry as expired (soft-delete).
   * Optional query param: reason
   */
  fastify.delete<{ Params: MemoryParams; Querystring: { reason?: string } }>(
    "/:id",
    async (request, reply) => {
      const projectRoot = ctx().config.projectRoot;
      const store = await ProjectMemoryStore.open(projectRoot, fastify.ctx.config.stateRoot);

      const flagged = await store.flagExpired(request.params.id, request.query.reason);
      store.close();

      if (!flagged) {
        return reply.status(404).send({ ok: false, error: "Entry not found" });
      }

      return reply.send({ ok: true, entry: flagged });
    }
  );
};
