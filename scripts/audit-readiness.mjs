#!/usr/bin/env node
/**
 * Aedis Readiness Audit — strict 4-axis report.
 *
 * Other Aedis scripts ask "did the build succeed?" or "did unit tests
 * pass?" This one asks the harder question: is Aedis actually ready
 * for an operator to use on a real repo?
 *
 * The audit splits readiness into four axes that DO NOT collapse into
 * one another:
 *
 *   1. test-green              — npm test passed (mechanics are sound)
 *   2. safety-green            — security:secrets passed (no secrets in repo)
 *   3. usability-green         — practical-smoke suite passed (the pipeline
 *                                actually completes small real tasks end-to-end
 *                                on a fixture repo, with safety gates intact)
 *   4. practical-gauntlet-green — full practical gauntlet passed (docs, code,
 *                                multi-file, refusal, garbage, control, perf)
 *   5. live-smoke-green        — operator attestation of real-provider smoke
 *   6. release-ready           — ALL of the above green
 *
 * The audit will NEVER claim release-ready on its own. The operator
 * must run their own live smoke and create the attestation file
 * (.aedis/live-smoke-attestation.json with passed=true and a recent
 * timestamp). Without that file, release-ready is FALSE no matter how
 * many unit tests pass.
 *
 * This is the answer to "we keep saying ready when real tasks fail":
 * unit-test green is not release-ready, and the script enforces that.
 *
 * Usage:
 *   node scripts/audit-readiness.mjs
 *
 * Exit codes:
 *   0 — all four axes green
 *   1 — at least one axis red (caller can branch on which)
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

const ATTESTATION_PATH = join(repoRoot, ".aedis", "live-smoke-attestation.json");
const ATTESTATION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// ── Run helpers ──────────────────────────────────────────────────────

/**
 * Run an npm script, stream nothing to stdout, capture exit code +
 * tail of output for failure reporting. We use spawn (not exec) so a
 * misbehaving script can't leak unbounded buffers.
 */
function runNpmScript(name) {
  return new Promise((resolve) => {
    const child = spawn("npm", ["run", "--silent", name], {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => { stdout += String(b); });
    child.stderr.on("data", (b) => { stderr += String(b); });
    child.on("close", (code) => {
      resolve({ ok: code === 0, code: code ?? -1, stdout, stderr });
    });
    child.on("error", (err) => {
      resolve({ ok: false, code: -1, stdout, stderr: stderr + "\n" + String(err) });
    });
  });
}

function tailLines(s, n) {
  if (!s) return "";
  const lines = s.split("\n");
  return lines.slice(-n).join("\n");
}

// ── Attestation reader ───────────────────────────────────────────────

/**
 * Read the operator's live-smoke attestation. The attestation is a
 * small JSON file the operator writes AFTER running a real-LLM smoke
 * task on their machine. The audit refuses to claim release-ready
 * without a recent passing attestation.
 *
 * Shape:
 *   {
 *     "passed": true,
 *     "at": "2026-05-01T18:00:00Z",
 *     "operator": "name or email",
 *     "tasks": ["README sentence", "helper function"],
 *     "model": "openrouter/deepseek-v4-flash",
 *     "notes": "all four tasks reached approval with visible diff"
 *   }
 */
function readAttestation() {
  if (!existsSync(ATTESTATION_PATH)) {
    return { present: false, reason: `Attestation file not found at ${ATTESTATION_PATH}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(ATTESTATION_PATH, "utf-8"));
  } catch (err) {
    return { present: true, valid: false, reason: `Attestation JSON is malformed: ${err.message}` };
  }
  if (parsed.passed !== true) {
    return { present: true, valid: false, reason: "Attestation has `passed: false` — operator marked live smoke as failed" };
  }
  if (typeof parsed.at !== "string") {
    return { present: true, valid: false, reason: "Attestation missing `at` timestamp" };
  }
  const age = Date.now() - new Date(parsed.at).getTime();
  if (!Number.isFinite(age) || age < 0) {
    return { present: true, valid: false, reason: `Attestation timestamp is invalid: ${parsed.at}` };
  }
  if (age > ATTESTATION_MAX_AGE_MS) {
    const days = Math.floor(age / (24 * 60 * 60 * 1000));
    return {
      present: true,
      valid: false,
      reason: `Attestation is ${days} days old (max ${Math.floor(ATTESTATION_MAX_AGE_MS / (24 * 60 * 60 * 1000))}); re-run live smoke and update`,
    };
  }
  return { present: true, valid: true, attestation: parsed };
}

// ── Report formatting ────────────────────────────────────────────────

function axisLine(label, status, detail) {
  const tag =
    status === "green"  ? "GREEN" :
    status === "red"    ? "RED  " :
    status === "blocked"? "BLKD " :
                          "????";
  return `  [${tag}] ${label.padEnd(18)} ${detail}`;
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  console.log("Aedis readiness audit");
  console.log("─".repeat(72));

  // Axis 1: test-green
  console.log("→ running unit test suite (npm test)…");
  const tests = await runNpmScript("test");
  const testGreen = tests.ok;

  // Axis 2: safety-green
  console.log("→ running secrets scan (npm run security:secrets)…");
  const secrets = await runNpmScript("security:secrets");
  const safetyGreen = secrets.ok;

  // Axis 3: usability-green
  // The practical-smoke suite is part of `npm test`; we re-run it on
  // its own here to surface the precise failures (and to make this
  // axis verifiable independently of the rest of the suite).
  console.log("→ running practical-smoke suite…");
  const smoke = await new Promise((resolve) => {
    const child = spawn("npx", ["tsx", "--test", "core/practical-smoke.test.ts"], {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (b) => { stdout += String(b); });
    child.stderr.on("data", (b) => { stderr += String(b); });
    child.on("close", (code) => resolve({ ok: code === 0, code: code ?? -1, stdout, stderr }));
    child.on("error", (err) => resolve({ ok: false, code: -1, stdout, stderr: stderr + "\n" + String(err) }));
  });
  const usabilityGreen = smoke.ok;

  // Axis 4: practical-gauntlet-green
  // Runs the full practical gauntlet (docs, code, multi-file, refusal,
  // garbage, control, performance) via the gauntlet runner. This is a
  // stronger signal than the practical-smoke suite: it covers every
  // category of real task we care about, including garbage detection
  // and refusal paths.
  console.log("→ running practical gauntlet (npm run gauntlet)…");
  const gauntlet = await runNpmScript("gauntlet");
  const gauntletGreen = gauntlet.ok;

  // Axis 5: live-smoke-green (attestation)
  const attestation = readAttestation();
  const liveSmokeGreen = attestation.present && attestation.valid;

  // Axis 6: release-ready = ALL axes green
  const releaseReady =
    testGreen && safetyGreen && usabilityGreen &&
    gauntletGreen && liveSmokeGreen;

  console.log("");
  console.log("Readiness axes");
  console.log("─".repeat(72));
  console.log(axisLine(
    "test-green",
    testGreen ? "green" : "red",
    testGreen ? "unit test suite passed" : `FAILED — exit ${tests.code}`,
  ));
  console.log(axisLine(
    "safety-green",
    safetyGreen ? "green" : "red",
    safetyGreen ? "secrets scan clean" : `FAILED — exit ${secrets.code}`,
  ));
  console.log(axisLine(
    "usability-green",
    usabilityGreen ? "green" : "red",
    usabilityGreen ? "practical-smoke fixture suite passed" : `FAILED — exit ${smoke.code}`,
  ));
  console.log(axisLine(
    "gauntlet-green",
    gauntletGreen ? "green" : "red",
    gauntletGreen ? "practical gauntlet passed" : `FAILED — exit ${gauntlet.code}`,
  ));
  console.log(axisLine(
    "live-smoke-green",
    liveSmokeGreen ? "green" : "blocked",
    liveSmokeGreen
      ? `verified by attestation @ ${attestation.attestation?.at}`
      : !attestation.present
        ? `BLOCKED — no attestation (${attestation.reason})`
        : `BLOCKED — invalid attestation (${attestation.reason})`,
  ));
  console.log(axisLine(
    "release-ready",
    releaseReady ? "green" : "blocked",
    releaseReady
      ? `all axes green, attestation @ ${attestation.attestation?.at}`
      : "BLOCKED — one or more upstream axes not green",
  ));

  if (!testGreen) {
    console.log("");
    console.log("Tail of unit-test output:");
    console.log(tailLines(tests.stdout || tests.stderr, 30));
  }
  if (!usabilityGreen) {
    console.log("");
    console.log("Tail of practical-smoke output:");
    console.log(tailLines(smoke.stdout || smoke.stderr, 30));
  }
  if (!gauntletGreen) {
    console.log("");
    console.log("Tail of gauntlet output:");
    console.log(tailLines(gauntlet.stdout || gauntlet.stderr, 30));
  }

  console.log("");
  console.log("─".repeat(72));
  if (releaseReady) {
    console.log("AEDIS READINESS: RELEASE-READY");
    console.log(`  attestation at: ${attestation.attestation?.at}`);
    if (attestation.attestation?.tasks) {
      console.log(`  attested tasks: ${attestation.attestation.tasks.join(", ")}`);
    }
    if (attestation.attestation?.model) {
      console.log(`  attested model: ${attestation.attestation.model}`);
    }
    process.exit(0);
  } else {
    console.log("AEDIS READINESS: NOT READY");
    const upstreamAllGreen = testGreen && safetyGreen && usabilityGreen && gauntletGreen;
    if (upstreamAllGreen) {
      console.log("");
      console.log("  All automated axes are green, but release-ready requires");
      console.log("  an operator-signed LIVE smoke attestation. Run a real-LLM");
      console.log("  task on a real repo against your provider, verify it reached");
      console.log("  approval with a visible diff, then write:");
      console.log("");
      console.log(`    ${ATTESTATION_PATH}`);
      console.log("");
      console.log("  containing JSON like:");
      console.log("");
      console.log("    {");
      console.log(`      "passed": true,`);
      console.log(`      "at": "${new Date().toISOString()}",`);
      console.log(`      "operator": "your-name",`);
      console.log(`      "tasks": ["README sentence add", "helper fn add"],`);
      console.log(`      "model": "openrouter/your-actual-model",`);
      console.log(`      "notes": "all tasks reached approval with diff"`);
      console.log("    }");
      console.log("");
      console.log("  Re-run this script after creating the attestation.");
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`audit-readiness failed: ${err?.message ?? err}`);
  process.exit(1);
});
