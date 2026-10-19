import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../../helpers/test-db.js";

const { cleanup } = setupTestDb();
vi.mock("../../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

// Mock embedding and memory-service
vi.mock("../../../lib/embedding.js", () => ({
  generateEmbedding: vi.fn().mockRejectedValue(new Error("not available")),
  isModelAvailable: vi.fn().mockReturnValue(false),
}));

vi.mock("../../../agent/memory-service.js", () => ({
  queryMemory: vi.fn().mockResolvedValue([]),
}));

import Fastify from "fastify";
import { memoryRoutes } from "../../../server/routes/memories.js";
import { createRole } from "../../../store/roles.js";
import { createMemory, getMemory } from "../../../store/memories.js";
import type { MemoryNode, Role } from "../../../shared/types.js";

afterAll(() => cleanup());
beforeEach(() => clearTestDb());

function seedAgent(id = "agent-1"): void {
  const agent: Role = {
    id,
    name: "Test Agent",
    cagPrompt: "",
    preferences: {},
    learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
    memoryStreamId: `stream-${id}`,
    status: "active",
    createdAt: Date.now(),
  };
  createRole(agent);
}

function seedMemory(roleId: string, id: string, content = "test content"): void {
  const mem: MemoryNode = {
    id,
    roleId,
    type: "event",
    content,
    keywords: ["test"],
    importance: 3,
    sourceType: "task_complete",
    createdAt: Date.now(),
    lastAccessed: Date.now(),
    retrievedCount: 0,
    tier: "episodic",
  };
  createMemory(mem);
}

async function buildApp() {
  const app = Fastify();
  await app.register(async (instance) => {
    await memoryRoutes(instance);
  });
  await app.ready();
  return app;
}

describe("server/routes/memories", () => {
  describe("GET /memories/:roleId", () => {
    it("should return memories for an agent", async () => {
      seedAgent("agent-1");
      seedMemory("agent-1", "m1", "first memory");
      seedMemory("agent-1", "m2", "second memory");

      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/memories/agent-1" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.memories.length).toBe(2);
      expect(body.count).toBe(2);
      // Should not include embedding in response
      expect(body.memories[0].embedding).toBeUndefined();
      await app.close();
    });

    it("should return 404 for non-existent agent", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/memories/nonexistent" });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe("NOT_FOUND");
      await app.close();
    });

    it("should return empty list for agent with no memories", async () => {
      seedAgent("agent-empty");
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/memories/agent-empty" });
      expect(res.statusCode).toBe(200);
      expect(res.json().memories).toEqual([]);
      expect(res.json().count).toBe(0);
      await app.close();
    });
  });

  describe("POST /memories/query", () => {
    it("should return 404 for non-existent agent", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/memories/query",
        payload: { roleId: "no-agent", prompt: "test" },
      });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it("should return 400 when body is invalid", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/memories/query",
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it("should return results from queryMemory", async () => {
      seedAgent("agent-q");
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/memories/query",
        payload: { roleId: "agent-q", prompt: "test query", topK: 5 },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().memories).toBeDefined();
      await app.close();
    });
  });


  describe("POST /memories", () => {
    it("should create a memory and return 201", async () => {
      seedAgent("agent-create");
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/memories",
        payload: { roleId: "agent-create", content: "new memory content", keywords: ["test"], importance: 4 },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.memory).toBeDefined();
      expect(body.memory.content).toBe("new memory content");
      expect(body.memory.roleId).toBe("agent-create");
      expect(body.memory.sourceType).toBe("manual");
      expect(body.memory.importance).toBe(4);
      expect(body.memory.embedding).toBeUndefined();
      await app.close();
    });

    it("should return 404 for non-existent role", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/memories",
        payload: { roleId: "no-role", content: "test" },
      });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it("should return 400 when body is invalid", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/memories",
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it("should default type to thought and importance to 3", async () => {
      seedAgent("agent-defaults");
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/memories",
        payload: { roleId: "agent-defaults", content: "default test" },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.memory.type).toBe("thought");
      expect(body.memory.importance).toBe(3);
      await app.close();
    });
  });

  describe("PATCH /memories/:id", () => {
    it("should update memory content", async () => {
      seedAgent("agent-patch");
      seedMemory("agent-patch", "m-patch", "old content");
      const app = await buildApp();
      const res = await app.inject({
        method: "PATCH",
        url: "/memories/m-patch",
        payload: { content: "updated content", importance: 5 },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.memoryId).toBe("m-patch");
      expect(body.updated).toBe(true);

      const mem = getMemory("m-patch");
      expect(mem!.content).toBe("updated content");
      expect(mem!.importance).toBe(5);
      await app.close();
    });

    it("should return 404 for non-existent memory", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "PATCH",
        url: "/memories/nonexistent",
        payload: { content: "test" },
      });
      expect(res.statusCode).toBe(404);
      await app.close();
    });
  });

  describe("DELETE /memories/:id", () => {
    it("should delete a memory", async () => {
      seedAgent("agent-del");
      seedMemory("agent-del", "m-del", "to be deleted");
      const app = await buildApp();
      const res = await app.inject({
        method: "DELETE",
        url: "/memories/m-del",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.memoryId).toBe("m-del");
      expect(body.deleted).toBe(true);
      expect(getMemory("m-del")).toBeUndefined();
      await app.close();
    });

    it("should return 404 for non-existent memory", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "DELETE",
        url: "/memories/nonexistent",
      });
      expect(res.statusCode).toBe(404);
      await app.close();
    });
  });
});
