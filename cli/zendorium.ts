#!/usr/bin/env node

import { existsSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";

import { TerminalStream, streamSocket } from "./stream.js";

// Override either via env to point at a remote Zendorium (e.g. tailscale-served).
// WS_URL defaults to API_BASE with the scheme swapped + /ws appended.
//   ZENDORIUM_API_BASE=https://mushin.tail8bb475.ts.net/zendorium zendorium health
const API_BASE = process.env["ZENDORIUM_API_BASE"] ?? "http://localhost:18796";
const WS_URL = process.env["ZENDORIUM_WS_URL"] ?? API_BASE.replace(/^http(s?):/, "ws$1:") + "/ws";

type Command = "run" | "status" | "runs" | "workers" | "health";

interface ParsedArgs {
  command: Command;
  args: string[];
  repo: string | undefined;
  watch: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  if (!argv.length) return { command: "health", args: [], repo: undefined, watch: false };

  // Detect command first (or fall through to "run").
  const known = new Set<Command>(["run", "status", "runs", "workers", "health"]);
  const first = argv[0] as Command;
  let command: Command;
  let rest: string[];
  if (known.has(first)) {
    command = first;
    rest = argv.slice(1);
  } else {
    command = "run";
    rest = argv;
  }

  // Extract --repo / --watch flags out of `rest`. Anything not a flag is positional.
  // Supports both `--repo <path>` and `--repo=<path>` styles. --watch is boolean.
  // Both flags are silently ignored when used with non-run commands — they have
  // no meaning for status/runs/workers/health.
  let repo: string | undefined;
  let watch = false;
  const positional: string[] = [];

  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (tok === "--watch") {
      watch = true;
      continue;
    }
    if (tok === "--repo") {
      const next = rest[i + 1];
      if (next === undefined || next.startsWith("--")) {
        process.stderr.write("--repo requires a path argument\n");
        process.exit(2);
      }
      repo = next;
      i++; // consume the value token
      continue;
    }
    if (tok.startsWith("--repo=")) {
      repo = tok.slice("--repo=".length);
      continue;
    }
    positional.push(tok);
  }

  return { command, args: positional, repo, watch };
}

function usage(): string {
  return [
    "zendorium \"fix the auth bug in login.ts\"",
    "zendorium run \"add dark mode to settings\" [--repo <path>] [--watch]",
    "zendorium status <run_id>",
    "zendorium runs",
    "zendorium workers",
    "zendorium health",
    "",
    "Run options:",
    "  --repo <path>   Build against a specific repo (default: cwd)",
    "  --watch         Tail systemd journal for zendorium during the run",
  ].join("\n");
}

// ─── HTTP helpers ────────────────────────────────────────────────────

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

function extractCostUsd(payload: any): number {
  // GET /tasks/:id/receipts returns a DOUBLE-NESTED shape:
  //   { task_id, receipt: { taskId, runId, receiptId, receipt: { totalCost: {...} } } }
  // The outer wrapper is added by the route handler; the inner is the
  // receipt event payload. The first check below targets that real shape.
  // The remaining checks are kept as defensive fallbacks for older code paths.
  const candidates = [
    payload?.receipt?.receipt?.totalCost?.estimatedCostUsd,
    payload?.receipt?.receipt?.total_cost?.estimatedCostUsd,
    payload?.receipt?.totalCost?.estimatedCostUsd,
    payload?.receipt?.total_cost?.estimatedCostUsd,
    payload?.active_run?.total_cost?.estimatedCostUsd,
    payload?.tracked?.cost?.estimatedCostUsd,
    payload?.tracked?.total_cost?.estimatedCostUsd,
    payload?.total_cost?.estimatedCostUsd,
    payload?.cost?.estimatedCostUsd,
  ];

  // Look for a positive value, not just any finite value. Otherwise a
  // shallow `0` from an unpopulated field short-circuits the lookup before
  // a deeper path with real data gets a chance to match.
  for (const value of candidates) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }

  return 0;
}

// ─── Journal Tail (--watch) ──────────────────────────────────────────

// Lines containing any of these substrings are dropped from the tail
// output. Matches the user's intended `grep -v` filter exactly.
const JOURNAL_FILTER = /req-|favicon|websocket|level/;

/**
 * Spawn `journalctl -u zendorium -f --since now` and stream its stdout
 * to the CLI's stdout, line-by-line, dropping lines that match the
 * JOURNAL_FILTER regex (req-/favicon/websocket/level noise).
 *
 * Returns the spawned ChildProcess so the caller can kill it when the
 * run completes. Returns null if spawn fails (e.g., journalctl not on
 * PATH, non-systemd host) — the run should continue without the tail
 * in that case rather than crash.
 */
function startJournalTail(): ChildProcess | null {
  let child: ChildProcess;
  try {
    child = spawn("journalctl", ["-u", "zendorium", "-f", "--since", "now"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    process.stderr.write(
      `[watch] failed to spawn journalctl: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return null;
  }

  // Buffer stdout chunks and split on newlines so we can apply the
  // filter line-by-line. Without buffering, a single chunk could split
  // a line in two and the filter would miss matches that span the boundary.
  let stdoutBuf = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutBuf += chunk.toString("utf8");
    let nl: number;
    while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
      const line = stdoutBuf.slice(0, nl);
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (line.length === 0) continue;
      if (JOURNAL_FILTER.test(line)) continue;
      process.stdout.write(`[journal] ${line}\n`);
    }
  });

  // stderr from journalctl is usually startup errors (permission denied,
  // unit not found). Surface it once so the operator knows the tail isn't
  // working, then let the run proceed without the tail.
  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8").trim();
    if (text) process.stderr.write(`[watch] journalctl stderr: ${text}\n`);
  });

  child.on("error", (err) => {
    process.stderr.write(`[watch] journalctl unavailable: ${err.message}\n`);
  });

  child.on("exit", (code, signal) => {
    // SIGTERM is our own clean shutdown — don't report it as an error.
    if (signal === "SIGTERM" || signal === "SIGKILL") return;
    if (code !== null && code !== 0) {
      process.stderr.write(`[watch] journalctl exited with code=${code}\n`);
    }
  });

  return child;
}

// ─── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const { command, args } = parsed;

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

  // ── Run command (POST task → WebSocket stream) ─────────────────

  const prompt = args.join(" ").trim();
  if (!prompt) {
    process.stderr.write(usage() + "\n");
    process.exitCode = 1;
    return;
  }

  // Resolve --repo (or default to cwd) and validate it exists before
  // we touch the network. Failing here saves a wasted POST and gives
  // the user a clearer error than the server's "path not found".
  let repoPath: string;
  if (parsed.repo) {
    if (!existsSync(parsed.repo)) {
      process.stderr.write(`zendorium: --repo path does not exist: ${parsed.repo}\n`);
      process.exitCode = 1;
      return;
    }
    repoPath = parsed.repo;
  } else {
    repoPath = process.cwd();
  }

  // Start the journal tail BEFORE the POST so the operator can see the
  // server-side log lines as the request lands. The tail uses --since now
  // to skip historical entries, so we'll only see entries from this point
  // forward. Stays alive until the finally block at the bottom of this
  // function kills it (handles both success and exception paths).
  let journalTail: ChildProcess | null = null;
  if (parsed.watch) {
    process.stderr.write(`[watch] tailing systemd journal for zendorium (filter: req-/favicon/websocket/level)\n`);
    journalTail = startJournalTail();
  }

  try {
    // Step 1: POST to /tasks to submit the build
    let taskId: string;
    try {
      process.stderr.write(`Repo: ${repoPath}\n`);
      process.stderr.write(`Submitting: ${prompt}\n`);
      const data = await fetchJson("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          repoPath,
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
      const [statusResult, receiptResult] = await Promise.allSettled([
        fetchJson(`/tasks/${encodeURIComponent(taskId)}`),
        fetchJson(`/tasks/${encodeURIComponent(taskId)}/receipts`),
      ]);

      const statusData = statusResult.status === "fulfilled" ? statusResult.value : null;
      const receiptData = receiptResult.status === "fulfilled" ? receiptResult.value : null;
      const finalCostUsd = extractCostUsd(receiptData) || extractCostUsd(statusData);

      if (statusData && (statusData.status === "complete" || statusData.status === "failed" || statusData.status === "partial" || statusData.status === "cancelled")) {
        const display = statusData.status === "partial" ? "complete (partial)" : statusData.status;
        process.stderr.write(`
Task ${taskId}: ${display}
`);
        process.stderr.write(`Cost: $${finalCostUsd.toFixed(4)}\n`);
        if (statusData.error) {
          process.stderr.write(`Error: ${statusData.error}
`);
        }
      }
    } catch {
      // Non-fatal — final summary already printed by stream
    }
  } finally {
    // Always kill the journal tail when the run finishes, regardless of
    // success or failure. SIGTERM gives journalctl a chance to flush any
    // buffered output cleanly. The exit handler in startJournalTail
    // recognizes SIGTERM as our own clean shutdown and stays quiet.
    if (journalTail) {
      try {
        journalTail.kill("SIGTERM");
      } catch {
        // Already exited or unkillable — nothing to do.
      }
    }
  }
}

void main();
