/**
 * Session routes — Create and manage autonomous build sessions.
 *
 * GET    /sessions               — List all sessions (admin/debug)
 * POST   /sessions              — Create a new session
 * GET    /sessions/:id          — Get session state
 * POST   /sessions/:id/cycles   — Trigger one additional cycle
 * DELETE /sessions/:id          — Cancel a session
 * GET    /sessions/:id/receipts — List receipts
 */

import { randomUUID } from "crypto";
import type { FastifyPluginAsync } from "fastify";
import { type ServerContext } from "../index.js";
import { type AedisSession, type CycleResult } from "../../types/session.js";
import {
  createSession,
  loadSession,
  saveSession,
  transitionSession,
  listAllSessions,
} from "../../core/session-store.js";
import { runSession, runOneMoreCycle, startCleanupTimer } from "../../core/session-coordinator.js";

// ─── Request schemas ────────────────────────────────────────────────

interface CreateSessionBody {
  task: string;           // natural language task intent
  projectRoot: string;   // path to the project
  maxCycles?: number;    // optional override (default: 3)
  maxDurationMs?: number; // optional duration override (default: 30min)
  goal?: string;         // optional goal description
  model?: string;        // optional model override
  constraints?: Record<string, string>;
}

interface SessionParams {
  id: string;
}

// ─── Routes ──────────────────────────────────────────────────────────

export const sessionRoutes: FastifyPluginAsync = async (fastify) => {
  const ctx = (): ServerContext => fastify.ctx;

  // Start cleanup timer on first registration
  startCleanupTimer(ctx().coordinator);

  /**
   * GET /sessions — List all sessions with status + cycleCount.
   * For debugging and admin use.
   */
  fastify.get(
    "/",
    async (request, reply) => {
      const all = await listAllSessions();
      return reply.send({
        ok: true,
        sessions: all.map(s => ({
          id: s.id,
          status: s.status,
          cycleCount: s.cycleCount,
          maxCycles: s.maxCycles,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          intent: {
            userRequest: s.intent.userRequest,
            projectRoot: s.intent.projectRoot,
          },
          terminalReason: s.terminalReason,
        })),
        total: all.length,
      });
    }
  );

  /**
   * POST /sessions — Create a new autonomous session.
   *
   * Creates the session and immediately starts running cycles.
   * Returns the session state after all cycles complete (terminal state).
   */
  fastify.post<{ Body: CreateSessionBody }>(
    "/",
    async (request, reply) => {
      const { task, projectRoot, maxCycles, maxDurationMs, goal, model, constraints } = request.body ?? {};

      if (!task || !projectRoot) {
        return reply.status(400).send({
          ok: false,
          error: "Missing required fields: task and projectRoot are required",
        });
      }

      const session = await runSession({
        coordinator: ctx().coordinator,
        intent: {
          userRequest: task,
          goal: goal ?? task,
          projectRoot,
          model,
          constraints,
        },
        maxCycles: maxCycles ?? 3,
        maxDurationMs: maxDurationMs ?? 30 * 60 * 1000,
      });

      return reply.send({ ok: true, session });
    }
  );

  /**
   * GET /sessions/:id — Get the current state of a session.
   */
  fastify.get<{ Params: SessionParams }>(
    "/:id",
    async (request, reply) => {
      const session = await loadSession(request.params.id);
      if (!session) {
        return reply.status(404).send({ ok: false, error: "Session not found" });
      }
      return reply.send({ ok: true, session });
    }
  );

  /**
   * POST /sessions/:id/cycles — Trigger ONE additional cycle on an existing session.
   *
   * Does NOT start fresh. Runs a single additional cycle using the session's
   * current state and carries forward the last error's hint as context.
   */
  fastify.post<{ Params: SessionParams }>(
    "/:id/cycles",
    async (request, reply) => {
      const session = await loadSession(request.params.id);
      if (!session) {
        return reply.status(404).send({ ok: false, error: "Session not found" });
      }
      if (session.status !== "active") {
        return reply.status(409).send({
          ok: false,
          error: `Session is not active (status=${session.status})`,
        });
      }

      const updated = await runOneMoreCycle(request.params.id, ctx().coordinator);
      return reply.send({ ok: true, session: updated });
    }
  );

  /**
   * DELETE /sessions/:id — Cancel a running session.
   */
  fastify.delete<{ Params: SessionParams }>(
    "/:id",
    async (request, reply) => {
      const existing = await loadSession(request.params.id);
      if (!existing) {
        return reply.status(404).send({ ok: false, error: "Session not found" });
      }
      if (existing.status !== "active") {
        return reply.status(409).send({
          ok: false,
          error: `Session is already ${existing.status}`,
        });
      }
      const updated = await transitionSession(request.params.id, "cancelled", "User cancelled");
      return reply.send({ ok: true, session: updated });
    }
  );

  /**
   * GET /sessions/:id/receipts — List all cycle receipts for a session.
   */
  fastify.get<{ Params: SessionParams }>(
    "/:id/receipts",
    async (request, reply) => {
      const session = await loadSession(request.params.id);
      if (!session) {
        return reply.status(404).send({ ok: false, error: "Session not found" });
      }
      return reply.send({
        ok: true,
        receipts: session.cycleHistory.map((cycle, idx) => ({
          cycleNumber: cycle.cycleNumber,
          outcome: cycle.outcome,
          action: cycle.action,
          startedAt: cycle.startedAt,
          completedAt: cycle.completedAt,
          artifactsProduced: cycle.artifactsProduced,
          artifactsVerified: cycle.artifactsVerified,
          error: cycle.error ?? undefined,
          learnedFrom: cycle.learnedFrom,
          nextCycleHint: cycle.nextCycleHint,
          verificationResult: cycle.verificationResult ?? undefined,
        })),
      });
    }
  );
};