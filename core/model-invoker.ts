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
 *   - glm-5.1-openrouter: GLM-5.1 via OpenRouter (z-ai/glm-5.1) + OPENROUTER_API_KEY
 *   - glm-5.1-direct: GLM-5.1 via ZAI direct (open.bigmodel.cn) + ZAI_API_KEY
 *   - local: mock response, zero cost
 *
 * Fallback chain:
 *   invokeModelWithFallback() walks a chain of InvokeConfigs, trying each
 *   in order. If a provider times out, it is added to the run's blacklist
 *   and never retried within the same run. Other errors fall through to
 *   the next chain entry without blacklisting (e.g. transient HTTP errors
 *   on a different provider may still be worth a future attempt).
 *
 *   When the chain is exhausted the call throws an aggregated InvokerError.
 *   There is NO universal safety-net provider — lane attribution must stay
 *   honest, and a hidden auto-fallback would let calls reach a model the
 *   caller never asked for. If you want a safety net, declare it explicitly
 *   in your chain.
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
  | "local";

export interface InvokeConfig {
  provider: Provider;
  model: string;
  prompt: string;
  systemPrompt?: string;
  maxTokens?: number;
  /** Run ID threaded through to the call log for scoped cost aggregation. */
  runId?: string;
  /**
   * Cancellation signal. When aborted, the in-flight HTTP request is
   * dropped (raced against the internal timeout) and the call throws
   * `InvokerError("...", "cancelled")`. Cancelled errors are never
   * retried inside fetchWithRetry, never blacklist a provider, never
   * increment the circuit breaker — cancellation is user-initiated and
   * not a provider fault.
   */
  signal?: AbortSignal;
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
  /** Whether a circuit-breaker skip occurred this run. */
  readonly skippedDueToCircuitBreaker: boolean;
  /**
   * Ordered per-attempt log including skips. Receipts persist this so
   * trust signals (which provider failed how, how long it took, what it
   * cost) survive past the run. Includes the successful attempt as the
   * last "ok" entry; skipped attempts have durationMs=0 and costUsd=0.
   */
  readonly attempts: readonly InvokeAttempt[];
}

/**
 * One row in the fallback log. Outcomes:
 *   - "ok": provider returned a non-empty response and we used it
 *   - "skipped_blacklist": skipped because provider timed out earlier this run
 *   - "skipped_circuit_breaker": skipped because cross-run CB is open
 *   - any InvokerErrorKind: provider was tried but failed with that kind
 */
export interface InvokeAttempt {
  readonly provider: Provider;
  readonly model: string;
  readonly outcome:
    | "ok"
    | "skipped_blacklist"
    | "skipped_circuit_breaker"
    | InvokerErrorKind;
  readonly durationMs: number;
  readonly costUsd: number;
  readonly tokensIn?: number;
  readonly tokensOut?: number;
  readonly errorMsg?: string;
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
  readonly circuitBreakerSkips: Set<Provider>;
}

export function createRunInvocationContext(): RunInvocationContext {
  return { timedOutProviders: new Set<Provider>(), escalationCount: 0, circuitBreakerSkips: new Set<Provider>() };
}


// ─── Circuit Breaker (cross-run, persisted) ──────────────────────────

const CB_PATH = ".aedis/circuit-breaker-state.json";

interface CbEntry { failures: number; lastFailure: number; }
interface CbState { providers: Record<string, CbEntry>; }

const CB_MAX = 5;
const CB_COOLING_MS = 15 * 60 * 1000;
const CB_HALF_LIFE_MS = 5 * 60 * 1000;

function cbRead(): CbState {
  try {
    return JSON.parse(String(require("fs").readFileSync(CB_PATH))) as CbState;
  } catch { return { providers: {} }; }
}
function cbWrite(s: CbState): void {
  const { writeFileSync, mkdirSync } = require("fs") as typeof import("fs");
  try { mkdirSync(".aedis", { recursive: true }); } catch { /* exists */ }
  writeFileSync(CB_PATH, JSON.stringify(s, null, 2));
}
function cbScore(e: CbEntry): number {
  const age = Date.now() - e.lastFailure;
  return age >= CB_COOLING_MS ? 1 : Math.pow(0.5, age / CB_HALF_LIFE_MS);
}
function cbOpen(p: Provider, s: CbState): boolean {
  const e = s.providers[p];
  if (!e) return false;
  return e.failures * (1 - cbScore(e)) >= CB_MAX;
}
function cbFail(p: Provider, s: CbState): void {
  const ex = s.providers[p];
  if (ex) { ex.failures++; ex.lastFailure = Date.now(); }
  else s.providers[p] = { failures: 1, lastFailure: Date.now() };
  cbWrite(s);
}
function cbOk(p: Provider, s: CbState): void {
  if (s.providers[p]) { delete s.providers[p]; cbWrite(s); }
}

// ─── Retry / Backoff ────────────────────────────────────────────────

const RETRYABLE_HTTP = new Set([429, 502, 503, 504]);
const RETRYABLE_NET = new Set(["ECONNRESET","ETIMEDOUT","ENETUNREACH","EHOSTUNREACH","ECONNREFUSED","EAGAIN","EPIPE"]);
const DEF_MAX_RETRIES = 2;
const DEF_BASE_DELAY = 1000;
const DEF_MAX_DELAY = 32_000;

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function retryDelay(attempt: number, retryAfterSec?: number): number {
  if (retryAfterSec !== undefined) return Math.min(retryAfterSec * 1000, DEF_MAX_DELAY);
  const exp = DEF_BASE_DELAY * Math.pow(2, attempt);
  const jitter = exp * 0.2 * (Math.random() * 2 - 1);
  return Math.min(exp + jitter, DEF_MAX_DELAY);
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
  "xiaomi/mimo-v2.5": { input: 0.001, output: 0.002 },
  "xiaomi/mimo-v2.5-pro": { input: 0.002, output: 0.004 },
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
  // GLM-5.1 via OpenRouter ($0.95/M in, $3.15/M out)
  "z-ai/glm-5.1":   { input: 0.00095, output: 0.00315 },
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

// ─── Main Entry Point ────────────────────────────────────────────────

export async function invokeModel(config: InvokeConfig): Promise<InvokeResult> {
  const { provider, model, prompt, systemPrompt, maxTokens, signal } = config;
  const startMs = Date.now();

  // Fast cancel: don't even check the circuit breaker if the caller
  // has already aborted.
  if (signal?.aborted) {
    throw new InvokerError(`${provider}/${model} cancelled before dispatch`, "cancelled");
  }

  // Circuit breaker check (cross-run)
  const cbState = cbRead();
  if (cbOpen(provider, cbState)) {
    throw new InvokerError(`Circuit breaker OPEN for ${provider} -- too many recent failures`, "circuit_breaker");
  }

  try {
    let result: InvokeResult;

    switch (provider) {
      case "local":
        result = invokeLocal(prompt);
        break;
      case "ollama":
        result = await invokeOllama(model, prompt, systemPrompt, maxTokens, signal);
        break;
      case "modelstudio":
        result = await invokeOpenAICompatible(
          process.env.MODELSTUDIO_BASE_URL ?? "https://dashscope.aliyuncs.com/compatible-mode/v1",
          requireEnv("MODELSTUDIO_API_KEY"),
          model, prompt, systemPrompt, maxTokens, false, signal,
        );
        break;
      case "openrouter":
        result = await invokeOpenAICompatible(
          "https://openrouter.ai/api/v1",
          requireEnv("OPENROUTER_API_KEY"),
          model, prompt, systemPrompt, maxTokens, true, signal,
        );
        break;
      case "anthropic":
        result = await invokeAnthropic(
          requireEnv("ANTHROPIC_API_KEY"),
          model, prompt, systemPrompt, maxTokens, signal,
        );
        break;
      case "openai":
        result = await invokeOpenAICompatible(
          process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
          requireEnv("OPENAI_API_KEY"),
          model, prompt, systemPrompt, maxTokens, false, signal,
        );
        break;
      case "minimax":
        result = await invokeOpenAICompatible(
          process.env.MINIMAX_BASE_URL ?? "https://api.minimax.chat/v1",
          requireEnv("MINIMAX_API_KEY"),
          model, prompt, systemPrompt, maxTokens, false, signal,
        );
        break;
      case "zai":
        result = await invokeOpenAICompatible(
          process.env.ZAI_BASE_URL ?? "https://api.z.ai/api/paas/v4/",
          requireEnv("ZAI_API_KEY"),
          model, prompt, systemPrompt, maxTokens, false, signal,
        );
        break;
      case "glm-5.1-openrouter":
        result = await invokeOpenAICompatible(
          "https://openrouter.ai/api/v1",
          requireEnv("OPENROUTER_API_KEY"),
          "z-ai/glm-5.1", prompt, systemPrompt, maxTokens, false, signal,
        );
        break;
      case "glm-5.1-direct":
        result = await invokeOpenAICompatible(
          "https://open.bigmodel.cn/api/paas/v4",
          requireEnv("ZAI_API_KEY"),
          "glm-5.1", prompt, systemPrompt, maxTokens, false, signal,
        );
        break;
      default:
        throw new InvokerError(`Unknown provider "${provider}"`, "config");
    }

    // Reject truly empty / whitespace-only responses at the provider
    // layer. Anything richer (short prose, no code fence) is the
    // caller's domain — they have file-path context the invoker doesn't.
    // Treating empty as a failure here lets the existing fallback chain
    // pick another provider instead of returning success with text="".
    if (!result.text || result.text.trim() === "") {
      throw new InvokerError(
        `${provider}/${model} returned empty content`,
        "empty_response",
      );
    }

    cbOk(provider, cbState);
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
    // Don't penalize the circuit breaker for:
    //   - circuit_breaker: would trivially recurse
    //   - empty_response: the *infra* worked; the *model* gave us junk.
    //     Penalizing the provider would close the breaker on a healthy
    //     endpoint just because one prompt happened to be hard.
    //   - cancelled: user-initiated, not a provider fault.
    if (kind !== "circuit_breaker" && kind !== "empty_response" && kind !== "cancelled") {
      cbFail(provider, cbState);
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
 *   - If the provider is in `runContext.timedOutProviders`, skip it and log.
 *   - Otherwise call invokeModel(). On success, return immediately.
 *   - On InvokerError of kind "timeout": add provider to blacklist, continue.
 *   - On any other error: continue to next entry without blacklisting.
 *
 * When the caller-provided chain is fully exhausted, throws an aggregated
 * InvokerError. There is NO universal safety-net provider — lane attribution
 * must stay honest, so calls cannot silently reach a model the caller never
 * asked for. If you need a safety net, declare it explicitly in your chain.
 *
 * The runContext is mutated in place — callers can pass the same context
 * across multiple invokeModelWithFallback calls within a single run, and
 * the timeout blacklist accumulates across the whole run.
 */
export async function invokeModelWithFallback(
  chain: readonly InvokeConfig[],
  runContext?: RunInvocationContext,
  signal?: AbortSignal,
): Promise<FallbackInvokeResult> {
  if (chain.length === 0) {
    throw new InvokerError("invokeModelWithFallback: chain is empty", "config");
  }

  const ctx = runContext ?? createRunInvocationContext();
  const attemptedProviders: Provider[] = [];
  const attempts: InvokeAttempt[] = [];
  const errors: string[] = [];
  let skippedDueToBlacklist = false;
  let skippedDueToCircuitBreaker = false;
  const cbState = cbRead();

  // Pre-merge: if the caller passed an explicit `signal` AND any chain
  // entry has its own per-config signal, we want either source to abort
  // the active call. The simplest approach is to thread the explicit
  // signal into each config below; per-config signals are preserved.
  // Caller-supplied signal takes precedence when both are present.

  for (const cfg of chain) {
    // Caller-cancelled: stop walking the chain. Record the remaining
    // entries as skipped (so receipts show what didn't run) and throw.
    if (signal?.aborted) {
      attempts.push({
        provider: cfg.provider,
        model: cfg.model,
        outcome: "cancelled",
        durationMs: 0,
        costUsd: 0,
        errorMsg: "cancelled before dispatch",
      });
      const cancelErr = new InvokerError(
        "invokeModelWithFallback: chain cancelled by caller",
        "cancelled",
      );
      cancelErr.attempts = attempts;
      throw cancelErr;
    }
    if (ctx.timedOutProviders.has(cfg.provider)) {
      console.warn(
        `[model-invoker] fallback: skipping ${cfg.provider}/${cfg.model} — provider is blacklisted (timed out earlier in this run)`
      );
      skippedDueToBlacklist = true;
      attempts.push({
        provider: cfg.provider,
        model: cfg.model,
        outcome: "skipped_blacklist",
        durationMs: 0,
        costUsd: 0,
      });
      continue;
    }
    if (cbOpen(cfg.provider, cbState)) {
      console.warn(
        `[model-invoker] fallback: skipping ${cfg.provider}/${cfg.model} -- circuit breaker OPEN`
      );
      ctx.circuitBreakerSkips.add(cfg.provider);
      skippedDueToCircuitBreaker = true;
      attempts.push({
        provider: cfg.provider,
        model: cfg.model,
        outcome: "skipped_circuit_breaker",
        durationMs: 0,
        costUsd: 0,
      });
      continue;
    }

    attemptedProviders.push(cfg.provider);
    console.log(`[model-invoker] fallback: attempting ${cfg.provider}/${cfg.model}`);
    const attemptStart = Date.now();

    try {
      // Caller-supplied signal wins over any per-config signal — the
      // run-level abort cancels every chain entry uniformly. If both
      // are provided, the per-config signal is ignored.
      const cfgWithSignal: InvokeConfig = signal ? { ...cfg, signal } : cfg;
      const result = await invokeModel(cfgWithSignal);
      console.log(`[model-invoker] fallback: ${cfg.provider}/${cfg.model} succeeded`);
      attempts.push({
        provider: cfg.provider,
        model: cfg.model,
        outcome: "ok",
        durationMs: Date.now() - attemptStart,
        costUsd: result.costUsd,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
      });
      return {
        ...result,
        usedProvider: cfg.provider,
        usedModel: cfg.model,
        attemptedProviders,
        skippedDueToBlacklist,
        skippedDueToCircuitBreaker,
        attempts,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const kind = err instanceof InvokerError ? err.kind : "unknown";
      errors.push(`${cfg.provider}/${cfg.model} (${kind}): ${msg}`);
      attempts.push({
        provider: cfg.provider,
        model: cfg.model,
        outcome: kind,
        durationMs: Date.now() - attemptStart,
        costUsd: 0,
        errorMsg: msg,
      });

      if (kind === "timeout") {
        console.warn(
          `[model-invoker] fallback: ${cfg.provider}/${cfg.model} TIMED OUT — blacklisting provider for the rest of this run`
        );
        ctx.timedOutProviders.add(cfg.provider);
      } else if (kind === "empty_response") {
        // Empty content from a model is a quality issue, not an infra
        // failure. Don't blacklist (other prompts may succeed) and don't
        // increment the circuit breaker (already skipped in invokeModel).
        // Just fall through to the next chain entry.
        console.warn(
          `[model-invoker] fallback: ${cfg.provider}/${cfg.model} returned empty content — trying next in chain`
        );
      } else if (kind === "cancelled") {
        // Caller cancelled. Don't try further entries, don't blacklist,
        // don't penalize the circuit breaker. Throw immediately so the
        // run can wind down.
        console.warn(
          `[model-invoker] fallback: ${cfg.provider}/${cfg.model} cancelled — abandoning chain`
        );
        const cancelErr = new InvokerError(msg, "cancelled");
        cancelErr.attempts = attempts;
        throw cancelErr;
      } else {
        console.warn(
          `[model-invoker] fallback: ${cfg.provider}/${cfg.model} failed (${kind}) — trying next in chain`
        );
      }
      // Continue to next chain entry
    }
  }

  // Chain exhausted with no success. There is no universal safety-net
  // fallback — lane attribution must stay honest, so we fail loudly here
  // instead of silently routing to a model the caller never named.
  const chainEntriesAttempted = attemptedProviders.length;
  const chainEntriesSkipped = chain.length - chainEntriesAttempted;
  const finalErr = new InvokerError(
    `All fallback providers failed (${chainEntriesAttempted} chain entries attempted, ${chainEntriesSkipped} skipped via blacklist): ${errors.join(" | ")}`,
    "unknown",
  );
  finalErr.attempts = attempts;
  throw finalErr;
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
  signal?: AbortSignal,
): Promise<InvokeResult> {
  const base = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";

  const messages: Array<{ role: string; content: string }> = [];
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  messages.push({ role: "user", content: prompt });

  const res = await fetchWithRetry(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, stream: false }),
  }, undefined, undefined, signal);

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

// ─── OpenAI-Compatible (ModelStudio, OpenRouter, OpenAI, MiniMax, ZAI) ─

async function invokeOpenAICompatible(
  baseUrl: string,
  apiKey: string | undefined,
  model: string,
  prompt: string,
  systemPrompt?: string,
  maxTokens?: number,
  isOpenRouter = false,
  signal?: AbortSignal,
): Promise<InvokeResult> {
  const messages: Array<{ role: string; content: string }> = [];
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  messages.push({ role: "user", content: prompt });

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  if (isOpenRouter) { headers["HTTP-Referer"] = "https://squidley.ai"; headers["X-Title"] = "Squidley-Aedis"; }

  const res = await fetchWithRetry(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens ?? 4096,
      temperature: 0.2,
    }),
  }, undefined, undefined, signal);

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
  signal?: AbortSignal,
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
  }, undefined, undefined, signal);

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
  timeoutMs = 300_000,
  maxRetries = DEF_MAX_RETRIES,
  externalSignal?: AbortSignal,
): Promise<Response> {
  // Fast-path: if the caller already cancelled before we get here,
  // don't even bother attempting the request.
  if (externalSignal?.aborted) {
    throw new InvokerError(`Request to ${url} cancelled`, "cancelled");
  }
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const timeoutCtrl = new AbortController();
    const timer = setTimeout(() => timeoutCtrl.abort(), timeoutMs);
    // Merge the timeout signal with the optional caller signal so
    // either source can abort the in-flight fetch. AbortSignal.any
    // is available since Node 20.
    const signals: AbortSignal[] = [timeoutCtrl.signal];
    if (externalSignal) signals.push(externalSignal);
    const mergedSignal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);
    try {
      const res = await fetch(url, { ...init, signal: mergedSignal });
      clearTimeout(timer);
      if (res.ok) return res;
      if (!RETRYABLE_HTTP.has(res.status)) return res;
      // If a retry is on the table but the caller has cancelled, drop
      // out immediately rather than wasting a backoff.
      if (externalSignal?.aborted) {
        throw new InvokerError(`Request to ${url} cancelled mid-retry`, "cancelled");
      }
      let retryAfterSec: number | undefined;
      const ra = res.headers.get("Retry-After");
      if (ra) {
        const p = parseInt(ra, 10);
        if (!isNaN(p)) retryAfterSec = p;
        else {
          const httpDate = new Date(ra).getTime();
          if (!isNaN(httpDate)) retryAfterSec = Math.max(0, Math.floor((httpDate - Date.now()) / 1000));
        }
      }
      const delay = retryDelay(attempt, retryAfterSec);
      if (attempt < maxRetries) {
        console.warn(`[model-invoker] fetchWithRetry: ${url} HTTP ${res.status} -- retry in ${Math.round(delay)}ms (attempt ${attempt+1}/${maxRetries})${retryAfterSec !== undefined ? ` (Retry-After: ${retryAfterSec}s)` : ""}`);
        await sleep(delay);
        continue;
      }
      return res;
    } catch (err: any) {
      clearTimeout(timer);
      lastErr = err;
      // Distinguish caller cancellation from internal timeout. Both
      // surface as AbortError, but we know which is which by checking
      // the external signal.
      if (err.name === "AbortError") {
        if (externalSignal?.aborted) {
          throw new InvokerError(`Request to ${url} cancelled`, "cancelled");
        }
        throw new InvokerError(`Request to ${url} timed out after ${timeoutMs}ms`, "timeout");
      }
      const isRetry = RETRYABLE_NET.has(err.code) || (err.message && (err.message.includes("ECONNRESET") || err.message.includes("ETIMEDOUT") || err.message.includes("ENETUNREACH") || err.message.includes("ECONNREFUSED")));
      if (!isRetry || attempt >= maxRetries) throw new InvokerError(`Network error calling ${url}: ${err.message ?? err}`, "network");
      if (externalSignal?.aborted) {
        throw new InvokerError(`Request to ${url} cancelled mid-retry`, "cancelled");
      }
      const delay = retryDelay(attempt);
      console.warn(`[model-invoker] fetchWithRetry: ${url} network error (${err.code ?? err.message}) -- retry in ${Math.round(delay)}ms (attempt ${attempt+1}/${maxRetries})`);
      await sleep(delay);
    }
  }
  throw lastErr ?? new InvokerError(`fetchWithRetry exhausted for ${url}`, "network");
}

// ─── Confidence-Based Escalation ────────────────────────────────────

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

export async function escalateOnLowConfidence(
  confidence: number,
  config: InvokeConfig,
  runContext: RunInvocationContext,
  threshold: number = 0.6,
): Promise<EscalationResult> {
  if (confidence >= threshold) {
    return { escalated: false, result: null, escalationProvider: null, escalationModel: null,
      reason: `confidence ${(confidence*100).toFixed(0)}% >= ${(threshold*100).toFixed(0)}% -- no escalation` };
  }
  if (runContext.escalationCount >= 1) {
    return { escalated: false, result: null, escalationProvider: null, escalationModel: null,
      reason: `low confidence but escalation cap (1 per run) already reached` };
  }
  console.log(`[model-invoker] low confidence (${(confidence*100).toFixed(0)}%) -- escalating to claude-sonnet-4-6`);
  runContext.escalationCount += 1;
  try {
    const result = await invokeModel({ ...config, provider: "anthropic", model: "claude-sonnet-4-6" });
    return { escalated: true, result, escalationProvider: "anthropic", escalationModel: "claude-sonnet-4-6",
      reason: `escalated from ${(confidence*100).toFixed(0)}% confidence` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { escalated: true, result: null, escalationProvider: "anthropic", escalationModel: "claude-sonnet-4-6",
      reason: `escalation failed: ${msg}` };
  }
}

// ─── Errors ──────────────────────────────────────────────────────────

export type InvokerErrorKind =
  | "timeout"
  | "http"
  | "network"
  | "config"
  | "unknown"
  | "circuit_breaker"
  | "empty_response"
  | "cancelled";

export class InvokerError extends Error {
  readonly kind: InvokerErrorKind;
  /**
   * Set on the final InvokerError thrown by invokeModelWithFallback when
   * the entire chain is exhausted. Holds the per-attempt log so callers
   * can persist it to receipts even on total failure. Single-call
   * invokeModel errors leave this undefined.
   */
  attempts?: readonly InvokeAttempt[];
  constructor(message: string, kind: InvokerErrorKind = "unknown") {
    super(message);
    this.name = "InvokerError";
    this.kind = kind;
  }
}
