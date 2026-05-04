// src/app.ts
// Fastify application factory — separate from server entry point for testability.

import Fastify, { FastifyInstance } from "fastify";
import fastifyCors from "@fastify/cors";
import fastifyJwt from "@fastify/jwt";
import fastifyWebsocket from "@fastify/websocket";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import { config } from "./utils/config.js";
import { authRoutes } from "./routes/auth.js";
import { robotRoutes } from "./routes/robots.js";
import { telemetryRoutes } from "./routes/telemetry.js";
import { wsRoutes } from "./routes/ws.js";

// Augment FastifyInstance with authenticate shorthand
declare module "fastify" {
  interface FastifyInstance {
    authenticate: (req: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply) => Promise<void>;
  }
}

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.NODE_ENV === "test" ? "silent" : "info",
      transport: config.NODE_ENV === "development"
        ? { target: "pino-pretty", options: { colorize: true } }
        : undefined,
    },
  });

  // ── Plugins ────────────────────────────────────────────────────────────────
  await app.register(fastifyCors, {
    origin: config.NODE_ENV === "production" ? false : true,
  });

  await app.register(fastifyJwt, { secret: config.JWT_SECRET });

  // Shorthand preHandler for protected routes
  app.decorate("authenticate", async (req: any, reply: any) => {
    try {
      await req.jwtVerify();
    } catch {
      reply.code(401).send({ error: "Unauthorized", message: "Invalid or expired token" });
    }
  });

  await app.register(fastifyWebsocket);

  // OpenAPI / Swagger docs at /docs
  await app.register(fastifySwagger, {
    openapi: {
      info: {
        title: "RoboMonitor API",
        description: "Real-time robot telemetry, anomaly detection, and WebSocket streaming",
        version: "1.0.0",
      },
      components: {
        securitySchemes: {
          bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
        },
      },
    },
  });

  await app.register(fastifySwaggerUi, {
    routePrefix: "/docs",
    uiConfig: { docExpansion: "list", deepLinking: false },
  });

  // ── Health ─────────────────────────────────────────────────────────────────
  app.get("/health", async () => ({
    status:      "ok",
    service:     "RoboMonitor",
    version:     "1.0.0",
    environment: config.NODE_ENV,
    timestamp:   new Date().toISOString(),
  }));

  // ── Request logging middleware ──────────────────────────────────────────────
  app.addHook("onRequest", (req, _reply, done) => {
    req.log.info({ method: req.method, url: req.url }, "incoming_request");
    done();
  });

  // ── Routes under /api/v1 ───────────────────────────────────────────────────
  await app.register(authRoutes,      { prefix: "/api/v1" });
  await app.register(robotRoutes,     { prefix: "/api/v1" });
  await app.register(telemetryRoutes, { prefix: "/api/v1" });
  await app.register(wsRoutes);   // WebSocket routes don't use /api/v1

  // ── Global error handler ───────────────────────────────────────────────────
  app.setErrorHandler((err, req, reply) => {
    req.log.error({ err, path: req.url }, "unhandled_error");
    reply.code(err.statusCode ?? 500).send({
      error: err.name ?? "InternalServerError",
      message: err.message ?? "An unexpected error occurred",
    });
  });

  return app;
}
