/**
 * Loqui route — Metrics + External API Layer v1.
 *
 * GET /loqui?question=&repoPath= — lightweight query-string
 * variant of POST /tasks/loqui. Returns a grounded answer plus
 * the list of repo files the gated context layer flagged as
 * relevant to the question, and a rough confidence score so
 * callers can tell "I found context and got an answer" apart
 * from "I had no relevant context."
 *
 * Design principles:
 *
 *   1. Read-only. No coordinator calls, no writes, no side
 *      effects beyond what `askLoqui` already does (load memory,
 *      gate context, call the model).
 *   2. Grounded. Related files come from the same
 *      project-memory + gated-context path the Coordinator uses
 *      at plan time — so "what does Loqui think is relevant"
 *      matches "what Aedis would include in context if this were
 *      a real run."
 *   3. Thin handler. The underlying primitives are already
 *      exported; this route composes them.
 */

import { existsSync } from "node:fs";
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { answerLoqui } from "../../core/loqui.js";
import { routeLoquiInput } from "../../core/loqui-router.js";

interface LoquiQuery {
  question?: string;
  repoPath?: string;
}

export const loquiRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /loqui?question=&repoPath=
   *
   * Response shape:
   *   {
   *     answer: string,
   *     confidence: number,        // 0..1
   *     relatedFiles: string[],
   *     reason: string,            // one-line explanation of the score
   *   }
   */
  fastify.get<{ Querystring: LoquiQuery }>(
    "/",
    async (
      request: FastifyRequest<{ Querystring: LoquiQuery }>,
      reply: FastifyReply,
    ) => {
      const question = String(request.query.question ?? "").trim();
      const repoPath = String(request.query.repoPath ?? "").trim();

      if (!question) {
        reply.code(400).send({
          error: "Bad request",
          message: "The `question` query parameter is required.",
        });
        return;
      }
      if (!repoPath) {
        reply.code(400).send({
          error: "Bad request",
          message: "The `repoPath` query parameter is required.",
        });
        return;
      }
      if (!existsSync(repoPath)) {
        reply.code(400).send({
          error: "Bad request",
          message: `repoPath does not exist on this host: ${repoPath}`,
        });
        return;
      }

      const decision = routeLoquiInput({
        input: question,
        context: { projectRoot: repoPath },
      });
      if (decision.action === "build") {
        reply.code(409).send({
          error: "Build request sent to read-only Loqui endpoint",
          message: "This is an edit request. Submit it through /tasks or /tasks/loqui/unified so Aedis can run target discovery and approval.",
          route: "build",
          intent: decision.intent,
          confidence: decision.confidence,
          signals: [...decision.signals],
        });
        return;
      }
      if (decision.action === "clarify") {
        reply.send({
          answer: decision.clarification,
          confidence: decision.confidence,
          relatedFiles: [],
          reason: decision.reason,
          provider: null,
          route: "clarify",
        });
        return;
      }

      const result = await answerLoqui(question, repoPath, fastify.ctx.config.stateRoot);

      reply.send({
        answer: result.answer,
        confidence: result.confidence,
        relatedFiles: result.relatedFiles,
        reason: result.reason,
        provider: result.provider,
      });
    },
  );
};
