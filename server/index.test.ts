import test from "node:test";
import assert from "node:assert/strict";
import { createServer as netCreateServer } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execSync } from "node:child_process";

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
// TAILSCALE_ONLY=true in .env keeps Tailscale auth enforced. Operators
// may set TAILSCALE_ONLY=false for local-only development. The default
// must keep auth enabled so a misconfigured deploy never accidentally
// exposes an unsecured server.
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

  // cwd of the test runner is the repository root.
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

async function getConfigRootsFromEnv(projectRoot: string, stateRoot: string): Promise<{ projectRoot: string; stateRoot: string }> {
  const { execSync } = await import("node:child_process");
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const distPath = join(process.cwd(), "dist/server/index.js");
  const tmpDir = mkdtempSync(join(tmpdir(), "aedis-test-"));
  const scriptPath = join(tmpDir, "check-roots.mjs");

  writeFileSync(
    scriptPath,
    `import { DEFAULT_CONFIG } from ${JSON.stringify(distPath)};\n` +
      `console.log(JSON.stringify({ projectRoot: DEFAULT_CONFIG.projectRoot, stateRoot: DEFAULT_CONFIG.stateRoot }));\n`,
  );

  try {
    const stdout = String(execSync(`node ${scriptPath}`, {
      env: { ...process.env, AEDIS_PROJECT_ROOT: projectRoot, AEDIS_STATE_ROOT: stateRoot },
      encoding: "utf8",
    })).trim();
    return JSON.parse(stdout) as { projectRoot: string; stateRoot: string };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

test("TAILSCALE_ONLY=true sets disableAuth=false in DEFAULT_CONFIG", async () => {
  const disabled = await getDisableAuthFromEnv("true");
  assert.equal(disabled, false, "TAILSCALE_ONLY=true must keep Tailscale auth enabled");
});

test("TAILSCALE_ONLY=false sets disableAuth=true in DEFAULT_CONFIG", async () => {
  const disabled = await getDisableAuthFromEnv("false");
  assert.equal(disabled, true, "TAILSCALE_ONLY=false must disable Tailscale auth for local development");
});

test("TAILSCALE_ONLY unset defaults to disableAuth=false (auth enabled)", async () => {
  const disabled = await getDisableAuthFromEnv("");
  assert.equal(disabled, false, "unset TAILSCALE_ONLY must default to disableAuth=false");
});

test("DEFAULT_CONFIG host defaults to loopback and requires opt-in for public bind", async () => {
  const scriptPath = mkdtempSync(join(tmpdir(), "aedis-host-config-")) + "/probe.mjs";
  writeFileSync(scriptPath, `
    import { DEFAULT_CONFIG } from ${JSON.stringify(resolve(process.cwd(), "server/index.ts"))};
    console.log(JSON.stringify({ host: DEFAULT_CONFIG.host }));
  `);
  try {
    const baseEnv = { ...process.env };
    delete baseEnv["AEDIS_HOST"];
    delete baseEnv["AEDIS_ALLOW_PUBLIC_BIND"];
    const loopback = JSON.parse(String(execSync(`node --import tsx ${scriptPath}`, {
      env: baseEnv,
      encoding: "utf8",
    })).trim()) as { host: string };
    assert.equal(loopback.host, "127.0.0.1");

    const refusedPublic = JSON.parse(String(execSync(`node --import tsx ${scriptPath}`, {
      env: { ...process.env, AEDIS_HOST: "0.0.0.0", AEDIS_ALLOW_PUBLIC_BIND: "" },
      encoding: "utf8",
    })).trim()) as { host: string };
    assert.equal(refusedPublic.host, "127.0.0.1");

    const allowedPublic = JSON.parse(String(execSync(`node --import tsx ${scriptPath}`, {
      env: { ...process.env, AEDIS_HOST: "0.0.0.0", AEDIS_ALLOW_PUBLIC_BIND: "true" },
      encoding: "utf8",
    })).trim()) as { host: string };
    assert.equal(allowedPublic.host, "0.0.0.0");
  } finally {
    rmSync(dirname(scriptPath), { recursive: true, force: true });
  }
});

test("DEFAULT_CONFIG keeps AEDIS_STATE_ROOT separate from AEDIS_PROJECT_ROOT", async () => {
  const roots = await getConfigRootsFromEnv("/tmp/aedis-target-repo", "/tmp/aedis-runtime-state");
  assert.equal(roots.projectRoot, "/tmp/aedis-target-repo");
  assert.equal(roots.stateRoot, "/tmp/aedis-runtime-state");
});
