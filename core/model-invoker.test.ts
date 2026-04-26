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

test("caller-supplied AbortSignal aborts the chain immediately and does not penalize the circuit breaker", async () => {
  process.env.OPENROUTER_API_KEY = "test";
  process.env.MINIMAX_API_KEY = "test";

  await withFreshCwd(() =>
    withStubbedFetch(
      async (url, init) => {
        // Simulate a slow provider that hangs until the caller signal aborts.
        return new Promise<Response>((_resolve, reject) => {
          const callerSignal = init.signal as AbortSignal | undefined;
          callerSignal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
          // Never resolve on its own — only the abort path completes.
          void url;
        });
      },
      async () => {
        const ctrl = new AbortController();
        const chain: InvokeConfig[] = [
          { provider: "openrouter", model: "xiaomi/mimo-v2.5", prompt: "hi" },
          { provider: "minimax", model: "minimax-coding", prompt: "hi" },
        ];
        // Abort after a short delay so the first request has actually started.
        setTimeout(() => ctrl.abort(), 30);

        await assert.rejects(
          () =>
            invokeModelWithFallback(
              chain,
              createRunInvocationContext(),
              ctrl.signal,
            ),
          (err: unknown) => {
            assert.ok(err instanceof InvokerError);
            assert.equal((err as InvokerError).kind, "cancelled");
            // The failed provider should NOT have been added to the
            // persisted circuit-breaker state.
            const cbFile = join(process.cwd(), ".aedis", "circuit-breaker-state.json");
            if (existsSync(cbFile)) {
              const state = JSON.parse(readFileSync(cbFile, "utf-8")) as {
                providers: Record<string, unknown>;
              };
              assert.equal(
                state.providers.openrouter,
                undefined,
                "openrouter should not be penalized for cancellation",
              );
            }
            return true;
          },
        );
      },
    ),
  );
});

test("pre-aborted signal short-circuits invokeModelWithFallback before any HTTP call", async () => {
  process.env.OPENROUTER_API_KEY = "test";

  await withFreshCwd(() =>
    withStubbedFetch(
      async () => {
        // If we ever reach here, the test should fail — pre-aborted
        // signals must skip the chain entirely.
        throw new Error("fetch should not be called when signal is pre-aborted");
      },
      async () => {
        const ctrl = new AbortController();
        ctrl.abort();
        const chain: InvokeConfig[] = [
          { provider: "openrouter", model: "xiaomi/mimo-v2.5", prompt: "hi" },
        ];
        await assert.rejects(
          () =>
            invokeModelWithFallback(
              chain,
              createRunInvocationContext(),
              ctrl.signal,
            ),
          (err: unknown) => {
            assert.ok(err instanceof InvokerError);
            assert.equal((err as InvokerError).kind, "cancelled");
            return true;
          },
        );
      },
    ),
  );
});

test("cancellation populates InvokerError.attempts so callers can persist what was tried (run 097adb9c regression)", async () => {
  // Run 097adb9c shipped with providerAttempts[] empty in the receipt
  // even though invokeModelWithFallback was cancelled mid-chain. The
  // root cause was actually in the workers (they didn't extract
  // err.attempts), but the model-invoker side of the contract MUST
  // also be pinned: the InvokerError it throws on cancellation has to
  // carry a populated attempts log, otherwise the workers have nothing
  // to extract. This test pins both halves: the cancelled outcome
  // appears AND the entry has the right provider/model identity.
  process.env.OPENROUTER_API_KEY = "test";

  await withFreshCwd(() =>
    withStubbedFetch(
      async () => {
        throw new Error("fetch should not be called when signal is pre-aborted");
      },
      async () => {
        const ctrl = new AbortController();
        ctrl.abort();
        const chain: InvokeConfig[] = [
          { provider: "openrouter", model: "xiaomi/mimo-v2.5", prompt: "hi" },
          { provider: "minimax", model: "minimax-coding", prompt: "hi" },
        ];
        await assert.rejects(
          () => invokeModelWithFallback(chain, createRunInvocationContext(), ctrl.signal),
          (err: unknown) => {
            assert.ok(err instanceof InvokerError);
            const ie = err as InvokerError;
            assert.equal(ie.kind, "cancelled");
            assert.ok(Array.isArray(ie.attempts), "InvokerError.attempts must be populated for cancellation");
            assert.ok(ie.attempts!.length >= 1, "at least one cancelled attempt must be recorded");
            assert.equal(ie.attempts![0]!.outcome, "cancelled");
            assert.equal(ie.attempts![0]!.provider, "openrouter");
            assert.equal(ie.attempts![0]!.model, "xiaomi/mimo-v2.5");
            return true;
          },
        );
      },
    ),
  );
});

test("cancelled outcome does NOT increment circuit breaker", async () => {
  // Cancellation is caller-initiated and must not penalize the provider.
  // Documented in invokeModel at line 411 ("don't penalize CB for
  // cancelled") and in the fallback-chain cancel branch (no cbFail
  // call). Confirm the persisted CB state stays clean after a cancel.
  process.env.OPENROUTER_API_KEY = "test";

  await withFreshCwd(() =>
    withStubbedFetch(
      async () => {
        throw new Error("fetch should not be called when signal is pre-aborted");
      },
      async () => {
        const ctrl = new AbortController();
        ctrl.abort();
        const chain: InvokeConfig[] = [
          { provider: "openrouter", model: "xiaomi/mimo-v2.5", prompt: "hi" },
        ];
        await assert.rejects(
          () => invokeModelWithFallback(chain, createRunInvocationContext(), ctrl.signal),
          (err: unknown) => err instanceof InvokerError,
        );
        const cbStatePath = join(process.cwd(), ".aedis/circuit-breaker-state.json");
        if (existsSync(cbStatePath)) {
          const state = JSON.parse(readFileSync(cbStatePath, "utf-8"));
          assert.equal(
            state.providers?.openrouter,
            undefined,
            "openrouter must not be penalized for cancellation",
          );
        }
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
