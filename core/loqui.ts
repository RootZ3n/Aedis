/**
 * Loqui — Aedis's conversational reasoning interface.
 *
 * Answers a free-form question about a repo by:
 *   1. loading the project memory at {projectRoot}/.aedis/memory.json
 *   2. gating the context against the question (keyword-relevance filter
 *      from core/context-gate.ts)
 *   3. building a single prompt that includes language, gated files, and
 *      the last three task summaries
 *   4. calling a local Ollama model (qwen3.6-plus, non-streaming) and
 *      returning the response text
 *
 * Designed to never throw. Any failure — empty question, missing memory,
 * Ollama unreachable, malformed JSON, model error — is converted into a
 * human-readable string so callers don't need defensive try/catch.
 */

import { gateContext, type GatedContext } from "./context-gate.js";
import { loadMemory, type TaskSummary } from "./project-memory.js";

const OLLAMA_URL = "http://localhost:11434/api/generate";
const MODEL = "qwen3.6-plus";
const REQUEST_TIMEOUT_MS = 120_000;

interface OllamaGenerateResponse {
  readonly response?: string;
  readonly error?: string;
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
    return await callOllama(prompt);
  } catch (err) {
    // Outer guard for anything not already caught downstream — guarantees
    // we never throw out of askLoqui regardless of how the call site uses it.
    return `Loqui: ${describe(err)}`;
  }
}

// ─── Internals ───────────────────────────────────────────────────────

function buildPrompt(
  question: string,
  gated: GatedContext,
  lastTasks: readonly TaskSummary[],
): string {
  const lines: string[] = [];
  lines.push("You are Loqui, the conversational reasoning interface for Aedis.");
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

async function callOllama(prompt: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(OLLAMA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, prompt, stream: false }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const detail = await safeReadBody(res);
      return `Loqui: model HTTP ${res.status}${detail ? ` — ${detail}` : ""}.`;
    }

    const raw = await res.text();
    let parsed: OllamaGenerateResponse;
    try {
      parsed = JSON.parse(raw) as OllamaGenerateResponse;
    } catch {
      return "Loqui: could not parse model response.";
    }

    if (parsed.error) return `Loqui: model error — ${parsed.error}`;

    const text = (parsed.response ?? "").trim();
    return text.length > 0 ? text : "Loqui: model returned an empty response.";
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
