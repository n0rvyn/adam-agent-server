import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
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
    approvalRequired: [],
    approvalTimeout: 300,
    allowedTools: [],
    disallowedTools: [],
    maxTurns: 100,
    maxBudgetUsd: 5.0,
    model: "claude-sonnet-4-6",
    effort: "high",
    settingSources: ["user", "project"],
    env: {},
  }),
}));

import { webhookRoutes } from "../../../server/routes/webhooks.js";
import { createTaskTemplate } from "../../../store/task-templates.js";

afterAll(() => cleanup());

describe("server/routes/webhooks", () => {
  let app: FastifyInstance;
  const mockBreeEngine = {
    runNow: vi.fn().mockResolvedValue("exec-123"),
    start: vi.fn(),
    stop: vi.fn(),
    scheduleJob: vi.fn(),
    unscheduleJob: vi.fn(),
    checkTaskCompleteTriggers: vi.fn(),
  };

  describe("without API key", () => {
    beforeEach(async () => {
      clearTestDb();
      mockBreeEngine.runNow.mockClear();
      app = Fastify();
      await app.register((instance) =>
        webhookRoutes(instance, mockBreeEngine as any),
      );
      await app.ready();
    });

    it("POST /webhooks/:name triggers template by ID", async () => {
      createTaskTemplate({
        id: "pkos-inbox",
        name: "PKOS Inbox Monitor",
        trigger: { type: "cron", cron: "*/15 * * * *" },
        steps: [{ id: "s1", prompt: "/inbox" }],
        rolePreference: "role-test-seed",
      enabled: true,
        createdAt: Date.now(),
      });

      const response = await app.inject({
        method: "POST",
        url: "/webhooks/pkos-inbox",
      });

      expect(response.statusCode).toBe(202);
      const body = JSON.parse(response.body);
      expect(body.code).toBe("ACCEPTED");
      expect(body.executionId).toBe("exec-123");
      expect(body.templateId).toBe("pkos-inbox");
      expect(mockBreeEngine.runNow).toHaveBeenCalledWith("pkos-inbox");
    });

    it("POST /webhooks/:name returns 404 for unknown template", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/webhooks/nonexistent",
      });

      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.body);
      expect(body.code).toBe("NOT_FOUND");
    });

    it("POST /webhooks/:name returns 409 for disabled template", async () => {
      createTaskTemplate({
        id: "disabled-template",
        name: "Disabled",
        trigger: { type: "manual" },
        steps: [{ id: "s1", prompt: "test" }],
        rolePreference: "role-test-seed",
      enabled: false,
        createdAt: Date.now(),
      });

      const response = await app.inject({
        method: "POST",
        url: "/webhooks/disabled-template",
      });

      expect(response.statusCode).toBe(409);
      const body = JSON.parse(response.body);
      expect(body.code).toBe("DISABLED");
    });

    it("GET /webhooks lists enabled templates as webhook endpoints", async () => {
      createTaskTemplate({
        id: "pkos-signal",
        name: "PKOS Signal",
        description: "Collect signals",
        trigger: { type: "cron", cron: "0 22 * * *" },
        steps: [{ id: "s1", prompt: "/signal" }],
        tags: ["pkos", "signal"],
        rolePreference: "role-test-seed",
      enabled: true,
        createdAt: Date.now(),
      });

      const response = await app.inject({
        method: "GET",
        url: "/webhooks",
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.webhooks).toHaveLength(1);
      expect(body.webhooks[0].name).toBe("pkos-signal");
      expect(body.webhooks[0].tags).toEqual(["pkos", "signal"]);
      expect(body.auth).toBe("X-API-Key header required");
    });

    it("POST /webhooks/:name returns 500 on execution error", async () => {
      createTaskTemplate({
        id: "error-template",
        name: "Error Template",
        trigger: { type: "manual" },
        steps: [{ id: "s1", prompt: "test" }],
        rolePreference: "role-test-seed",
      enabled: true,
        createdAt: Date.now(),
      });

      mockBreeEngine.runNow.mockRejectedValueOnce(new Error("execution failed"));

      const response = await app.inject({
        method: "POST",
        url: "/webhooks/error-template",
      });

      expect(response.statusCode).toBe(500);
      const body = JSON.parse(response.body);
      expect(body.code).toBe("EXECUTION_ERROR");
    });
  });

  // Webhook-level auth has moved to the global onRequest hook in src/server/app.ts.
  // See src/__tests__/server/app.test.ts for auth coverage.
});
