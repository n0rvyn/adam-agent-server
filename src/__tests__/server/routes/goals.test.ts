import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../../helpers/test-db.js";

const { cleanup } = setupTestDb();
vi.mock("../../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

// Mock goal-manager functions
vi.mock("../../../goal-manager/goal-manager.js", () => ({
  parseGoal: vi.fn().mockImplementation((input: string) => {
    try {
      const parsed = JSON.parse(input);
      return {
        goalState: {
          name: parsed.name ?? "",
          description: parsed.description,
          metric: parsed.metric ?? "",
          targetValue: parsed.targetValue ?? 0,
          currentValue: parsed.currentValue ?? 0,
          deadline: parsed.deadline ?? 0,
          budget: parsed.budget ?? 0,
          roleId: parsed.roleId ?? "engineer",
          status: "active",
        },
        validationResult: {
          isValid: !!(parsed.name && parsed.metric && parsed.targetValue && parsed.deadline && parsed.budget),
          errors: [],
          warnings: [],
        },
        rawInput: input,
      };
    } catch {
      return {
        goalState: { name: input, metric: "", targetValue: 0, currentValue: 0, deadline: 0, budget: 0, roleId: "engineer", status: "active" },
        validationResult: { isValid: false, errors: ["S: name must be non-empty"], warnings: [] },
        rawInput: input,
      };
    }
  }),
  persistGoal: vi.fn().mockImplementation((goalState: Record<string, unknown>) => ({
    id: "goal-generated",
    name: goalState.name,
    description: goalState.description,
    roleId: goalState.roleId,
    metricType: goalState.metric,
    targetValue: goalState.targetValue,
    currentValue: goalState.currentValue ?? 0,
    deadline: goalState.deadline,
    budgetUsd: goalState.budget,
    status: "active",
    createdAt: Date.now(),
  })),
  buildMetricTree: vi.fn(),
}));

import Fastify from "fastify";
import { goalRoutes } from "../../../server/routes/goals.js";
import { createGoal } from "../../../store/goals.js";
import type { Goal } from "../../../shared/types.js";

afterAll(() => cleanup());
beforeEach(() => clearTestDb());

function makeGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: overrides.id ?? `goal-${Math.random().toString(36).slice(2)}`,
    name: overrides.name ?? "Test Goal",
    description: overrides.description,
    roleId: overrides.roleId ?? "engineer",
    metricType: overrides.metricType ?? "count",
    targetValue: overrides.targetValue ?? 100,
    currentValue: overrides.currentValue ?? 0,
    deadline: overrides.deadline ?? Date.now() + 86400000,
    budgetUsd: overrides.budgetUsd ?? 50,
    status: overrides.status ?? "active",
    createdAt: overrides.createdAt ?? Date.now(),
  };
}

async function buildApp() {
  const app = Fastify();
  await app.register(async (instance) => {
    await goalRoutes(instance);
  });
  await app.ready();
  return app;
}

describe("server/routes/goals", () => {
  describe("GET /goals", () => {
    it("should return empty list when no goals exist", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/goals" });
      expect(res.statusCode).toBe(200);
      expect(res.json().goals).toEqual([]);
      await app.close();
    });

    it("should return goals from database", async () => {
      createGoal(makeGoal({ id: "g1", name: "Goal One" }));
      createGoal(makeGoal({ id: "g2", name: "Goal Two" }));

      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/goals" });
      expect(res.statusCode).toBe(200);
      expect(res.json().goals.length).toBe(2);
      await app.close();
    });

    it("should filter by status query param", async () => {
      createGoal(makeGoal({ id: "g-active", status: "active" }));
      createGoal(makeGoal({ id: "g-completed", status: "completed" }));

      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/goals?status=active" });
      expect(res.statusCode).toBe(200);
      const goals = res.json().goals;
      expect(goals.length).toBe(1);
      expect(goals[0].status).toBe("active");
      await app.close();
    });
  });

  describe("GET /goals/:id", () => {
    it("should return a specific goal", async () => {
      createGoal(makeGoal({ id: "g-find", name: "Find Me" }));

      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/goals/g-find" });
      expect(res.statusCode).toBe(200);
      expect(res.json().goal.name).toBe("Find Me");
      await app.close();
    });

    it("should return 404 for non-existent goal", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/goals/nonexistent" });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe("NOT_FOUND");
      await app.close();
    });
  });

  describe("POST /goals", () => {
    it("should create a goal with valid JSON input", async () => {
      const app = await buildApp();
      const input = JSON.stringify({
        name: "Increase coverage",
        metric: "percentage",
        targetValue: 80,
        deadline: Date.now() + 86400000,
        budget: 100,
        roleId: "engineer",
      });
      const res = await app.inject({
        method: "POST",
        url: "/goals",
        payload: { input },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().goal).toBeDefined();
      await app.close();
    });

    it("should return 400 when input is missing", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/goals",
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });
  });
});
