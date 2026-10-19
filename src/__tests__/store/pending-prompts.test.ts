import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

import {
  generatePromptId,
  createPendingPrompt,
  getPendingPrompt,
  listOpenPromptsBySession,
  listOpenPromptsByTask,
  resolvePendingPrompt,
  expirePendingPrompt,
  listExpiredOpenPrompts,
  type PendingPrompt,
} from "../../store/pending-prompts.js";

afterAll(() => cleanup());
beforeEach(() => clearTestDb());

describe("pending-prompts store", () => {
  it("generates 4-char base32 ids without forbidden chars (0/O/1/I/L)", () => {
    for (let i = 0; i < 100; i++) {
      const id = generatePromptId(`session-${i}`);
      expect(id.length === 4 || id.length === 8).toBe(true);
      if (id.length === 4) {
        expect(id).not.toMatch(/[01OIL]/);
        expect(id).toMatch(/^[A-HJ-KM-NP-Z2-9]{4}$/);
      }
    }
  });

  it("4-char id is unique within open prompts of same session", () => {
    const sessionId = "session-1";
    const ids = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const id = generatePromptId(sessionId);
      ids.add(id);
      createPendingPrompt({
        id,
        sessionId,
        messageId: `msg-${i}`,
        shape: "yes_no",
        askedAt: Date.now(),
        expiresAt: Date.now() + 86400000,
      });
    }
    expect(ids.size).toBe(20);
  });

  it("CRUD lifecycle: create -> get -> resolve", () => {
    const prompt: PendingPrompt = {
      id: "TEST",
      sessionId: "s1",
      taskId: "t1",
      messageId: "m1",
      shape: "yes_no",
      askedAt: 1000,
      expiresAt: 87400000,
    };
    createPendingPrompt(prompt);

    const fetched = getPendingPrompt("TEST");
    expect(fetched).toBeDefined();
    expect(fetched?.shape).toBe("yes_no");

    expect(listOpenPromptsBySession("s1")).toHaveLength(1);
    expect(listOpenPromptsByTask("t1")).toHaveLength(1);

    resolvePendingPrompt("TEST", "user-msg-1", "native_quote", "approved");
    const resolved = getPendingPrompt("TEST");
    expect(resolved?.resolvedAt).toBeDefined();
    expect(resolved?.resolvedVia).toBe("native_quote");
    expect(resolved?.resolvedValue).toBe("approved");

    expect(listOpenPromptsBySession("s1")).toHaveLength(0);
  });

  it("expirePendingPrompt sets expired_reason without resolved_at", () => {
    createPendingPrompt({
      id: "EXPI",
      sessionId: "s2",
      messageId: "m2",
      shape: "yes_no",
      askedAt: 1000,
      expiresAt: 2000,
    });

    expirePendingPrompt("EXPI", "timeout");
    const fetched = getPendingPrompt("EXPI");
    expect(fetched?.expiredReason).toBe("timeout");
    expect(fetched?.resolvedAt).toBeUndefined();

    expect(listOpenPromptsBySession("s2")).toHaveLength(0);
  });

  it("listExpiredOpenPrompts returns prompts past expires_at", () => {
    const now = Date.now();
    createPendingPrompt({
      id: "OLD1",
      sessionId: "s3",
      messageId: "m3",
      shape: "yes_no",
      askedAt: now - 100000,
      expiresAt: now - 50000,
    });
    createPendingPrompt({
      id: "NEW1",
      sessionId: "s3",
      messageId: "m4",
      shape: "yes_no",
      askedAt: now,
      expiresAt: now + 86400000,
    });

    const expired = listExpiredOpenPrompts(now);
    expect(expired.map((p) => p.id)).toEqual(["OLD1"]);
  });
});
