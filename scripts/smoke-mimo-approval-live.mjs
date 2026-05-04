#!/usr/bin/env node
/**
 * Live release smoke for the default hot path:
 *   real temp git repo -> real OpenRouter Mimo Builder/Critic ->
 *   one-file diff -> AWAITING_APPROVAL -> sticky review bar visible.
 *
 * Required env:
 *   OPENROUTER_API_KEY
 *
 * Optional env:
 *   AEDIS_LIVE_SMOKE_PORT
 */
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import puppeteer from "puppeteer";

const root = process.cwd();
const port = Number(process.env.AEDIS_LIVE_SMOKE_PORT || 18991);
const base = `http://127.0.0.1:${port}`;
const serverEntry = process.env.AEDIS_LIVE_SMOKE_SERVER_ENTRY || "server/index.ts";
const pollTimeoutMs = Number(process.env.AEDIS_LIVE_SMOKE_POLL_TIMEOUT_MS || 8 * 60_000);
const submitMode = process.env.AEDIS_LIVE_SMOKE_SUBMIT_MODE || "tasks";
const expectedMessage = process.env.AEDIS_LIVE_SMOKE_EXPECTED_MESSAGE || "hello from aedis";

if (!process.env.OPENROUTER_API_KEY) {
  console.error("[smoke:mimo-approval-live] OPENROUTER_API_KEY is required for the real Mimo smoke.");
  process.exit(2);
}

const repo = mkdtempSync(join(tmpdir(), "aedis-mimo-live-"));
const stateRoot = mkdtempSync(join(tmpdir(), "aedis-mimo-live-state-"));
const serverLogPath = join(stateRoot, "server.log");
const serverLogLines = [];
let server;
let serverExit = null;

function recordServerLog(stream, chunk) {
  const text = chunk.toString("utf8");
  appendFileSync(serverLogPath, text);
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    serverLogLines.push(`[${stream}] ${line}`);
    if (serverLogLines.length > 2000) serverLogLines.shift();
  }
  const out = stream === "stdout" ? process.stdout : process.stderr;
  out.write(chunk);
}

function lastServerLogLines(limit = 200) {
  try {
    const lines = readFileSync(serverLogPath, "utf8").split(/\r?\n/).filter(Boolean);
    return lines.slice(-limit).join("\n");
  } catch {
    return serverLogLines.slice(-limit).join("\n");
  }
}

function formatServerExit() {
  if (!serverExit) return "server is still running";
  return `server exited code=${serverExit.code ?? "null"} signal=${serverExit.signal ?? "null"}`;
}

function assertServerAlive(context) {
  if (serverExit) {
    throw new Error(`${context}: ${formatServerExit()}\nserver log: ${serverLogPath}\n${lastServerLogLines(200)}`);
  }
}

async function tracedFetch(endpoint, options = {}) {
  const url = endpoint.startsWith("http") ? endpoint : `${base}${endpoint}`;
  const method = options.method || "GET";
  console.log(`[smoke:mimo-approval-live] fetch ${method} ${url}`);
  assertServerAlive(`before ${method} ${url}`);
  try {
    const res = await fetch(url, options);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`HTTP ${res.status} ${res.statusText} from ${method} ${url}\n${body.slice(0, 4000)}`);
    }
    return res;
  } catch (error) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const message = formatErrorWithCause(error);
    throw new Error(
      `fetch failed for ${method} ${url}: ${message}\n${formatServerExit()}\nserver log: ${serverLogPath}\n${lastServerLogLines(200)}`,
    );
  }
}

function formatErrorWithCause(error) {
  if (!(error instanceof Error)) return String(error);
  const parts = [error.stack || error.message];
  let cause = error.cause;
  const seen = new Set();
  while (cause && typeof cause === "object" && !seen.has(cause)) {
    seen.add(cause);
    if (cause instanceof Error) {
      parts.push(`cause: ${cause.stack || cause.message}`);
      cause = cause.cause;
      continue;
    }
    try {
      parts.push(`cause: ${JSON.stringify(cause)}`);
    } catch {
      parts.push(`cause: ${String(cause)}`);
    }
    break;
  }
  return parts.join("\n");
}

function run(cmd, args, cwd = repo) {
  const result = spawnSync(cmd, args, { cwd, stdio: "pipe", encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout.trim();
}

async function waitForServer() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    assertServerAlive("server exited before health check");
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`server did not become healthy\nserver log: ${serverLogPath}\n${lastServerLogLines(200)}`);
}

async function pollRun(runId) {
  const deadline = Date.now() + pollTimeoutMs;
  while (Date.now() < deadline) {
    const res = await tracedFetch(`/runs/${encodeURIComponent(runId)}`);
    const body = await res.json();
    const status = dominantRunStatus(body);
    const diff = extractDiff(body);
    if (status.includes("AWAITING_APPROVAL") || /awaiting_approval/i.test(JSON.stringify(body))) {
      return { body, diff };
    }
    if (/FAILED|CANCELLED|REJECTED|ROLLBACK|NO_OP/.test(status)) {
      throw new Error(`run reached terminal non-approval state: ${status}\n${JSON.stringify(body, null, 2).slice(0, 4000)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error("run did not reach AWAITING_APPROVAL before timeout");
}

function dominantRunStatus(body) {
  const values = [
    body?.status,
    body?.phase,
    body?.verdict,
    body?.classification,
    body?.summary?.classification,
    body?.receipt?.verdict,
    body?.receipt?.humanSummary?.classification,
    body?.finalReceipt?.verdict,
    body?.finalReceipt?.humanSummary?.classification,
  ];
  return values
    .filter((value) => value !== null && value !== undefined)
    .map((value) => String(value).toUpperCase())
    .join(" ");
}

function countRealDiffLines(diff) {
  return String(diff || "").split(/\r?\n/).filter((line) => {
    if (!line) return false;
    if (line.startsWith("+++") || line.startsWith("---")) return false;
    return line.startsWith("+") || line.startsWith("-");
  }).length;
}

function isRenderableRealDiff(diff) {
  const text = String(diff || "");
  return (
    text.trim().length > 0 &&
    /^---\s+/m.test(text) &&
    /^\+\+\+\s+/m.test(text) &&
    countRealDiffLines(text) > 0
  );
}

function extractDiff(body) {
  const changes = Array.isArray(body?.changes) ? body.changes : [];
  return changes
    .map((change) => typeof change?.diff === "string" ? change.diff.replace(/\n*$/, "\n") : "")
    .filter((diff) => diff.trim())
    .join("");
}

try {
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "aedis-live-smoke", version: "0.0.0", type: "module" }, null, 2) + "\n");
  writeFileSync(join(repo, "src/message.ts"), "export const message = \"hello\";\n");
  run("git", ["init", "-q"]);
  run("git", ["config", "user.email", "aedis-smoke@example.invalid"]);
  run("git", ["config", "user.name", "Aedis Smoke"]);
  run("git", ["add", "."]);
  run("git", ["commit", "-qm", "initial"]);

  server = spawn(process.execPath, ["--import", "tsx", serverEntry], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      AEDIS_PORT: String(port),
      AEDIS_HOST: "127.0.0.1",
      AEDIS_STATE_ROOT: stateRoot,
      AEDIS_PROJECT_ROOT: repo,
      AEDIS_REQUIRE_APPROVAL: "true",
      AEDIS_AUTO_PROMOTE: "false",
      AEDIS_MODEL_PROFILE: "default",
      TAILSCALE_ONLY: "false",
    },
  });
  server.stdout.on("data", (chunk) => recordServerLog("stdout", chunk));
  server.stderr.on("data", (chunk) => recordServerLog("stderr", chunk));
  server.once("exit", (code, signal) => {
    serverExit = { code, signal };
    console.error(`[smoke:mimo-approval-live] spawned server exited code=${code ?? "null"} signal=${signal ?? "null"}`);
  });
  server.once("close", (code, signal) => {
    serverExit = { code, signal };
    console.error(`[smoke:mimo-approval-live] spawned server closed code=${code ?? "null"} signal=${signal ?? "null"}`);
  });
  server.once("error", (error) => {
    serverExit = { code: null, signal: `spawn-error:${error.message}` };
    console.error(`[smoke:mimo-approval-live] spawned server error: ${error.stack || error.message}`);
  });

  await waitForServer();

  const prompt = process.env.AEDIS_LIVE_SMOKE_PROMPT ||
    `In src/message.ts, change the exported message string from hello to ${expectedMessage}. Only edit src/message.ts.`;
  const submitEndpoint = submitMode === "loqui" ? "/tasks/loqui/unified" : "/tasks";
  const submitBody = submitMode === "loqui"
    ? { input: prompt, repoPath: repo, context: { projectRoot: repo } }
    : { prompt, repoPath: repo };
  const submit = await tracedFetch(submitEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(submitBody),
  });
  const submitted = await submit.json();
  const runId = submitted.run_id || submitted.task_id;
  if (!runId) throw new Error(`submit did not return run id: ${JSON.stringify(submitted)}`);

  const { body, diff } = await pollRun(runId);
  console.log("SMOKE DIFF:", JSON.stringify(diff));
  const serialized = JSON.stringify(body);
  if (!isRenderableRealDiff(diff)) throw new Error(`run reached approval without a renderable real diff; diff=${JSON.stringify(diff.slice(0, 500))}`);
  if (/NO-OP|no-op|no effective source change/i.test(serialized)) throw new Error("run reported no-op during live smoke");
  if (/AEDIS_BLOCKER/i.test(serialized) || /AEDIS_BLOCKER/i.test(diff)) throw new Error("run surfaced AEDIS_BLOCKER during live smoke");
  if (/critic_timeout/i.test(serialized)) throw new Error("run failed through critic_timeout during live smoke");
  if (!diff.includes(expectedMessage)) throw new Error(`diff did not contain expected message ${JSON.stringify(expectedMessage)}; diff=${JSON.stringify(diff.slice(0, 1000))}`);
  if (/execution failed/i.test(serialized) && /approval/i.test(serialized)) {
    throw new Error("contradictory approval + execution failed state detected");
  }

  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(`${base}/ui/`, { waitUntil: "networkidle0" });
  await page.evaluate((id, promptText, repoPath) => localStorage.setItem("aedis.runHistory", JSON.stringify([{
    id,
    prompt: promptText,
    repoPath,
    status: "awaiting_approval",
  }])), runId, prompt, repo);
  await page.goto(`${base}/ui/`, { waitUntil: "networkidle0" });
  const waitForApprovalAndDiff = () => page.waitForFunction(() => {
    const isVisible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const approve = document.querySelector("#approval-approve");
    const approvalVisible = (isVisible(approve) && /Approve/i.test(approve.textContent || "")) || [...document.querySelectorAll("body *")].some((el) =>
      isVisible(el) && /Review required/i.test(el.textContent || ""),
    );
    const diffBody = document.querySelector("#diff-panel-body");
    const diffText = diffBody ? diffBody.textContent || "" : "";
    const diffVisible = Boolean(
      isVisible(diffBody) &&
      !/No changes yet/i.test(diffText) &&
      !/No approvable diff/i.test(diffText) &&
      (diffBody.querySelector(".diff-line.add, .diff-line.rem") || /[+-]\s*export const message/.test(diffText))
    );
    return approvalVisible && diffVisible;
  }, { timeout: 30_000 });
  try {
    await waitForApprovalAndDiff();
  } catch (error) {
    const uiDebug = await page.evaluate(() => {
      const approval = document.querySelector("#approval-card");
      const approve = document.querySelector("#approval-approve");
      const diffBody = document.querySelector("#diff-panel-body");
      const diffFiles = document.querySelector("#diff-panel-files");
      const rect = approval ? approval.getBoundingClientRect() : null;
      return {
        approvalClass: approval ? approval.className : null,
        approvalText: approval ? approval.textContent : null,
        approveDisplay: approve ? window.getComputedStyle(approve).display : null,
        approvalTop: rect ? rect.top : null,
        diffFiles: diffFiles ? diffFiles.textContent : null,
        diffText: diffBody ? diffBody.textContent : null,
        diffHtml: diffBody ? diffBody.innerHTML.slice(0, 1000) : null,
        bodyText: document.body.textContent ? document.body.textContent.slice(0, 2000) : "",
      };
    });
    throw new Error(`UI did not show approval and diff together: ${formatErrorWithCause(error)}\n${JSON.stringify(uiDebug, null, 2)}`);
  }
  const uiDiffText = await page.$eval("#diff-panel-body", (el) => el.textContent || "");
  const reviewText = await page.evaluate(() => document.body.textContent || "");
  const box = await page.evaluate(() => {
    const approve = document.querySelector("#approval-approve");
    const card = document.querySelector("#approval-card");
    const target = approve || card;
    const rect = target ? target.getBoundingClientRect() : { top: 9999, bottom: 9999 };
    return { top: rect.top, bottom: rect.bottom, text: document.body.textContent || "" };
  });
  await page.screenshot({ path: join(stateRoot, "mimo-approval-smoke.png"), fullPage: false });
  await browser.close();

  if (!/Review required/i.test(reviewText) || !/Approve/i.test(reviewText) || !/Reject/i.test(reviewText) || !/View diff/i.test(reviewText)) {
    throw new Error(`sticky review text/buttons missing: ${reviewText}`);
  }
  if (!/[+-]\s*export const message/.test(uiDiffText)) {
    throw new Error(`approval appeared without a visible renderable diff in the UI: ${uiDiffText.slice(0, 500)}`);
  }
  if (box.top < 0 || box.top > 180) {
    throw new Error(`approval card is not obvious without scrolling; top=${box.top}`);
  }

  console.log("[smoke:mimo-approval-live] PASS");
  console.log(`[smoke:mimo-approval-live] run=${runId}`);
  console.log(`[smoke:mimo-approval-live] screenshot=${join(stateRoot, "mimo-approval-smoke.png")}`);
} catch (error) {
  console.error("[smoke:mimo-approval-live] FAIL");
  console.error(formatErrorWithCause(error));
  console.error(`[smoke:mimo-approval-live] server log: ${serverLogPath}`);
  const logs = lastServerLogLines(200);
  if (logs) console.error(logs);
  process.exitCode = 1;
} finally {
  if (server && !server.killed) server.kill("SIGTERM");
  rmSync(repo, { recursive: true, force: true });
}
