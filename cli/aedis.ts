#!/usr/bin/env node
/**
 * Aedis CLI — simple command-line interface to Aedis.
 *
 * Usage:
 *   aedis submit "fix the auth bug"          Submit a build task
 *   aedis status <task-id>                  Check task status
 *   aedis metrics                           Show cost/success metrics
 *   aedis sessions                          List active sessions
 *   aedis workers                           Worker pool status
 *   aedis health                            Server health
 *   aedis reliability run <tasks.json>      Run a reliability trial
 *   aedis reliability list                  List recorded trials
 *   aedis reliability show [<trial-id>]     Print trial JSON (latest if omitted)
 *   aedis reliability diff <prev> <curr>    Regression report between two trials
 *
 * Environment:
 *   AEDIS_API_BASE      HTTP base URL (default: http://localhost:18796)
 *   AEDIS_PROJECT_ROOT  Where state/reliability/ is written (default: cwd)
 */

import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import {
  detectRegressions,
  loadLatestTrial,
  loadPreviousTrial,
  loadTrial,
  listTrials,
  persistTrial,
  runTrial,
  type ReliabilityTask,
} from "../core/reliability-harness.js";
import { HttpTaskRunner } from "../core/reliability-runner.js";

const API_BASE = process.env["AEDIS_API_BASE"] ?? "http://localhost:18796";
const PROJECT_ROOT = process.env["AEDIS_PROJECT_ROOT"] ?? process.cwd();

// ─── HTTP helpers ────────────────────────────────────────────────────

async function fetchJson(path: string, init?: RequestInit): Promise<any> {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw Object.assign(new Error(`${res.status} ${res.statusText} — ${url}\n${body}`), { status: res.status });
  }
  return res.json();
}

function die(msg: string, code = 1): never {
  console.error(msg);
  process.exitCode = code;
  process.exit(code);
}

// ─── Formatters ───────────────────────────────────────────────────────

function fmtMetrics(data: any): string {
  const rate = ((data.successRate ?? 0) * 100).toFixed(1);
  const totalCost = `$${Number(data.totalCostUsd ?? 0).toFixed(4)}`;
  const avgCost = `$${Number(data.avgCostPerRunUsd ?? 0).toFixed(4)}`;
  const runs = data.totalRuns ?? 0;
  const ok = data.successfulRuns ?? 0;
  const fail = data.failedRuns ?? 0;
  const partial = data.partialRuns ?? 0;
  const inflight = data.inFlightRuns ?? 0;
  const conf = ((data.avgConfidence ?? 0) * 100).toFixed(0);

  const lines = [
    `Total runs:    ${runs}  (${ok} ok · ${fail} failed · ${partial} partial · ${inflight} in-flight)`,
    `Success rate:  ${rate}%`,
    `Total cost:    ${totalCost}`,
    `Avg cost/run:  ${avgCost}`,
    `Avg confidence: ${conf}%`,
    "",
    "By status:",
  ];

  for (const [k, v] of Object.entries<any>(data.byStatus ?? {})) {
    lines.push(`  ${k}: ${v.count} runs  ${`$${Number(v.totalCostUsd ?? 0).toFixed(4)}`}`);
  }

  return lines.join("\n");
}

function fmtSessions(data: any): string {
  if (!data.sessions?.length) return "No sessions.";
  return data.sessions.map((s: any) => {
    const icon = s.status === "active" ? "+" : s.status === "done" ? "·" : "-";
    const cycles = `${s.cycleCount ?? 0}/${s.maxCycles ?? "?"}`;
    const reason = s.terminalReason ? ` — ${s.terminalReason}` : "";
    return `${icon} ${String(s.id ?? "").slice(0, 8)}  ${String(s.status ?? "").padEnd(8)}  cycles:${cycles}  ${(s.intent?.userRequest ?? "").slice(0, 60)}${reason}`;
  }).join("\n");
}

function fmtTask(data: any): string {
  const lines: string[] = [
    `task_id:      ${data.task_id ?? data.taskId ?? "?"}`,
    `run_id:       ${data.run_id ?? data.runId ?? "?"}`,
    `status:       ${data.status ?? "?"}`,
    `submitted_at: ${data.submitted_at ?? data.submittedAt ?? "?"}`,
  ];
  if (data.completed_at ?? data.completedAt) lines.push(`completed_at: ${data.completed_at ?? data.completedAt}`);
  if (data.error) lines.push(`error:        ${data.error}`);
  if (data.progress) {
    lines.push(`phase:        ${data.progress.phase ?? "?"}`);
    lines.push(`tasks:        ${data.progress.completed_tasks}/${data.progress.total_tasks}`);
  }
  return lines.join("\n");
}

// ─── Commands ────────────────────────────────────────────────────────

const COMMANDS = {
  async metrics(_args: string[]) {
    const data = await fetchJson("/metrics");
    console.log(fmtMetrics(data));
  },

  async sessions(_args: string[]) {
    const data = await fetchJson("/sessions");
    console.log(fmtSessions(data));
  },

  async workers(_args: string[]) {
    const data = await fetchJson("/workers");
    if (data.pools) {
      for (const p of data.pools) {
        const icon = p.available ? "+" : "-";
        console.log(`${icon} ${String(p.role).padEnd(12)} ${p.count} worker(s)`);
      }
    }
    if (data.summary) {
      console.log(`\n${data.summary.available_roles}/${data.summary.total_roles} roles staffed  ·  ${data.summary.total_workers} total workers`);
    }
  },

  async health(_args: string[]) {
    const data = await fetchJson("/health");
    console.log(`status:   ${data.status ?? "?"}`);
    console.log(`uptime:   ${data.uptime_human ?? "?"}`);
    console.log(`port:     ${data.port ?? "?"}`);
    console.log(`version:  ${data.version ?? "?"}`);
    if (data.websocket) console.log(`ws:       ${data.websocket.connected_clients} client(s)`);
  },

  async status(args: string[]) {
    const taskId = args[0];
    if (!taskId) { console.error("status <task-id>"); process.exitCode = 1; return; }
    const data = await fetchJson(`/tasks/${encodeURIComponent(taskId)}`);
    console.log(fmtTask(data));
  },

  async reliability(args: string[]) {
    const sub = args[0];
    if (sub === "run") {
      const file = args[1];
      if (!file || !existsSync(file)) {
        die("reliability run <tasks.json> [--label <label>]");
      }
      const label = args.includes("--label")
        ? args[args.indexOf("--label") + 1] ?? "ad-hoc"
        : "ad-hoc";
      const tasks = JSON.parse(readFileSync(file, "utf8")) as ReliabilityTask[];
      if (!Array.isArray(tasks) || tasks.length === 0) {
        die(`reliability: ${file} must contain a non-empty task array`);
      }
      const runner = new HttpTaskRunner({ apiBase: API_BASE });
      const trial = await runTrial({
        runner,
        tasks,
        label,
        onProgress: (r, i) => {
          console.error(
            `  [${i + 1}/${tasks.length}] ${r.taskId}  ${r.outcome}  (${r.errorType}, ${(r.durationMs / 1000).toFixed(1)}s)`,
          );
        },
      });
      await persistTrial(PROJECT_ROOT, trial);
      const prev = await loadPreviousTrial(PROJECT_ROOT, trial);
      const regressions = prev ? detectRegressions(prev, trial) : null;

      const m = trial.metrics;
      console.log(`trial:            ${trial.trialId}`);
      console.log(`label:            ${trial.label}`);
      console.log(`total:            ${m.total}`);
      console.log(`success:          ${m.successes}  (${(m.strictSuccessRate * 100).toFixed(1)}%)`);
      console.log(`weak_success:     ${m.weakSuccesses}`);
      console.log(`failure:          ${m.failures}`);
      console.log(`avg iterations:   ${m.avgIterations.toFixed(2)}`);
      console.log(`avg cost:         $${m.avgCostUsd.toFixed(4)}`);
      console.log(
        `cost/success:     ${Number.isFinite(m.costPerSuccessUsd) ? "$" + m.costPerSuccessUsd.toFixed(4) : "n/a"}`,
      );
      if (m.errorClusters.length > 0) {
        console.log("error clusters:");
        for (const c of m.errorClusters) {
          console.log(`  ${c.errorType.padEnd(22)} ${c.count}  [${c.taskIds.join(", ")}]`);
        }
      }
      if (regressions) {
        console.log(`\nvs ${regressions.previousTrialId}:`);
        console.log(`  regressed: ${regressions.regressed}  recovered: ${regressions.recovered}  degraded: ${regressions.degraded}  improved: ${regressions.improved}`);
        for (const e of regressions.entries) {
          console.log(`  ${e.severity.padEnd(12)} ${e.taskId}  ${e.previousOutcome} → ${e.currentOutcome}`);
        }
      }
      if (m.failures > 0) process.exitCode = 2;
      return;
    }
    if (sub === "list") {
      const trials = await listTrials(PROJECT_ROOT);
      if (trials.length === 0) {
        console.log("no trials recorded");
        return;
      }
      for (const t of trials) {
        const rate = (t.metrics.strictSuccessRate * 100).toFixed(1);
        console.log(
          `${t.trialId}  ${t.label.padEnd(20)} ${t.startedAt}  ${t.metrics.total} tasks  ${rate}% strict`,
        );
      }
      return;
    }
    if (sub === "show") {
      const id = args[1];
      const trial = id
        ? await loadTrial(PROJECT_ROOT, id)
        : await loadLatestTrial(PROJECT_ROOT);
      if (!trial) die(id ? `trial not found: ${id}` : "no trials recorded");
      console.log(JSON.stringify(trial, null, 2));
      return;
    }
    if (sub === "diff") {
      const aId = args[1];
      const bId = args[2];
      if (!aId || !bId) die("reliability diff <previousTrialId> <currentTrialId>");
      const prev = await loadTrial(PROJECT_ROOT, aId);
      const curr = await loadTrial(PROJECT_ROOT, bId);
      if (!prev || !curr) die(`trial not found: ${!prev ? aId : bId}`);
      const report = detectRegressions(prev!, curr!);
      console.log(JSON.stringify(report, null, 2));
      if (report.regressed > 0) process.exitCode = 2;
      return;
    }
    console.error("reliability <run|list|show|diff>");
    process.exitCode = 1;
  },

  async submit(args: string[]) {
    const input = args.join(" ").trim();
    if (!input) { console.error("submit <prompt>"); process.exitCode = 1; return; }
    const repoPath = process.cwd();
    if (!existsSync(repoPath)) {
      console.error(`aedis: cwd does not exist: ${repoPath}`); process.exitCode = 1; return;
    }
    const data = await fetchJson("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: input, repoPath }),
    });
    if (data.status === "needs_clarification") {
      console.log("Clarification needed:", data.question);
      return;
    }
    if (data.status === "needs_decomposition") {
      console.log("Decomposition plan created:", data.message ?? "");
      console.log("task_id:", data.task_id);
      return;
    }
    console.log("task_id:", data.task_id);
    console.log("run_id: ", data.run_id);
    console.log("status: ", data.status);
  },
};

// ─── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // @ts-ignore — config is optional at runtime
  const parsed = parseArgs({ args: process.argv.slice(2), allowPositionals: true });
  const cmds = parsed.positionals;
  const cmd = cmds[0] ?? "";
  const args = cmds.slice(1);

  if (!cmd) {
    console.error("Usage: aedis <command> [args]");
    console.error("Commands: submit, status, metrics, sessions, workers, health, reliability");
    process.exitCode = 1;
    return;
  }

  const fn: ((args: string[]) => Promise<void>) | undefined = (COMMANDS as any)[cmd];
  if (!fn) {
    console.error(`Unknown command: ${cmd}`);
    console.error("Commands: submit, status, metrics, sessions, workers, health, reliability");
    process.exitCode = 1;
    return;
  }

  try {
    await fn(args);
  } catch (err: any) {
    console.error(`aedis ${cmd}: ${err?.message ?? err}`);
    process.exitCode = 1;
  }
}

main();
