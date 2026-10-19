import { existsSync } from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { timingSafeEqual } from "node:crypto";
import type { ServerConfig } from "../shared/types.js";

import { PACKAGE_ROOT } from "../lib/package-root.js";
import { getVersion } from "../lib/version.js";
import { getAuthKeyBuffer, setAuthKey } from "./auth-key.js";

export function buildApp(_config: ServerConfig, apiKey?: string) {
  if (!apiKey || apiKey.length === 0) {
    throw new Error(
      "server.apiKey required — bootstrap must run before buildApp. " +
      "Tests should pass TEST_API_KEY as the second argument.",
    );
  }
  // Seed auth-key module (idempotent — bootstrap may have already called this)
  setAuthKey(apiKey);

  const app = Fastify({
    logger: false,
  });

  // OpenAPI spec generation
  void app.register(swagger, {
    openapi: {
      info: {
        title: "Adam API",
        description: "Agent orchestration server built on Claude Agent SDK. Multi-agent system with parallel task execution, intelligent agent routing, self-evolving personas, and REST/WebSocket API.",
        version: getVersion(),
      },
      servers: [{ url: "http://localhost:7100" }],
      tags: [
        { name: "Tasks", description: "Task lifecycle management" },
        { name: "Roles", description: "Role CRUD and workspace management" },
        { name: "Skills", description: "Skill CRUD and permissions" },
        { name: "Memories", description: "Agent memory search and retrieval" },
        { name: "Goals", description: "Goal-driven task management" },
        { name: "Strategies", description: "Thompson Sampling strategy engine" },
        { name: "Templates", description: "Task template CRUD and triggers" },
        { name: "Webhooks", description: "External system integration" },
        { name: "Config", description: "Runtime configuration management" },
        { name: "Evolution", description: "Agent evolution audit log" },
        { name: "Cost", description: "Platform LLM cost accounting" },
        { name: "Health", description: "Server health checks" },
      ],
      components: {
        securitySchemes: {
          apiKey: {
            type: "apiKey",
            in: "header",
            name: "x-api-key",
            description: "API key for webhook endpoints",
          },
        },
      },
    },
  });

  // Swagger UI at /docs
  void app.register(swaggerUi, {
    routePrefix: "/docs",
  });

  void app.register(cors, {
    origin: true,
  });

  void app.register(websocket, {
    options: {
      maxPayload: 1024 * 1024 * 16,
    },
  });

  // Global API key auth (after CORS, before routes). Always enforced.
  app.addHook("onRequest", async (request, reply) => {
    const url = request.url;
    // Skip health endpoints, docs, static UI assets, and the auth verification endpoint itself.
    // /auth/verify runs its own check via the same hook pattern — but it needs to be reachable
    // for the login page to validate a candidate key; the header check below handles it.
    if (
      url === "/healthz" ||
      url === "/readyz" ||
      url.startsWith("/docs") ||
      url.startsWith("/ui")
    ) {
      return;
    }

    const keyBuffer = getAuthKeyBuffer();

    // Check header first, then query param (for browser WebSocket which can't set headers)
    const headerKey = request.headers["x-api-key"] as string | undefined;
    if (headerKey && timingSafeCompare(headerKey, keyBuffer)) return;

    const query = request.query as Record<string, string>;
    const queryKey = query["api_key"] || query["x-api-key"];
    if (queryKey && timingSafeCompare(queryKey, keyBuffer)) return;

    return reply.status(401).send({ code: "UNAUTHORIZED", message: "Invalid or missing API key" });
  });

  const webDistPath = path.join(PACKAGE_ROOT, "web/dist");
  if (existsSync(webDistPath)) {
    void app.register(fastifyStatic, {
      root: webDistPath,
      prefix: "/ui/",
      wildcard: true,
    });

    // SPA fallback: /ui serves index.html; /ui/* only for navigation routes (no file extension)
    app.get("/ui", async (_request, reply) => {
      return reply.sendFile("index.html", webDistPath);
    });
  }

  // Normalize Fastify validation errors to Adam's { code, message } format.
  // This ensures routes with JSON Schema body definitions (for OpenAPI docs)
  // produce the same error format as manual zod safeParse validation.
  app.setErrorHandler((error: { validation?: Array<{ instancePath?: string; params?: { missingProperty?: string }; message?: string }>; statusCode?: number; message: string }, _request, reply) => {
    if (error.validation) {
      const messages = error.validation.map((v: { instancePath?: string; params?: { missingProperty?: string }; message?: string }) => {
        const path = v.instancePath || v.params?.missingProperty || "";
        return path ? `${path}: ${v.message}` : v.message;
      });
      return reply.status(400).send({
        code: "VALIDATION_ERROR",
        message: messages.join("; "),
      });
    }
    // Non-validation errors: preserve status code
    const statusCode = error.statusCode ?? 500;
    return reply.status(statusCode).send({
      code: "INTERNAL_ERROR",
      message: error.message,
    });
  });

  // SPA fallback: serve index.html for client-side routes only (not asset files)
  app.setNotFoundHandler((request, reply) => {
    const urlPath = request.url.split("?")[0];
    if (request.url.startsWith("/ui") && existsSync(webDistPath) && !path.extname(urlPath)) {
      return reply.sendFile("index.html", webDistPath);
    }
    return reply.status(404).send({ code: "NOT_FOUND", message: "Route not found" });
  });

  return app;
}

function timingSafeCompare(a: string, b: Buffer): boolean {
  try {
    const aBuf = Buffer.from(a);
    if (aBuf.length !== b.length) return false;
    return timingSafeEqual(aBuf, b);
  } catch {
    return false;
  }
}
