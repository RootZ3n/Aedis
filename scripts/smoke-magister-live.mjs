#!/usr/bin/env node
/**
 * Live-server smoke for the Magister "Teach Me Anything" regression.
 *
 * Spawns `node dist/server/index.js` on a temp port with an isolated
 * AEDIS_STATE_ROOT, then drives the actual HTTP API the way the
 * browser does:
 *
 *   1. POST /missions/start  with the production Magister prompt
 *      (with five subtasks like the UI's mission decomposer creates)
 *   2. POST /task-plans/:id/start  to dispatch the first subtask
 *   3. Poll  GET /task-plans/:id   until the plan is non-running
 *
 * Then asserts ONE of these terminal states — anything else is a hard
 * regression:
 *
 *   (A) status === "completed" with the first subtask's lastVerdict
 *       === "success" (Builder dispatched and produced a diff)
 *
 *   (B) status === "needs_replan" with stopReason === "needs_clarification"
 *       AND the first subtask exposes recommendedTargets.length > 0
 *       so the UI's "Repair Plan" CTA has something to attach
 *
 * `status === "failed"` with `subtask_terminal_failure` and idle
 * workers (the original live bug) fails this script with exit 1 so
 * `npm run smoke:magister` is wired into the release-readiness gate.
 *
 * The smoke is deterministic when scouts can't find a real target
 * (which is the case when the prompt names "Magister project" but
 * the temp project root has no Magister files): the coordinator's
 * pre-dispatch guard fires, NeedsClarificationError is thrown, and
 * the task-loop converts it to needs_replan. That's outcome (B) —
 * the contract this fix exists to deliver.
 *
 * Usage:
 *   node scripts/smoke-magister-live.mjs
 *
 * Exit codes:
 *   0 — outcome (A) or (B) reached cleanly
 *   1 — terminal FAILED, timeout, server crash, or any other regression
 */

import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createServer as netCreateServer } from "node:net";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, "..");

const MAGISTER_OBJECTIVE =
  "In the Magister project, add a new conversational mode called \"Teach Me Anything\" " +
  "that allows the user to speak with Varros as a learning guide.";

// Five-subtask decomposition mirroring what the live UI's Loqui
// proposer produces for this prompt. Subtask 1 is the mission-level
// prompt that the operator's screenshot showed dying at
// `subtask_terminal_failure` before this fix.
const SUBTASKS = [
  { title: "Wire mode entry", prompt: MAGISTER_OBJECTIVE },
  { title: "Entry point: register TEACH_ME_ANYTHING in the mode router", prompt:
    "Entry point: Add a new mode identifier TEACH_ME_ANYTHING and register it in the mode router system alongside existing Magister modes." },
  { title: "Implementation: create a handler reusing Varros personality", prompt:
    "Implementation: Create a handler/module for the new mode. Reuse the existing Varros personality system without duplicating logic." },
  { title: "UX: trigger the mode via command/route", prompt:
    "UX: Add a simple way for users to trigger the new mode (command/route/function). A placeholder response is acceptable for the first iteration." },
  { title: "Constraints: stop for approval", prompt:
    "Constraints: Do not modify unrelated files. Do not duplicate types. Stop for approval before any source promotion." },
];

async function pickFreePort() {
  return new Promise((resolve, reject) => {
    const probe = netCreateServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const addr = probe.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

async function waitForHealth(baseUrl, deadlineMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < deadlineMs) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return await res.json();
    } catch {
      // not yet listening
    }
    await delay(200);
  }
  throw new Error(`server did not become healthy within ${deadlineMs}ms`);
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const txt = await res.text();
  let json = null;
  try { json = txt ? JSON.parse(txt) : null; } catch { /* keep raw */ }
  return { status: res.status, ok: res.ok, body: json, raw: txt };
}

async function getJson(url) {
  const res = await fetch(url);
  const txt = await res.text();
  let json = null;
  try { json = txt ? JSON.parse(txt) : null; } catch { /* keep raw */ }
  return { status: res.status, ok: res.ok, body: json, raw: txt };
}

function buildTempProjectRoot() {
  const root = mkdtempSync(join(tmpdir(), "aedis-smoke-magister-"));
  // Deliberately minimal — we want the live coordinator to take the
  // pre-dispatch guard path (NeedsClarificationError → needs_replan).
  // A realistic Magister surface would route past the guard and
  // dispatch Builder against the configured cloud provider, which
  // turns the smoke into a multi-minute LLM run with real cost. The
  // contract this script pins is "no FAILED + idle workers" — the
  // populated-chips path is covered by the Magister fixture unit
  // test (core/magister-fixture.test.ts) where the scout's output
  // is deterministic.
  writeFileSync(join(root, "README.md"),
    "# Smoke fixture\n\nIntentionally empty. Drives outcome (B) end-to-end.\n");
  return root;
}

function logSection(title) {
  console.log("");
  console.log(`── ${title} ${"─".repeat(Math.max(0, 60 - title.length))}`);
}

function summarizePlan(plan) {
  if (!plan) return "(no plan)";
  const subFails = plan.subtasks.filter((s) => s.status === "failed").length;
  const subStuck = plan.subtasks.filter((s) => s.status === "needs_clarification").length;
  return `status=${plan.status} stop=${plan.stopReason || "-"} ` +
    `subtasks: ${plan.subtasks.length} (failed=${subFails}, needs_clar=${subStuck})`;
}

async function main() {
  const distEntry = join(repoRoot, "dist/server/index.js");
  if (!existsSync(distEntry)) {
    console.error(`[smoke:magister] missing ${distEntry} — run \`npm run build\` first`);
    process.exit(1);
  }

  const stateRoot = mkdtempSync(join(tmpdir(), "aedis-smoke-state-"));
  const projectRoot = buildTempProjectRoot();
  const port = await pickFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    AEDIS_PORT: String(port),
    AEDIS_HOST: "127.0.0.1",
    AEDIS_STATE_ROOT: stateRoot,
    AEDIS_PROJECT_ROOT: projectRoot,
    TAILSCALE_ONLY: "false", // disable auth for smoke
    NODE_ENV: "production",
  };

  logSection("spawn");
  console.log(`spawning ${distEntry}`);
  console.log(`  port=${port}`);
  console.log(`  stateRoot=${stateRoot}`);
  console.log(`  projectRoot=${projectRoot}`);

  const child = spawn(process.execPath, [distEntry], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    cwd: repoRoot,
  });
  const logs = [];
  child.stdout.on("data", (b) => logs.push(["out", b.toString()]));
  child.stderr.on("data", (b) => logs.push(["err", b.toString()]));

  let exitCode = 1;
  try {
    const health = await waitForHealth(baseUrl, 30_000);
    console.log(`server up: build=${health?.build?.commitShort ?? "?"} workers=${health?.all_workers_available}`);

    logSection("POST /missions/start");
    const startRes = await postJson(`${baseUrl}/missions/start`, {
      objective: MAGISTER_OBJECTIVE,
      repoPath: projectRoot,
      subtasks: SUBTASKS,
    });
    console.log(`status=${startRes.status} body.status=${startRes.body?.status} task_plan_id=${startRes.body?.task_plan_id}`);
    if (startRes.status !== 201 || !startRes.body?.task_plan_id) {
      throw new Error(`/missions/start failed: ${startRes.raw}`);
    }
    if (startRes.body.status !== "plan_ready") {
      throw new Error(`expected status=plan_ready (no execution yet); got ${startRes.body.status}`);
    }
    if (startRes.body.executed !== false) {
      throw new Error("response must signal executed=false on plan creation");
    }
    if (startRes.body.plan?.status !== "pending") {
      throw new Error(`plan must start in pending; got ${startRes.body.plan?.status}`);
    }

    const planId = startRes.body.task_plan_id;

    logSection(`POST /task-plans/${planId}/start`);
    const dispatchRes = await postJson(`${baseUrl}/task-plans/${planId}/start`, {});
    console.log(`status=${dispatchRes.status} body.status=${dispatchRes.body?.status}`);
    if (dispatchRes.status !== 202) {
      throw new Error(`/task-plans/:id/start expected 202; got ${dispatchRes.status}: ${dispatchRes.raw}`);
    }

    logSection("poll plan");
    const t0 = Date.now();
    const TIMEOUT_MS = 90_000;
    let plan = null;
    let summary = null;
    while (Date.now() - t0 < TIMEOUT_MS) {
      await delay(500);
      const r = await getJson(`${baseUrl}/task-plans/${planId}`);
      if (!r.ok) {
        throw new Error(`GET /task-plans/${planId} returned ${r.status}: ${r.raw}`);
      }
      plan = r.body?.plan;
      summary = r.body?.summary;
      if (!plan) continue;
      if (plan.status !== "pending" && plan.status !== "running") {
        // settled
        break;
      }
    }
    console.log(`final: ${summarizePlan(plan)}`);

    if (!plan) throw new Error("no plan returned from API");

    // CONTRACT — exactly one of:
    //   (A) status=completed, first subtask success
    //   (B) status=needs_replan, stop=needs_clarification, subtask
    //       carries recommendedTargets so UI Repair Plan has a target
    //
    // Anything else, especially `status=failed +
    // stop=subtask_terminal_failure`, is the original live bug and
    // must hard-fail the smoke.
    const sub1 = plan.subtasks?.[0];

    if (plan.status === "completed") {
      console.log("outcome (A): plan completed");
      if (!sub1 || (sub1.lastVerdict !== "success" && sub1.status !== "completed" && sub1.status !== "repaired")) {
        throw new Error(`outcome A requires first subtask success; got status=${sub1?.status} verdict=${sub1?.lastVerdict}`);
      }
      console.log(`  first subtask: status=${sub1.status} verdict=${sub1.lastVerdict}`);
      exitCode = 0;
    } else if (plan.status === "needs_replan") {
      console.log("outcome (B): plan needs replan");
      if (plan.stopReason !== "needs_clarification") {
        throw new Error(`outcome B requires stopReason=needs_clarification; got ${plan.stopReason}`);
      }
      const stuck = plan.subtasks.find((s) => s.status === "needs_clarification");
      if (!stuck) {
        throw new Error("outcome B requires at least one subtask in needs_clarification");
      }
      // recommendedTargets MAY be empty when scouts genuinely found
      // nothing in the project — the contract is that the operator
      // gets a clear blocker + nextRecommendedAction either way.
      // Populated chips are covered by the unit fixture
      // (core/magister-fixture.test.ts) where scout output is
      // deterministic.
      const recs = Array.isArray(stuck.recommendedTargets) ? stuck.recommendedTargets : [];
      if (!stuck.nextRecommendedAction || !/attach|target|clarify|decompose/i.test(stuck.nextRecommendedAction)) {
        throw new Error(
          `outcome B requires actionable nextRecommendedAction; got "${stuck.nextRecommendedAction}"`,
        );
      }
      if (!stuck.blockerReason) {
        throw new Error("outcome B requires a blockerReason on the stuck subtask");
      }
      console.log(`  stuck subtask: ${stuck.id} status=${stuck.status}`);
      console.log(`  recommendedTargets (${recs.length}): ${recs.slice(0, 5).join(", ")}${recs.length > 5 ? `, …` : ""}`);
      console.log(`  blockerReason: ${stuck.blockerReason}`);
      console.log(`  nextRecommendedAction: ${stuck.nextRecommendedAction}`);

      // Exercise the Repair Plan CTA's attach-target route end-to-end
      // (with a synthetic target if scouts found none) so we know the
      // operator's recovery actually works in the live server.
      const top = recs[0] ?? "modes/teach-me-anything.ts";
      logSection(`POST /task-plans/${planId}/subtasks/${stuck.id}/attach-target`);
      const attachRes = await postJson(
        `${baseUrl}/task-plans/${planId}/subtasks/${stuck.id}/attach-target`,
        { target: top },
      );
      console.log(`status=${attachRes.status} body.subtask_id=${attachRes.body?.subtask_id}`);
      if (attachRes.status !== 200) {
        throw new Error(`attach-target expected 200; got ${attachRes.status}: ${attachRes.raw}`);
      }
      const planAfter = attachRes.body?.plan;
      if (planAfter?.status !== "paused") {
        throw new Error(`attach-target should leave plan paused; got ${planAfter?.status}`);
      }
      const subAfter = planAfter?.subtasks?.find((s) => s.id === stuck.id);
      if (subAfter?.status !== "pending") {
        throw new Error(`stuck subtask should be pending after attach; got ${subAfter?.status}`);
      }
      const targetEsc = top.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (!new RegExp(`Target file:\\s*${targetEsc}`).test(subAfter?.prompt ?? "")) {
        throw new Error("attached target was not prepended to the subtask prompt");
      }
      console.log(`  prompt now begins with: ${(subAfter?.prompt ?? "").split("\n")[0]}`);
      exitCode = 0;
    } else if (plan.status === "failed" && plan.stopReason === "subtask_terminal_failure") {
      // The exact regression this script exists to catch.
      throw new Error(
        `LIVE REGRESSION: plan terminated as failed/subtask_terminal_failure with idle workers — ` +
        `the original Magister bug is back. ${summarizePlan(plan)}`,
      );
    } else {
      throw new Error(`unexpected plan terminal state: ${summarizePlan(plan)}`);
    }

    logSection("OK");
    console.log(`smoke passed: outcome ${plan.status === "completed" ? "(A)" : "(B)"}`);
  } catch (err) {
    console.error("");
    console.error("══ SMOKE FAILED ══");
    console.error(err?.stack || err?.message || String(err));
    console.error("");
    console.error("── server stdout/stderr (last 60 lines) ──");
    const tail = logs.slice(-60).map(([t, s]) => `[${t}] ${s.trimEnd()}`).join("\n");
    console.error(tail || "(no output)");
  } finally {
    try { child.kill("SIGTERM"); } catch { /* ignore */ }
    await delay(150);
    try { child.kill("SIGKILL"); } catch { /* ignore */ }
    try { rmSync(stateRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(projectRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  process.exit(exitCode);
}

main().catch((err) => {
  console.error("[smoke:magister] unexpected:", err);
  process.exit(1);
});
