import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockListTasks, mockGetRuntimeConfig } = vi.hoisted(() => ({
  mockListTasks: vi.fn().mockReturnValue([]),
  mockGetRuntimeConfig: vi.fn(() => ({
    execution: { maxConcurrent: 5 },
  })),
}));

// Mock db and embedding before imports
vi.mock("../../../store/db.js", () => {
  const Database = require("better-sqlite3");
  const db = new Database(":memory:");
  db.exec("CREATE TABLE IF NOT EXISTS test (id INTEGER)");
  return {
    getDb: () => db,
    closeDb: () => {},
  };
});

vi.mock("../../../store/roles.js", () => ({
  listRoles: vi.fn().mockReturnValue([{ id: "role-1" }]),
}));

vi.mock("../../../lib/embedding.js", () => ({
  isModelAvailable: vi.fn().mockReturnValue(true),
}));

vi.mock("../../../store/tasks.js", () => ({
  listTasks: mockListTasks,
  getTotalCostSince: vi.fn().mockReturnValue(0),
}));

vi.mock("../../../config/runtime.js", () => ({
  getRuntimeConfig: mockGetRuntimeConfig,
}));

vi.mock("../../../audit/intent-eval.js", () => ({
  getIntentEvalStats: vi.fn(() => ({
    intentEvalDegradedToday: 3,
    intentEvalBudgetUsd: 1.25,
  })),
}));

import Fastify from "fastify";
import { healthRoutes } from "../../../server/routes/health.js";

function createMockConfig() {
  return {
    defaults: {
      timeout: 30000,
      maxTurns: 10,
      maxBudgetUsd: 1,
      effort: "medium" as const,
      model: "claude-sonnet-4-20250514",
      settingSources: [],
      allowedTools: [],
      disallowedTools: [],
      approvalRequired: [],
      approvalTimeout: 30000,
      env: {},
    },
    server: { port: 3000, host: "0.0.0.0" },
  };
}

describe("server/routes/health", () => {
  describe("GET /healthz", () => {
    it("should return ok status", async () => {
      const app = Fastify();
      const mockConfig = createMockConfig();

      await healthRoutes(app, mockConfig as any);
      await app.ready();

      const res = await app.inject({ method: "GET", url: "/healthz" });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe("ok");
      await app.close();
    });

    it("should always return 200 regardless of subsystem state", async () => {
      const app = Fastify();
      const mockConfig = createMockConfig();

      await healthRoutes(app, mockConfig as any);
      await app.ready();

      const res = await app.inject({ method: "GET", url: "/healthz" });
      expect(res.statusCode).toBe(200);
      await app.close();
    });
  });

  describe("GET /readyz", () => {
    it("should return ready when all checks pass", async () => {
      const app = Fastify();
      const mockConfig = createMockConfig();

      await healthRoutes(app, mockConfig as any);
      await app.ready();

      const res = await app.inject({ method: "GET", url: "/readyz" });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe("ready");
      expect(res.json().checks).toBeDefined();
      await app.close();
    });
  });

  describe("GET /stats", () => {
    beforeEach(() => {
      mockListTasks.mockReset();
      mockGetRuntimeConfig.mockReturnValue({ execution: { maxConcurrent: 5 } });
    });

    it("should return executionPool with active, max, queued fields", async () => {
      mockListTasks.mockImplementation((status: string) => {
        if (status === "running") return [{ id: "r1" }, { id: "r2" }];
        if (status === "pending") return [{ id: "p1" }];
        return [];
      });

      const app = Fastify();
      const mockConfig = createMockConfig();
      await healthRoutes(app, mockConfig as any);
      await app.ready();

      const res = await app.inject({ method: "GET", url: "/stats" });
      expect(res.statusCode).toBe(200);

      const body = res.json();
      expect(body.executionPool).toBeDefined();
      expect(body.executionPool.active).toBe(2);
      expect(body.executionPool.max).toBe(5);
      expect(body.executionPool.queued).toBe(1);
      expect(body.totalCostToday).toBe(0);
      expect(body.intentEvalDegradedToday).toBe(3);
      expect(body.intentEvalBudgetUsd).toBe(1.25);
      await app.close();
    });

    it("should reflect zero active and queued when no tasks", async () => {
      mockListTasks.mockReturnValue([]);

      const app = Fastify();
      const mockConfig = createMockConfig();
      await healthRoutes(app, mockConfig as any);
      await app.ready();

      const res = await app.inject({ method: "GET", url: "/stats" });
      const body = res.json();
      expect(body.executionPool.active).toBe(0);
      expect(body.executionPool.queued).toBe(0);
      await app.close();
    });
  });
});
