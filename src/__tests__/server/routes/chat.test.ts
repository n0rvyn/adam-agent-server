import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import Fastify from "fastify";
import { setupTestDb, clearTestDb } from "../../helpers/test-db.js";

vi.mock("../../../store/db.js", () => ({
  getDb: () => getTestDbRef(),
}));

vi.mock("../../../config/index.js", () => ({
  getChatConfig: () => ({
    sessionTimeoutMinutes: 30,
    maxSessionTurns: 20,
    autoTitle: true,
    archiveExtractMemory: true,
  }),
  getDefaults: () => ({
    timeout: 600, approvalRequired: [], approvalTimeout: 300,
    allowedTools: [], disallowedTools: [], maxTurns: 100,
    maxBudgetUsd: 5.0, model: "", effort: "high",
    settingSources: ["project"], env: {},
  }),
  DEFAULT_CONFIG: { chat: { sessionTimeoutMinutes: 30, maxSessionTurns: 20, autoTitle: true, archiveExtractMemory: true } },
}));

vi.mock("../../../agent/memory-service.js", () => ({
  queryMemory: vi.fn().mockResolvedValue([]),
}));
vi.mock("../../../lib/llm-eval.js", () => ({
  callClaudeForEvaluation: vi.fn().mockResolvedValue("Mock Session Title"),
}));
vi.mock("../../../delivery/outbound-gateway.js", () => ({
  getOutboundGateway: () => ({ redeliverExecutionTo: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue({ success: true, logEntryId: "log-test" }),
  }),
}));

let dbRef: ReturnType<typeof setupTestDb>["db"];
function getTestDbRef() { return dbRef; }

import { chatRoutes } from "../../../server/routes/chat.js";
import { _resetForTest } from "../../../chat/session-manager.js";
import { _resetListenerForTest, setChatManager } from "../../../chat/message-handler.js";

describe("server/routes/chat", () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    const { db } = setupTestDb();
    dbRef = db;

    // Provide a mock ChatManager for handleChatMessage
    const mockChatManager = {
      handleMessage: vi.fn().mockResolvedValue("mock response"),
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn(),
      isHealthy: vi.fn().mockReturnValue(true),
    } as unknown as import("../../../manager/chat-manager.js").ChatManager;
    setChatManager(mockChatManager);

    app = Fastify();
    await app.register(chatRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await _resetListenerForTest();
    _resetForTest();
    await app.close();
    dbRef.close();
  });

  afterEach(async () => {
    await _resetListenerForTest();
  });

  beforeEach(async () => {
    _resetForTest();
    await _resetListenerForTest();
    clearTestDb();
  });

  describe("POST /chat/sessions", () => {
    it("creates a session", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/chat/sessions",
        payload: { source: { type: "web" } },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().session.status).toBe("active");
    });

    it("returns 400 for missing source", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/chat/sessions",
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("GET /chat/sessions", () => {
    it("lists sessions", async () => {
      // Create via route
      await app.inject({ method: "POST", url: "/chat/sessions", payload: { source: { type: "web" } } });
      await app.inject({ method: "POST", url: "/chat/sessions", payload: { source: { type: "tui" } } });
      const res = await app.inject({ method: "GET", url: "/chat/sessions" });
      expect(res.statusCode).toBe(200);
      expect(res.json().sessions.length).toBeGreaterThanOrEqual(2);
    });

    it("filters by status", async () => {
      await app.inject({ method: "POST", url: "/chat/sessions", payload: { source: { type: "api" } } });
      const res = await app.inject({ method: "GET", url: "/chat/sessions?status=active" });
      expect(res.statusCode).toBe(200);
      for (const s of res.json().sessions) {
        expect(s.status).toBe("active");
      }
    });
  });

  describe("GET /chat/sessions/:id", () => {
    it("returns session with messages", async () => {
      const createRes = await app.inject({
        method: "POST",
        url: "/chat/sessions",
        payload: { source: { type: "web" } },
      });
      const sessionId = createRes.json().session.id;
      const res = await app.inject({ method: "GET", url: `/chat/sessions/${sessionId}` });
      expect(res.statusCode).toBe(200);
      expect(res.json().session.id).toBe(sessionId);
      expect(res.json().messages).toBeDefined();
    });

    it("returns 404 for non-existent", async () => {
      const res = await app.inject({ method: "GET", url: `/chat/sessions/${crypto.randomUUID()}` });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("POST /chat/sessions/:id/archive", () => {
    it("archives session", async () => {
      const createRes = await app.inject({
        method: "POST",
        url: "/chat/sessions",
        payload: { source: { type: "web" } },
      });
      const sessionId = createRes.json().session.id;
      const res = await app.inject({ method: "POST", url: `/chat/sessions/${sessionId}/archive` });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe("archived");
    });

    it("returns 404 for non-existent", async () => {
      const res = await app.inject({ method: "POST", url: `/chat/sessions/${crypto.randomUUID()}/archive` });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("POST /chat/sessions/:id/restore", () => {
    it("restores archived session", async () => {
      const createRes = await app.inject({
        method: "POST",
        url: "/chat/sessions",
        payload: { source: { type: "web" } },
      });
      const sessionId = createRes.json().session.id;
      await app.inject({ method: "POST", url: `/chat/sessions/${sessionId}/archive` });
      const res = await app.inject({ method: "POST", url: `/chat/sessions/${sessionId}/restore` });
      expect(res.statusCode).toBe(200);
      expect(res.json().session.status).toBe("active");
    });
  });

  describe("DELETE /chat/sessions/:id", () => {
    it("deletes session", async () => {
      const createRes = await app.inject({
        method: "POST",
        url: "/chat/sessions",
        payload: { source: { type: "web" } },
      });
      const sessionId = createRes.json().session.id;
      const res = await app.inject({ method: "DELETE", url: `/chat/sessions/${sessionId}` });
      expect(res.statusCode).toBe(204);
    });

    it("returns 404 for non-existent", async () => {
      const res = await app.inject({ method: "DELETE", url: `/chat/sessions/${crypto.randomUUID()}` });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("POST /chat/messages", () => {
    it("creates session and message on first send", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/chat/messages",
        payload: { content: "hello", source: { type: "web" } },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().sessionId).toBeDefined();
      expect(res.json().messageId).toBeDefined();
    });

    it("returns 400 for empty content", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/chat/messages",
        payload: { content: "", source: { type: "web" } },
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 400 for missing source", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/chat/messages",
        payload: { content: "hello" },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("GET /chat/sessions/:id/messages", () => {
    it("returns messages for session", async () => {
      const createRes = await app.inject({
        method: "POST",
        url: "/chat/sessions",
        payload: { source: { type: "web" } },
      });
      const sessionId = createRes.json().session.id;
      const res = await app.inject({ method: "GET", url: `/chat/sessions/${sessionId}/messages` });
      expect(res.statusCode).toBe(200);
      expect(res.json().messages).toBeDefined();
    });

    it("returns 404 for non-existent session", async () => {
      const res = await app.inject({ method: "GET", url: `/chat/sessions/${crypto.randomUUID()}/messages` });
      expect(res.statusCode).toBe(404);
    });
  });
});
