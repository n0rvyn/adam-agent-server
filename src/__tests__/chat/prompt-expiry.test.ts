/**
 * Tests for prompt expiry sweep (Task 12):
 * - sweepExpiredPrompts() marks expired open prompts with reason="timeout"
 * - Already-resolved prompts are not affected by sweep
 * - Immediate-expire on task terminal (Task 12 companion test in chat-manager-prompt-terminal.test.ts)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { setupTestDb, clearTestDb } from "../helpers/test-db.js";

let dbRef: ReturnType<typeof setupTestDb>["db"];
vi.mock("../../store/db.js", () => ({
  getDb: () => dbRef,
}));

import { sweepExpiredPrompts } from "../../chat/prompt-expiry.js";
import { createPendingPrompt, getPendingPrompt } from "../../store/pending-prompts.js";
import type { ApprovalShape } from "../../shared/types.js";

function makePendingPrompt(opts: {
  id: string;
  sessionId?: string;
  messageId?: string;
  taskId?: string;
  expiresIn?: number; // ms from now; negative = already expired
  resolvedAt?: number;
  expiredReason?: string;
  shape?: ApprovalShape;
}) {
  const now = Date.now();
  createPendingPrompt({
    id: opts.id,
    sessionId: opts.sessionId ?? "s-prompt-expiry",
    messageId: opts.messageId ?? `msg-${opts.id}`,
    taskId: opts.taskId,
    shape: opts.shape ?? "yes_no",
    askedAt: now - 60_000,
    expiresAt: now + (opts.expiresIn ?? 3_600_000),
    resolvedAt: opts.resolvedAt,
    expiredReason: opts.expiredReason as undefined,
  });
}

describe("prompt expiry sweep (Task 12)", () => {
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

  it("expires prompts whose expires_at < now", () => {
    // 3 open prompts: 2 expired, 1 still valid
    makePendingPrompt({ id: "EXP1", expiresIn: -10_000 }); // expired 10s ago
    makePendingPrompt({ id: "EXP2", expiresIn: -3_600_000 }); // expired 1h ago
    makePendingPrompt({ id: "OPEN1", expiresIn: 3_600_000 }); // expires in 1h

    const count = sweepExpiredPrompts();

    expect(count).toBe(2);
    const exp1 = getPendingPrompt("EXP1");
    expect(exp1?.expiredReason).toBe("timeout");
    const exp2 = getPendingPrompt("EXP2");
    expect(exp2?.expiredReason).toBe("timeout");
    const open1 = getPendingPrompt("OPEN1");
    expect(open1?.expiredReason).toBeUndefined();
    expect(open1?.resolvedAt).toBeUndefined();
  });

  it("does not expire already-resolved prompts", () => {
    // One resolved (has resolvedAt), one expired — sweep should only expire the latter
    makePendingPrompt({
      id: "RESOLVED",
      expiresIn: -5_000,
      resolvedAt: Date.now() - 1_000,
    });
    makePendingPrompt({ id: "EXPIRED", expiresIn: -5_000 });

    const count = sweepExpiredPrompts();

    expect(count).toBe(1); // only EXPIRED
    const resolved = getPendingPrompt("RESOLVED");
    expect(resolved?.resolvedAt).toBeDefined();
    expect(resolved?.expiredReason).toBeUndefined();
    const expired = getPendingPrompt("EXPIRED");
    expect(expired?.expiredReason).toBe("timeout");
  });

  it("returns 0 when no prompts are expired", () => {
    makePendingPrompt({ id: "STILL-OPEN", expiresIn: 1_000_000 });
    makePendingPrompt({ id: "ALSO-OPEN", expiresIn: 999_999 });

    const count = sweepExpiredPrompts();

    expect(count).toBe(0);
    expect(getPendingPrompt("STILL-OPEN")?.expiredReason).toBeUndefined();
    expect(getPendingPrompt("ALSO-OPEN")?.expiredReason).toBeUndefined();
  });

  it("returns 0 when all prompts have expired_reason set already", () => {
    makePendingPrompt({ id: "ALREADY-EXPIRED-1", expiresIn: -5_000, expiredReason: "task_terminated" });
    makePendingPrompt({ id: "ALREADY-EXPIRED-2", expiresIn: -5_000, expiredReason: "timeout" });

    const count = sweepExpiredPrompts();

    expect(count).toBe(0);
  });
});
