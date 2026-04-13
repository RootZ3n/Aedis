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
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import cors from "@fastify/cors";

import { createTailscaleAuth } from "./middleware/auth.js";
import { createEventBus, type EventBus } from "./websocket.js";
import { Coordinator, type CoordinatorConfig } from "../core/coordinator.js";
import { ReceiptStore } from "../core/receipt-store.js";
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

import { taskRoutes } from "./routes/tasks.js";
import { runRoutes } from "./routes/runs.js";
import { workerRoutes } from "./routes/workers.js";
import { healthRoutes } from "./routes/health.js";
import { configRoutes } from "./routes/config.js";
import { metricsRoutes } from "./routes/metrics.js";
import { loquiRoutes } from "./routes/loqui.js";
import { trustRoutes } from "./routes/trust.js";
import { proveRoutes } from "./routes/prove.js";

// ─── Types ───────────────────────────────────────────────────────────

export interface ServerConfig {
  port: number;
  host: string;
  projectRoot: string;
  coordinatorConfig?: Partial<CoordinatorConfig>;
  /** Disable Tailscale auth (for local dev) */
  disableAuth?: boolean;
  /** Additional allowed CIDRs */
  allowedCidrs?: string[];
}

const DEFAULT_CONFIG: ServerConfig = {
  port: 18796,
  host: "0.0.0.0",
  projectRoot: process.cwd(),
};

// ─── Server Context (shared across routes) ───────────────────────────

export interface ServerContext {
  coordinator: Coordinator;
  eventBus: EventBus;
  receiptStore: ReceiptStore;
  workerRegistry: WorkerRegistry;
  config: ServerConfig;
  startedAt: string;
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
function buildVerificationConfig(projectRoot: string): Partial<VerificationPipelineConfig> {
  const hooks: ToolHook[] = [];
  let scripts: Record<string, string> = {};

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

  return {
    hooks,
    requiredChecks: ["lint", "typecheck", "tests"],
    strictMode: process.env["AEDIS_STRICT_MODE"] === "true",
  };
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
  const receiptStore = new ReceiptStore(cfg.projectRoot);
  await receiptStore.markIncompleteRunsCrashed(
    `Server restarted on ${new Date().toISOString()} before the run reached a terminal state`,
  );

  const coordinator = new Coordinator(
    {
      projectRoot: cfg.projectRoot,
      verificationConfig,
      ...cfg.coordinatorConfig,
    },
    profile,
    registry,
    eventBus,
    receiptStore,
  );

  const ctx: ServerContext = {
    coordinator,
    eventBus,
    receiptStore,
    workerRegistry: registry,
    config: cfg,
    startedAt: new Date().toISOString(),
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
  await server.register(healthRoutes);
  await server.register(configRoutes, { prefix: "/config" });
  // Metrics + External API Layer v1 — read-only external surface.
  await server.register(metricsRoutes, { prefix: "/metrics" });
  await server.register(loquiRoutes, { prefix: "/loqui" });
  await server.register(trustRoutes, { prefix: "/trust" });
  await server.register(proveRoutes, { prefix: "/prove" });

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
  const server = await createServer(cfg, trustProfile, workerRegistry);

  try {
    const address = await server.listen({ port: cfg.port, host: cfg.host });
    server.log.info(`Aedis server listening on ${address}`);
    server.log.info(`WebSocket available at ws://${cfg.host}:${cfg.port}/ws`);
    server.log.info(`UI available at http://${cfg.host}:${cfg.port}/`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }

  // Graceful shutdown
  const shutdown = async () => {
    server.log.info("Shutting down Aedis server...");
    await server.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
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
