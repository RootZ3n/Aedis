import { gateContext, type GatedContext } from "./context-gate.js";
import { buildGroundedRepoContext, type GroundedRepoContext } from "./loqui-grounding.js";
import { loadMemory, type TaskSummary } from "./project-memory.js";

const REQUEST_TIMEOUT_MS = 120_000;

interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

interface LoquiProvider {
  readonly name: string;
  readonly model: string;
  readonly url: string;
  readonly apiKeyEnv: string;
  readonly headers?: Record<string, string>;
}

export interface LoquiAnswer {
  readonly answer: string;
  readonly confidence: number;
  readonly relatedFiles: readonly string[];
  readonly reason: string;
  readonly provider: string | null;
}

const PROVIDERS: readonly LoquiProvider[] = [
  {
    name: "openrouter",
    model: process.env["LOQUI_OPENROUTER_MODEL"] ?? "xiaomi/mimo-v2-pro",
    url: "https://openrouter.ai/api/v1/chat/completions",
    apiKeyEnv: "OPENROUTER_API_KEY",
  },
  {
    name: "openai",
    model: process.env["LOQUI_OPENAI_MODEL"] ?? "gpt-4.1-mini",
    url: "https://api.openai.com/v1/chat/completions",
    apiKeyEnv: "OPENAI_API_KEY",
  },
];

export async function askLoqui(
  question: string,
  projectRoot: string,
): Promise<string> {
  const result = await answerLoqui(question, projectRoot);
  return result.answer;
}

export async function answerLoqui(
  question: string,
  projectRoot: string,
  stateRoot?: string,
): Promise<LoquiAnswer> {
  const trimmed = (question ?? "").trim();
  if (!trimmed) {
    return {
      answer: "Please ask a concrete repo question.",
      confidence: 0,
      relatedFiles: [],
      reason: "empty question",
      provider: null,
    };
  }

  const grounding = await buildGroundedRepoContext(trimmed, projectRoot, stateRoot);
  const { gated, lastTasks } = await loadSupplementalMemory(trimmed, projectRoot, stateRoot);
  const prompt = buildPrompt(trimmed, grounding, gated, lastTasks);
  const providerResult = await callProviderChain(prompt);

  if (providerResult.answer) {
    return {
      answer: providerResult.answer,
      confidence: estimateConfidence(providerResult.provider, grounding),
      relatedFiles: grounding.relatedFiles,
      reason: `${grounding.reason} · provider ${providerResult.provider}`,
      provider: providerResult.provider,
    };
  }

  return {
    answer: buildSafeFailureAnswer(grounding),
    confidence: grounding.relatedFiles.length > 0 ? 0.42 : 0.2,
    relatedFiles: grounding.relatedFiles,
    reason: `${grounding.reason} · model providers unavailable`,
    provider: null,
  };
}

async function loadSupplementalMemory(
  question: string,
  projectRoot: string,
  stateRoot?: string,
): Promise<{ gated: GatedContext | null; lastTasks: readonly TaskSummary[] }> {
  try {
    const memory = await loadMemory(projectRoot, stateRoot);
    return {
      gated: gateContext(memory, question),
      lastTasks: memory.recentTasks.slice(0, 3),
    };
  } catch {
    return { gated: null, lastTasks: [] };
  }
}

function buildPrompt(
  question: string,
  grounding: GroundedRepoContext,
  gated: GatedContext | null,
  lastTasks: readonly TaskSummary[],
): string {
  const lines: string[] = [];
  lines.push("Answer the user's repo question using the actual code context below.");
  lines.push("Prefer grounded file evidence over assumptions. If context is insufficient, say what is missing.");
  lines.push("");
  lines.push(`Question: ${question}`);
  lines.push("");

  lines.push(`Repo index: ${grounding.repoIndex ? `${grounding.repoIndex.files.length} indexed files` : "unavailable"}`);
  lines.push(`Supplemental memory language: ${gated?.language ?? "unknown"}`);
  lines.push("");

  if (grounding.relatedFiles.length > 0) {
    lines.push("Related files:");
    for (const file of grounding.relatedFiles) lines.push(`- ${file}`);
    lines.push("");
  }

  if (grounding.searchHits.length > 0) {
    lines.push("Search hits:");
    for (const hit of grounding.searchHits.slice(0, 8)) {
      lines.push(`- ${hit.path}:${hit.line} ${hit.text}`);
    }
    lines.push("");
  }

  if (grounding.snippets.length > 0) {
    lines.push("Code snippets:");
    for (const snippet of grounding.snippets.slice(0, 4)) {
      lines.push(`FILE ${snippet.path} (${snippet.reason})`);
      lines.push("```");
      lines.push(snippet.content);
      lines.push("```");
    }
    lines.push("");
  }

  if (gated?.relevantFiles?.length) {
    lines.push("Supplemental memory hints:");
    for (const file of gated.relevantFiles.slice(0, 6)) {
      if (!grounding.relatedFiles.includes(file)) {
        lines.push(`- ${file}`);
      }
    }
    lines.push("");
  }

  if (lastTasks.length > 0) {
    lines.push("Recent Aedis task history (supplemental):");
    for (const task of lastTasks) {
      lines.push(`- [${task.verdict}] ${task.prompt.slice(0, 140)}`);
    }
    lines.push("");
  }

  lines.push("Answer:");
  return lines.join("\n");
}

async function callProviderChain(prompt: string): Promise<{ answer: string | null; provider: string | null }> {
  for (const provider of PROVIDERS) {
    const apiKey = process.env[provider.apiKeyEnv];
    if (!apiKey) continue;
    const answer = await callProvider(provider, apiKey, prompt);
    if (answer) {
      return { answer, provider: provider.name };
    }
  }
  return { answer: null, provider: null };
}

async function callProvider(
  provider: LoquiProvider,
  apiKey: string,
  prompt: string,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(provider.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        ...(provider.headers ?? {}),
      },
      body: JSON.stringify({
        model: provider.model,
        messages: [
          {
            role: "system",
            content: "You are Loqui, Aedis's grounded repo reasoning assistant. Be concise, concrete, and cite files when possible.",
          } satisfies ChatMessage,
          { role: "user", content: prompt } satisfies ChatMessage,
        ],
        stream: false,
      }),
      signal: controller.signal,
    });

    if (!res.ok) return null;
    const parsed = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = parsed.choices?.[0]?.message?.content?.trim() ?? "";
    return content || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function buildSafeFailureAnswer(grounding: GroundedRepoContext): string {
  const files = grounding.relatedFiles.length > 0
    ? grounding.relatedFiles.slice(0, 4).join(", ")
    : "no strong file matches";
  const hits = grounding.searchHits.length > 0
    ? grounding.searchHits.slice(0, 3).map((hit) => `${hit.path}:${hit.line}`).join(", ")
    : "no direct search hits";
  return `I couldn't reach a language provider right now. Grounded repo context is still available: related files ${files}; search hits ${hits}.`;
}

function estimateConfidence(provider: string | null, grounding: GroundedRepoContext): number {
  let score = provider ? 0.45 : 0.2;
  if (grounding.repoIndex) score += 0.15;
  if (grounding.relatedFiles.length > 0) score += Math.min(0.2, grounding.relatedFiles.length * 0.04);
  if (grounding.searchHits.length > 0) score += Math.min(0.2, grounding.searchHits.length * 0.03);
  return Math.min(1, Math.round(score * 100) / 100);
}
