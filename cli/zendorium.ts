#!/usr/bin/env node

import { TerminalStream, streamSocket } from "./stream.js";

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

async function main(): Promise<void> {
  const { command, args } = parseArgs(process.argv.slice(2));
  const stream = new TerminalStream();

  let request: Record<string, unknown>;
  switch (command) {
    case "run": {
      const prompt = args.join(" ").trim();
      if (!prompt) {
        process.stderr.write(usage() + "\n");
        process.exitCode = 1;
        return;
      }
      request = {
        type: "run",
        prompt,
        input: prompt,
        request: prompt,
        client: "zendorium-cli",
      };
      break;
    }
    case "status": {
      const runId = args[0];
      if (!runId) {
        process.stderr.write("status requires <run_id>\n");
        process.exitCode = 1;
        return;
      }
      request = { type: "status", runId, run_id: runId, client: "zendorium-cli" };
      break;
    }
    case "runs":
      request = { type: "runs", client: "zendorium-cli" };
      break;
    case "workers":
      request = { type: "workers", client: "zendorium-cli" };
      break;
    case "health":
    default:
      request = { type: "health", client: "zendorium-cli" };
      break;
  }

  try {
    const socket = new WebSocket(WS_URL);
    await streamSocket(socket, stream, {
      request,
      closeOnComplete: command !== "run",
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
