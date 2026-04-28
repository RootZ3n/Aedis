/**
 * Aedis Server — Fastify + WebSocket on port 18796.
 *
 * Entry point for the Aedis API. Mounts all route files,
 * connects to the Coordinator, and streams events over WebSocket.
 * Serves ui/ as static files at / and /ui/*.
 *
 * Can be run directly: node server/index.js
 */

import "dotenv/config";

import { existsSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { createServer as netCreateServer } from "net";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import cors from "@fastify/cors";

import { createTailscaleAuth } from "./middleware/auth.js";
import { createEventBus, type EventBus } from "./websocket.js";
import { Coordinator, type CoordinatorConfig } from "../core/coordinator.js";
import { ReceiptStore } from "../core/receipt-store.js";
import { getBuildMetadata, type BuildMetadata } from "../core/build-metadata.js";
import {
  createCustomHook,
  createTypecheckHook,
  type ToolHook,
  type VerificationPipelineConfig,
} from "../core/verification-pipeline.js";
import { WorkerRegistry } from "../workers/base.js";
import { ScoutWorker } from "../workers/scout.js";
import { BuilderWorker } from "../workers/builder.js";
import { CriticWorker } from "../workers/critic.js";
import { VerifierWorker } from "../workers/verifier.js";
import { IntegratorWorker } from "../workers/integrator.js";
import type { TrustProfile } from "../router/trust-router.js";

import { costRoutes } from "./routes/cost.js";
import { taskRoutes } from "./routes/tasks.js";
import { runRoutes } from "./routes/runs.js";
import { workerRoutes } from "./routes/workers.js";
import { healthRoutes } from "./routes/health.js";
import { configRoutes } from "./routes/config.js";
import { providerRoutes } from "./routes/providers.js";
import { metricsRoutes } from "./routes/metrics.js";
import { loquiRoutes } from "./routes/loqui.js";
import { trustRoutes } from "./routes/trust.js";
import { proveRoutes } from "./routes/prove.js";
import { reliabilityRoutes } from "./routes/reliability.js";
import { campaignRoutes } from "./routes/campaign.js";
import { sessionRoutes } from "./routes/sessions.js";
import { memoryRoutes } from "./routes/memory.js";
import { planRoutes } from "./routes/plans.js";
import { safeDefaults, policyFromCoordinatorConfig, type RuntimePolicy } from "../core/runtime-policy.js";
import { loadLaneConfigFromDisk } from "../core/lane-config.js";

/**
 * Parse AEDIS_APPROVAL_TIMEOUT_HOURS into a positive number, or null
 * when unset / invalid. Exported for test coverage of the env-parse
 * contract — sweeps must be opt-in and tolerant of bad input rather
 * than crashing the boot path.
 */
export function parseApprovalTimeoutHours(raw: string | undefined): number | null {
  if (raw === undefined || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

// ─── Types ───────────────────────────────────────────────────────────

export interface ServerConfig {
  port: number;
  host: string;
  /**
   * Aedis runtime state root. This is intentionally separate from
   * projectRoot so receipts do not dirty the target source repository.
   */
  stateRoot: string;
  projectRoot: string;
  coordinatorConfig?: Partial<CoordinatorConfig>;
  /** Disable Tailscale auth (for local dev) */
  disableAuth?: boolean;
  /** Additional allowed CIDRs */
  allowedCidrs?: string[];
}

function readPortFromEnv(): number {
  const raw = process.env["AEDIS_PORT"] ?? process.env["PORT"];
  if (!raw) return 18796;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : 18796;
}

/**
 * Probe whether `port` is already bound on `host`. Returns true when a
 * live listener occupies the port (EADDRINUSE on a probe bind). Used
 * before startup recovery so a duplicate `node dist/server/index.js`
 * invocation cannot run `markIncompleteRunsCrashed` against a healthy
 * sibling — that race deletes the live server's worktree mid-run and
 * surfaces as burn-in BLOCKED/INTERRUPTED with `ENOENT` on the active
 * workspace.
 */
export function isPortInUse(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = netCreateServer();
    probe.unref();
    probe.once("error", (err: NodeJS.ErrnoException) => {
      probe.close();
      resolve(err.code === "EADDRINUSE");
    });
    probe.once("listening", () => {
      probe.close(() => resolve(false));
    });
    try {
      probe.listen(port, host);
    } catch {
      resolve(false);
    }
  });
}

export const DEFAULT_CONFIG: ServerConfig = {
  port: readPortFromEnv(),
  host: process.env["AEDIS_HOST"] ?? "0.0.0.0",
  stateRoot: process.env["AEDIS_STATE_ROOT"] ?? process.cwd(),
  projectRoot: process.env["AEDIS_PROJECT_ROOT"] ?? process.cwd(),
  // TAILSCALE_ONLY=true in .env disables auth so local browsers and
  // curl can reach the server. Defaults to false (auth enabled) so a
  // misconfigured deploy never accidentally exposes an unsecured server.
  disableAuth: process.env["TAILSCALE_ONLY"] === "true",
};

// ─── Server Context (shared across routes) ───────────────────────────

export interface ServerContext {
  coordinator: Coordinator;
  eventBus: EventBus;
  receiptStore: ReceiptStore;
  workerRegistry: WorkerRegistry;
  config: ServerConfig;
  startedAt: string;
  build: BuildMetadata;
  pid: number;
  /**
   * Snapshot of the runtime safety policy (auto-promote, approval,
   * lane mode). Re-computed on demand so a runtime config edit shows
   * up on the next /health request without a server restart.
   */
  getRuntimePolicy: () => RuntimePolicy;
}

// ─── Defaults for standalone boot ────────────────────────────────────

function defaultTrustProfile(): TrustProfile {
  return {
    scores: new Map(),
    tierThresholds: { fast: 0.6, standard: 0.75, premium: 0.9 },
  };
}

/**
 * Build a WorkerRegistry with all 5 worker types registered.
 */
/**
 * Detect the primary language/stack of a project so the verifier can
 * pick the right hooks. Returns an ordered list of detected stacks —
 * a repo with both package.json AND pyproject.toml (rare but real)
 * gets both. Godot projects are detected via project.godot.
 */
function detectProjectStacks(projectRoot: string): ReadonlyArray<"typescript" | "python" | "godot" | "rust" | "go" | "unknown"> {
  const stacks: Array<"typescript" | "python" | "godot" | "rust" | "go" | "unknown"> = [];
  if (existsSync(join(projectRoot, "tsconfig.json")) || existsSync(join(projectRoot, "package.json"))) {
    stacks.push("typescript");
  }
  if (
    existsSync(join(projectRoot, "pyproject.toml")) ||
    existsSync(join(projectRoot, "requirements.txt")) ||
    existsSync(join(projectRoot, "setup.py")) ||
    existsSync(join(projectRoot, "Pipfile"))
  ) {
    stacks.push("python");
  }
  if (existsSync(join(projectRoot, "project.godot"))) stacks.push("godot");
  if (existsSync(join(projectRoot, "Cargo.toml"))) stacks.push("rust");
  if (existsSync(join(projectRoot, "go.mod"))) stacks.push("go");
  if (stacks.length === 0) stacks.push("unknown");
  return stacks;
}

function buildVerificationConfig(projectRoot: string): Partial<VerificationPipelineConfig> {
  const hooks: ToolHook[] = [];
  let scripts: Record<string, string> = {};
  const stacks = detectProjectStacks(projectRoot);
  console.log(`[server] project stacks detected at ${projectRoot}: ${stacks.join(", ")}`);

  const packageJsonPath = join(projectRoot, "package.json");
  if (existsSync(packageJsonPath)) {
    try {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
        scripts?: Record<string, string>;
      };
      scripts = packageJson.scripts ?? {};
    } catch {
      scripts = {};
    }
  }

  if (typeof scripts.lint === "string" && scripts.lint.trim()) {
    hooks.push(createCustomHook({
      name: "Lint",
      command: "npm",
      args: ["run", "lint"],
      kind: "lint",
    }));
  }

  const tsconfigPath = join(projectRoot, "tsconfig.json");
  if (existsSync(tsconfigPath)) {
    hooks.push(createTypecheckHook({ project: tsconfigPath }));
  }

  if (typeof scripts.test === "string" && scripts.test.trim()) {
    hooks.push(createCustomHook({
      name: "Tests",
      command: "npm",
      args: ["run", "test"],
      kind: "tests",
    }));
  }

  // Language-agnostic hooks. The verifier runs every registered hook
  // against the ACTIVE workspace at dispatch time (cwd is per-run, not
  // per-boot). We can't know at boot whether a given run will target a
  // Python repo or a Godot repo — so we register the hooks
  // unconditionally, guarded by their own "are there files to check?"
  // logic, and let them no-op on repos that don't match.
  //
  // Python: syntax-check every .py file with python3 -m py_compile. On
  // a TS repo with no .py files, `xargs -r` makes the command a no-op
  // and exits 0. On a Python repo it catches import typos / unmatched
  // parens / unterminated strings. Only registered if python3 is on
  // PATH.
  if (hasExecutableOnPath("python3")) {
    hooks.push(createCustomHook({
      name: "Python Syntax",
      command: "sh",
      args: ["-c", "find . -type f -name '*.py' -not -path './.venv/*' -not -path './venv/*' -not -path './__pycache__/*' -not -path './node_modules/*' -not -path './.git/*' 2>/dev/null | head -500 | xargs -r python3 -m py_compile"],
      kind: "typecheck",
    }));
  }

  // Godot: headless --check-only validates scripts + scenes. The
  // `--check-only` flag exits 0 on success, nonzero if any script
  // fails to parse. Only registered if the godot binary is on PATH
  // AND this run's cwd has a project.godot — the sh wrapper short-
  // circuits on non-Godot repos.
  if (hasExecutableOnPath("godot")) {
    hooks.push(createCustomHook({
      name: "Godot Check",
      command: "sh",
      args: ["-c", "[ -f project.godot ] || exit 0; godot --headless --quit --check-only"],
      kind: "typecheck",
    }));
  }

  // Required checks: whichever typecheck-class hooks we managed to
  // register. An empty list means the verifier won't fail closed on
  // "missing required checks" — for an unknown-stack repo, the diff /
  // contract / cross-file stages still run and still gate.
  const requiredChecks = hooks.some((h) => h.kind === "typecheck")
    ? ["typecheck"] as const
    : [] as const;

  return {
    hooks,
    requiredChecks: [...requiredChecks],
    strictMode: process.env["AEDIS_STRICT_MODE"] === "true",
  };
}

/**
 * Cheap which(1): returns true if the command resolves on PATH. Used
 * so we don't register hooks that would blow up with ENOENT.
 */
function hasExecutableOnPath(cmd: string): boolean {
  try {
    const paths = (process.env["PATH"] ?? "").split(":").filter(Boolean);
    for (const p of paths) {
      if (existsSync(join(p, cmd))) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function buildDefaultRegistry(projectRoot: string, verificationConfig: Partial<VerificationPipelineConfig>): WorkerRegistry {
  const registry = new WorkerRegistry();
  registry.register(new ScoutWorker({ projectRoot }));
  registry.register(new BuilderWorker({ projectRoot }));
  registry.register(new CriticWorker({ projectRoot }));
  registry.register(new VerifierWorker({
    hooks: verificationConfig.hooks ?? [],
    verificationConfig,
  }));
  registry.register(new IntegratorWorker());
  console.log("[server] WorkerRegistry: 5 workers registered — scout, builder, critic, verifier, integrator");
  return registry;
}

// ─── Resolve ui/ directory relative to this file ─────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function resolveUiRoot(): string {
  const siblingUi = join(__dirname, "..", "ui");
  if (existsSync(siblingUi)) return siblingUi;

  // Built output lives in dist/server, while source ui/ stays at repo-root/ui.
  const repoUi = join(__dirname, "..", "..", "ui");
  if (existsSync(repoUi)) return repoUi;

  return siblingUi;
}

const UI_ROOT = resolveUiRoot();

// ─── Boot ────────────────────────────────────────────────────────────

export async function createServer(
  config: Partial<ServerConfig> = {},
  trustProfile?: TrustProfile,
  workerRegistry?: WorkerRegistry
): Promise<ReturnType<typeof Fastify>> {
  const cfg: ServerConfig = { ...DEFAULT_CONFIG, ...config };
  const verificationConfig = buildVerificationConfig(cfg.projectRoot);
  const registry = workerRegistry ?? buildDefaultRegistry(cfg.projectRoot, verificationConfig);
  const profile = trustProfile ?? defaultTrustProfile();

  const eventBus = createEventBus();
  const receiptStore = new ReceiptStore(cfg.stateRoot);

  // Bail before startup recovery if another aedis server already owns
  // the port. `markIncompleteRunsCrashed` rewrites every RUNNING run to
  // INTERRUPTED and deletes its worktree — running it from a duplicate
  // process kills the live server's in-flight runs (the burn-in-09
  // 10s/BLOCKED symptom). The `bind probe` matches what Fastify will do
  // at listen time, so the check is true to the conflict it guards.
  const probeHost = cfg.host === "0.0.0.0" ? "127.0.0.1" : cfg.host;
  if (await isPortInUse(cfg.port, probeHost)) {
    throw new Error(
      `[server] port ${cfg.port} already bound on ${probeHost} — another aedis server is running. ` +
      `Refusing to run startup recovery (would orphan the live server's runs).`,
    );
  }

  const recovery = await receiptStore.markIncompleteRunsCrashed(
    `Server restarted on ${new Date().toISOString()} before the run reached a terminal state`,
  );
  if (recovery.runsRecovered > 0) {
    console.log(
      `[server] STARTUP RECOVERY: ${recovery.runsRecovered} run(s) marked INTERRUPTED; ` +
      `orphan workspaces=${recovery.orphanWorkspaces.length} ` +
      `(removed=${recovery.orphanWorkspaces.filter((o) => o.removed).length})`,
    );
    for (const orphan of recovery.orphanWorkspaces) {
      console.log(
        `[server] STARTUP RECOVERY: workspace ${orphan.workspacePath} — ` +
        (orphan.removed ? "cleaned" : `FAILED: ${orphan.error ?? "unknown"}`),
      );
    }
  }

  // Safe Default Mode — applied at server boot regardless of test
  // defaults. Approval is REQUIRED unless AEDIS_REQUIRE_APPROVAL=false
  // is set; auto-promote stays OFF unless AEDIS_AUTO_PROMOTE=true is
  // set. The double-negative on approval is intentional: the operator
  // has to type "false" to disable a guard, never the other way.
  const safe = safeDefaults();
  if (safe.source.autoPromoteOnSuccess === "env-override") {
    console.log("[server] AEDIS_AUTO_PROMOTE=true — clean runs will auto-promote to source repo");
  }
  if (safe.source.requireApproval === "env-override") {
    console.warn("[server] AEDIS_REQUIRE_APPROVAL=false — approval gate disabled (unsafe)");
  }

  const coordinator = new Coordinator(
    {
      projectRoot: cfg.projectRoot,
      verificationConfig,
      autoPromoteOnSuccess: safe.autoPromoteOnSuccess,
      requireApproval: safe.requireApproval,
      requireWorkspace: safe.requireWorkspace,
      ...cfg.coordinatorConfig,
    },
    profile,
    registry,
    eventBus,
    receiptStore,
  );

  // Optional approval-timeout sweeper. Default off — opt in by setting
  // AEDIS_APPROVAL_TIMEOUT_HOURS to a positive number. When set, runs
  // that have been AWAITING_APPROVAL longer than the threshold are
  // auto-rejected on the same path as a manual rejection (rollback,
  // workspace cleanup, terminal receipt). The timer is intentionally
  // server-scoped so a config change takes effect at next restart.
  const timeoutHours = parseApprovalTimeoutHours(process.env["AEDIS_APPROVAL_TIMEOUT_HOURS"]);
  if (timeoutHours !== null) {
    const timeoutMs = Math.round(timeoutHours * 60 * 60 * 1000);
    console.log(
      `[server] AEDIS_APPROVAL_TIMEOUT_HOURS=${timeoutHours} — abandoned approvals auto-reject after ${timeoutHours}h`,
    );
    const sweepIntervalMs = Math.min(5 * 60 * 1000, Math.max(60_000, Math.floor(timeoutMs / 4)));
    setInterval(() => {
      coordinator.rejectExpiredApprovals(timeoutMs).catch((err) => {
        console.error(`[server] approval-timeout sweep error: ${err}`);
      });
    }, sweepIntervalMs).unref();
  }

  // Read lane mode from disk for the policy summary. Re-read by /health
  // on every request so a config edit during runtime shows up without
  // a server restart. Falls back to "unset" when the file is absent.
  const computeRuntimePolicy = (): RuntimePolicy => {
    const laneCfg = loadLaneConfigFromDisk(cfg.projectRoot);
    return policyFromCoordinatorConfig(
      {
        autoPromoteOnSuccess: safe.autoPromoteOnSuccess,
        requireApproval: safe.requireApproval,
        requireWorkspace: safe.requireWorkspace,
      },
      laneCfg.mode,
    );
  };
  // Auth mode log — operator needs to know immediately whether the server
  // is enforcing Tailscale auth or running open. This is the first thing
  // to check when the server is unreachable or `aedis doctor` shows an
  // auth-enabled server is blocking requests.
  if (cfg.disableAuth) {
    console.log(`[server] auth: DISABLED (TAILSCALE_ONLY=false or not set) — server is OPEN`);
    console.log(`[server] ⚠ NOT recommended for production or internet-facing deployments`);
  } else {
    console.log(`[server] auth: ENABLED — Tailscale identity required for all API access`);
  }

  console.log(
    `[server] runtime policy: autoPromote=${safe.autoPromoteOnSuccess} ` +
    `approvalRequired=${safe.requireApproval} ` +
    `requireWorkspace=${safe.requireWorkspace}`,
  );

  const ctx: ServerContext = {
    coordinator,
    eventBus,
    receiptStore,
    workerRegistry: registry,
    config: cfg,
    startedAt: new Date().toISOString(),
    build: getBuildMetadata({ projectRoot: cfg.projectRoot }),
    pid: process.pid,
    getRuntimePolicy: computeRuntimePolicy,
  };

  // ─── Fastify instance ──────────────────────────────────────────

  const server = Fastify({
    logger: {
      level: "info",
    },
  });

  // ─── Plugins ───────────────────────────────────────────────────

  await server.register(cors, {
    origin: true,
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
  });

  await server.register(websocket);

  // ─── Static files: ui/ at /ui/* ────────────────────────────────

  await server.register(fastifyStatic, {
    root: UI_ROOT,
    prefix: "/ui/",
  });

  // ─── GET / → serve ui/index.html directly ─────────────────────

  const indexHtmlPath = join(UI_ROOT, "index.html");
  let indexHtml: string;
  try {
    indexHtml = readFileSync(indexHtmlPath, "utf-8");
  } catch {
    indexHtml = "<html><body><h1>Aedis</h1><p>ui/index.html not found</p></body></html>";
  }

  server.get("/", async (_request, reply) => {
    reply.type("text/html").send(indexHtml);
  });

  // ─── Auth middleware ───────────────────────────────────────────

  server.addHook(
    "onRequest",
    createTailscaleAuth({
      enabled: !cfg.disableAuth,
      allowedCidrs: cfg.allowedCidrs ?? [],
    })
  );

  // ─── Decorate with context ────────────────────────────────────

  server.decorate("ctx", ctx);

  // ─── Routes ────────────────────────────────────────────────────

  await server.register(taskRoutes, { prefix: "/tasks" });
  await server.register(runRoutes, { prefix: "/runs" });
  await server.register(workerRoutes, { prefix: "/workers" });
  // External API layer — /api/* mirrors the internal routes for external consumers
  // (Crucibulum, CLI tools) that expect the /api prefix convention.
  await server.register(workerRoutes, { prefix: "/api/workers" });
  await server.register(taskRoutes, { prefix: "/api/tasks" });
  await server.register(sessionRoutes, { prefix: "/api/sessions" });
  await server.register(runRoutes, { prefix: "/api/runs" });
  await server.register(metricsRoutes, { prefix: "/api/metrics" });
  await server.register(healthRoutes);
  await server.register(configRoutes, { prefix: "/config" });
  await server.register(providerRoutes, { prefix: "/config/providers" });
  // Metrics + External API Layer v1 — read-only external surface.
  await server.register(costRoutes, { prefix: "/cost" });
  await server.register(metricsRoutes, { prefix: "/metrics" });
  await server.register(loquiRoutes, { prefix: "/loqui" });
  await server.register(trustRoutes, { prefix: "/trust" });
  await server.register(proveRoutes, { prefix: "/prove" });
  await server.register(reliabilityRoutes, { prefix: "/reliability" });
  await server.register(campaignRoutes, { prefix: "/campaign" });
  await server.register(sessionRoutes, { prefix: "/sessions" });
  await server.register(memoryRoutes, { prefix: "/memory" });
  await server.register(planRoutes, { prefix: "/plans" });
  await server.register(planRoutes, { prefix: "/api/plans" });

  // ─── Approval gate endpoints ──────────────────────────────────

  server.get("/approvals/pending", async (_req, reply) => {
    const pending = coordinator.getPendingApprovals();
    reply.send({ ok: true, pending });
  });

  server.post<{ Params: { runId: string } }>("/approvals/:runId/approve", async (req, reply) => {
    const result = await coordinator.approveRun(req.params.runId);
    reply.send(result);
  });

  server.post<{ Params: { runId: string } }>("/approvals/:runId/reject", async (req, reply) => {
    const result = await coordinator.rejectRun(req.params.runId);
    reply.send(result);
  });

  // ─── WebSocket endpoint ────────────────────────────────────────

  server.register(async function (fastify) {
    fastify.get("/ws", { websocket: true }, (socket /* WebSocket */, req) => {

      // Parse optional event filter from query
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const filterParam = url.searchParams.get("events");
      const filter = filterParam
        ? (filterParam.split(",") as any[])
        : undefined;

      eventBus.addClient(socket as any, filter);

      // Send welcome message
      try {
        socket.send(JSON.stringify({
          type: "connected",
          timestamp: new Date().toISOString(),
          message: "Aedis WebSocket connected",
          clients: eventBus.clientCount(),
        }));
      } catch {
        // Socket may have closed
      }

      // Keepalive ping every 30s
      const keepalive = setInterval(() => {
        try {
          if (socket.readyState === 1) {
            socket.ping();
          } else {
            clearInterval(keepalive);
          }
        } catch {
          clearInterval(keepalive);
        }
      }, 30_000);

      socket.on("close", () => {
        clearInterval(keepalive);
        eventBus.removeClient(socket as any);
      });

      socket.on("error", () => {
        clearInterval(keepalive);
        eventBus.removeClient(socket as any);
      });

      // Handle client messages
      socket.on("message", (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === "ping") {
            socket.send(JSON.stringify({ type: "pong", timestamp: new Date().toISOString() }));
          }
          if (msg.type === "subscribe") {
            socket.send(JSON.stringify({
              type: "subscribed",
              taskId: msg.taskId,
              runId: msg.runId,
              timestamp: new Date().toISOString(),
            }));
          }
        } catch {
          // Ignore malformed messages
        }
      });
    });
  });

  return server;
}

// ─── Standalone boot ─────────────────────────────────────────────────

export async function startServer(
  config: Partial<ServerConfig> = {},
  trustProfile?: TrustProfile,
  workerRegistry?: WorkerRegistry
): Promise<void> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  let server: Awaited<ReturnType<typeof createServer>>;
  try {
    server = await createServer(cfg, trustProfile, workerRegistry);
  } catch (err) {
    // The port-in-use guard inside createServer throws BEFORE
    // recovery runs, so a duplicate `node dist/server/index.js` exits
    // here without touching state. Surface a concise message rather
    // than a stack trace.
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  try {
    const address = await server.listen({ port: cfg.port, host: cfg.host });
    server.log.info(`Aedis server listening on ${address}`);
    server.log.info(`WebSocket available at ws://${cfg.host}:${cfg.port}/ws`);
    server.log.info(`UI available at http://${cfg.host}:${cfg.port}/`);
    // Stale-dist / duplicate-process detection starts here. Print a
    // single, grep-friendly line with pid + port + build so the
    // operator can match a running process to the dist that produced
    // it. `aedis doctor` reads the same shape via /health.
    const build = server.ctx.build;
    server.log.info(
      `[server] boot pid=${process.pid} port=${cfg.port} ` +
      `version=${build.version} commit=${build.commitShort} ` +
      `buildTime=${build.buildTime} buildSource=${build.source}`,
    );
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    server.log.info(`Shutting down Aedis server (${signal})...`);
    await server.close();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGHUP", () => shutdown("SIGHUP"));

  // Fatal error logging — a crash with no logs is unacceptable.
  process.on("uncaughtException", (err, origin) => {
    console.error(`[server] FATAL uncaughtException (origin=${origin}):`);
    console.error(err.stack ?? err.message ?? String(err));
    // Attempt to flush logs before dying
    try { server.log.error({ err, origin }, "uncaughtException"); } catch { /* best effort */ }
    process.exit(1);
  });

  process.on("unhandledRejection", (reason, promise) => {
    console.error(`[server] FATAL unhandledRejection:`);
    console.error(reason instanceof Error ? reason.stack ?? reason.message : String(reason));
    // Log but do NOT exit — unhandled rejections from dangling promises
    // (e.g. timed-out dispatch) are expected. The coordinator's own
    // catch block handles the primary error path; this is the safety net
    // for secondary rejections from abandoned Promise.race losers.
  });
}

// ─── Self-boot when run directly ─────────────────────────────────────

const isDirectRun =
  process.argv[1]?.endsWith("server/index.js") ||
  process.argv[1]?.endsWith("server/index.ts");

if (isDirectRun) {
  startServer().catch((err) => {
    console.error("Aedis server failed to start:", err);
    process.exit(1);
  });
}

// ─── Type augmentation for Fastify ───────────────────────────────────

declare module "fastify" {
  interface FastifyInstance {
    ctx: ServerContext;
  }
}
