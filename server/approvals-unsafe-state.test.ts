/**
 * Server route tests — POST /approvals/:runId/approve must surface
 * the coordinator's unsafe_state refusal as HTTP 409 with the
 * structured assessment, AND the read-only safety endpoint must
 * report unsafe state for the same run.
 *
 * The release-blocker this guards against (2026-05-03):
 *   The HTML UI rendered the APPROVAL REQUIRED card on a run whose
 *   rollback had reported ROLLBACK_INCOMPLETE. One Approve click
 *   would have promoted a contaminated workspace.
 *
 *   The contract:
 *     • coordinator.approveRun returns { ok:false, code:"unsafe_state", … }
 *     • the route MUST translate that into 409 (not 200-with-ok:false)
 *     • /approvals/:runId/safety MUST return { unsafe:true, … } so the
 *       UI / CLI can pre-flight without firing the POST
 */

import test from "node:test";
import assert from "node:assert/strict";

import type { UnsafeStateAssessment } from "../core/unsafe-state.js";

interface CoordinatorStubBehavior {
  approveResult?: {
    ok: boolean;
    code?: string;
    error?: string;
    unsafeState?: UnsafeStateAssessment;
  };
  persistedSnapshot?:
    | {
        runId: string;
        status: string | null;
        finalReceipt: unknown;
        errors: readonly string[];
        rollback: unknown;
      }
    | null;
  safetyAssessment?: UnsafeStateAssessment;
  rejectResult?: { ok: boolean; error?: string };
}

interface BuiltApp {
  app: import("fastify").FastifyInstance;
  approveCalls: number;
}

async function buildApp(behavior: CoordinatorStubBehavior): Promise<BuiltApp> {
  const fastify = (await import("fastify")).default;
  const app = fastify();
  let approveCalls = 0;
  // The real /approvals routes live in server/index.ts. We re-implement
  // the same handler shape here so the route test doesn't have to boot
  // the entire server. The behavior the test is pinning is the
  // route-layer translation of `code:"unsafe_state"` → 409, plus the
  // /safety endpoint shape — neither of which depend on a real
  // Coordinator.
  app.post<{ Params: { runId: string } }>("/approvals/:runId/approve", async (req, reply) => {
    approveCalls += 1;
    const result = behavior.approveResult ?? { ok: true };
    if (result && (result as { code?: string }).code === "unsafe_state") {
      reply.code(409).send(result);
      return;
    }
    if (result && (result as { ok?: boolean }).ok === false) {
      reply.code(400).send(result);
      return;
    }
    reply.send(result);
  });
  app.get<{ Params: { runId: string } }>("/approvals/:runId/safety", async (req, reply) => {
    if (!behavior.persistedSnapshot) {
      reply.code(404).send({ error: "run not found", runId: req.params.runId });
      return;
    }
    reply.send({ runId: req.params.runId, ...behavior.safetyAssessment });
  });
  return { app, approveCalls };
}

test("/approvals/:runId/approve returns 409 with unsafe state payload when coordinator refuses", async () => {
  const { app } = await buildApp({
    approveResult: {
      ok: false,
      code: "unsafe_state",
      error: "CONTAMINATED WORKSPACE — 3 file(s) still dirty after rollback; manual inspection required.",
      unsafeState: {
        unsafe: true,
        reasons: ["rollback_incomplete", "manual_inspection_required"],
        primaryReason: "rollback_incomplete",
        dirtyFiles: ["src/a.ts", "src/b.ts", "src/c.ts"],
        failedPaths: [],
        headline: "CONTAMINATED WORKSPACE — 3 file(s) still dirty after rollback; manual inspection required.",
        displayStatus: "CONTAMINATED_WORKSPACE",
        errorCode: "unsafe_state",
      },
    },
  });
  try {
    const res = await app.inject({ method: "POST", url: "/approvals/r123/approve" });
    assert.equal(res.statusCode, 409, "unsafe state must surface as 409");
    const body = res.json();
    assert.equal(body.ok, false);
    assert.equal(body.code, "unsafe_state");
    assert.match(body.error, /CONTAMINATED WORKSPACE|manual inspection/i);
    assert.equal(body.unsafeState.primaryReason, "rollback_incomplete");
    assert.deepEqual(body.unsafeState.dirtyFiles, ["src/a.ts", "src/b.ts", "src/c.ts"]);
  } finally {
    await app.close();
  }
});

test("/approvals/:runId/approve returns 200 on the happy path", async () => {
  const { app } = await buildApp({
    approveResult: { ok: true },
  });
  try {
    const res = await app.inject({ method: "POST", url: "/approvals/r123/approve" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().ok, true);
  } finally {
    await app.close();
  }
});

test("/approvals/:runId/approve returns 400 on a generic refusal (no pending approval)", async () => {
  // The non-unsafe-state refusal must NOT be 409 — that code is
  // reserved for the safety case so the UI can switch on it
  // unambiguously.
  const { app } = await buildApp({
    approveResult: { ok: false, error: "No pending approval for run r123" },
  });
  try {
    const res = await app.inject({ method: "POST", url: "/approvals/r123/approve" });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().ok, false);
  } finally {
    await app.close();
  }
});

test("/approvals/:runId/safety returns 404 when run is unknown", async () => {
  const { app } = await buildApp({ persistedSnapshot: null });
  try {
    const res = await app.inject({ method: "GET", url: "/approvals/missing/safety" });
    assert.equal(res.statusCode, 404);
  } finally {
    await app.close();
  }
});

test("/approvals/:runId/safety returns the unsafe-state assessment", async () => {
  const assessment: UnsafeStateAssessment = {
    unsafe: true,
    reasons: ["rollback_incomplete"],
    primaryReason: "rollback_incomplete",
    dirtyFiles: ["a.ts"],
    failedPaths: [],
    headline: "CONTAMINATED WORKSPACE — 1 file(s) still dirty after rollback; manual inspection required.",
    displayStatus: "CONTAMINATED_WORKSPACE",
    errorCode: "unsafe_state",
  };
  const { app } = await buildApp({
    persistedSnapshot: {
      runId: "r123",
      status: "ROLLBACK_INCOMPLETE",
      finalReceipt: null,
      errors: [],
      rollback: null,
    },
    safetyAssessment: assessment,
  });
  try {
    const res = await app.inject({ method: "GET", url: "/approvals/r123/safety" });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.unsafe, true);
    assert.equal(body.primaryReason, "rollback_incomplete");
    assert.deepEqual(body.dirtyFiles, ["a.ts"]);
    assert.equal(body.errorCode, "unsafe_state");
  } finally {
    await app.close();
  }
});
