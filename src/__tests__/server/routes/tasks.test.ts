import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../../helpers/test-db.js";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

const { cleanup } = setupTestDb();

vi.mock("../../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

vi.mock("../../../config/index.js", () => ({
  getDefaults: () => ({
    timeout: 600,
    approvalRequired: ["rm -rf"],
    approvalTimeout: 300,
    allowedTools: [],
    disallowedTools: [],
    maxTurns: 100,
    maxBudgetUsd: 5.0,
    model: "claude-sonnet-4-6",
    effort: "high",
    settingSources: ["project"],
    env: {},
  }),
}));

import { taskRoutes } from "../../../server/routes/tasks.js";
import { createRole } from "../../../store/roles.js";
import type { Role } from "../../../shared/types.js";
import { createTask } from "../../../store/tasks.js";

const TEST_ROLE_ID = "role-test-route";

afterAll(() => cleanup());

describe("server/routes/tasks", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    clearTestDb();

    // Admission requires an existing active role. Seed one for every test.
    const role: Role = {
      id: TEST_ROLE_ID,
      name: "route-test",
      cagPrompt: "test",
      learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
      memoryStreamId: `ms-${TEST_ROLE_ID}`,
      status: "active",
      preferences: {},
      createdAt: Date.now(),
    };
    createRole(role);

    app = Fastify();
    app.setErrorHandler((error: { validation?: Array<{ instancePath?: string; params?: { missingProperty?: string }; message?: string }>; statusCode?: number; message: string }, _request, reply) => {
      if (error.validation) {
        const messages = error.validation.map((v: { instancePath?: string; params?: { missingProperty?: string }; message?: string }) => {
          const path = v.instancePath || v.params?.missingProperty || "";
          return path ? `${path}: ${v.message}` : v.message;
        });
        return reply.status(400).send({ code: "VALIDATION_ERROR", message: messages.join("; ") });
      }
      const statusCode = error.statusCode ?? 500;
      return reply.status(statusCode).send({ code: "INTERNAL_ERROR", message: error.message });
    });
    await app.register(async (instance) => {
      await taskRoutes(instance);
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  describe("POST /tasks", () => {
    it("should create task and return 201 with taskId", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/tasks",
        payload: { prompt: "Hello, world!", roleId: TEST_ROLE_ID },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body.taskId).toBeDefined();
      expect(typeof body.taskId).toBe("string");
    });

    it("should return 400 when prompt is missing", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/tasks",
        payload: {},
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.code).toBe("VALIDATION_ERROR");
    });

    it("should return 400 when prompt is empty string", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/tasks",
        payload: { prompt: "" },
      });

      expect(response.statusCode).toBe(400);
    });

    it("should accept custom config overrides", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/tasks",
        payload: {
          prompt: "test",
          roleId: TEST_ROLE_ID,
          config: { timeout: 120, maxTurns: 50 },
        },
      });

      expect(response.statusCode).toBe(201);
    });

    it("returns 400 with ROLE_TOOL_MISMATCH when requirements exceed role capabilities", async () => {
      // seeded role has no allowedTools — demand "Bash" which it lacks
      const response = await app.inject({
        method: "POST",
        url: "/tasks",
        payload: {
          prompt: "run a shell command",
          roleId: TEST_ROLE_ID,
          requirements: { tools: ["Bash"] },
        },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.code).toBe("ROLE_TOOL_MISMATCH");
      expect(body.message).toBeDefined();
      expect(body.missing?.tools).toEqual(["Bash"]);
    });

    it("returns 400 with REQUIREMENTS_MISSING when autoSelectRole is true but no requirements", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/tasks",
        payload: {
          prompt: "ambiguous task",
          autoSelectRole: true,
        },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.code).toBe("REQUIREMENTS_MISSING");
    });
  });

  describe("GET /tasks", () => {
    it("should list tasks", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/tasks",
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.tasks).toBeDefined();
      expect(Array.isArray(body.tasks)).toBe(true);
    });

    it("should return created tasks", async () => {
      await app.inject({
        method: "POST",
        url: "/tasks",
        payload: { prompt: "task 1", roleId: TEST_ROLE_ID },
      });
      await app.inject({
        method: "POST",
        url: "/tasks",
        payload: { prompt: "task 2", roleId: TEST_ROLE_ID },
      });

      const response = await app.inject({
        method: "GET",
        url: "/tasks",
      });

      const body = JSON.parse(response.body);
      expect(body.tasks.length).toBe(2);
    });

    it("should filter by status", async () => {
      await app.inject({
        method: "POST",
        url: "/tasks",
        payload: { prompt: "test", roleId: TEST_ROLE_ID },
      });

      const response = await app.inject({
        method: "GET",
        url: "/tasks?status=pending",
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.tasks.length).toBe(1);
    });

    it("does not expose executionProfile envVars in task list", async () => {
      createTask({
        id: "00000000-0000-0000-0000-000000000101",
        status: "pending",
        prompt: "secret task",
        config: {
          timeout: 300,
          approvalRequired: [],
          approvalTimeout: 60,
          env: { API_TOKEN: "secret-token" },
          executionProfile: {
            id: TEST_ROLE_ID,
            name: "route-test",
            cagPrompt: "test",
            learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
            memoryStreamId: `ms-${TEST_ROLE_ID}`,
            status: "active",
            preferences: {},
            createdAt: Date.now(),
            envVars: { PRIVATE_TOKEN: "secret-token" },
          },
        },
        createdAt: Date.now(),
        roleId: TEST_ROLE_ID,
      });

      const response = await app.inject({ method: "GET", url: "/tasks" });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(JSON.stringify(body)).not.toContain("secret-token");
      expect(body.tasks[0].config).not.toHaveProperty("executionProfile");
      expect(body.tasks[0].config).not.toHaveProperty("env");
    });
  });

  describe("GET /tasks/:id", () => {
    it("should return task by id", async () => {
      const createResp = await app.inject({
        method: "POST",
        url: "/tasks",
        payload: { prompt: "test", roleId: TEST_ROLE_ID },
      });
      const { taskId } = JSON.parse(createResp.body);

      const response = await app.inject({
        method: "GET",
        url: `/tasks/${taskId}`,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.task.id).toBe(taskId);
      expect(body.task.prompt).toBe("test");
    });

    it("should return 404 for non-existent task", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/tasks/00000000-0000-0000-0000-000000000000",
      });

      expect(response.statusCode).toBe(404);
    });

    it("should return 400 for invalid UUID", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/tasks/not-a-uuid",
      });

      expect(response.statusCode).toBe(400);
    });

    it("does not expose executionProfile envVars in task detail", async () => {
      const taskId = "11111111-1111-4111-8111-111111111102";
      createTask({
        id: taskId,
        status: "pending",
        prompt: "secret task",
        config: {
          timeout: 300,
          approvalRequired: [],
          approvalTimeout: 60,
          executionProfile: {
            id: TEST_ROLE_ID,
            name: "route-test",
            cagPrompt: "test",
            learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
            memoryStreamId: `ms-${TEST_ROLE_ID}`,
            status: "active",
            preferences: {},
            createdAt: Date.now(),
            envVars: { PRIVATE_TOKEN: "detail-secret" },
          },
        },
        createdAt: Date.now(),
        roleId: TEST_ROLE_ID,
      });

      const response = await app.inject({ method: "GET", url: `/tasks/${taskId}` });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(JSON.stringify(body)).not.toContain("detail-secret");
      expect(body.task.config).not.toHaveProperty("executionProfile");
    });
  });

  describe("POST /tasks/:id/cancel", () => {
    it("should cancel a pending task", async () => {
      const createResp = await app.inject({
        method: "POST",
        url: "/tasks",
        payload: { prompt: "test", roleId: TEST_ROLE_ID },
      });
      const { taskId } = JSON.parse(createResp.body);

      const response = await app.inject({
        method: "POST",
        url: `/tasks/${taskId}/cancel`,
      });

      expect(response.statusCode).toBe(200);
      // TaskController calls updateTask to cancel
      const { getTask } = await import("../../../store/tasks.js");
      const task = getTask(taskId);
      expect(task?.status).toBe("cancelled");
    });

    it("should return 404 for non-existent task", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/tasks/00000000-0000-0000-0000-000000000000/cancel",
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe("POST /tasks/batch-cancel", () => {
    it("should cancel multiple pending tasks in one call", async () => {
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const resp = await app.inject({ method: "POST", url: "/tasks", payload: { prompt: `task ${i}`, roleId: TEST_ROLE_ID } });
        ids.push(JSON.parse(resp.body).taskId);
      }

      const response = await app.inject({
        method: "POST",
        url: "/tasks/batch-cancel",
        payload: { taskIds: ids },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.cancelled).toBe(3);
      expect(body.total).toBe(3);
      expect(body.errors).toBeUndefined();

      // Verify all tasks are now cancelled
      const { getTask } = await import("../../../store/tasks.js");
      for (const id of ids) {
        expect(getTask(id)?.status).toBe("cancelled");
      }
    });

    it("should skip tasks in terminal state and report them in errors", async () => {
      const { getTask, updateTask } = await import("../../../store/tasks.js");

      // Create tasks
      const resp1 = await app.inject({ method: "POST", url: "/tasks", payload: { prompt: "pending one", roleId: TEST_ROLE_ID } });
      const id1 = JSON.parse(resp1.body).taskId;

      const resp2 = await app.inject({ method: "POST", url: "/tasks", payload: { prompt: "will complete", roleId: TEST_ROLE_ID } });
      const id2 = JSON.parse(resp2.body).taskId;
      updateTask(id2, { status: "completed", completedAt: Date.now() });

      const resp3 = await app.inject({ method: "POST", url: "/tasks", payload: { prompt: "will fail", roleId: TEST_ROLE_ID } });
      const id3 = JSON.parse(resp3.body).taskId;
      updateTask(id3, { status: "failed", error: "boom", completedAt: Date.now() });

      const response = await app.inject({
        method: "POST",
        url: "/tasks/batch-cancel",
        payload: { taskIds: [id1, id2, id3] },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.cancelled).toBe(1);
      expect(body.total).toBe(3);
      expect(body.errors).toHaveLength(2);
      expect(body.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ taskId: id2, reason: expect.stringContaining("completed") }),
          expect.objectContaining({ taskId: id3, reason: expect.stringContaining("failed") }),
        ]),
      );
    });

    it("should return 400 for empty taskIds array", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/tasks/batch-cancel",
        payload: { taskIds: [] },
      });

      expect(response.statusCode).toBe(400);
    });

    it("should return correct count of cancelled vs total", async () => {
      const { updateTask } = await import("../../../store/tasks.js");

      const resp1 = await app.inject({ method: "POST", url: "/tasks", payload: { prompt: "a", roleId: TEST_ROLE_ID } });
      const id1 = JSON.parse(resp1.body).taskId;

      const resp2 = await app.inject({ method: "POST", url: "/tasks", payload: { prompt: "b", roleId: TEST_ROLE_ID } });
      const id2 = JSON.parse(resp2.body).taskId;
      updateTask(id2, { status: "completed", completedAt: Date.now() });

      const nonExistentId = "00000000-0000-0000-0000-000000000001";

      const response = await app.inject({
        method: "POST",
        url: "/tasks/batch-cancel",
        payload: { taskIds: [id1, id2, nonExistentId] },
      });

      const body = JSON.parse(response.body);
      expect(body.cancelled).toBe(1);
      expect(body.total).toBe(3);
      expect(body.errors).toHaveLength(2);
    });
  });
});
