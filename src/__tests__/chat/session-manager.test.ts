import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { setupTestDb, clearTestDb } from "../helpers/test-db.js";

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDbRef(),
}));

vi.mock("../../config/index.js", () => ({
  getChatConfig: () => ({
    sessionTimeoutMinutes: 1, // 1 minute for fast testing
    maxSessionTurns: 20,
    autoTitle: true,
    archiveExtractMemory: true,
  }),
  getDefaults: () => ({}),
  DEFAULT_CONFIG: { chat: { sessionTimeoutMinutes: 30, maxSessionTurns: 20, autoTitle: true, archiveExtractMemory: true } },
}));

let dbRef: ReturnType<typeof setupTestDb>["db"];
function getTestDbRef() { return dbRef; }

import {
  createSession,
  getSession,
  getActiveSession,
  archiveSession,
  restoreSession,
  deleteSession,
  touchSession,
  incrementMessageCount,
  listSessions,
  warmCache,
  startTimeoutPoller,
  stopTimeoutPoller,
  _resetForTest,
} from "../../chat/session-manager.js";
import * as sessionStore from "../../store/sessions.js";
import type { ChatSource } from "../../shared/types.js";

describe("chat/session-manager", () => {
  beforeAll(() => {
    const { db } = setupTestDb();
    dbRef = db;
  });

  afterAll(() => {
    _resetForTest();
    dbRef.close();
  });

  beforeEach(() => {
    _resetForTest();
    clearTestDb();
  });

  const webSource: ChatSource = { type: "web" };
  const tuiSource: ChatSource = { type: "tui" };

  describe("createSession", () => {
    it("creates a session and adds to cache", () => {
      const session = createSession(webSource);
      expect(session.id).toBeDefined();
      expect(session.status).toBe("active");
      expect(session.source.type).toBe("web");
      expect(session.messageCount).toBe(0);
    });

    it("persists session to database", () => {
      const session = createSession(webSource);
      const fromDb = sessionStore.getSession(session.id);
      expect(fromDb).toBeDefined();
      expect(fromDb!.id).toBe(session.id);
    });
  });

  describe("getActiveSession", () => {
    it("finds active session from cache by source", () => {
      const session = createSession(webSource);
      const found = getActiveSession(webSource);
      expect(found).toBeDefined();
      expect(found!.id).toBe(session.id);
    });

    it("returns undefined for no matching source", () => {
      createSession(webSource);
      const found = getActiveSession(tuiSource);
      expect(found).toBeUndefined();
    });

    it("falls back to DB if not in cache", () => {
      // Create session, then reset cache
      const session = createSession(webSource);
      _resetForTest();
      const found = getActiveSession(webSource);
      expect(found).toBeDefined();
      expect(found!.id).toBe(session.id);
    });
  });

  describe("getSession", () => {
    it("returns from cache if available", () => {
      const session = createSession(webSource);
      const found = getSession(session.id);
      expect(found!.id).toBe(session.id);
    });

    it("falls back to DB", () => {
      const session = createSession(webSource);
      _resetForTest();
      const found = getSession(session.id);
      expect(found).toBeDefined();
    });

    it("returns undefined for non-existent", () => {
      expect(getSession("nonexistent")).toBeUndefined();
    });
  });

  describe("archiveSession", () => {
    it("changes status to archived", () => {
      const session = createSession(webSource);
      archiveSession(session.id);
      const archived = sessionStore.getSession(session.id);
      expect(archived!.status).toBe("archived");
    });

    it("removes from cache", () => {
      const session = createSession(webSource);
      archiveSession(session.id);
      const found = getActiveSession(webSource);
      expect(found).toBeUndefined();
    });
  });

  describe("restoreSession", () => {
    it("changes status back to active", () => {
      const session = createSession(webSource);
      archiveSession(session.id);
      const restored = restoreSession(session.id);
      expect(restored).toBeDefined();
      expect(restored!.status).toBe("active");
    });

    it("adds back to cache", () => {
      const session = createSession(webSource);
      archiveSession(session.id);
      restoreSession(session.id);
      const found = getActiveSession(webSource);
      expect(found).toBeDefined();
    });
  });

  describe("deleteSession", () => {
    it("removes session from DB and cache", () => {
      const session = createSession(webSource);
      deleteSession(session.id);
      expect(getSession(session.id)).toBeUndefined();
      expect(sessionStore.getSession(session.id)).toBeUndefined();
    });
  });

  describe("touchSession", () => {
    it("updates lastActiveAt", () => {
      const session = createSession(webSource);
      const originalTime = session.lastActiveAt;
      touchSession(session.id);
      const updated = sessionStore.getSession(session.id);
      expect(updated!.lastActiveAt).toBeGreaterThanOrEqual(originalTime);
    });
  });

  describe("incrementMessageCount", () => {
    it("increments message count", () => {
      const session = createSession(webSource);
      incrementMessageCount(session.id);
      incrementMessageCount(session.id);
      const updated = sessionStore.getSession(session.id);
      expect(updated!.messageCount).toBe(2);
    });
  });

  describe("listSessions", () => {
    it("lists all sessions", () => {
      createSession(webSource);
      createSession(tuiSource);
      const all = listSessions();
      expect(all).toHaveLength(2);
    });

    it("filters by status", () => {
      const s1 = createSession(webSource);
      createSession(tuiSource);
      archiveSession(s1.id);
      const active = listSessions("active");
      expect(active).toHaveLength(1);
    });
  });

  describe("warmCache", () => {
    it("loads active sessions from DB into cache", () => {
      const session = createSession(webSource);
      _resetForTest();
      warmCache();
      const found = getActiveSession(webSource);
      expect(found).toBeDefined();
      expect(found!.id).toBe(session.id);
    });

    it("does not load archived sessions", () => {
      const session = createSession(webSource);
      archiveSession(session.id);
      _resetForTest();
      warmCache();
      const found = getActiveSession(webSource);
      expect(found).toBeUndefined();
    });
  });

  describe("timeout poller", () => {
    it("archives sessions inactive longer than timeout", async () => {
      vi.useFakeTimers();
      const session = createSession(webSource);
      // Set lastActiveAt to 2 minutes ago (timeout is 1 minute)
      sessionStore.updateSession(session.id, { lastActiveAt: Date.now() - 120_000 });
      warmCache(); // Refresh cache with updated time

      startTimeoutPoller(100); // Poll every 100ms
      vi.advanceTimersByTime(200);
      stopTimeoutPoller();

      const found = sessionStore.getSession(session.id);
      expect(found!.status).toBe("archived");
      vi.useRealTimers();
    });

    it("does not archive recently active sessions", async () => {
      vi.useFakeTimers();
      const session = createSession(webSource);

      startTimeoutPoller(100);
      vi.advanceTimersByTime(200);
      stopTimeoutPoller();

      const found = sessionStore.getSession(session.id);
      expect(found!.status).toBe("active");
      vi.useRealTimers();
    });
  });
});
