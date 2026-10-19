import { join } from "path";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import cors from "@fastify/cors";
import { vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

// Re-export test-db helpers for convenience
export { clearTestDb };

export interface TestServer {
  app: FastifyInstance;
  port: number;
  baseUrl: string;
  wsBaseUrl: string;
  cleanup: () => void;
  teardown: () => Promise<void>;
}

/**
 * Start a lightweight test server with Fastify + WebSocket support.
 * Uses in-memory DB via test-db helper (same pattern as existing tests).
 * Listens on a random port for real HTTP/WS connections.
 */
export async function startTestServer(opts?: {
  registerRoutes?: (app: FastifyInstance) => Promise<void>;
}): Promise<TestServer> {
  const { cleanup } = setupTestDb();

  // Mock the DB module to use test DB
  vi.doMock("../../store/db.js", () => ({
    getDb: () => getTestDb(),
    closeDb: () => {},
  }));

  const mockConfig = {
    defaults: {
      timeout: 600,
      maxTurns: 100,
      maxBudgetUsd: 5.0,
      effort: "high" as const,
      model: "claude-sonnet-4-6",
      settingSources: ["project"],
      allowedTools: [],
      disallowedTools: [],
      approvalRequired: [],
      approvalTimeout: 300,
      env: {},
    },
    server: { port: 0, host: "127.0.0.1" },
  };

  vi.doMock("../../config/index.js", () => ({
    loadConfig: () => mockConfig,
    loadDefaultConfig: () => mockConfig,
    getDefaults: () => mockConfig.defaults,
  }));

  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true });
  await app.register(websocket, {
    options: { maxPayload: 1024 * 1024 },
  });

  if (opts?.registerRoutes) {
    await opts.registerRoutes(app);
  }

  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    app,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    wsBaseUrl: `ws://127.0.0.1:${port}`,
    cleanup,
    teardown: async () => {
      await app.close();
      cleanup();
      vi.restoreAllMocks();
    },
  };
}
