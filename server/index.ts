/**
 * Zendorium Server — Fastify + WebSocket on port 18796.
 *
 * Entry point for the Zendorium API. Mounts all route files,
 * connects to the Coordinator, and streams events over WebSocket.
 */

import Fastify from "fastify";
import websocket from "@fastify/websocket";
import cors from "@fastify/cors";

import { createTailscaleAuth } from "./middleware/auth.js";
import { createEventBus, type EventBus } from "./websocket.js";
import { Coordinator, type CoordinatorConfig } from "../core/coordinator.js";
import { WorkerRegistry } from "../workers/base.js";
import type { TrustProfile } from "../router/trust-router.js";

import { taskRoutes } from "./routes/tasks.js";
import { runRoutes } from "./routes/runs.js";
import { workerRoutes } from "./routes/workers.js";
import { healthRoutes } from "./routes/health.js";

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

// ─── Boot ────────────────────────────────────────────────────────────

export async function createServer(
  config: Partial<ServerConfig> = {},
  trustProfile: TrustProfile,
  workerRegistry: WorkerRegistry
): Promise<ReturnType<typeof Fastify>> {
  const cfg: ServerConfig = { ...DEFAULT_CONFIG, ...config };

  const eventBus = createEventBus();

  const coordinator = new Coordinator(
    {
      projectRoot: cfg.projectRoot,
      ...cfg.coordinatorConfig,
    },
    trustProfile,
    workerRegistry,
    eventBus
  );

  const ctx: ServerContext = {
    coordinator,
    eventBus,
    workerRegistry,
    config: cfg,
    startedAt: new Date().toISOString(),
  };

  // ─── Fastify instance ──────────────────────────────────────────

  const server = Fastify({
    logger: {
      level: "info",
      transport: {
        target: "pino-pretty",
        options: { colorize: true },
      },
    },
  });

  // ─── Plugins ───────────────────────────────────────────────────

  await server.register(cors, {
    origin: true,
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
  });

  await server.register(websocket);

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

  // ─── WebSocket endpoint ────────────────────────────────────────

  server.register(async function (fastify) {
    fastify.get("/ws", { websocket: true }, (socket, req) => {
      // Parse optional event filter from query
      const url = new URL(req.url ?? "/", "http://localhost");
      const filterParam = url.searchParams.get("events");
      const filter = filterParam
        ? (filterParam.split(",") as any[])
        : undefined;

      eventBus.addClient(socket, filter);

      socket.on("close", () => {
        eventBus.removeClient(socket);
      });

      socket.on("error", () => {
        eventBus.removeClient(socket);
      });

      // Client can send ping, we respond with pong
      socket.on("message", (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === "ping") {
            socket.send(JSON.stringify({ type: "pong", timestamp: new Date().toISOString() }));
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
  trustProfile: TrustProfile,
  workerRegistry: WorkerRegistry
): Promise<void> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const server = await createServer(cfg, trustProfile, workerRegistry);

  try {
    const address = await server.listen({ port: cfg.port, host: cfg.host });
    server.log.info(`Zendorium server listening on ${address}`);
    server.log.info(`WebSocket available at ws://${cfg.host}:${cfg.port}/ws`);
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

// ─── Type augmentation for Fastify ───────────────────────────────────

declare module "fastify" {
  interface FastifyInstance {
    ctx: ServerContext;
  }
}
