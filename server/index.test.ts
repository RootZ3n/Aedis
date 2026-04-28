import test from "node:test";
import assert from "node:assert/strict";
import { createServer as netCreateServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isPortInUse, createServer } from "./index.js";

// Pick an unlikely-to-collide port range for the harness — the tests
// bind real sockets to confirm the probe matches what Fastify will see.
function pickPort(): number {
  return 18900 + Math.floor(Math.random() * 100);
}

async function bindSocket(port: number, host = "127.0.0.1"): Promise<{ close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const srv = netCreateServer();
    srv.once("error", reject);
    srv.once("listening", () =>
      resolve({
        close: () => new Promise<void>((res) => srv.close(() => res())),
      }),
    );
    srv.listen(port, host);
  });
}

test("isPortInUse returns true when a process is listening on the port", async () => {
  const port = pickPort();
  const sock = await bindSocket(port);
  try {
    assert.equal(await isPortInUse(port, "127.0.0.1"), true);
  } finally {
    await sock.close();
  }
});

test("isPortInUse returns false when nothing is listening", async () => {
  // Bind+close to grab a freshly free port, then re-check.
  const port = pickPort();
  const sock = await bindSocket(port);
  await sock.close();
  assert.equal(await isPortInUse(port, "127.0.0.1"), false);
});

test("createServer refuses to start when port is bound (skips startup recovery race)", async () => {
  // The narrow burn-in-09 BLOCKED bug: a duplicate `node dist/server/index.js`
  // ran `markIncompleteRunsCrashed` BEFORE its own listen() failed with
  // EADDRINUSE. That orphaned the live server's RUNNING run mid-flight
  // (workspace deleted, builder ENOENT, harness sees INTERRUPTED → BLOCKED).
  // Pin the guard: createServer must throw before touching receipt state
  // when another listener already owns the port.
  const port = pickPort();
  const sock = await bindSocket(port);
  const projectRoot = mkdtempSync(join(tmpdir(), "aedis-port-guard-"));
  try {
    await assert.rejects(
      () => createServer({ port, host: "127.0.0.1", projectRoot }),
      /port .* already bound/i,
      "createServer should reject when port is in use",
    );
  } finally {
    await sock.close();
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ─── parseApprovalTimeoutHours (env-parse contract) ─────────────────
//
// AEDIS_APPROVAL_TIMEOUT_HOURS is opt-in. Bad values (typos, "off",
// non-numeric, negative, zero) must resolve to null so the boot path
// doesn't start a sweeper that does nothing or crashes.

test("parseApprovalTimeoutHours: undefined / empty → null (env disabled)", async () => {
  const { parseApprovalTimeoutHours } = await import("./index.js");
  assert.equal(parseApprovalTimeoutHours(undefined), null);
  assert.equal(parseApprovalTimeoutHours(""), null);
});

test("parseApprovalTimeoutHours: positive number → number (env enabled)", async () => {
  const { parseApprovalTimeoutHours } = await import("./index.js");
  assert.equal(parseApprovalTimeoutHours("24"), 24);
  assert.equal(parseApprovalTimeoutHours("0.5"), 0.5);
  assert.equal(parseApprovalTimeoutHours("168"), 168);
});

test("parseApprovalTimeoutHours: zero / negative / non-finite → null (no sweep on bad value)", async () => {
  const { parseApprovalTimeoutHours } = await import("./index.js");
  for (const v of ["0", "-1", "-24", "Infinity", "NaN"]) {
    assert.equal(
      parseApprovalTimeoutHours(v),
      null,
      `value ${JSON.stringify(v)} must resolve to null`,
    );
  }
});

test("parseApprovalTimeoutHours: non-numeric strings → null", async () => {
  const { parseApprovalTimeoutHours } = await import("./index.js");
  for (const v of ["off", "true", "24h", "yes", "abc"]) {
    assert.equal(
      parseApprovalTimeoutHours(v),
      null,
      `value ${JSON.stringify(v)} must resolve to null`,
    );
  }
});

// ─── TAILSCALE_ONLY wiring ────────────────────────────────────────────
//
// TAILSCALE_ONLY=true in .env maps to disableAuth=true in ServerConfig,
// which disables Tailscale auth middleware so local browsers can reach
// the server. The default (unset or "false") must keep auth enabled so a
// misconfigured deploy never accidentally exposes an unsecured server.
//
// Each test spawns a subprocess that sets the env var and verifies the
// computed config value — this is the only way to test env-reading logic
// without polluting the test runner's own process.

// Each test runs node --eval in a fresh subprocess with the env var
// set. Using --eval (not --input-type=module) because --eval runs in
// the module scope where DEFAULT_CONFIG is directly readable as a global.
// The import() side-effect loads the module so DEFAULT_CONFIG is populated
// before we read it.

async function getDisableAuthFromEnv(tailcaleOnly: string): Promise<boolean> {
  const { execSync } = await import("node:child_process");
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  // cwd of the test runner is the repo root (/mnt/ai/aedis).
  // dist/ is at the repo root, so resolve from cwd.
  const distPath = join(process.cwd(), "dist/server/index.js");

  // Write a temp script rather than using --eval (node --eval in a
  // subprocess does not reliably expose module-level bindings from an
  // imported module — it creates a fresh module scope where top-level
  // imports from the evaluated code are not accessible in the eval string).
  const tmpDir = mkdtempSync(join(tmpdir(), "aedis-test-"));
  const scriptPath = join(tmpDir, "check.mjs");

  writeFileSync(
    scriptPath,
    `import { DEFAULT_CONFIG } from ${JSON.stringify(distPath)};\n` +
      `console.log(String(DEFAULT_CONFIG.disableAuth ?? "undefined"));\n`,
  );

  const env = { ...process.env, TAILSCALE_ONLY: tailcaleOnly };
  let stdout: string;

  try {
    stdout = String(execSync(`node ${scriptPath}`, { env, encoding: "utf8" })).trim();
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  if (stdout === "true") return true;
  if (stdout === "false") return false;
  // Treat unknown/undefined as false (auth on by default)
  return false;
}

test("TAILSCALE_ONLY=true sets disableAuth=true in DEFAULT_CONFIG", async () => {
  const disabled = await getDisableAuthFromEnv("true");
  assert.equal(disabled, true, "TAILSCALE_ONLY=true must set disableAuth=true");
});

test("TAILSCALE_ONLY=false sets disableAuth=false in DEFAULT_CONFIG", async () => {
  const disabled = await getDisableAuthFromEnv("false");
  assert.equal(disabled, false, "TAILSCALE_ONLY=false must set disableAuth=false");
});

test("TAILSCALE_ONLY unset defaults to disableAuth=false (auth enabled)", async () => {
  const disabled = await getDisableAuthFromEnv("");
  assert.equal(disabled, false, "unset TAILSCALE_ONLY must default to disableAuth=false");
});
