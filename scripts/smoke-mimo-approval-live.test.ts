import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const canonicalDiff = [
  "--- a/src/message.ts",
  "+++ b/src/message.ts",
  "@@",
  "-export const message = \"hello\";",
  "+export const message = \"hello from aedis\";",
  "",
].join("\n");

async function runSmoke(env: NodeJS.ProcessEnv) {
  try {
    return await execFileAsync(process.execPath, ["scripts/smoke-mimo-approval-live.mjs"], {
      cwd: process.cwd(),
      timeout: 60_000,
      maxBuffer: 1024 * 1024 * 5,
      env,
    });
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    throw new Error(`${err.message || "smoke failed"}\n${err.stdout ?? ""}\n${err.stderr ?? ""}`);
  }
}

test("smoke-mimo-approval-live reports endpoint and server logs when the spawned server closes the socket", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aedis-smoke-crash-"));
  const serverPath = join(dir, "crash-server.mjs");
  writeFileSync(
    serverPath,
    `
import http from "node:http";

const port = Number(process.env.AEDIS_PORT);
const host = process.env.AEDIS_HOST || "127.0.0.1";
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.url === "/tasks") {
    console.error("[fake-smoke-server] crashing on POST /tasks");
    req.socket.destroy();
    server.close(() => process.exit(42));
    return;
  }
  res.writeHead(404);
  res.end("not found");
});
server.listen(port, host, () => console.log("[fake-smoke-server] ready"));
`,
    "utf8",
  );

  try {
    await assert.rejects(
      execFileAsync(process.execPath, ["scripts/smoke-mimo-approval-live.mjs"], {
        cwd: process.cwd(),
        timeout: 30_000,
        env: {
          ...process.env,
          OPENROUTER_API_KEY: "test-key",
          AEDIS_LIVE_SMOKE_PORT: "19191",
          AEDIS_LIVE_SMOKE_SERVER_ENTRY: serverPath,
          AEDIS_LIVE_SMOKE_POLL_TIMEOUT_MS: "1000",
        },
      }),
      (error: unknown) => {
        const err = error as { stdout?: string; stderr?: string; message?: string };
        const output = `${err.stdout ?? ""}\n${err.stderr ?? ""}\n${err.message ?? ""}`;
        assert.match(output, /fetch failed for POST http:\/\/127\.0\.0\.1:19191\/tasks/);
        assert.match(output, /server log:/);
        assert.match(output, /\[fake-smoke-server\] crashing on POST \/tasks/);
        assert.match(output, /server (exited|closed) code=42/);
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("smoke-mimo-approval-live accepts canonical changes diff and visible approval UI", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aedis-smoke-pass-"));
  const serverPath = join(dir, "approval-server.mjs");
  writeFileSync(
    serverPath,
    `
import http from "node:http";

const port = Number(process.env.AEDIS_PORT);
const host = process.env.AEDIS_HOST || "127.0.0.1";
const diff = ${JSON.stringify(canonicalDiff)};
const html = \`<!doctype html>
<html>
  <body>
    <section id="approval-card">
      <span>Review required</span>
      <button id="approval-approve">Approve</button>
      <button id="approval-reject">Reject</button>
      <button id="approval-view-full">View diff</button>
    </section>
    <div id="diff-panel-body">+ export const message = "hello from aedis";</div>
  </body>
</html>\`;

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.url === "/tasks" && req.method === "POST") {
    req.resume();
    res.writeHead(202, { "content-type": "application/json" });
    res.end(JSON.stringify({ run_id: "run-smoke-pass", task_id: "task-smoke-pass" }));
    return;
  }
  if (req.url === "/runs/run-smoke-pass") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "run-smoke-pass",
      runId: "run-smoke-pass",
      status: "AWAITING_APPROVAL",
      summary: { classification: "PARTIAL_SUCCESS" },
      changes: [{ path: "src/message.ts", operation: "modify", diff }],
    }));
    return;
  }
  if (req.url === "/ui/" || req.url === "/ui/index.html" || req.url === "/") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(html);
    return;
  }
  res.writeHead(404);
  res.end("not found");
});
server.listen(port, host, () => console.log("[fake-smoke-server] ready"));
`,
    "utf8",
  );

  try {
    const result = await runSmoke({
        ...process.env,
        OPENROUTER_API_KEY: "test-key",
        AEDIS_LIVE_SMOKE_PORT: "19192",
        AEDIS_LIVE_SMOKE_SERVER_ENTRY: serverPath,
        AEDIS_LIVE_SMOKE_POLL_TIMEOUT_MS: "1000",
    });
    const output = `${result.stdout}\n${result.stderr}`;
    assert.match(output, /SMOKE DIFF:/);
    assert.match(output, /--- a\/src\/message\.ts/);
    assert.match(output, /hello from aedis/);
    assert.match(output, /\[smoke:mimo-approval-live\] PASS/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("smoke-mimo-approval-live waits for actual UI to fetch canonical diff before approval passes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aedis-smoke-ui-async-"));
  const serverPath = join(dir, "approval-ui-server.mjs");
  const uiHtml = readFileSync(join(process.cwd(), "ui/index.html"), "utf8");
  writeFileSync(
    serverPath,
    `
import http from "node:http";

const port = Number(process.env.AEDIS_PORT);
const host = process.env.AEDIS_HOST || "127.0.0.1";
const diff = ${JSON.stringify(canonicalDiff)};
const uiHtml = ${JSON.stringify(uiHtml)};
const run = {
  id: "run-smoke-ui-async",
  runId: "run-smoke-ui-async",
  taskId: "task-smoke-ui-async",
  prompt: "change src/message.ts",
  status: "AWAITING_APPROVAL",
  summary: { classification: "PARTIAL_SUCCESS", headline: "Review required", verification: "passed" },
  changes: [{ path: "src/message.ts", operation: "modify", diff }],
};

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.url === "/tasks" && req.method === "POST") {
    req.resume();
    res.writeHead(202, { "content-type": "application/json" });
    res.end(JSON.stringify({ run_id: run.runId, task_id: run.taskId }));
    return;
  }
  if (req.url === "/runs?limit=20") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ runs: [{ runId: run.runId, id: run.id, status: run.status, prompt: run.prompt }] }));
    return;
  }
  if (req.url === "/runs/run-smoke-ui-async") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(run));
    return;
  }
  if (req.url === "/metrics") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ successRate: 1, successfulRuns: 1, failedRuns: 0, partialRuns: 0, avgConfidence: 1, avgCostPerRunUsd: 0 }));
    return;
  }
  if (req.url === "/config/models") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ profile: "default", config: {}, registry: {} }));
    return;
  }
  if (req.url === "/ui/" || req.url === "/ui/index.html" || req.url === "/") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(uiHtml);
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});
server.listen(port, host, () => console.log("[fake-smoke-ui-server] ready"));
`,
    "utf8",
  );

  try {
    const result = await runSmoke({
        ...process.env,
        OPENROUTER_API_KEY: "test-key",
        AEDIS_LIVE_SMOKE_PORT: "19193",
        AEDIS_LIVE_SMOKE_SERVER_ENTRY: serverPath,
        AEDIS_LIVE_SMOKE_POLL_TIMEOUT_MS: "1000",
    });
    const output = `${result.stdout}\n${result.stderr}`;
    assert.match(output, /SMOKE DIFF:/);
    assert.match(output, /--- a\/src\/message\.ts/);
    assert.match(output, /hello from aedis/);
    assert.doesNotMatch(output, /No changes yet/);
    assert.match(output, /\[smoke:mimo-approval-live\] PASS/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("smoke-mimo-approval-live can submit through the Loqui unified path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aedis-smoke-loqui-"));
  const serverPath = join(dir, "approval-loqui-server.mjs");
  writeFileSync(
    serverPath,
    `
import http from "node:http";

const port = Number(process.env.AEDIS_PORT);
const host = process.env.AEDIS_HOST || "127.0.0.1";
const diff = ${JSON.stringify(canonicalDiff)};
const html = \`<!doctype html>
<html>
  <body>
    <section id="approval-card">
      <span>Review required</span>
      <button id="approval-approve">Approve</button>
      <button id="approval-reject">Reject</button>
      <button id="approval-view-full">View diff</button>
    </section>
    <div id="diff-panel-body"><div class="diff-line add">+ export const message = "hello from aedis";</div></div>
  </body>
</html>\`;

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.url === "/tasks/loqui/unified" && req.method === "POST") {
    req.resume();
    res.writeHead(202, { "content-type": "application/json" });
    res.end(JSON.stringify({ route: "build", run_id: "run-smoke-loqui", task_id: "task-smoke-loqui", status: "running" }));
    return;
  }
  if (req.url === "/runs/run-smoke-loqui") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "run-smoke-loqui",
      runId: "run-smoke-loqui",
      status: "AWAITING_APPROVAL",
      summary: { classification: "PARTIAL_SUCCESS" },
      changes: [{ path: "src/message.ts", operation: "modify", diff }],
    }));
    return;
  }
  if (req.url === "/ui/" || req.url === "/ui/index.html" || req.url === "/") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(html);
    return;
  }
  res.writeHead(404);
  res.end("not found");
});
server.listen(port, host, () => console.log("[fake-smoke-loqui-server] ready"));
`,
    "utf8",
  );

  try {
    const result = await runSmoke({
      ...process.env,
      OPENROUTER_API_KEY: "test-key",
      AEDIS_LIVE_SMOKE_PORT: "19194",
      AEDIS_LIVE_SMOKE_SERVER_ENTRY: serverPath,
      AEDIS_LIVE_SMOKE_POLL_TIMEOUT_MS: "1000",
      AEDIS_LIVE_SMOKE_SUBMIT_MODE: "loqui",
    });
    const output = `${result.stdout}\n${result.stderr}`;
    assert.match(output, /fetch POST http:\/\/127\.0\.0\.1:19194\/tasks\/loqui\/unified/);
    assert.match(output, /SMOKE DIFF:/);
    assert.match(output, /\[smoke:mimo-approval-live\] PASS/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
