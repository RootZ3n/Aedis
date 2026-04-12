/**
 * Loqui Router — Unified Intent Routing v1.
 *
 * Takes a raw user utterance plus conversational context, runs it
 * through `classifyLoquiIntent`, and returns an inspectable
 * `LoquiRouteDecision` that tells the server which backend path to
 * invoke:
 *
 *   - "build"    → POST /tasks (Coordinator.submit, full pipeline)
 *   - "answer"   → POST /tasks/loqui (askLoqui, Q&A path)
 *   - "clarify"  → don't execute, return a question to the user
 *   - "resume"   → re-submit a prior prompt with a tighter-scope hint
 *                  (v1 scaffold — still goes through Coordinator.submit
 *                   but with a clearer framing in the rawInput)
 *
 * The router is the single authority on "should this hit the build
 * pipeline or not." The UI stops needing to guess, the old mode
 * toggle is gone, and every route decision is recorded so the user
 * can see *why* a given message went where it went.
 *
 * Design principles:
 *
 *   1. Pure function of intent + context. No side effects, no
 *      network, no storage. The HTTP handler owns dispatch.
 *
 *   2. Non-destructive by default. Any ambiguity sends the
 *      message to either `answer` or `clarify`, never to `build`.
 *
 *   3. The decision carries a rephrased prompt when appropriate.
 *      A dry-run request becomes "show the plan for X without
 *      changing anything" before it reaches the Q&A path, so
 *      Loqui knows to respond with a plan rather than attempting
 *      to execute.
 *
 *   4. Intent is inspectable in the response payload so the UI
 *      can render the intent badge ("Building", "Explaining",
 *      "Planning", etc.) directly from the router's decision.
 */

import { classifyLoquiIntent, type LoquiIntent, type LoquiIntentContext, type LoquiIntentDecision } from "./loqui-intent.js";

// ─── Types ───────────────────────────────────────────────────────────

export type LoquiRouteAction = "build" | "answer" | "clarify" | "resume";

/**
 * UI-facing labels for the intent badge. The classifier internal
 * names are intentionally separate from these display strings so a
 * refactor of the classifier does not force a UI change.
 */
export type LoquiIntentLabel =
  | "Building"
  | "Answering"
  | "Explaining"
  | "Planning"
  | "Dry Run"
  | "Checking Status"
  | "Resuming"
  | "Clarifying";

export interface LoquiRouteDecision {
  readonly action: LoquiRouteAction;
  readonly intent: LoquiIntent;
  readonly label: LoquiIntentLabel;
  /** Raw user input, trimmed. */
  readonly originalInput: string;
  /**
   * The prompt the router wants the backend to actually run. This
   * may be the same as `originalInput` (for a pure build) or a
   * reframed version (for dry-run, explain, resume) that tells the
   * Q&A path to answer in a specific mode.
   */
  readonly effectivePrompt: string;
  /** Short human reason — displayed in the UI tooltip / log. */
  readonly reason: string;
  /** 0–1 confidence forwarded from the classifier. */
  readonly confidence: number;
  /** Every rule that fired, for audit. */
  readonly signals: readonly string[];
  /**
   * When action === "clarify", the concise question Loqui should
   * ask the user. Always present when action is clarify, empty
   * otherwise.
   */
  readonly clarification: string;
}

export interface LoquiRouteInput {
  readonly input: string;
  readonly context?: LoquiIntentContext;
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Route a Loqui utterance. Returns a decision describing which
 * backend path to invoke and how to frame the prompt.
 */
export function routeLoquiInput(input: LoquiRouteInput): LoquiRouteDecision {
  const original = (input.input ?? "").trim();
  const classification = classifyLoquiIntent(original, input.context ?? {});
  return decisionFromClassification(original, classification);
}

/**
 * Map a classifier decision to a router decision. Exposed so the
 * server handler can classify once at the edge, log it, and then
 * share the same decision object across the dispatch and the
 * response payload.
 */
export function decisionFromClassification(
  original: string,
  classification: LoquiIntentDecision,
): LoquiRouteDecision {
  if (classification.needsClarification) {
    return {
      action: "clarify",
      intent: classification.intent,
      label: "Clarifying",
      originalInput: original,
      effectivePrompt: original,
      reason: classification.reason,
      confidence: classification.confidence,
      signals: classification.signals,
      clarification: classification.clarification,
    };
  }

  switch (classification.intent) {
    case "build":
      return {
        action: "build",
        intent: "build",
        label: "Building",
        originalInput: original,
        effectivePrompt: original,
        reason: classification.reason,
        confidence: classification.confidence,
        signals: classification.signals,
        clarification: "",
      };

    case "resume_run":
      return {
        action: "resume",
        intent: "resume_run",
        label: "Resuming",
        originalInput: original,
        // Reframe so the Coordinator / memory path sees an explicit
        // continuation. The server handler is responsible for
        // stapling the prior run's prompt onto this before calling
        // Coordinator.submit — see server/routes/tasks.ts.
        effectivePrompt: `Continuation of the prior run: ${original}`,
        reason: classification.reason,
        confidence: classification.confidence,
        signals: classification.signals,
        clarification: "",
      };

    case "dry_run":
      return {
        action: "answer",
        intent: "dry_run",
        label: "Dry Run",
        originalInput: original,
        effectivePrompt:
          `The user asked for a dry-run (no changes). Produce a concrete step-by-step plan ` +
          `for the request below, describing exactly which files you would touch and what ` +
          `changes you would make, without actually doing anything. Do not write any files. ` +
          `Request: ${original}`,
        reason: classification.reason,
        confidence: classification.confidence,
        signals: classification.signals,
        clarification: "",
      };

    case "plan":
      return {
        action: "answer",
        intent: "plan",
        label: "Planning",
        originalInput: original,
        effectivePrompt:
          `The user wants a proposed plan, not execution. Describe the approach you would ` +
          `take for this request in concrete steps, prioritized, with the first step you ` +
          `would tackle. Request: ${original}`,
        reason: classification.reason,
        confidence: classification.confidence,
        signals: classification.signals,
        clarification: "",
      };

    case "explain":
      return {
        action: "answer",
        intent: "explain",
        label: "Explaining",
        originalInput: original,
        effectivePrompt:
          `Explain the following in the context of this repository. Be concrete and ` +
          `reference specific files, functions, or decisions where possible. ` +
          `Request: ${original}`,
        reason: classification.reason,
        confidence: classification.confidence,
        signals: classification.signals,
        clarification: "",
      };

    case "status":
      return {
        action: "answer",
        intent: "status",
        label: "Checking Status",
        originalInput: original,
        effectivePrompt:
          `The user is asking about the state of a run or the repository. Use the recent ` +
          `task summaries to answer directly. If the answer depends on a specific run, ` +
          `name it and its verdict. Request: ${original}`,
        reason: classification.reason,
        confidence: classification.confidence,
        signals: classification.signals,
        clarification: "",
      };

    case "question":
      return {
        action: "answer",
        intent: "question",
        label: "Answering",
        originalInput: original,
        effectivePrompt: original,
        reason: classification.reason,
        confidence: classification.confidence,
        signals: classification.signals,
        clarification: "",
      };

    case "unknown":
    default:
      return {
        action: "clarify",
        intent: "unknown",
        label: "Clarifying",
        originalInput: original,
        effectivePrompt: original,
        reason: classification.reason,
        confidence: classification.confidence,
        signals: classification.signals,
        clarification:
          classification.clarification ||
          "I'm not sure what you want me to do — can you say whether you want me to build something, answer a question, or plan?",
      };
  }
}
