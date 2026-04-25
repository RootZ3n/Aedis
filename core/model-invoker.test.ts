import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  invokeModelWithFallback,
  createRunInvocationContext,
  type InvokeConfig,
  InvokerError,
} from "./model-invoker.js";

/**
 * These tests stub global fetch so we can drive provider responses
 * deterministically. The contract under test is:
 *   - empty/whitespace-only model output is rejected at the provider
 *     layer (kind: "empty_response") and falls through to the next
 *     chain entry without incrementing the cross-run circuit breaker
 *   - the FallbackInvokeResult.attempts log records every step
 *     (skips, errors, success) in order
 */

type FetchHandler = (url: string, init: RequestInit) => Promise<Response>;

function withStubbedFetch(handler: FetchHandler, fn: () => Promise<void>): Promise<void> {
  const originalFetch = globalThis.fetch;
  // Match the (input, init) signature loosely — node's fetch types
  // accept URL | Request | string for input.
  (globalThis as unknown as { fetch: FetchHandler }).fetch = (input, init) =>
    handler(typeof input === "string" ? input : String(input), init ?? {});
  return fn().finally(() => {
    globalThis.fetch = originalFetch;
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function openAiChoiceBody(text: string) {
  return {
    choices: [{ message: { content: text } }],
    usage: { prompt_tokens: 10, completion_tokens: text.length },
  };
}

/** Run each test in a fresh CWD so the persisted CB state file doesn't bleed across cases. */
function withFreshCwd(fn: () => Promise<void>): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "aedis-modelinvoker-"));
  const original = process.cwd();
  process.chdir(tmp);
  return fn().finally(() => {
    process.chdir(original);
    rmSync(tmp, { recursive: true, force: true });
  });
}

test("empty content from provider 1 falls through to provider 2 without CB increment", async () => {
  process.env.OPENROUTER_API_KEY = "test";
  process.env.MINIMAX_API_KEY = "test";

  await withFreshCwd(() =>
    withStubbedFetch(
      async (url) => {
        if (url.includes("openrouter.ai")) {
          // Empty content — should be classified empty_response.
          return jsonResponse(openAiChoiceBody(""));
        }
        if (url.includes("api.minimax.chat")) {
          return jsonResponse(openAiChoiceBody("ok-from-minimax"));
        }
        throw new Error(`unexpected URL ${url}`);
      },
      async () => {
        const chain: InvokeConfig[] = [
          { provider: "openrouter", model: "xiaomi/mimo-v2.5", prompt: "hi" },
          { provider: "minimax", model: "minimax-coding", prompt: "hi" },
        ];
        const result = await invokeModelWithFallback(chain, createRunInvocationContext());

        assert.equal(result.usedProvider, "minimax");
        assert.equal(result.text, "ok-from-minimax");

        // Both providers were attempted, in order
        assert.deepEqual(result.attemptedProviders, ["openrouter", "minimax"]);

        // Per-attempt log: empty_response, then ok
        assert.equal(result.attempts.length, 2);
        assert.equal(result.attempts[0]!.provider, "openrouter");
        assert.equal(result.attempts[0]!.outcome, "empty_response");
        assert.equal(result.attempts[1]!.provider, "minimax");
        assert.equal(result.attempts[1]!.outcome, "ok");

        // Circuit breaker file should NOT show openrouter as failed —
        // empty content is a model quality issue, not infra. If the CB
        // state was written (it may not be on first call), there must
        // be no entry for openrouter.
        const cbFile = join(process.cwd(), ".aedis", "circuit-breaker-state.json");
        if (existsSync(cbFile)) {
          const state = JSON.parse(readFileSync(cbFile, "utf-8")) as {
            providers: Record<string, unknown>;
          };
          assert.equal(
            state.providers.openrouter,
            undefined,
            "openrouter should not be penalized for empty content",
          );
        }
      },
    ),
  );
});

test("attempts log includes blacklist skips for providers that timed out earlier in the run", async () => {
  process.env.OPENROUTER_API_KEY = "test";
  process.env.MINIMAX_API_KEY = "test";

  await withFreshCwd(() =>
    withStubbedFetch(
      async (url) => {
        if (url.includes("api.minimax.chat")) {
          return jsonResponse(openAiChoiceBody("ok-from-minimax"));
        }
        throw new Error(`unexpected URL ${url}`);
      },
      async () => {
        const ctx = createRunInvocationContext();
        // Simulate a prior timeout in this run.
        ctx.timedOutProviders.add("openrouter");

        const result = await invokeModelWithFallback(
          [
            { provider: "openrouter", model: "xiaomi/mimo-v2.5", prompt: "hi" },
            { provider: "minimax", model: "minimax-coding", prompt: "hi" },
          ],
          ctx,
        );

        assert.equal(result.usedProvider, "minimax");
        assert.equal(result.skippedDueToBlacklist, true);
        assert.equal(result.attempts.length, 2);
        assert.equal(result.attempts[0]!.outcome, "skipped_blacklist");
        assert.equal(result.attempts[0]!.provider, "openrouter");
        assert.equal(result.attempts[1]!.outcome, "ok");
      },
    ),
  );
});

test("InvokerError on total failure carries the full attempts log", async () => {
  process.env.OPENROUTER_API_KEY = "test";
  process.env.MINIMAX_API_KEY = "test";

  await withFreshCwd(() =>
    withStubbedFetch(
      async (url) => {
        if (url.includes("openrouter.ai")) {
          return jsonResponse(openAiChoiceBody("")); // empty
        }
        if (url.includes("api.minimax.chat")) {
          return jsonResponse(openAiChoiceBody("")); // empty
        }
        if (url.includes("localhost:18797")) {
          // Portum last-resort — also empty
          return jsonResponse(openAiChoiceBody(""));
        }
        throw new Error(`unexpected URL ${url}`);
      },
      async () => {
        const chain: InvokeConfig[] = [
          { provider: "openrouter", model: "xiaomi/mimo-v2.5", prompt: "hi" },
          { provider: "minimax", model: "minimax-coding", prompt: "hi" },
        ];

        await assert.rejects(
          () => invokeModelWithFallback(chain, createRunInvocationContext()),
          (err: unknown) => {
            assert.ok(err instanceof InvokerError);
            const ie = err as InvokerError;
            assert.ok(Array.isArray(ie.attempts));
            // chain (2) + portum last-resort (1)
            assert.equal(ie.attempts!.length, 3);
            assert.ok(
              ie.attempts!.every((a) => a.outcome === "empty_response"),
              "every attempt should be classified empty_response",
            );
            return true;
          },
        );
      },
    ),
  );
});
