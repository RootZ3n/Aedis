/**
 * ModelInvoker — Unified model caller for all Zendorium providers.
 *
 * Reads API keys from process.env. Logs every call.
 *
 * Providers:
 *   - ollama: POST http://localhost:11434/api/chat
 *   - modelstudio: OpenAI-compatible, MODELSTUDIO_BASE_URL + MODELSTUDIO_API_KEY
 *   - openrouter: https://openrouter.ai/api/v1/chat/completions + OPENROUTER_API_KEY
 *   - anthropic: https://api.anthropic.com/v1/messages + ANTHROPIC_API_KEY
 *   - openai: https://api.openai.com/v1/chat/completions + OPENAI_API_KEY
 *   - minimax: MiniMax chat completions + MINIMAX_API_KEY
 *   - zai: OpenAI-compatible, ZAI_BASE_URL + ZAI_API_KEY
 *   - local: mock response, zero cost
 */

// ─── Types ───────────────────────────────────────────────────────────

export type Provider =
  | "ollama"
  | "modelstudio"
  | "openrouter"
  | "anthropic"
  | "openai"
  | "minimax"
  | "zai"
  | "local";

export interface InvokeConfig {
  provider: Provider;
  model: string;
  prompt: string;
  systemPrompt?: string;
  maxTokens?: number;
}

export interface InvokeResult {
  text: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

// ─── Cost Table (per 1K tokens) ──────────────────────────────────────

const COST_PER_1K: Record<string, { input: number; output: number }> = {
  // Ollama — local, free
  "local":            { input: 0,      output: 0      },
  "qwen3.5:4b":      { input: 0,      output: 0      },
  "qwen3.5:9b":      { input: 0,      output: 0      },
  // ModelStudio
  "qwen3.6-plus":    { input: 0.0008, output: 0.002  },
  "glm-4":           { input: 0.001,  output: 0.002  },
  // OpenRouter
  "xiaomi/mimo-v2-pro": { input: 0.0005, output: 0.0015 },
  // Anthropic
  "claude-opus-4-6":   { input: 0.015,  output: 0.075  },
  "claude-sonnet-4-6": { input: 0.003,  output: 0.015  },
  // OpenAI
  "gpt-4o":          { input: 0.0025, output: 0.01   },
  "gpt-5.4":         { input: 0.005,  output: 0.015  },
  // MiniMax
  "minimax-coding":  { input: 0.0004, output: 0.0016 },
  // ZAI
  "glm-5.1":        { input: 0.002,  output: 0.006  },
};

function estimateCost(model: string, tokensIn: number, tokensOut: number): number {
  const rates = COST_PER_1K[model] ?? { input: 0.001, output: 0.003 };
  return Number(((tokensIn / 1000) * rates.input + (tokensOut / 1000) * rates.output).toFixed(6));
}

// ─── Call Log ────────────────────────────────────────────────────────

export interface CallLogEntry {
  timestamp: string;
  provider: Provider;
  model: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  durationMs: number;
  error?: string;
}

const callLog: CallLogEntry[] = [];

export function getCallLog(): readonly CallLogEntry[] {
  return callLog;
}

export function getCallLogSummary(): { totalCalls: number; totalCostUsd: number; totalTokensIn: number; totalTokensOut: number } {
  return {
    totalCalls: callLog.length,
    totalCostUsd: Number(callLog.reduce((sum, e) => sum + e.costUsd, 0).toFixed(6)),
    totalTokensIn: callLog.reduce((sum, e) => sum + e.tokensIn, 0),
    totalTokensOut: callLog.reduce((sum, e) => sum + e.tokensOut, 0),
  };
}

function logCall(entry: CallLogEntry): void {
  callLog.push(entry);
  // Keep last 500 entries
  if (callLog.length > 500) callLog.shift();
  console.log(
    `[model-invoker] ${entry.provider}/${entry.model} — ${entry.tokensIn}in/${entry.tokensOut}out — $${entry.costUsd.toFixed(6)} — ${entry.durationMs}ms${entry.error ? ` — ERROR: ${entry.error}` : ""}`
  );
}

// ─── Main Entry Point ────────────────────────────────────────────────

export async function invokeModel(config: InvokeConfig): Promise<InvokeResult> {
  const { provider, model, prompt, systemPrompt, maxTokens } = config;
  const startMs = Date.now();

  try {
    let result: InvokeResult;

    switch (provider) {
      case "local":
        result = invokeLocal(prompt);
        break;
      case "ollama":
        result = await invokeOllama(model, prompt, systemPrompt, maxTokens);
        break;
      case "modelstudio":
        result = await invokeOpenAICompatible(
          process.env.MODELSTUDIO_BASE_URL ?? "https://dashscope.aliyuncs.com/compatible-mode/v1",
          requireEnv("MODELSTUDIO_API_KEY"),
          model, prompt, systemPrompt, maxTokens,
        );
        break;
      case "openrouter":
        result = await invokeOpenAICompatible(
          "https://openrouter.ai/api/v1",
          requireEnv("OPENROUTER_API_KEY"),
          model, prompt, systemPrompt, maxTokens,
        );
        break;
      case "anthropic":
        result = await invokeAnthropic(
          requireEnv("ANTHROPIC_API_KEY"),
          model, prompt, systemPrompt, maxTokens,
        );
        break;
      case "openai":
        result = await invokeOpenAICompatible(
          process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
          requireEnv("OPENAI_API_KEY"),
          model, prompt, systemPrompt, maxTokens,
        );
        break;
      case "minimax":
        result = await invokeOpenAICompatible(
          process.env.MINIMAX_BASE_URL ?? "https://api.minimax.chat/v1",
          requireEnv("MINIMAX_API_KEY"),
          model, prompt, systemPrompt, maxTokens,
        );
        break;
      case "zai":
        result = await invokeOpenAICompatible(
          process.env.ZAI_BASE_URL ?? "https://api.z.ai/api/paas/v4/",
          requireEnv("ZAI_API_KEY"),
          model, prompt, systemPrompt, maxTokens,
        );
        break;
      default:
        throw new InvokerError(`Unknown provider "${provider}"`);
    }

    logCall({
      timestamp: new Date().toISOString(),
      provider, model,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      costUsd: result.costUsd,
      durationMs: Date.now() - startMs,
    });

    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logCall({
      timestamp: new Date().toISOString(),
      provider, model,
      tokensIn: 0, tokensOut: 0, costUsd: 0,
      durationMs: Date.now() - startMs,
      error: msg,
    });
    throw err;
  }
}

// ─── Local (Mock) ─────────────────────────────────────��──────────────

function invokeLocal(prompt: string): InvokeResult {
  return {
    text: `[local] Acknowledged (${prompt.length} chars). No model call.`,
    tokensIn: Math.ceil(prompt.length / 4),
    tokensOut: 16,
    costUsd: 0,
  };
}

// ─── Ollama ──────────────────────────────────────────────────────────

async function invokeOllama(
  model: string,
  prompt: string,
  systemPrompt?: string,
  _maxTokens?: number,
): Promise<InvokeResult> {
  const base = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";

  const messages: Array<{ role: string; content: string }> = [];
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  messages.push({ role: "user", content: prompt });

  const res = await fetchWithTimeout(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, stream: false }),
  });

  if (!res.ok) {
    throw new InvokerError(`Ollama ${model}: ${res.status} ${await res.text().catch(() => "")}`);
  }

  const data = await res.json() as any;
  const text = data.message?.content ?? "";
  const tokensIn = data.prompt_eval_count ?? Math.ceil(prompt.length / 4);
  const tokensOut = data.eval_count ?? Math.ceil(text.length / 4);

  return { text, tokensIn, tokensOut, costUsd: estimateCost(model, tokensIn, tokensOut) };
}

// ─── OpenAI-Compatible (ModelStudio, OpenRouter, OpenAI, MiniMax, ZAI) ─

async function invokeOpenAICompatible(
  baseUrl: string,
  apiKey: string,
  model: string,
  prompt: string,
  systemPrompt?: string,
  maxTokens?: number,
): Promise<InvokeResult> {
  const messages: Array<{ role: string; content: string }> = [];
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  messages.push({ role: "user", content: prompt });

  const res = await fetchWithTimeout(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens ?? 4096,
      temperature: 0.2,
    }),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new InvokerError(`${model} via ${baseUrl}: ${res.status} ${res.statusText}\n${errBody}`);
  }

  const data = await res.json() as any;
  const text = data.choices?.[0]?.message?.content ?? "";
  const usage = data.usage ?? {};
  const tokensIn = usage.prompt_tokens ?? Math.ceil(prompt.length / 4);
  const tokensOut = usage.completion_tokens ?? Math.ceil(text.length / 4);

  return { text, tokensIn, tokensOut, costUsd: estimateCost(model, tokensIn, tokensOut) };
}

// ─── Anthropic ───────────────────────────────────────────────────────

async function invokeAnthropic(
  apiKey: string,
  model: string,
  prompt: string,
  systemPrompt?: string,
  maxTokens?: number,
): Promise<InvokeResult> {
  const body: Record<string, unknown> = {
    model,
    max_tokens: maxTokens ?? 4096,
    messages: [{ role: "user", content: prompt }],
  };
  if (systemPrompt) body.system = systemPrompt;

  const res = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new InvokerError(`Anthropic ${model}: ${res.status} ${res.statusText}\n${errBody}`);
  }

  const data = await res.json() as any;
  const text = (data.content ?? [])
    .filter((block: any) => block.type === "text")
    .map((block: any) => block.text)
    .join("");
  const tokensIn = data.usage?.input_tokens ?? Math.ceil(prompt.length / 4);
  const tokensOut = data.usage?.output_tokens ?? Math.ceil(text.length / 4);

  return { text, tokensIn, tokensOut, costUsd: estimateCost(model, tokensIn, tokensOut) };
}

// ─── Helpers ─────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new InvokerError(`Missing environment variable: ${name}`);
  return val;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number = 120_000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err: any) {
    if (err.name === "AbortError") {
      throw new InvokerError(`Request to ${url} timed out after ${timeoutMs}ms`);
    }
    throw new InvokerError(`Network error calling ${url}: ${err.message ?? err}`);
  } finally {
    clearTimeout(timer);
  }
}

// ─── Errors ──────────────────────────────────────────────────────────

export class InvokerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvokerError";
  }
}
