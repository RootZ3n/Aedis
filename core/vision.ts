/**
 * Vision worker — optional post-build screenshot self-check.
 *
 * Captures a screenshot of the running Aedis UI and asks an Ollama
 * vision model to describe visible errors. Strictly opt-in:
 *
 *   - Coordinator gates the entire feature behind AEDIS_VISION=true.
 *     This module assumes that gate has already passed.
 *   - The model itself is named via AEDIS_VISION_MODEL (preferred) or
 *     the legacy OLLAMA_VISION_MODEL alias. There is NO default —
 *     prior versions silently fell back to qwen3-vl:8b, which kept
 *     activating after the user removed it from Ollama and ate VRAM.
 *     If neither env var is set, captureAndAnalyze returns
 *     `{skipped: true, reason: ...}` without contacting Ollama, the
 *     browser, or any remote service.
 *   - Before launching puppeteer (heavy: spawns a Chromium process)
 *     the function pre-checks Ollama's /api/tags to confirm the
 *     configured model is actually installed. If not, it skips with
 *     a clear reason — no auto-pull, no implicit fallback to a
 *     different model.
 *
 * The structured return shape lets callers distinguish "skipped on
 * purpose" from "tried and failed mid-call" — the coordinator log
 * line should differ.
 */

import puppeteer from "puppeteer";

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";

export interface VisionCheckResult {
  /** True when the check was deliberately skipped (no config, model missing, etc.). */
  readonly skipped: boolean;
  /** Skip reason for human-readable logs. Null on success. */
  readonly reason: string | null;
  /** Vision model's analysis text. Null on skip or failure. */
  readonly analysis: string | null;
  /** The model identity that was (or would have been) used. */
  readonly model: string | null;
}

/** Resolve the configured vision model. New name wins; legacy alias kept for back-compat. */
function configuredVisionModel(): string | null {
  const newName = process.env.AEDIS_VISION_MODEL?.trim();
  if (newName) return newName;
  const legacy = process.env.OLLAMA_VISION_MODEL?.trim();
  if (legacy) return legacy;
  return null;
}

/**
 * Check whether `model` is installed in the local Ollama daemon by
 * hitting /api/tags and matching against the returned name list.
 * Returns false if Ollama is unreachable or the model isn't listed —
 * never throws. The caller treats both cases the same way: skip
 * cleanly without launching the browser or invoking the vision call.
 */
async function isOllamaModelAvailable(
  model: string,
  baseUrl: string = OLLAMA_BASE_URL,
): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/api/tags`, { method: "GET" });
    if (!response.ok) return false;
    const data = (await response.json()) as { models?: Array<{ name?: string }> };
    const names = (data.models ?? []).map((m) => m.name ?? "");
    return names.includes(model);
  } catch {
    return false;
  }
}

/**
 * Build a "skipped" result without contacting any external service.
 * Exposed for tests and for callers that want to short-circuit
 * without going through captureAndAnalyze (e.g., dry-run mode).
 */
export function visionSkipped(reason: string, model: string | null = null): VisionCheckResult {
  return { skipped: true, reason, analysis: null, model };
}

/**
 * Capture a UI screenshot and ask the configured vision model about it.
 *
 * Returns a structured VisionCheckResult. Skipped paths (no model
 * configured, model not installed) do NOT throw — they return
 * `{skipped: true, reason: ...}`. Genuine mid-call failures (browser
 * launch, network, model returns empty) DO throw — those represent
 * an attempted check that didn't complete, which the coordinator
 * already catches as `console.warn("vision check failed: ...")`.
 */
export async function captureAndAnalyze(
  url: string,
  question: string,
): Promise<VisionCheckResult> {
  const model = configuredVisionModel();
  if (!model) {
    return visionSkipped(
      "AEDIS_VISION_MODEL not configured — vision check is opt-in. Set AEDIS_VISION_MODEL=<ollama-vision-model> (e.g. qwen3-vl:4b) to enable.",
    );
  }
  if (!(await isOllamaModelAvailable(model))) {
    return visionSkipped(
      `vision model "${model}" is not installed in Ollama at ${OLLAMA_BASE_URL}. Install it explicitly (\`ollama pull ${model}\`) to enable; Aedis will not auto-pull.`,
      model,
    );
  }

  // Both gates passed — launch the browser and call the model.
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    await page.goto(url, { waitUntil: "networkidle2", timeout: 60_000 });
    const screenshot = await page.screenshot({ type: "png", fullPage: true, encoding: "base64" });
    const analysis = await analyzeScreenshot(String(screenshot), question, model);
    return { skipped: false, reason: null, analysis, model };
  } finally {
    await browser.close();
  }
}

interface OllamaChatResponse {
  message?: {
    content?: string;
  };
}

async function analyzeScreenshot(
  base64Png: string,
  question: string,
  model: string,
): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60_000);

  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [
          {
            role: "system",
            content:
              "You are a precise visual analysis assistant. Answer the user's question based on the provided screenshot. Be concise and factual.",
          },
          {
            role: "user",
            content: question,
            images: [base64Png],
          },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `Ollama vision request failed: ${response.status} ${response.statusText}${body ? `\n${body}` : ""}`,
      );
    }

    const data = (await response.json()) as OllamaChatResponse;
    const content = data.message?.content?.trim();

    if (!content) {
      throw new Error(`Ollama vision request returned no content for model ${model}.`);
    }

    return content;
  } finally {
    clearTimeout(timeoutId);
  }
}

// Test-only: expose internals so tests don't have to spawn puppeteer.
export const __testOnly = {
  configuredVisionModel,
  isOllamaModelAvailable,
};
