import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { setupTestDb, clearTestDb } from "../helpers/test-db.js";
import { vi } from "vitest";

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDbRef(),
}));

let dbRef: ReturnType<typeof setupTestDb>["db"];
function getTestDbRef() { return dbRef; }

import {
  createMessage,
  findEnvelopeByPlatformMessageId,
  findEnvelopesByPromptId,
  updatePlatformMessageId,
  updateMessagePromptBinding,
  getMessage,
} from "../../store/messages.js";
import { createSession } from "../../store/sessions.js";
import type { ChatSession } from "../../shared/types.js";

function makeSession(id = "session-1"): ChatSession {
  return {
    id,
    status: "active",
    source: { type: "web" },
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    messageCount: 0,
  };
}

describe("messages helpers (Task 8)", () => {
  beforeAll(() => {
    const { db } = setupTestDb();
    dbRef = db;
  });

  afterAll(() => {
    dbRef.close();
  });

  beforeEach(() => {
    clearTestDb();
    createSession(makeSession());
  });

  describe("findEnvelopeByPlatformMessageId", () => {
    it("returns matching row", () => {
      createMessage({
        id: "m1", sessionId: "session-1", role: "assistant", content: "hi",
        source: { type: "channel", channelId: "ch1", chatId: "c1" },
        kind: "approval_prompt", platformMessageId: "PM1", createdAt: 1,
      });
      expect(findEnvelopeByPlatformMessageId("PM1")?.id).toBe("m1");
    });

    it("returns undefined for non-existent platform_message_id", () => {
      createMessage({
        id: "m2", sessionId: "session-1", role: "assistant", content: "hi",
        source: { type: "web" }, kind: "user_message", createdAt: 2,
      });
      expect(findEnvelopeByPlatformMessageId("nonexistent")).toBeUndefined();
    });

    it("returns newest row when multiple rows share platform_message_id", () => {
      createMessage({
        id: "m-old", sessionId: "session-1", role: "assistant", content: "old",
        source: { type: "web" }, kind: "user_message", platformMessageId: "SAME-PM", createdAt: 1,
      });
      createMessage({
        id: "m-new", sessionId: "session-1", role: "assistant", content: "new",
        source: { type: "web" }, kind: "user_message", platformMessageId: "SAME-PM", createdAt: 2,
      });
      expect(findEnvelopeByPlatformMessageId("SAME-PM")?.id).toBe("m-new");
    });

    it("does not return row with NULL platform_message_id", () => {
      createMessage({
        id: "m-null", sessionId: "session-1", role: "assistant", content: "no pm",
        source: { type: "web" }, kind: "user_message", createdAt: 1,
      });
      // findEnvelopeByPlatformMessageId queries with WHERE platform_message_id = ?
      // A NULL value won't match "NULL" as a string, so it should return undefined
      expect(findEnvelopeByPlatformMessageId("NULL")).toBeUndefined();
    });
  });

  describe("findEnvelopesByPromptId", () => {
    it("returns rows ordered by created_at ASC", () => {
      createMessage({
        id: "m-a", sessionId: "session-1", role: "assistant", content: "first",
        source: { type: "web" }, kind: "approval_prompt", promptId: "P1", createdAt: 100,
      });
      createMessage({
        id: "m-b", sessionId: "session-1", role: "user", content: "second",
        source: { type: "web" }, kind: "user_message", promptId: "P1", createdAt: 200,
      });
      const rows = findEnvelopesByPromptId("P1");
      expect(rows).toHaveLength(2);
      expect(rows[0].id).toBe("m-a");
      expect(rows[1].id).toBe("m-b");
    });

    it("returns empty array for non-existent prompt_id", () => {
      expect(findEnvelopesByPromptId("NONEXISTENT")).toEqual([]);
    });

    it("does not return rows where prompt_id is NULL", () => {
      createMessage({
        id: "m-no-prompt", sessionId: "session-1", role: "assistant", content: "no prompt",
        source: { type: "web" }, kind: "user_message", createdAt: 1,
      });
      expect(findEnvelopesByPromptId("NONEXISTENT")).toEqual([]);
    });
  });

  describe("updatePlatformMessageId", () => {
    it("writes platform_message_id and getMessage can read it", () => {
      createMessage({
        id: "m-pm", sessionId: "session-1", role: "assistant", content: "test",
        source: { type: "channel", channelId: "wc1", chatId: "chat1" },
        kind: "approval_prompt", createdAt: 1,
      });
      updatePlatformMessageId("m-pm", "WC-MSG-123");
      const msg = getMessage("m-pm");
      expect(msg?.platformMessageId).toBe("WC-MSG-123");
    });

    it("overwrites previous platform_message_id on repeated calls", () => {
      createMessage({
        id: "m-pm2", sessionId: "session-1", role: "assistant", content: "test",
        source: { type: "channel", channelId: "tg1", chatId: "tgc1" },
        kind: "approval_prompt", createdAt: 1,
      });
      updatePlatformMessageId("m-pm2", "first");
      updatePlatformMessageId("m-pm2", "second");
      const msg = getMessage("m-pm2");
      expect(msg?.platformMessageId).toBe("second");
    });
  });

  describe("updateMessagePromptBinding", () => {
    it("writes prompt_id and getMessage can read it", () => {
      createMessage({
        id: "m-bind", sessionId: "session-1", role: "user", content: "批准",
        source: { type: "web" }, kind: "user_message", createdAt: 1,
      });
      updateMessagePromptBinding("m-bind", "A2K7");
      const msg = getMessage("m-bind");
      expect(msg?.promptId).toBe("A2K7");
    });

    it("overwrites previous prompt_id on repeated calls", () => {
      createMessage({
        id: "m-bind2", sessionId: "session-1", role: "user", content: "approved",
        source: { type: "web" }, kind: "user_message", createdAt: 1,
      });
      updateMessagePromptBinding("m-bind2", "FIRST");
      updateMessagePromptBinding("m-bind2", "SECOND");
      const msg = getMessage("m-bind2");
      expect(msg?.promptId).toBe("SECOND");
    });
  });

  describe("schema roundtrip: source_channel_id and source_chat_id", () => {
    it("stores and retrieves channel source with channelId and chatId", () => {
      createMessage({
        id: "m-channel", sessionId: "session-1", role: "assistant", content: "approval prompt",
        source: { type: "channel", channelId: "ch9", chatId: "c9" },
        kind: "approval_prompt", createdAt: 1,
      });
      const msg = getMessage("m-channel");
      expect(msg?.source.type).toBe("channel");
      expect(msg?.source.channelId).toBe("ch9");
      expect(msg?.source.chatId).toBe("c9");
    });

    it("returns undefined channelId/chatId for web source", () => {
      createMessage({
        id: "m-web", sessionId: "session-1", role: "assistant", content: "hello",
        source: { type: "web" },
        kind: "assistant_text", createdAt: 1,
      });
      const msg = getMessage("m-web");
      expect(msg?.source.type).toBe("web");
      expect(msg?.source.channelId).toBeUndefined();
      expect(msg?.source.chatId).toBeUndefined();
    });

    it("returns undefined channelId/chatId for tui source", () => {
      createMessage({
        id: "m-tui", sessionId: "session-1", role: "assistant", content: "hello tui",
        source: { type: "tui" },
        kind: "assistant_text", createdAt: 1,
      });
      const msg = getMessage("m-tui");
      expect(msg?.source.type).toBe("tui");
      expect(msg?.source.channelId).toBeUndefined();
      expect(msg?.source.chatId).toBeUndefined();
    });
  });
});
