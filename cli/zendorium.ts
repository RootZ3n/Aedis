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

// ─── HTTP fetch for query commands ───────────────────────────────────

async function fetchJson(path: string): Promise<unknown> {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText} — ${url}\n${body}`);
  }
  return res.json();
}

function formatJson(data: unknown): string {
  return JSON.stringify(data, null, 2);
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

  // Commands that use HTTP endpoints directly
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
      process.stdout.write(formatJson(data) + "\n");
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
      const data = await fetchJson(`/runs/${encodeURIComponent(runId)}`);
      process.stdout.write(formatJson(data) + "\n");
    } catch (err) {
      process.stderr.write(`zendorium status: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    }
    return;
  }

  // "run" command — uses WebSocket for live streaming
  const prompt = args.join(" ").trim();
  if (!prompt) {
    process.stderr.write(usage() + "\n");
    process.exitCode = 1;
    return;
  }

  const stream = new TerminalStream();
  const request = {
    type: "run",
    prompt,
    input: prompt,
    request: prompt,
    client: "zendorium-cli",
  };

  try {
    const socket = new WebSocket(WS_URL);
    await streamSocket(socket, stream, {
      request,
      closeOnComplete: false,
    });
  } catch (error) {
    const msg = error instanceof Error
      ? error.message
      : typeof error === "object" && error !== null && "message" in error
        ? String((error as any).message)
        : String(error);
    process.stderr.write(`zendorium: connection failed: ${msg}\n`);
    process.stderr.write(`  Is the Zendorium server running at ${WS_URL}?\n`);
    process.exitCode = 1;
  }
}

void main();
