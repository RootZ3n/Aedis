/**
 * Provider failure summary normalization tests.
 *
 * Pins the contract:
 *   - Common provider errors are normalized to human-readable summaries
 *   - Raw error is preserved in the rawError field
 *   - Unknown errors get a generic but helpful summary
 *   - Raw provider errors do NOT dominate the user-facing headline
 */

import test from "node:test";
import assert from "node:assert/strict";

import { normalizeProviderError } from "./model-invoker.js";

// ─── Known error patterns ──────────────────────────────────────────

test("429 rate limit → human-readable headline + next step", () => {
  const result = normalizeProviderError("HTTP 429: Too Many Requests — rate limit exceeded for model qwen3.5");
  assert.equal(result.category, "rate_limited");
  assert.match(result.headline, /rate.limit/i);
  assert.match(result.nextStep, /retry|switch/i);
  assert.ok(result.rawError.includes("429"));
});

test("503 unavailable → provider unavailable", () => {
  const result = normalizeProviderError("HTTP 503 Service Unavailable");
  assert.equal(result.category, "provider_unavailable");
  assert.match(result.headline, /unavailable/i);
  assert.match(result.nextStep, /status page|retry/i);
});

test("model not found → model not found category", () => {
  const result = normalizeProviderError("Error: model 'gpt-999' does not exist on this provider");
  assert.equal(result.category, "model_not_found");
  assert.match(result.headline, /model not found/i);
  assert.match(result.nextStep, /model name|model-config/i);
});

test("401 unauthorized → api key invalid", () => {
  const result = normalizeProviderError("HTTP 401 Unauthorized: Invalid API key provided");
  assert.equal(result.category, "api_key_invalid");
  assert.match(result.headline, /API key/i);
  assert.match(result.nextStep, /API key|environment/i);
});

test("timeout → timeout category", () => {
  const result = normalizeProviderError("Request timed out after 300000ms");
  assert.equal(result.category, "timeout");
  assert.match(result.headline, /timed out/i);
  assert.match(result.nextStep, /timeout|faster/i);
});

test("circuit breaker open → circuit breaker category", () => {
  const result = normalizeProviderError("Circuit breaker open for provider openrouter after 3 consecutive failures");
  assert.equal(result.category, "circuit_breaker_open");
  assert.match(result.headline, /circuit breaker/i);
  assert.match(result.nextStep, /breaker|reset|switch/i);
});

test("all fallback providers failed → all providers failed", () => {
  const result = normalizeProviderError("All fallback providers failed: openrouter, minimax exhausted");
  assert.equal(result.category, "all_providers_failed");
  assert.match(result.headline, /all.*providers.*failed/i);
  assert.match(result.nextStep, /provider|connectivity/i);
});

// ─── Unknown errors ───────────────────────────────────────────────

test("unknown error → generic headline, raw preserved", () => {
  const raw = "java.lang.NullPointerException at line 42";
  const result = normalizeProviderError(raw);
  assert.equal(result.category, "unknown");
  assert.match(result.headline, /unexpected error/i);
  assert.equal(result.rawError, raw);
});

// ─── Raw error does NOT dominate user-facing summary ─────────────

test("raw error is preserved but headline is always human-readable", () => {
  const raw = "ECONNREFUSED 127.0.0.1:11434 — connect ECONNREFUSED ::1:11434 at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1595:16)";
  const result = normalizeProviderError(raw);
  // headline must NOT contain stack trace noise
  assert.doesNotMatch(result.headline, /ECONNREFUSED|TCPConnectWrap|oncomplete/);
  // but rawError preserves everything
  assert.equal(result.rawError, raw);
  // nextStep is actionable
  assert.ok(result.nextStep.length > 10);
});

test("headline never contains raw HTTP body noise", () => {
  const raw = '{"error":{"message":"You exceeded your current quota, please check your plan","type":"insufficient_quota","param":null,"code":"insufficient_quota"}}';
  const result = normalizeProviderError(raw);
  assert.doesNotMatch(result.headline, /\{.*\}/);
  assert.equal(result.rawError, raw);
});
