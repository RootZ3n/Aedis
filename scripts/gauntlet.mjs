#!/usr/bin/env node
/**
 * Aedis Practical Gauntlet Runner
 *
 * Runs all gauntlet test suites, collects results, and produces:
 *   - machine-readable JSON report at .aedis/gauntlet-report.json
 *   - human-readable text report on stdout
 *
 * Usage:
 *   node scripts/gauntlet.mjs          # deterministic fixture mode
 *   AEDIS_GAUNTLET_LIVE=1 node scripts/gauntlet.mjs   # + live provider smoke
 *   AEDIS_GAUNTLET_KEEP=1 node scripts/gauntlet.mjs   # keep fixture repos
 *
 * Exit codes:
 *   0 — all suites passed
 *   1 — at least one failure
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

const LIVE = process.env.AEDIS_GAUNTLET_LIVE === "1";

const SUITES = [
  { name: "docs",      file: "test/practical/gauntlet-docs.test.ts",      category: "Tiny docs tasks" },
  { name: "code",      file: "test/practical/gauntlet-code.test.ts",      category: "Simple code tasks" },
  { name: "multifile", file: "test/practical/gauntlet-multifile.test.ts",  category: "Multi-file tasks" },
  { name: "refusal",   file: "test/practical/gauntlet-refusal.test.ts",   category: "Refusal/clarification" },
  { name: "garbage",   file: "test/practical/gauntlet-garbage.test.ts",   category: "Garbage-output detection" },
  { name: "control",   file: "test/practical/gauntlet-control.test.ts",   category: "Run control" },
  { name: "perf",      file: "test/practical/gauntlet-perf.test.ts",      category: "Performance measurement" },
];

if (LIVE) {
  SUITES.push({ name: "live", file: "test/practical/gauntlet-live.test.ts", category: "Live provider smoke" });
}

function runSuite(suite) {
  return new Promise((resolve) => {
    const child = spawn("npx", ["tsx", "--test", suite.file], {
      cwd: repoRoot,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => { stdout += String(b); });
    child.stderr.on("data", (b) => { stderr += String(b); });
    child.on("close", (code) => {
      resolve({ suite, ok: code === 0, code: code ?? -1, stdout, stderr });
    });
    child.on("error", (err) => {
      resolve({ suite, ok: false, code: -1, stdout, stderr: stderr + "\n" + String(err) });
    });
  });
}

function tailLines(s, n) {
  if (!s) return "";
  return s.split("\n").slice(-n).join("\n");
}

async function main() {
  const start = Date.now();
  console.log("Aedis Practical Gauntlet");
  console.log("=".repeat(72));
  console.log(`Suites: ${SUITES.length}  Live mode: ${LIVE}`);
  console.log("");

  const results = [];
  for (const suite of SUITES) {
    process.stdout.write(`  Running ${suite.name}...`);
    const result = await runSuite(suite);
    const status = result.ok ? "PASS" : "FAIL";
    console.log(` ${status}`);
    results.push(result);
  }

  console.log("");
  console.log("-".repeat(72));

  const passed = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok).length;
  const allPassed = failed === 0;

  console.log(`Results: ${passed}/${results.length} suites passed`);
  console.log("");

  for (const r of results) {
    const tag = r.ok ? "PASS" : "FAIL";
    console.log(`  [${tag}] ${r.suite.name} — ${r.suite.category}`);
    if (!r.ok) {
      console.log(`         Exit code: ${r.code}`);
      console.log("         Tail of output:");
      const tail = tailLines(r.stdout || r.stderr, 20);
      for (const line of tail.split("\n")) {
        console.log(`           ${line}`);
      }
    }
  }

  // Write machine-readable report.
  const reportDir = join(repoRoot, ".aedis");
  if (!existsSync(reportDir)) mkdirSync(reportDir, { recursive: true });

  const report = {
    timestamp: new Date().toISOString(),
    durationMs: Date.now() - start,
    live: LIVE,
    totalSuites: SUITES.length,
    passed,
    failed,
    suites: results.map(r => ({
      name: r.suite.name,
      category: r.suite.category,
      file: r.suite.file,
      status: r.ok ? "PASS" : "FAIL",
      exitCode: r.code,
      tailOutput: tailLines(r.stdout || r.stderr, 30),
    })),
    readiness: {
      practical_gauntlet_green: allPassed,
      live_smoke_green: LIVE && allPassed,
    },
  };

  writeFileSync(
    join(reportDir, "gauntlet-report.json"),
    JSON.stringify(report, null, 2) + "\n",
    "utf-8",
  );

  console.log("");
  console.log("-".repeat(72));
  console.log(`practical_gauntlet_green: ${allPassed}`);
  if (LIVE) {
    console.log(`live_smoke_green:        ${allPassed}`);
  }
  console.log(`Report: .aedis/gauntlet-report.json`);
  console.log(`Duration: ${Date.now() - start}ms`);

  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error(`gauntlet runner failed: ${err?.message ?? err}`);
  process.exit(1);
});
