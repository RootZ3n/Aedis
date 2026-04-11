import puppeteer from "puppeteer";

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
const OLLAMA_VISION_MODEL = process.env.OLLAMA_VISION_MODEL ?? "qwen3-vl";

interface OllamaChatResponse {
  message?: {
    content?: string;
  };
}

export async function captureAndAnalyze(url: string, question: string): Promise<string> {
  const browser = await puppeteer.launch({ headless: true });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    await page.goto(url, { waitUntil: "networkidle2", timeout: 60_000 });

    const screenshot = await page.screenshot({ type: "png", fullPage: true, encoding: "base64" });
    const analysis = await analyzeScreenshot(String(screenshot), question);
    return analysis;
  } finally {
    await browser.close();
  }
}

async function analyzeScreenshot(base64Png: string, question: string): Promise<string> {
  const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OLLAMA_VISION_MODEL,
      stream: false,
      messages: [
        {
          role: "user",
          content: question,
          images: [base64Png],
        },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Ollama vision request failed: ${response.status} ${response.statusText}${body ? `\n${body}` : ""}`);
  }

  const data = (await response.json()) as OllamaChatResponse;
  const content = data.message?.content?.trim();

  if (!content) {
    throw new Error(`Ollama vision request returned no content for model ${OLLAMA_VISION_MODEL}.`);
  }

  return content;
}
