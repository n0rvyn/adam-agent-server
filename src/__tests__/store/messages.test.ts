import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { vi } from "vitest";
import { setupTestDb, clearTestDb } from "../helpers/test-db.js";

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDbRef(),
}));

let dbRef: ReturnType<typeof setupTestDb>["db"];
function getTestDbRef() { return dbRef; }

import { createMessage, getMessage, getMessagesBySession, getRecentMessages, deleteMessage, deleteMessagesBySession, countMessagesBySession, findMessageByTaskId } from "../../store/messages.js";
import { createSession } from "../../store/sessions.js";
import type { ChatMessage, ChatSession } from "../../shared/types.js";

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

function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: `m-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    sessionId: "session-1",
    role: "user",
    content: "test message",
    source: { type: "web" },
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("store/messages", () => {
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

  it("creates and retrieves a message", () => {
    const msg = makeMessage();
    createMessage(msg);
    const retrieved = getMessage(msg.id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.content).toBe("test message");
    expect(retrieved!.role).toBe("user");
  });

  it("returns undefined for non-existent message", () => {
    expect(getMessage("nonexistent")).toBeUndefined();
  });

  it("gets messages by session ordered by created_at ASC", () => {
    const now = Date.now();
    createMessage(makeMessage({ id: "m1", createdAt: now }));
    createMessage(makeMessage({ id: "m2", createdAt: now + 100 }));
    createMessage(makeMessage({ id: "m3", createdAt: now + 200 }));

    const messages = getMessagesBySession("session-1");
    expect(messages).toHaveLength(3);
    expect(messages[0].id).toBe("m1");
    expect(messages[2].id).toBe("m3");
  });

  it("gets recent messages with correct limit and order", () => {
    const now = Date.now();
    for (let i = 0; i < 10; i++) {
      createMessage(makeMessage({ id: `m${i}`, createdAt: now + i * 100, content: `msg ${i}` }));
    }

    const recent = getRecentMessages("session-1", 3);
    expect(recent).toHaveLength(3);
    expect(recent[0].content).toBe("msg 7");
    expect(recent[1].content).toBe("msg 8");
    expect(recent[2].content).toBe("msg 9");
  });

  it("handles getRecentMessages with fewer messages than requested", () => {
    createMessage(makeMessage({ id: "m1" }));
    const recent = getRecentMessages("session-1", 10);
    expect(recent).toHaveLength(1);
  });

  it("deletes a single message", () => {
    const msg = makeMessage();
    createMessage(msg);
    deleteMessage(msg.id);
    expect(getMessage(msg.id)).toBeUndefined();
  });

  it("deletes all messages for a session", () => {
    createMessage(makeMessage({ id: "m1" }));
    createMessage(makeMessage({ id: "m2" }));
    deleteMessagesBySession("session-1");
    expect(getMessagesBySession("session-1")).toHaveLength(0);
  });

  it("counts messages by session", () => {
    createMessage(makeMessage({ id: "m1" }));
    createMessage(makeMessage({ id: "m2" }));
    createMessage(makeMessage({ id: "m3" }));
    expect(countMessagesBySession("session-1")).toBe(3);
  });

  it("finds message by taskId", () => {
    createMessage(makeMessage({ id: "m1", taskId: "task-abc" }));
    const found = findMessageByTaskId("task-abc");
    expect(found).toBeDefined();
    expect(found!.id).toBe("m1");
  });

  it("returns undefined for non-existent taskId", () => {
    expect(findMessageByTaskId("nonexistent")).toBeUndefined();
  });

  it("stores and retrieves metadata as JSON", () => {
    createMessage(makeMessage({ id: "m1", metadata: { key: "value", num: 42 } }));
    const retrieved = getMessage("m1");
    expect(retrieved!.metadata).toEqual({ key: "value", num: 42 });
  });
});
