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
import { askLoqui } from "../../core/loqui.js";
import { loadMemory } from "../../core/project-memory.js";
import { gateContext } from "../../core/context-gate.js";

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

      // Collect the grounded signals FIRST — we want to be able
      // to report relatedFiles even if askLoqui itself falls back
      // to its "Loqui: …" error string path.
      let relatedFiles: string[] = [];
      let language = "unknown";
      try {
        const memory = await loadMemory(repoPath);
        const gated = gateContext(memory, question);
        language = gated.language;
        relatedFiles = [...gated.relevantFiles];
      } catch {
        // Memory missing or unreadable — relatedFiles stays empty
        // and the confidence score will reflect that below.
      }

      const answer = await askLoqui(question, repoPath);

      // Confidence heuristic: start at 0.4 as the "we produced an
      // answer" baseline, bump up when we found grounding files,
      // penalize when the answer is one of Loqui's built-in
      // error strings. Deliberately simple — callers that want
      // the grounded basis can read `reason`.
      const answerLooksErrored =
        answer.startsWith("Loqui:") &&
        (answer.includes("error") ||
          answer.includes("could not") ||
          answer.includes("HTTP") ||
          answer.includes("empty") ||
          answer.includes("not set"));

      let confidence = 0.4;
      const basis: string[] = ["base:0.40 for any produced answer"];
      if (relatedFiles.length > 0) {
        const boost = Math.min(0.4, 0.1 * relatedFiles.length);
        confidence += boost;
        basis.push(`grounding: +${boost.toFixed(2)} for ${relatedFiles.length} related file(s)`);
      } else {
        basis.push("grounding: no related files → no boost");
      }
      if (language !== "unknown") {
        confidence += 0.05;
        basis.push(`language known (${language}): +0.05`);
      }
      if (answerLooksErrored) {
        confidence = Math.max(0, confidence - 0.5);
        basis.push("error-looking answer: -0.50");
      }
      confidence = Math.min(1, Math.max(0, round2(confidence)));

      reply.send({
        answer,
        confidence,
        relatedFiles,
        reason: basis.join(" · "),
      });
    },
  );
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
