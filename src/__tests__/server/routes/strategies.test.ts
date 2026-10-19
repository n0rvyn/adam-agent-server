import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../../helpers/test-db.js";

const { cleanup } = setupTestDb();
vi.mock("../../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

// Mock StrategyEngine methods
vi.mock("../../../strategy/engine.js", () => ({
  StrategyEngine: {
    getStrategies: vi.fn().mockReturnValue([]),
    getSamplingProbabilities: vi.fn().mockReturnValue(new Map()),
    getPopulationStats: vi.fn().mockReturnValue({ count: 0, avgReward: 0 }),
  },
}));

import Fastify from "fastify";
import { strategyRoutes } from "../../../server/routes/strategies.js";
import { createStrategy } from "../../../store/strategies.js";
import type { Strategy } from "../../../shared/types.js";

afterAll(() => cleanup());
beforeEach(() => {
  clearTestDb();
  vi.clearAllMocks();
});

function makeStrategy(overrides: Partial<Strategy> = {}): Strategy {
  return {
    id: overrides.id ?? `strat-${Math.random().toString(36).slice(2)}`,
    roleId: overrides.roleId ?? "engineer",
    taskType: overrides.taskType ?? "code_review",
    name: overrides.name ?? "Default Strategy",
    promptTemplate: overrides.promptTemplate ?? "Review the code for {{file}}",
    alpha: overrides.alpha ?? 0.5,
    beta: overrides.beta ?? 0.5,
    totalTrials: overrides.totalTrials ?? 0,
    createdAt: overrides.createdAt ?? Date.now(),
  };
}

async function buildApp() {
  const app = Fastify();
  await app.register(async (instance) => {
    await strategyRoutes(instance);
  });
  await app.ready();
  return app;
}

describe("server/routes/strategies", () => {
  describe("GET /strategies", () => {
    it("should return strategies list", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/strategies" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveProperty("strategies");
      await app.close();
    });

    it("should filter by role query param", async () => {
      createStrategy(makeStrategy({ id: "s1", roleId: "engineer" }));
      createStrategy(makeStrategy({ id: "s2", roleId: "analyst" }));

      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/strategies?role=engineer" });
      expect(res.statusCode).toBe(200);
      // The route uses listStrategiesByRole for role-only queries
      const body = res.json();
      expect(body.strategies).toBeDefined();
      await app.close();
    });

    it("should use StrategyEngine for role+taskType queries", async () => {
      const { StrategyEngine } = await import("../../../strategy/engine.js");
      (StrategyEngine.getStrategies as ReturnType<typeof vi.fn>).mockReturnValueOnce([
        makeStrategy({ id: "filtered" }),
      ]);

      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/strategies?role=engineer&taskType=code_review",
      });
      expect(res.statusCode).toBe(200);
      expect(StrategyEngine.getStrategies).toHaveBeenCalledWith("engineer", "code_review");
      await app.close();
    });
  });

  describe("GET /strategies/:role/:taskType/probabilities (removed)", () => {
    it("should return 404 — endpoint removed (DP-001)", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/strategies/engineer/code_review/probabilities",
      });
      expect(res.statusCode).toBe(404);
      await app.close();
    });
  });
});
