import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { proveRoutes } from "./prove.js";

// /prove/repo competes with active builds for workers, providers, file
// locks, and host memory. The route must refuse with 409 while any run
// is in flight; the cd373634 SIGTERM-mid-build incident exposed the
// risk even though that specific window did not actually concurrent-
// run prove activity. This guards future overlap structurally.

test("POST /prove/repo refuses with 409 when a run is active", async () => {
  const fastify = (await import("fastify")).default;
  const projectRoot = mkdtempSync(join(tmpdir(), "aedis-prove-route-"));

  try {
    const app = fastify();
    (app as any).decorate("ctx", {
      receiptStore: {},
      coordinator: { listActiveRunIds: () => ["run-busy-1"] },
      eventBus: { emit: () => {} },
      config: { projectRoot },
    });
    await app.register(proveRoutes, { prefix: "/prove" });

    const res = await app.inject({
      method: "POST",
      url: "/prove/repo",
      payload: { repoPath: "/tmp/some-repo" },
    });

    assert.equal(res.statusCode, 409);
    const body = res.json();
    assert.equal(body.error, "active-run");
    assert.deepEqual(body.activeRunIds, ["run-busy-1"]);
    assert.match(body.message, /Aedis run\(s\) are active/);

    await app.close();
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("POST /prove/repo passes the active-run guard when nothing is in flight (then fails on missing repoPath)", async () => {
  // When no run is active we want the guard to fall through. We do NOT
  // want this test to actually invoke proveRepo (it walks a real repo),
  // so we send an empty body and expect the existing 400 validation to
  // fire after the guard passes — proving the guard is non-blocking
  // when idle.
  const fastify = (await import("fastify")).default;
  const projectRoot = mkdtempSync(join(tmpdir(), "aedis-prove-route-idle-"));

  try {
    const app = fastify();
    (app as any).decorate("ctx", {
      receiptStore: {},
      coordinator: { listActiveRunIds: () => [] },
      eventBus: { emit: () => {} },
      config: { projectRoot },
    });
    await app.register(proveRoutes, { prefix: "/prove" });

    const res = await app.inject({
      method: "POST",
      url: "/prove/repo",
      payload: {},
    });

    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, "repoPath is required");

    await app.close();
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
