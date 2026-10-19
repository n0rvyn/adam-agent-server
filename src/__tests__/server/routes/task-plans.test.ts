import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import Fastify from "fastify";
import { setupTestDb, clearTestDb, getTestDb } from "../../helpers/test-db.js";

const { cleanup } = setupTestDb();
vi.mock("../../../store/db.js", () => ({ getDb: () => getTestDb(), closeDb: () => {} }));
vi.mock("../../../config/index.js", () => ({
  getDefaults: () => ({
    plugins: [], allowedTools: [], disallowedTools: [],
    approvalRequired: [], maxBudgetUsd: 5.0,
    timeout: 600, approvalTimeout: 300,
  }),
}));

import { createTask } from "../../../store/tasks.js";
import { createTaskPlan } from "../../../store/task-plans.js";
import { taskRoutes } from "../../../server/routes/tasks.js";
import type { TaskPlan } from "../../../shared/types.js";

afterAll(() => cleanup());
beforeEach(() => clearTestDb());

async function buildApp() {
  const app = Fastify();
  await app.register(async (instance) => {
    await taskRoutes(instance);
  });
  await app.ready();
  return app;
}

describe("GET /tasks/:id/plan", () => {
  it("returns plans for existing task", async () => {
    const app = await buildApp();

    createTask({
      id: "00000000-0000-4000-8000-000000000001",
      status: "completed",
      prompt: "test",
      createdAt: Date.now(),
      config: { timeout: 600, approvalRequired: [], approvalTimeout: 300 } as any,
    });

    const plan: TaskPlan = {
      id: "plan-1",
      taskId: "00000000-0000-4000-8000-000000000001",
      plan: {
        steps: [{ index: 0, description: "Analyze", toolsNeeded: ["Read"], expectedOutput: "Analysis", riskLevel: "low" }],
        requiredPermissions: { allowedTools: [], disallowedTools: [], approvalRequired: [], maxBudgetUsd: 5, plugins: [] },
        overallRisk: "low",
      },
      status: "approved",
      createdAt: Date.now(),
    };
    createTaskPlan(plan);

    const res = await app.inject({ method: "GET", url: "/tasks/00000000-0000-4000-8000-000000000001/plan" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { plans: any[] };
    expect(body.plans).toHaveLength(1);
    expect(body.plans[0].taskId).toBe("00000000-0000-4000-8000-000000000001");
    expect(body.plans[0].plan.steps).toHaveLength(1);
  });

  it("returns empty array for task with no plans", async () => {
    const app = await buildApp();

    createTask({
      id: "00000000-0000-4000-8000-000000000002",
      status: "completed",
      prompt: "test",
      createdAt: Date.now(),
      config: { timeout: 600, approvalRequired: [], approvalTimeout: 300 } as any,
    });

    const res = await app.inject({ method: "GET", url: "/tasks/00000000-0000-4000-8000-000000000002/plan" });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { plans: any[] }).plans).toHaveLength(0);
  });

  it("returns 404 for non-existent task", async () => {
    const app = await buildApp();

    const res = await app.inject({ method: "GET", url: "/tasks/00000000-0000-4000-8000-000000000099/plan" });
    expect(res.statusCode).toBe(404);
  });
});
