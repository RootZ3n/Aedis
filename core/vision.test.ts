/**
 * Vision opt-in regression.
 *
 * Pre-fix: core/vision.ts hardcoded `OLLAMA_VISION_MODEL` to
 * "qwen3-vl:8b" as a default. Aedis's post-run vision check
 * (gated only by AEDIS_VISION=true) silently invoked that model on
 * every run, kept it loaded, and consumed VRAM after the user
 * removed it from Ollama. The recent cancellation validation
 * surfaced this as a journal log:
 *   {"error":"model 'qwen3-vl:8b' not found"}
 *
 * Post-fix invariants pinned by these tests:
 *   1. captureAndAnalyze returns {skipped:true} (no fetch, no
 *      browser launch) when AEDIS_VISION_MODEL / OLLAMA_VISION_MODEL
 *      are both unset.
 *   2. captureAndAnalyze returns {skipped:true} when the configured
 *      model is not in `ollama list` (queried via /api/tags).
 *   3. The pre-check reads /api/tags, not /api/chat — no expensive
 *      load until availability is confirmed.
 *   4. AEDIS_VISION_MODEL takes precedence over the legacy
 *      OLLAMA_VISION_MODEL alias.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { captureAndAnalyze, visionSkipped, __testOnly } from "./vision.js";

type FetchHandler = (url: string, init?: RequestInit) => Promise<Response>;

function withStubbedFetch(handler: FetchHandler, fn: () => Promise<void>): Promise<void> {
  const originalFetch = globalThis.fetch;
  (globalThis as unknown as { fetch: FetchHandler }).fetch = (input, init) =>
    handler(typeof input === "string" ? input : String(input), init ?? {});
  return fn().finally(() => {
    globalThis.fetch = originalFetch;
  });
}

function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

function tagsResponse(modelNames: string[]): Response {
  return new Response(
    JSON.stringify({ models: modelNames.map((n) => ({ name: n })) }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

// ─── Configuration resolution ───────────────────────────────────────

test("vision: AEDIS_VISION_MODEL takes precedence over legacy OLLAMA_VISION_MODEL", async () => {
  await withEnv(
    { AEDIS_VISION_MODEL: "new-model:1b", OLLAMA_VISION_MODEL: "old-model:1b" },
    async () => {
      assert.equal(__testOnly.configuredVisionModel(), "new-model:1b");
    },
  );
});

test("vision: legacy OLLAMA_VISION_MODEL is honored when AEDIS_VISION_MODEL is unset", async () => {
  await withEnv(
    { AEDIS_VISION_MODEL: undefined, OLLAMA_VISION_MODEL: "legacy-model:4b" },
    async () => {
      assert.equal(__testOnly.configuredVisionModel(), "legacy-model:4b");
    },
  );
});

test("vision: configuredVisionModel returns null when both env vars are unset", async () => {
  await withEnv(
    { AEDIS_VISION_MODEL: undefined, OLLAMA_VISION_MODEL: undefined },
    async () => {
      assert.equal(__testOnly.configuredVisionModel(), null);
    },
  );
});

test("vision: configuredVisionModel ignores empty/whitespace env values", async () => {
  await withEnv(
    { AEDIS_VISION_MODEL: "   ", OLLAMA_VISION_MODEL: undefined },
    async () => {
      assert.equal(__testOnly.configuredVisionModel(), null);
    },
  );
});

// ─── captureAndAnalyze: skipped paths ───────────────────────────────

test("vision: captureAndAnalyze returns skipped when no model is configured (no fetch, no browser)", async () => {
  await withEnv(
    { AEDIS_VISION_MODEL: undefined, OLLAMA_VISION_MODEL: undefined },
    async () => {
      let fetchCalls = 0;
      await withStubbedFetch(
        async () => {
          fetchCalls += 1;
          throw new Error("fetch must NOT be called when no vision model is configured");
        },
        async () => {
          const result = await captureAndAnalyze("http://localhost:18796", "anything");
          assert.equal(result.skipped, true);
          assert.equal(result.analysis, null);
          assert.equal(result.model, null);
          assert.match(result.reason ?? "", /AEDIS_VISION_MODEL not configured/);
        },
      );
      assert.equal(fetchCalls, 0, "no fetch must occur on the skipped-by-config path");
    },
  );
});

test("vision: captureAndAnalyze returns skipped when configured model is not installed in Ollama", async () => {
  // The exact bug shape: AEDIS_VISION_MODEL points at a model that
  // isn't in `ollama list`. Pre-fix this would proceed to /api/chat
  // and get the cryptic "model 'qwen3-vl:8b' not found" response;
  // post-fix the pre-check at /api/tags catches it cleanly.
  await withEnv(
    { AEDIS_VISION_MODEL: "qwen3-vl:8b", OLLAMA_VISION_MODEL: undefined },
    async () => {
      let chatCalled = false;
      await withStubbedFetch(
        async (url) => {
          if (url.includes("/api/tags")) {
            return tagsResponse(["other-model:7b", "qwen3.5:9b"]); // qwen3-vl:8b NOT present
          }
          if (url.includes("/api/chat")) {
            chatCalled = true;
            throw new Error("chat must NOT be called when model is not installed");
          }
          throw new Error(`unexpected URL ${url}`);
        },
        async () => {
          const result = await captureAndAnalyze("http://localhost:18796", "anything");
          assert.equal(result.skipped, true);
          assert.equal(result.model, "qwen3-vl:8b", "skip reason carries the configured model identity");
          assert.match(result.reason ?? "", /not installed in Ollama/);
          assert.match(result.reason ?? "", /will not auto-pull/);
        },
      );
      assert.equal(chatCalled, false, "no /api/chat call when pre-check fails");
    },
  );
});

test("vision: captureAndAnalyze skips cleanly when /api/tags is unreachable (Ollama down)", async () => {
  // If Ollama itself is down, the pre-check fetch rejects. We treat
  // that the same as "model not installed" — skip cleanly, never
  // proceed to launch puppeteer or call /api/chat.
  await withEnv(
    { AEDIS_VISION_MODEL: "qwen3-vl:4b", OLLAMA_VISION_MODEL: undefined },
    async () => {
      let chatCalled = false;
      await withStubbedFetch(
        async (url) => {
          if (url.includes("/api/tags")) {
            throw new TypeError("fetch failed: connection refused");
          }
          if (url.includes("/api/chat")) {
            chatCalled = true;
            throw new Error("chat must NOT be called when Ollama is unreachable");
          }
          throw new Error(`unexpected URL ${url}`);
        },
        async () => {
          const result = await captureAndAnalyze("http://localhost:18796", "anything");
          assert.equal(result.skipped, true);
          assert.match(result.reason ?? "", /not installed in Ollama/);
        },
      );
      assert.equal(chatCalled, false);
    },
  );
});

test("vision: isOllamaModelAvailable returns false on non-200 from /api/tags", async () => {
  await withStubbedFetch(
    async () => new Response("server error", { status: 500 }),
    async () => {
      const ok = await __testOnly.isOllamaModelAvailable("any-model:1b");
      assert.equal(ok, false);
    },
  );
});

test("vision: isOllamaModelAvailable returns true when the model name is in the tag list", async () => {
  await withStubbedFetch(
    async (url) => {
      assert.match(url, /\/api\/tags$/);
      return tagsResponse(["qwen3-vl:4b", "qwen3.5:9b", "other:1b"]);
    },
    async () => {
      const ok = await __testOnly.isOllamaModelAvailable("qwen3-vl:4b");
      assert.equal(ok, true);
    },
  );
});

test("vision: isOllamaModelAvailable matches by exact name (no fuzzy/family fallback)", async () => {
  // Defensive: don't accidentally treat qwen3-vl:8b as available
  // because qwen3-vl:4b is installed. The user removed the 8b
  // variant deliberately; we must not silently substitute.
  await withStubbedFetch(
    async () => tagsResponse(["qwen3-vl:4b"]),
    async () => {
      const ok = await __testOnly.isOllamaModelAvailable("qwen3-vl:8b");
      assert.equal(ok, false);
    },
  );
});

test("vision: visionSkipped helper builds the canonical skip shape", () => {
  const r = visionSkipped("test reason", "some-model:1b");
  assert.equal(r.skipped, true);
  assert.equal(r.reason, "test reason");
  assert.equal(r.model, "some-model:1b");
  assert.equal(r.analysis, null);

  const noModel = visionSkipped("no model");
  assert.equal(noModel.model, null);
});
