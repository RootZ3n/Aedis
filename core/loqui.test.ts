import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { answerLoqui } from "./loqui.js";

test("Loqui falls back safely when no provider is configured", async () => {
  const root = mkdtempSync(join(tmpdir(), "aedis-loqui-"));
  const previousOpenRouter = process.env.OPENROUTER_API_KEY;
  const previousOpenAI = process.env.OPENAI_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENAI_API_KEY;

  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(
      join(root, "src", "auth.ts"),
      "export function loginUser() { return 'ok'; }\n",
      "utf-8",
    );

    const result = await answerLoqui("Where is loginUser defined?", root);
    assert.match(result.answer, /couldn't reach a language provider/i);
    assert.ok(result.relatedFiles.some((file) => file.includes("auth.ts")));
    assert.equal(result.provider, null);
  } finally {
    if (previousOpenRouter) process.env.OPENROUTER_API_KEY = previousOpenRouter;
    if (previousOpenAI) process.env.OPENAI_API_KEY = previousOpenAI;
    rmSync(root, { recursive: true, force: true });
  }
});

test("Loqui falls back to the secondary provider", async () => {
  const root = mkdtempSync(join(tmpdir(), "aedis-loqui-"));
  const previousFetch = globalThis.fetch;
  const previousOpenRouter = process.env.OPENROUTER_API_KEY;
  const previousOpenAI = process.env.OPENAI_API_KEY;
  process.env.OPENROUTER_API_KEY = "primary-key";
  process.env.OPENAI_API_KEY = "secondary-key";

  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "router.ts"), "export const route = true;\n", "utf-8");

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("openrouter.ai")) {
        return new Response("upstream unavailable", { status: 503 });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: "The route flag is exported from src/router.ts." } }],
      }), { status: 200 });
    }) as typeof fetch;

    const result = await answerLoqui("Where is route exported?", root);
    assert.equal(result.provider, "openai");
    assert.match(result.answer, /src\/router\.ts/);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousOpenRouter) process.env.OPENROUTER_API_KEY = previousOpenRouter; else delete process.env.OPENROUTER_API_KEY;
    if (previousOpenAI) process.env.OPENAI_API_KEY = previousOpenAI; else delete process.env.OPENAI_API_KEY;
    rmSync(root, { recursive: true, force: true });
  }
});
