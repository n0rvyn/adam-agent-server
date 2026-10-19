import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { vi } from "vitest";
import { setupTestDb, clearTestDb } from "../helpers/test-db.js";

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDbRef(),
}));

let dbRef: ReturnType<typeof setupTestDb>["db"];
function getTestDbRef() { return dbRef; }

import { createSession, getSession, updateSession, listSessions, findSessionBySource, deleteSession } from "../../store/sessions.js";
import type { ChatSession } from "../../shared/types.js";

function makeSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: `s-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    status: "active",
    source: { type: "web" },
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    messageCount: 0,
    ...overrides,
  };
}

describe("store/sessions", () => {
  beforeAll(() => {
    const { db } = setupTestDb();
    dbRef = db;
  });

  afterAll(() => {
    dbRef.close();
  });

  beforeEach(() => {
    clearTestDb();
  });

  it("creates and retrieves a session", () => {
    const session = makeSession();
    createSession(session);
    const retrieved = getSession(session.id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.id).toBe(session.id);
    expect(retrieved!.status).toBe("active");
    expect(retrieved!.source.type).toBe("web");
  });

  it("returns undefined for non-existent session", () => {
    expect(getSession("nonexistent")).toBeUndefined();
  });

  it("updates session fields", () => {
    const session = makeSession();
    createSession(session);
    updateSession(session.id, { status: "archived", title: "Test Title" });
    const updated = getSession(session.id);
    expect(updated!.status).toBe("archived");
    expect(updated!.title).toBe("Test Title");
  });

  it("lists sessions with status filter", () => {
    createSession(makeSession({ id: "s1", status: "active" }));
    createSession(makeSession({ id: "s2", status: "archived" }));
    createSession(makeSession({ id: "s3", status: "active" }));

    const active = listSessions("active");
    expect(active).toHaveLength(2);

    const archived = listSessions("archived");
    expect(archived).toHaveLength(1);

    const all = listSessions();
    expect(all).toHaveLength(3);
  });

  it("lists sessions ordered by lastActiveAt descending", () => {
    const now = Date.now();
    createSession(makeSession({ id: "old", lastActiveAt: now - 2000 }));
    createSession(makeSession({ id: "new", lastActiveAt: now }));
    createSession(makeSession({ id: "mid", lastActiveAt: now - 1000 }));

    const sessions = listSessions();
    expect(sessions[0].id).toBe("new");
    expect(sessions[1].id).toBe("mid");
    expect(sessions[2].id).toBe("old");
  });

  it("finds session by source", () => {
    createSession(makeSession({ id: "s1", source: { type: "tui" } }));
    createSession(makeSession({ id: "s2", source: { type: "web" } }));

    const found = findSessionBySource({ type: "tui" });
    expect(found).toBeDefined();
    expect(found!.id).toBe("s1");
  });

  it("finds session by channel source", () => {
    createSession(makeSession({
      id: "ch1",
      source: { type: "channel", channelId: "tg-1", chatId: "chat-123" },
    }));

    const found = findSessionBySource({ type: "channel", channelId: "tg-1", chatId: "chat-123" });
    expect(found).toBeDefined();
    expect(found!.id).toBe("ch1");
  });

  it("returns undefined when no session matches source", () => {
    expect(findSessionBySource({ type: "api" })).toBeUndefined();
  });

  it("deletes a session", () => {
    const session = makeSession();
    createSession(session);
    deleteSession(session.id);
    expect(getSession(session.id)).toBeUndefined();
  });

  it("handles update with no fields gracefully", () => {
    const session = makeSession();
    createSession(session);
    updateSession(session.id, {});
    expect(getSession(session.id)!.status).toBe("active");
  });
});
