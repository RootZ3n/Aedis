#!/usr/bin/env node

import { TerminalStream, streamSocket } from "./stream.js";

const API_BASE = "http://localhost:18796";
const WS_URL = "ws://localhost:18796/ws";

type Command = "run" | "status" | "runs" | "workers" | "health";

function parseArgs(argv: string[]): { command: Command; args: string[] } {
  if (!argv.length) return { command: "health", args: [] };
  const known = new Set<Command>(["run", "status", "runs", "workers", "health"]);
  const first = argv[0] as Command;
  if (known.has(first)) return { command: first, args: argv.slice(1) };
  return { command: "run", args: argv };
}

function usage(): string {
  return [
    "zendorium \"fix the auth bug in login.ts\"",
    "zendorium run \"add dark mode to settings\"",
    "zendorium status <run_id>",
    "zendorium runs",
    "zendorium workers",
    "zendorium health",
  ].join("\n");
}

// ─���─ HTTP helpers ────────────────────────────────────────────────────

async function fetchJson(path: string, init?: RequestInit): Promise<any> {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText} — ${url}\n${body}`);
  }
  return res.json();
}

function formatHealth(data: any): string {
  const lines: string[] = [];
  lines.push(`Status:   ${data.status ?? "unknown"}`);
  lines.push(`Uptime:   ${data.uptime_human ?? "?"}`);
  lines.push(`Port:     ${data.port ?? "?"}`);
  lines.push(`Version:  ${data.version ?? "?"}`);
  lines.push("");

  if (data.workers) {
    lines.push("Workers:");
    for (const [role, info] of Object.entries<any>(data.workers)) {
      const icon = info.available ? "+" : "-";
      lines.push(`  ${icon} ${role.padEnd(12)} ${info.available ? "available" : "missing"}  (${info.count})`);
    }
    lines.push("");
  }

  if (data.websocket) {
    lines.push(`WebSocket: ${data.websocket.connected_clients} client(s) connected`);
  }

  if (data.crucibulum) {
    lines.push(`Crucibulum: ${data.crucibulum.connected ? "connected" : "not connected"}`);
  }

  return lines.join("\n");
}

function formatWorkers(data: any): string {
  const lines: string[] = [];

  if (data.summary) {
    lines.push(`Workers: ${data.summary.total_workers} total, ${data.summary.available_roles}/${data.summary.total_roles} roles staffed`);
    lines.push(`Status:  ${data.summary.fully_staffed ? "Fully staffed" : "Understaffed"}`);
    lines.push("");
  }

  if (data.pools) {
    for (const pool of data.pools) {
      const icon = pool.available ? "+" : "-";
      lines.push(`${icon} ${pool.role.padEnd(12)} ${pool.count} worker(s)`);
      for (const w of pool.workers ?? []) {
        lines.push(`    ${w.name} (${w.type})`);
      }
    }
  }

  return lines.join("\n");
}

// ─── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { command, args } = parseArgs(process.argv.slice(2));

  // ── Query commands (HTTP) ──────────────────────────────────────

  if (command === "health") {
    try {
      const data = await fetchJson("/health");
      process.stdout.write(formatHealth(data) + "\n");
    } catch (err) {
      process.stderr.write(`zendorium health: ${err instanceof Error ? err.message : String(err)}\n`);
      process.stderr.write(`  Is the Zendorium server running at ${API_BASE}?\n`);
      process.exitCode = 1;
    }
    return;
  }

  if (command === "workers") {
    try {
      const data = await fetchJson("/workers");
      process.stdout.write(formatWorkers(data) + "\n");
    } catch (err) {
      process.stderr.write(`zendorium workers: ${err instanceof Error ? err.message : String(err)}\n`);
      process.stderr.write(`  Is the Zendorium server running at ${API_BASE}?\n`);
      process.exitCode = 1;
    }
    return;
  }

  if (command === "runs") {
    try {
      const data = await fetchJson("/runs");
      process.stdout.write(JSON.stringify(data, null, 2) + "\n");
    } catch (err) {
      process.stderr.write(`zendorium runs: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    }
    return;
  }

  if (command === "status") {
    const runId = args[0];
    if (!runId) {
      process.stderr.write("status requires <run_id>\n");
      process.exitCode = 1;
      return;
    }
    try {
      const data = await fetchJson(`/tasks/${encodeURIComponent(runId)}`);
      process.stdout.write(JSON.stringify(data, null, 2) + "\n");
    } catch (err) {
      process.stderr.write(`zendorium status: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    }
    return;
  }

  // ── Run command (POST task → WebSocket stream) ���────────────────

  const prompt = args.join(" ").trim();
  if (!prompt) {
    process.stderr.write(usage() + "\n");
    process.exitCode = 1;
    return;
  }

  // Step 1: POST to /tasks to submit the build
  let taskId: string;
  try {
    process.stderr.write(`Submitting: ${prompt}\n`);
    const data = await fetchJson("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt,
        repoPath: process.cwd(),
      }),
    });
    taskId = data.task_id;
    process.stderr.write(`Task ${taskId} accepted. Connecting to live stream...\n`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`zendorium: failed to submit task: ${msg}\n`);
    process.stderr.write(`  Is the Zendorium server running at ${API_BASE}?\n`);
    process.exitCode = 1;
    return;
  }

  // Step 2: Connect WebSocket and subscribe to this task's events
  const stream = new TerminalStream();

  try {
    const socket = new WebSocket(WS_URL);

    await streamSocket(socket, stream, {
      // On open, send subscribe message so server filters events for this run
      request: {
        type: "subscribe",
        taskId,
        client: "zendorium-cli",
      },
      // Close when run completes or fails
      closeOnComplete: true,
      // Filter: only close on events matching our taskId
      taskId,
    });
  } catch (error) {
    const msg = error instanceof Error
      ? error.message
      : typeof error === "object" && error !== null && "message" in error
        ? String((error as any).message)
        : String(error);
    process.stderr.write(`zendorium: stream error: ${msg}\n`);
    process.exitCode = 1;
  }

  // Step 3: Print final receipt
  try {
    const data = await fetchJson(`/tasks/${encodeURIComponent(taskId)}`);
    if (data.status === "complete" || data.status === "failed") {
      process.stderr.write(`\nTask ${taskId}: ${data.status}\n`);
      if (data.error) {
        process.stderr.write(`Error: ${data.error}\n`);
      }
    }
  } catch {
    // Non-fatal — final summary already printed by stream
  }
}

void main();
