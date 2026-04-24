/**
 * ModelInvoker — Unified model caller for all Aedis providers.
 *
 * OpenRouter hardening features added 2026-04-24:
 *   - Cross-run circuit breaker: persisted to .aedis/circuit-breaker-state.json
 *   - 429 / Retry-After handling with exponential backoff
 *   - Transient HTTP retry (502, 503, 504) with backoff
 *   - OpenRouter-specific headers (HTTP-Referer, X-Title)
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
 *   - glm-5.1-openrouter: GLM-5.1 via OpenRouter (z-ai/glm-5.1) + OPENROUTER_API_KEY
 *   - glm-5.1-direct: GLM-5.1 via ZAI direct (open.bigmodel.cn) + ZAI_API_KEY
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
 *   Circuit breaker state (cross-run) is checked before every call:
 *   providers that have failed >5 times in the last 15 minutes are skipped
 *   entirely until the cooling period expires.
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
  | "glm-5.1-openrouter"
  | "glm-5.1-direct"
  | "portum"
  | "local";

export interface InvokeConfig {
  provider: Provider;
  model: string;
  prompt: string;
  systemPrompt?: string;
  maxTokens?: number;
  /** Run ID threaded through to the call log for scoped cost aggregation. */
  runId?: string;
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
  /** Whether a circuit-breaker skip occurred. */
  readonly skippedDueToCircuitBreaker: boolean;
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
  /** Number of confidence-based escalations performed in this run. */
  escalationCount: number;
  /** Providers skipped this run due to circuit breaker. */
  circuitBreakerSkips: Set<Provider>;
}

export function createRunInvocationContext(): RunInvocationContext {
  return { timedOutProviders: new Set<Provider>(), escalationCount: 0, circuitBreakerSkips: new Set<Provider>() };
}

// ─── Circuit Breaker ─────────────────────────────────────────────────

const CIRCUIT_BREAKER_PATH = ".aedis/circuit-breaker-state.json";

interface CircuitBreakerEntry {
  failures: number;        // consecutive failures for this provider
  lastFailure: number;     // unix ms timestamp of last failure
}

interface CircuitBreakerState {
  providers: Record<string, CircuitBreakerEntry>;
}

const CB_MAX_FAILURES = 5;           // trips after this many consecutive failures
const CB_COOLING_MS   = 15 * 60 * 1000; // 15-minute cooling period
const CB_HALF_LIFE_MS = 5 * 60 * 1000;  // exponential decay window

function readCircuitBreaker(): CircuitBreakerState {
  try {
    const raw = Deno.readFileSync(CIRCUIT_BREAKER_PATH);
    return JSON.parse(new TextDecoder().decode(raw)) as CircuitBreakerState;
  } catch {
    return { providers: {} };
  }
}

function writeCircuitBreaker(state: CircuitBreakerState): void {
  // Runs in Node.js (aiofs unavailable), use sync fs
  const { writeFileSync, mkdirSync } = require("fs");
  try { mkdirSync(".aedis", { recursive: true }); } catch { /* already exists */ }
  writeFileSync(CIRCUIT_BREAKER_PATH, JSON.stringify(state, null, 2));
}

/**
 * Decay function: each past failure "counts less" as time passes,
 * preventing a single bad window from blocking a provider forever.
 * Returns a score from 0 (fresh failure) to 1 (ancient/irrelevant).
 */
function cbFailureScore(entry: CircuitBreakerEntry): number {
  const age = Date.now() - entry.lastFailure;
  if (age >= CB_COOLING_MS) return 1; // fully decayed, treat as recovered
  return Math.pow(0.5, age / CB_HALF_LIFE_MS);
}

function isProviderCircuitOpen(provider: Provider, state: CircuitBreakerState): boolean {
  const entry = state.providers[provider];
  if (!entry) return false;

  // Decay-based scoring: multiply consecutive failures by time-decayed weight
  const score = entry.failures * (1 - cbFailureScore(entry));
  return score >= CB_MAX_FAILURES;
}

function recordProviderFailure(provider: Provider, state: CircuitBreakerState): void {
  const existing = state.providers[provider];
  if (existing) {
    existing.failures += 1;
    existing.lastFailure = Date.now();
  } else {
    state.providers[provider] = { failures: 1, lastFailure: Date.now() };
  }
  writeCircuitBreaker(state);
}

function recordProviderSuccess(provider: Provider, state: CircuitBreakerState): void {
  // On success, reset failure count for this provider
  if (state.providers[provider]) {
    delete state.providers[provider];
    writeCircuitBreaker(state);
  }
}

// ─── Last-resort fallback ────────────────────────────────────────────

const PORTUM_LAST_RESORT: { provider: Provider; model: string } = {
  provider: "portum",
  model: "qwen3.6-plus",
};

// ─── Cost Table (per 1K tokens) ──────────────────────────────────────

const COST_PER_1K: Record<string, { input: number; output: number }> = {
  // Ollama — local, free
  "local":            { input: 0,      output: 0      },
  "qwen3.5:4b":       { input: 0,      output: 0      },
  "qwen3.5:9b":       { input: 0,      output: 0      },
  // ModelStudio
  "qwen3.6-plus":     { input: 0.0008, output: 0.002  },
  "glm-4":            { input: 0.001,  output: 0.002  },
  // OpenRouter
  "xiaomi/mimo-v2.5": { input: 0.001,  output: 0.002  },
  "xiaomi/mimo-v2.5-pro": { input: 0.002, output: 0.004 },
  // Anthropic
  "claude-opus-4-6":  { input: 0.015,  output: 0.075  },
  "claude-sonnet-4-6": { input: 0.003, output: 0.015 },
  // OpenAI
  "gpt-4o":           { input: 0.0025, output: 0.01   },
  "gpt-5.4":          { input: 0.005,  output: 0.015  },
  // MiniMax
  "minimax-coding":   { input: 0.0004, output: 0.0016 },
  // ZAI
  "glm-5.1":          { input: 0.002,  output: 0.006  },
  // GLM-5.1 via OpenRouter ($0.95/M in, $3.15/M out)
  "z-ai/glm-5.1":     { input: 0.00095, output: 0.00315 },
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
  /** Run ID for scoped cost aggregation. */
  runId?: string;
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

// ─── Retry / Backoff ────────────────────────────────────────────────

/** HTTP status codes that represent transient errors — retry with backoff. */
const RETRYABLE_HTTP_STATUS = new Set([429, 502, 503, 504]);

/** Network errors that are transient and worth retrying. */
const RETRYABLE_NETWORK_ERRORS = new Set([
  "ECONNRESET", "ETIMEDOUT", "ENETUNREACH", "EHOSTUNREACH",
  "ECONNREFUSED", "EAGAIN", "EPIPE",
]);

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BASE_DELAY_MS = 1000; // 1 second
const DEFAULT_MAX_DELAY_MS = 32_000; // 32 seconds

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRetryDelay(attempt: number, retryAfterSec?: number): number {
  // If server sent Retry-After, use that directly (clamped to max)
  if (retryAfterSec !== undefined) {
    return Math.min(retryAfterSec * 1000, DEFAULT_MAX_DELAY_MS);
  }
  // Exponential backoff: 1s, 2s, 4s, ...
  const exponential = DEFAULT_BASE_DELAY_MS * Math.pow(2, attempt);
  // Add jitter (±20%) to avoid thundering herd
  const jitter = exponential * 0.2 * (Math.random() * 2 - 1);
  return Math.min(exponential + jitter, DEFAULT_MAX_DELAY_MS);
}

// ─── Main Entry Point ────────────────────────────────────────────────

export async function invokeModel(config: InvokeConfig): Promise<InvokeResult> {
  const { provider, model, prompt, systemPrompt, maxTokens } = config;
  const startMs = Date.now();

  // ── Circuit breaker check ────────────────────────────────────────
  const cbState = readCircuitBreaker();
  if (isProviderCircuitOpen(provider, cbState)) {
    throw new InvokerError(
      `Circuit breaker OPEN for ${provider} — provider skipped (too many recent failures)`,
      "circuit_breaker",
    );
  }

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
          true, // isOpenRouter
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
          process.env.MINIMAX_BASE_URL ?? "https://api.minimax.io/v1",
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
      case "glm-5.1-openrouter":
        result = await invokeOpenAICompatible(
          "https://openrouter.ai/api/v1",
          requireEnv("OPENROUTER_API_KEY"),
          "z-ai/glm-5.1", prompt, systemPrompt, maxTokens,
          true, // isOpenRouter
        );
        break;
      case "glm-5.1-direct":
        result = await invokeOpenAICompatible(
          "https://open.bigmodel.cn/api/paas/v4",
          requireEnv("ZAI_API_KEY"),
          "glm-5.1", prompt, systemPrompt, maxTokens,
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

    // ── Success: reset circuit breaker ─────────────────────────────
    recordProviderSuccess(provider, cbState);

    logCall({
      timestamp: new Date().toISOString(),
      provider, model,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      costUsd: result.costUsd,
      durationMs: Date.now() - startMs,
      ...(config.runId ? { runId: config.runId } : {}),
    });

    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const kind = err instanceof InvokerError ? err.kind : "unknown";

    // ── Failure: record in circuit breaker ────────────────────────
    if (kind !== "circuit_breaker") {
      recordProviderFailure(provider, cbState);
    }

    logCall({
      timestamp: new Date().toISOString(),
      provider, model,
      tokensIn: 0, tokensOut: 0, costUsd: 0,
      durationMs: Date.now() - startMs,
      error: msg,
      ...(config.runId ? { runId: config.runId } : {}),
    });
    throw err;
  }
}

/**
 * Invoke a model with a fallback chain.
 *
 * Walks `chain` in order. For each entry:
 *   - Check circuit breaker (cross-run) — skip if open, record skip in ctx.circuitBreakerSkips
 *   - If the provider is in `runContext.timedOutProviders`, skip it and log.
 *   - Otherwise call invokeModel(). On success, return immediately.
 *   - On InvokerError of kind "timeout": add provider to blacklist, continue.
 *   - On InvokerError of kind "circuit_breaker": continue to next entry.
 *   - On any other error: continue to next entry without blacklisting.
 *
 * After the caller-provided chain is fully exhausted, a final last-resort
 * attempt is made against portum/qwen3.6-plus. The last-resort is skipped
 * if portum was already in the chain or is blacklisted/tripped.
 *
 * The runContext is mutated in place.
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
  let skippedDueToCircuitBreaker = false;
  const cbState = readCircuitBreaker();

  for (const cfg of chain) {
    if (ctx.timedOutProviders.has(cfg.provider)) {
      console.warn(
        `[model-invoker] fallback: skipping ${cfg.provider}/${cfg.model} — provider is blacklisted (timed out earlier in this run)`
      );
      skippedDueToBlacklist = true;
      continue;
    }

    if (isProviderCircuitOpen(cfg.provider, cbState)) {
      console.warn(
        `[model-invoker] fallback: skipping ${cfg.provider}/${cfg.model} — circuit breaker is OPEN (too many recent failures)`
      );
      ctx.circuitBreakerSkips.add(cfg.provider);
      skippedDueToCircuitBreaker = true;
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
        skippedDueToCircuitBreaker,
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
      } else if (kind === "circuit_breaker") {
        console.warn(
          `[model-invoker] fallback: ${cfg.provider}/${cfg.model} circuit breaker open — skipping`
        );
        ctx.circuitBreakerSkips.add(cfg.provider);
        skippedDueToCircuitBreaker = true;
      } else {
        console.warn(
          `[model-invoker] fallback: ${cfg.provider}/${cfg.model} failed (${kind}) — trying next in chain`
        );
      }
    }
  }

  const chainEntriesAttempted = attemptedProviders.length;
  const chainEntriesSkipped = chain.length - chainEntriesAttempted;

  // ─── Last resort: Portum ────────────────────────────────────────
  const portumInChain = chain.some((cfg) => cfg.provider === PORTUM_LAST_RESORT.provider);
  const portumBlacklisted = ctx.timedOutProviders.has(PORTUM_LAST_RESORT.provider);
  const portumCircuitOpen = isProviderCircuitOpen(PORTUM_LAST_RESORT.provider, cbState);

  if (!portumInChain && !portumBlacklisted && !portumCircuitOpen) {
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
        skippedDueToCircuitBreaker,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const kind = err instanceof InvokerError ? err.kind : "unknown";
      errors.push(`${PORTUM_LAST_RESORT.provider}/${PORTUM_LAST_RESORT.model} (${kind}): ${msg}`);
      if (kind === "timeout") {
        ctx.timedOutProviders.add(PORTUM_LAST_RESORT.provider);
      }
      console.warn(`[model-invoker] fallback: portum last-resort failed (${kind}) — giving up`);
    }
  } else {
    if (portumInChain) console.warn("[model-invoker] fallback: chain exhausted — portum was already in caller chain, skipping last-resort");
    else if (portumBlacklisted) console.warn("[model-invoker] fallback: chain exhausted — portum is blacklisted (timed out earlier in this run), skipping last-resort");
    else if (portumCircuitOpen) console.warn("[model-invoker] fallback: chain exhausted — portum circuit breaker is OPEN, skipping last-resort");
    skippedDueToCircuitBreaker = true;
  }

  throw new InvokerError(
    `All fallback providers failed (${chainEntriesAttempted} chain entries attempted, ${chainEntriesSkipped} skipped via blacklist/circuit, plus portum last-resort): ${errors.join(" | ")}`,
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

  const res = await fetchWithRetry(`${base}/api/chat`, {
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
  isOpenRouter: boolean = false,
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

  // OpenRouter-specific headers — helps with quota tracking and reduces 429s
  if (isOpenRouter) {
    headers["HTTP-Referer"] = "https://squidley.ai";
    headers["X-Title"] = "Squidley-Aedis";
  }

  const res = await fetchWithRetry(`${baseUrl}/chat/completions`, {
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

  const res = await fetchWithRetry("https://api.anthropic.com/v1/messages", {
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

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  timeoutMs: number = 300_000,
  maxRetries: number = DEFAULT_MAX_RETRIES,
): Promise<Response> {
  const controller = new AbortController();
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, { ...init, signal: controller.signal });

      // ── Success ──────────────────────────────────────────────
      clearTimeout(timer);

      if (response.ok) {
        return response;
      }

      // ── HTTP error — decide if retryable ──────────────────────
      const status = response.status;

      if (!RETRYABLE_HTTP_STATUS.has(status)) {
        // Non-retryable HTTP error (400, 401, 403, 404, 500, 501, etc.) — return as-is
        return response;
      }

      // ── Retryable HTTP error (429, 502, 503, 504) ─────────────
      let retryAfterSec: number | undefined;

      // Read Retry-After header if present
      const retryAfter = response.headers.get("Retry-After");
      if (retryAfter) {
        const parsed = parseInt(retryAfter, 10);
        if (!isNaN(parsed)) retryAfterSec = parsed;
        else {
          // Could be a HTTP-date (e.g. "Wed, 21 Oct 2025 07:28:00 GMT") — treat as seconds from now
          const httpDate = new Date(retryAfter).getTime();
          if (!isNaN(httpDate)) retryAfterSec = Math.max(0, Math.floor((httpDate - Date.now()) / 1000));
        }
      }

      const delay = getRetryDelay(attempt, retryAfterSec);

      if (attempt < maxRetries) {
        console.warn(
          `[model-invoker] fetchWithRetry: ${url} returned ${status} — retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${maxRetries})${retryAfterSec !== undefined ? ` (Retry-After: ${retryAfterSec}s)` : ""}`
        );
        await sleep(delay);
        continue;
      } else {
        // Exhausted retries — return the last response (will become an error in caller)
        return response;
      }

    } catch (err: any) {
      clearTimeout(timer);
      lastError = err;

      if (err.name === "AbortError") {
        throw new InvokerError(`Request to ${url} timed out after ${timeoutMs}ms`, "timeout");
      }

      // Network error — check if it's retryable
      const isRetryable =
        RETRYABLE_NETWORK_ERRORS.has(err.code) ||
        (err.message && (
          err.message.includes("ECONNRESET") ||
          err.message.includes("ETIMEDOUT") ||
          err.message.includes("ENETUNREACH") ||
          err.message.includes("EHOSTUNREACH") ||
          err.message.includes("ECONNREFUSED")
        ));

      if (!isRetryable || attempt >= maxRetries) {
        throw new InvokerError(`Network error calling ${url}: ${err.message ?? err}`, "network");
      }

      const delay = getRetryDelay(attempt);
      console.warn(
        `[model-invoker] fetchWithRetry: ${url} network error (${err.code ?? err.message}) — retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${maxRetries})`
      );
      await sleep(delay);
    }
  }

  // Should not reach here, but TypeScript doesn't know that
  throw lastError ?? new InvokerError(`fetchWithRetry exhausted all attempts for ${url}`, "network");
}

// ─── Confidence-Based Escalation ─────────────────────────────────────

export interface EscalationResult {
  /** Whether an escalation was performed. */
  readonly escalated: boolean;
  /** The result from the escalation attempt (if escalated). */
  readonly result: InvokeResult | null;
  /** The provider used for escalation. */
  readonly escalationProvider: Provider | null;
  /** The model used for escalation. */
  readonly escalationModel: string | null;
  /** Reason for escalation or why it was skipped. */
  readonly reason: string;
}

/**
 * Check a builder result's confidence and escalate to a better model if
 * confidence is below the threshold. Capped at 1 escalation per run to
 * prevent cost runaway.
 */
export async function escalateOnLowConfidence(
  confidence: number,
  config: InvokeConfig,
  runContext: RunInvocationContext,
  threshold: number = 0.6,
): Promise<EscalationResult> {
  if (confidence >= threshold) {
    return {
      escalated: false,
      result: null,
      escalationProvider: null,
      escalationModel: null,
      reason: `confidence ${(confidence * 100).toFixed(0)}% >= ${(threshold * 100).toFixed(0)}% threshold — no escalation needed`,
    };
  }

  if (runContext.escalationCount >= 1) {
    console.log(
      `[model-invoker] low confidence (${(confidence * 100).toFixed(0)}%) but escalation cap reached (${runContext.escalationCount}/1) — skipping retry`,
    );
    return {
      escalated: false,
      result: null,
      escalationProvider
// ─── Errors ──────────────────────────────────────────────────────────

export type InvokerErrorKind = "timeout" | "http" | "network" | "config" | "unknown" | "circuit_breaker";

export class InvokerError extends Error {
  readonly kind: InvokerErrorKind;
  constructor(message: string, kind: InvokerErrorKind = "unknown") {
    super(message);
    this.name = "InvokerError";
    this.kind = kind;
  }
}
