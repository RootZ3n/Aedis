/**
 * Zendorium Server — Fastify + WebSocket on port 18796.
 *
 * Entry point for the Zendorium API. Mounts all route files,
 * connects to the Coordinator, and streams events over WebSocket.
 * Serves ui/ as static files at / and /ui/*.
 *
 * Can be run directly: node server/index.js
 */

import "dotenv/config";

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import cors from "@fastify/cors";

import { createTailscaleAuth } from "./middleware/auth.js";
import { createEventBus, type EventBus } from "./websocket.js";
import { Coordinator, type CoordinatorConfig } from "../core/coordinator.js";
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
function buildDefaultRegistry(projectRoot: string): WorkerRegistry {
  const registry = new WorkerRegistry();
  registry.register(new ScoutWorker({ projectRoot }));
  registry.register(new BuilderWorker({ projectRoot }));
  registry.register(new CriticWorker({ projectRoot }));
  registry.register(new VerifierWorker());
  registry.register(new IntegratorWorker());
  console.log("[server] WorkerRegistry: 5 workers registered — scout, builder, critic, verifier, integrator");
  return registry;
}

// ─── Resolve ui/ directory relative to this file ─────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const UI_ROOT = join(__dirname, "..", "ui");

// ─── Boot ────────────────────────────────────────────────────────────

export async function createServer(
  config: Partial<ServerConfig> = {},
  trustProfile?: TrustProfile,
  workerRegistry?: WorkerRegistry
): Promise<ReturnType<typeof Fastify>> {
  const cfg: ServerConfig = { ...DEFAULT_CONFIG, ...config };
  const registry = workerRegistry ?? buildDefaultRegistry(cfg.projectRoot);
  const profile = trustProfile ?? defaultTrustProfile();

  const eventBus = createEventBus();

  const coordinator = new Coordinator(
    {
      projectRoot: cfg.projectRoot,
      ...cfg.coordinatorConfig,
    },
    profile,
    registry,
    eventBus
  );

  const ctx: ServerContext = {
    coordinator,
    eventBus,
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
    indexHtml = "<html><body><h1>Zendorium</h1><p>ui/index.html not found</p></body></html>";
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
    server.log.info(`Zendorium server listening on ${address}`);
    server.log.info(`WebSocket available at ws://${cfg.host}:${cfg.port}/ws`);
    server.log.info(`UI available at http://${cfg.host}:${cfg.port}/`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }

  // Graceful shutdown
  const shutdown = async () => {
    server.log.info("Shutting down Zendorium server...");
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
    console.error("Zendorium server failed to start:", err);
    process.exit(1);
  });
}

// ─── Type augmentation for Fastify ───────────────────────────────────

declare module "fastify" {
  interface FastifyInstance {
    ctx: ServerContext;
  }
}
