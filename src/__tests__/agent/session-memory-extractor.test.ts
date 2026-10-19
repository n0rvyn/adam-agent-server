import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();
vi.mock("../../store/db.js", () => ({ getDb: () => getTestDb(), closeDb: () => {} }));
vi.mock("../../lib/embedding.js", () => ({
  generateEmbedding: vi.fn().mockRejectedValue(new Error("model not available")),
  isModelAvailable: vi.fn().mockReturnValue(false),
}));

import { extractFromSessionMessages, processSessionArchive } from "../../agent/session-memory-extractor.js";
import { createMessage } from "../../store/messages.js";
import * as sessionStore from "../../store/sessions.js";
import { listMemoriesByRole } from "../../store/memories.js";
import type { MemoryNode } from "../../shared/types.js";

afterAll(() => cleanup());
beforeEach(() => {
  clearTestDb();
  createRole({
    id: "agent-mem", name: "Test", cagPrompt: "",
    preferences: {}, learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] }, memoryStreamId: "mem-1",
    status: "active", createdAt: Date.now(),
  });
});

function seedSession(id: string) {
  sessionStore.createSession({
    id, status: "active", source: { type: "tui" }, 
    createdAt: Date.now(), lastActiveAt: Date.now(), messageCount: 0,
  });
}

describe("session-memory-extractor", () => {
  describe("extractFromSessionMessages", () => {
    it("extracts facts from user and assistant messages", () => {
      seedSession("sess-1");
      createMessage({ id: "m1", sessionId: "sess-1", role: "user", content: "How do I fix the authentication middleware in our Express app?", source: { type: "tui" }, createdAt: Date.now() });
      createMessage({ id: "m2", sessionId: "sess-1", role: "assistant", content: "You need to update the session token storage to use httpOnly cookies instead of localStorage for security.", source: { type: "tui" }, createdAt: Date.now() });

      const result = extractFromSessionMessages("sess-1");
      expect(result.facts.length).toBeGreaterThanOrEqual(2);
      expect(result.facts[0].content).toContain("User request:");
      expect(result.facts[1].content).toContain("Assistant response:");
    });

    it("skips short messages", () => {
      seedSession("sess-2");
      createMessage({ id: "m3", sessionId: "sess-2", role: "user", content: "ok", source: { type: "tui" }, createdAt: Date.now() });

      const result = extractFromSessionMessages("sess-2");
      expect(result.facts).toHaveLength(0);
    });

    it("returns empty for session with no messages", () => {
      seedSession("sess-3");
      const result = extractFromSessionMessages("sess-3");
      expect(result.facts).toHaveLength(0);
    });
  });

  describe("processSessionArchive", () => {
    it("stores extracted memories for the role", async () => {
      seedSession("sess-archive");
      createMessage({ id: "m4", sessionId: "sess-archive", role: "user", content: "I need to implement a rate limiter for the API endpoints to prevent abuse", source: { type: "tui" }, createdAt: Date.now() });
      createMessage({ id: "m5", sessionId: "sess-archive", role: "assistant", content: "Here is a sliding window rate limiter implementation using Redis for distributed counting across instances", source: { type: "tui" }, createdAt: Date.now() });

      const count = await processSessionArchive("sess-archive", "agent-mem");
      expect(count).toBeGreaterThanOrEqual(2);

      const memories = listMemoriesByRole("agent-mem", 10, 0);
      expect(memories.length).toBeGreaterThanOrEqual(2);
      expect(memories.some((m: MemoryNode) => m.sourceType === "session_archive")).toBe(true);
    });
  });
});
import { createRole } from "../../store/roles.js";
