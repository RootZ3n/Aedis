/**
 * ModelInvoker — Unified model caller for all Aedis providers.
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
 *   - portum: OpenAI-compatible, http://localhost:18797/v1/chat/completions, no API key
 *   - local: mock response, zero cost
 *
 * Fallback chain:
 *   invokeModelWithFallback() walks a chain of InvokeConfigs, trying each
 *   in order. If a provider times out, it is added to the run's blacklist
 *   and never retried within the same run. Other errors fall through to
 *   the next chain entry without blacklisting (e.g. transient HTTP errors
 *   on a different provider may still be worth a future attempt).
 *
 *   After the caller-provided chain is exhausted, a final last-resort
 *   attempt is made against portum/qwen3.6-plus. Portum is the local
 *   OpenAI-compatible gateway at localhost:18797 — it serves as a universal
 *   safety net for every worker without each worker needing to know about
 *   it. The last-resort attempt is skipped if portum was already in the
 *   caller's chain or if it was blacklisted (timed out) earlier in the run.
 *
 * Default timeout: 5 minutes (300_000 ms). Builders sending large prompts
 * to slower providers were tripping the previous 2-minute cap. Workers
 * that need a tighter bound can pass an explicit timeoutMs.
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
  | "portum"
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

export interface FallbackInvokeResult extends InvokeResult {
  /** The provider that actually returned the result. */
  readonly usedProvider: Provider;
  /** The model that actually returned the result. */
  readonly usedModel: string;
  /** Every provider that was attempted, in order, including the one that succeeded. */
  readonly attemptedProviders: readonly Provider[];
  /** Whether at least one provider was skipped due to a prior timeout in the same run. */
  readonly skippedDueToBlacklist: boolean;
}

/**
 * Per-run state for fallback invocation. Holds the set of providers that
 * have timed out within the current run so they are never retried.
 *
 * Callers (Coordinator, BuilderWorker) own the lifecycle: create one per
 * run, pass it to every invokeModelWithFallback call within that run,
 * discard it when the run ends.
 */
export interface RunInvocationContext {
  readonly timedOutProviders: Set<Provider>;
}

export function createRunInvocationContext(): RunInvocationContext {
  return { timedOutProviders: new Set<Provider>() };
}

// ─── Last-resort fallback ────────────────────────────────────────────

/**
 * Universal last-resort entry appended after every caller-provided chain.
 * Portum is the local OpenAI-compatible gateway running on port 18797 and
 * has no API-key requirement, so it can be reached unconditionally as long
 * as the local service is up.
 */
const PORTUM_LAST_RESORT: { provider: Provider; model: string } = {
  provider: "portum",
  model: "qwen3.6-plus",
};

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
      case "portum":
        result = await invokeOpenAICompatible(
          "http://localhost:18797/v1",
          undefined,
          model, prompt, systemPrompt, maxTokens,
        );
        break;
      default:
        throw new InvokerError(`Unknown provider "${provider}"`, "config");
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

/**
 * Invoke a model with a fallback chain.
 *
 * Walks `chain` in order. For each entry:
 *   - If the provider is in `runContext.timedOutProviders`, skip it and log.
 *   - Otherwise call invokeModel(). On success, return immediately.
 *   - On InvokerError of kind "timeout": add provider to blacklist, continue.
 *   - On any other error: continue to next entry without blacklisting.
 *
 * After the caller-provided chain is fully exhausted, a final last-resort
 * attempt is made against portum/qwen3.6-plus (the local OpenAI-compatible
 * gateway). The last-resort is skipped if portum was already in the chain
 * (no point in double-attempting) or if portum is in the blacklist
 * (timed out earlier in this run). If every entry — including the
 * last-resort — fails, throws an aggregated InvokerError.
 *
 * The runContext is mutated in place — callers can pass the same context
 * across multiple invokeModelWithFallback calls within a single run, and
 * the timeout blacklist accumulates across the whole run.
 */
export async function invokeModelWithFallback(
  chain: readonly InvokeConfig[],
  runContext?: RunInvocationContext,
): Promise<FallbackInvokeResult> {
  if (chain.length === 0) {
    throw new InvokerError("invokeModelWithFallback: chain is empty", "config");
  }

  const ctx = runContext ?? createRunInvocationContext();
  const attemptedProviders: Provider[] = [];
  const errors: string[] = [];
  let skippedDueToBlacklist = false;

  for (const cfg of chain) {
    if (ctx.timedOutProviders.has(cfg.provider)) {
      console.warn(
        `[model-invoker] fallback: skipping ${cfg.provider}/${cfg.model} — provider is blacklisted (timed out earlier in this run)`
      );
      skippedDueToBlacklist = true;
      continue;
    }

    attemptedProviders.push(cfg.provider);
    console.log(`[model-invoker] fallback: attempting ${cfg.provider}/${cfg.model}`);

    try {
      const result = await invokeModel(cfg);
      console.log(`[model-invoker] fallback: ${cfg.provider}/${cfg.model} succeeded`);
      return {
        ...result,
        usedProvider: cfg.provider,
        usedModel: cfg.model,
        attemptedProviders,
        skippedDueToBlacklist,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const kind = err instanceof InvokerError ? err.kind : "unknown";
      errors.push(`${cfg.provider}/${cfg.model} (${kind}): ${msg}`);

      if (kind === "timeout") {
        console.warn(
          `[model-invoker] fallback: ${cfg.provider}/${cfg.model} TIMED OUT — blacklisting provider for the rest of this run`
        );
        ctx.timedOutProviders.add(cfg.provider);
      } else {
        console.warn(
          `[model-invoker] fallback: ${cfg.provider}/${cfg.model} failed (${kind}) — trying next in chain`
        );
      }
      // Continue to next chain entry
    }
  }

  // Snapshot how many of the original chain entries were tried vs. skipped
  // BEFORE we add Portum to attemptedProviders. The error message below
  // reports both numbers, and we don't want Portum's last-resort entry to
  // skew the chain-skip count.
  const chainEntriesAttempted = attemptedProviders.length;
  const chainEntriesSkipped = chain.length - chainEntriesAttempted;

  // ─── Last resort: Portum ──────────────────────────────────────────
  // Portum is the local OpenAI-compatible gateway at localhost:18797 and
  // requires no API key, so it can be reached unconditionally as long as
  // the local service is up. We try it once after the caller's chain is
  // exhausted — but only if Portum wasn't already in the chain (avoid
  // double-attempting) and isn't blacklisted from a prior timeout.
  const portumInChain = chain.some((cfg) => cfg.provider === PORTUM_LAST_RESORT.provider);
  const portumBlacklisted = ctx.timedOutProviders.has(PORTUM_LAST_RESORT.provider);

  if (!portumInChain && !portumBlacklisted) {
    // Inherit prompt/systemPrompt/maxTokens from the most recent chain
    // entry — in current usage every chain entry shares the same prompt,
    // and the last entry is the most recently constructed so it tends to
    // reflect any per-run adjustments.
    const template = chain[chain.length - 1]!;
    const portumCfg: InvokeConfig = {
      provider: PORTUM_LAST_RESORT.provider,
      model: PORTUM_LAST_RESORT.model,
      prompt: template.prompt,
      systemPrompt: template.systemPrompt,
      maxTokens: template.maxTokens,
    };

    attemptedProviders.push(PORTUM_LAST_RESORT.provider);
    console.log(
      `[model-invoker] fallback: chain exhausted — last-resort attempt ${PORTUM_LAST_RESORT.provider}/${PORTUM_LAST_RESORT.model}`
    );

    try {
      const result = await invokeModel(portumCfg);
      console.log(
        `[model-invoker] fallback: ${PORTUM_LAST_RESORT.provider}/${PORTUM_LAST_RESORT.model} succeeded as last resort`
      );
      return {
        ...result,
        usedProvider: PORTUM_LAST_RESORT.provider,
        usedModel: PORTUM_LAST_RESORT.model,
        attemptedProviders,
        skippedDueToBlacklist,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const kind = err instanceof InvokerError ? err.kind : "unknown";
      errors.push(`${PORTUM_LAST_RESORT.provider}/${PORTUM_LAST_RESORT.model} (${kind}): ${msg}`);
      if (kind === "timeout") {
        ctx.timedOutProviders.add(PORTUM_LAST_RESORT.provider);
      }
      console.warn(
        `[model-invoker] fallback: portum last-resort failed (${kind}) — giving up`
      );
    }
  } else if (portumInChain) {
    console.warn(
      "[model-invoker] fallback: chain exhausted — portum was already in caller chain, skipping last-resort"
    );
  } else {
    // portum is blacklisted from an earlier timeout
    console.warn(
      "[model-invoker] fallback: chain exhausted — portum is blacklisted (timed out earlier in this run), skipping last-resort"
    );
    skippedDueToBlacklist = true;
  }

  throw new InvokerError(
    `All fallback providers failed (${chainEntriesAttempted} chain entries attempted, ${chainEntriesSkipped} skipped via blacklist, plus portum last-resort): ${errors.join(" | ")}`,
    "unknown",
  );
}

// ─── Local (Mock) ────────────────────────────────────────────────────

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
    throw new InvokerError(
      `Ollama ${model}: ${res.status} ${await res.text().catch(() => "")}`,
      "http",
    );
  }

  const data = await res.json() as any;
  const text = data.message?.content ?? "";
  const tokensIn = data.prompt_eval_count ?? Math.ceil(prompt.length / 4);
  const tokensOut = data.eval_count ?? Math.ceil(text.length / 4);

  return { text, tokensIn, tokensOut, costUsd: estimateCost(model, tokensIn, tokensOut) };
}

// ─── OpenAI-Compatible (ModelStudio, OpenRouter, OpenAI, MiniMax, ZAI, Portum) ─

async function invokeOpenAICompatible(
  baseUrl: string,
  apiKey: string | undefined,
  model: string,
  prompt: string,
  systemPrompt?: string,
  maxTokens?: number,
): Promise<InvokeResult> {
  const messages: Array<{ role: string; content: string }> = [];
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  messages.push({ role: "user", content: prompt });

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const res = await fetchWithTimeout(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens ?? 4096,
      temperature: 0.2,
    }),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new InvokerError(
      `${model} via ${baseUrl}: ${res.status} ${res.statusText}\n${errBody}`,
      "http",
    );
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
    throw new InvokerError(
      `Anthropic ${model}: ${res.status} ${res.statusText}\n${errBody}`,
      "http",
    );
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
  if (!val) throw new InvokerError(`Missing environment variable: ${name}`, "config");
  return val;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number = 300_000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err: any) {
    if (err.name === "AbortError") {
      throw new InvokerError(`Request to ${url} timed out after ${timeoutMs}ms`, "timeout");
    }
    throw new InvokerError(`Network error calling ${url}: ${err.message ?? err}`, "network");
  } finally {
    clearTimeout(timer);
  }
}

// ─── Errors ──────────────────────────────────────────────────────────

export type InvokerErrorKind = "timeout" | "http" | "network" | "config" | "unknown";

export class InvokerError extends Error {
  readonly kind: InvokerErrorKind;
  constructor(message: string, kind: InvokerErrorKind = "unknown") {
    super(message);
    this.name = "InvokerError";
    this.kind = kind;
  }
}
