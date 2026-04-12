/**
 * Loqui — Aedis's conversational reasoning interface.
 *
 * Answers a free-form question about a repo by:
 *   1. loading the project memory at {projectRoot}/.aedis/memory.json
 *   2. gating the context against the question (keyword-relevance filter
 *      from core/context-gate.ts)
 *   3. building a single prompt that includes language, gated files, and
 *      the last three task summaries
 *   4. calling OpenRouter (xiaomi/mimo-v2-pro) and returning the response text
 *
 * Designed to never throw. Any failure — empty question, missing memory,
 * network unreachable, malformed JSON, model error — is converted into a
 * human-readable string so callers don't need defensive try/catch.
 */

import { gateContext, type GatedContext } from "./context-gate.js";
import { loadMemory, type TaskSummary } from "./project-memory.js";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MODEL = "xiaomi/mimo-v2-pro";
const REQUEST_TIMEOUT_MS = 120_000;

interface OpenRouterMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

// ─── Public API ──────────────────────────────────────────────────────

export async function askLoqui(
  question: string,
  projectRoot: string,
): Promise<string> {
  try {
    const trimmed = (question ?? "").trim();
    if (!trimmed) return "Loqui: please ask a question.";

    const memory = await loadMemory(projectRoot);
    const gated = gateContext(memory, trimmed);
    const lastTasks = memory.recentTasks.slice(0, 3);
    const prompt = buildPrompt(trimmed, gated, lastTasks);
    return await callOpenRouter(prompt);
  } catch (err) {
    return `Loqui: ${describe(err)}`;
  }
}

// ─── Internals ──────────────────────────────────────────────────────

function buildPrompt(
  question: string,
  gated: GatedContext,
  lastTasks: readonly TaskSummary[],
): string {
  const lines: string[] = [];
  lines.push("Answer the user's question about this repo using only the context below. Be concise and concrete. If the context is insufficient, say so.");
  lines.push("");
  lines.push(`Repo language: ${gated.language || "unknown"}`);
  lines.push("");

  if (gated.relevantFiles.length > 0) {
    lines.push("Relevant files (filtered from recent activity):");
    for (const file of gated.relevantFiles) {
      lines.push(`  - ${file}`);
    }
  } else {
    lines.push("Relevant files: (none flagged for this question)");
  }
  lines.push("");

  if (lastTasks.length > 0) {
    lines.push("Last task summaries:");
    for (const task of lastTasks) {
      const sha = task.commitSha ? task.commitSha.slice(0, 8) : "no commit";
      const cost = Number.isFinite(task.cost) ? `$${task.cost.toFixed(4)}` : "$?";
      const promptLine = task.prompt.length > 120
        ? `${task.prompt.slice(0, 117)}...`
        : task.prompt;
      lines.push(`  - [${task.verdict}] ${promptLine} (${sha}, ${cost}, ${task.timestamp})`);
    }
  } else {
    lines.push("Last task summaries: (no history yet)");
  }
  lines.push("");
  lines.push(`Question: ${question}`);
  lines.push("");
  lines.push("Answer:");

  return lines.join("\n");
}

async function callOpenRouter(prompt: string): Promise<string> {
  const apiKey = process.env["OPENROUTER_API_KEY"];
  if (!apiKey) return "Loqui: OPENROUTER_API_KEY is not set in environment.";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const messages: OpenRouterMessage[] = [
      {
        role: "system",
        content: "You are Loqui, the conversational reasoning interface for Aedis. Answer concisely and concretely.",
      },
      { role: "user", content: prompt },
    ];

    const res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        stream: false,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const detail = await safeReadBody(res);
      return `Loqui: OpenRouter HTTP ${res.status}${detail ? ` — ${detail}` : ""}.`;
    }

    const raw = await res.text();
    let parsed: { choices?: Array<{ message?: { content?: string } }> };
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch {
      return "Loqui: could not parse OpenRouter response.";
    }

    const choice = parsed.choices?.[0];
    const content = choice?.message?.content ?? "";
    return content.trim().length > 0
      ? content.trim()
      : "Loqui: model returned an empty response.";
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return `Loqui: model call timed out after ${Math.round(REQUEST_TIMEOUT_MS / 1000)}s.`;
    }
    return `Loqui: model call failed — ${describe(err)}.`;
  } finally {
    clearTimeout(timer);
  }
}

async function safeReadBody(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.slice(0, 200);
  } catch {
    return "";
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}