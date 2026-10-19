import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

import { createMessage, getMessage } from "../../store/messages.js";
import type { ChatMessage } from "../../shared/types.js";

afterAll(() => cleanup());
beforeEach(() => {
  clearTestDb();
  // Seed a chat_session row to satisfy session_id FK if present
  const db = getTestDb();
  db.prepare(`
    INSERT INTO chat_sessions (id, status, source_type, created_at, last_active_at, message_count)
    VALUES ('s-test', 'active', 'web', 1000, 1000, 0)
  `).run();
});

describe("chat_messages envelope round-trip (UX-013, column<->arg position safety)", () => {
  it("ux-013a-attachments-purpose-locator-roundtrip-messages: preserves all 20 fields end-to-end (write -> read)", () => {
    // Use distinct, identifiable values for every field so that any column<->arg position
    // swap will produce a mismatched value on read-back.
    const msg: ChatMessage = {
      id: "msg-id-001",
      sessionId: "s-test",
      role: "assistant",
      content: "the message body",
      source: { type: "web" },
      taskId: "task-id-002",
      channelMessageId: "platform-msg-003",
      metadata: { extraKey: "extraValue" },
      createdAt: 1234567890,
      traceId: "trace-id-004",
      kind: "result_delivery",
      parentMessageId: "parent-id-005",
      threadRoot: "thread-root-006",
      promptId: "PRMT",
      approvalShape: "yes_no",
      roleId: "role-id-007",
      attachments: [
        {
          artifactId: "art-id-008",
          locator: "local:///tmp/file.md",
          filename: "file.md",
          mimeType: "text/markdown",
          size: 42,
          purpose: "report",
          contentHash: "deadbeef",
          retentionHint: "persistent",
        },
      ],
      mirroredToTargets: [{ type: "channel", channelId: "ch-A", chatId: "u-A" }],
      platformMessageId: "platform-id-009",
      seq: 7,
    };

    createMessage(msg);
    const read = getMessage("msg-id-001");

    expect(read).toBeDefined();
    expect(read?.id).toBe(msg.id);
    expect(read?.sessionId).toBe(msg.sessionId);
    expect(read?.role).toBe(msg.role);
    expect(read?.content).toBe(msg.content);
    expect(read?.source.type).toBe("web");
    expect(read?.taskId).toBe(msg.taskId);
    expect(read?.channelMessageId).toBe(msg.channelMessageId);
    expect(read?.metadata).toEqual(msg.metadata);
    expect(read?.createdAt).toBe(msg.createdAt);
    expect(read?.traceId).toBe(msg.traceId);
    expect(read?.kind).toBe("result_delivery");
    expect(read?.parentMessageId).toBe(msg.parentMessageId);
    expect(read?.threadRoot).toBe(msg.threadRoot);
    expect(read?.promptId).toBe(msg.promptId);
    expect(read?.approvalShape).toBe("yes_no");
    expect(read?.roleId).toBe(msg.roleId);
    expect(read?.attachments).toEqual(msg.attachments);
    expect(read?.mirroredToTargets).toEqual(msg.mirroredToTargets);
    expect(read?.platformMessageId).toBe(msg.platformMessageId);
    expect(read?.seq).toBe(7);
  });

  it("kind defaults from role when not explicitly set", () => {
    const userMsg: ChatMessage = {
      id: "u-1", sessionId: "s-test", role: "user", content: "hi",
      source: { type: "web" }, createdAt: 1000,
    };
    const botMsg: ChatMessage = {
      id: "b-1", sessionId: "s-test", role: "assistant", content: "hello",
      source: { type: "web" }, createdAt: 1001,
    };
    createMessage(userMsg);
    createMessage(botMsg);
    expect(getMessage("u-1")?.kind).toBe("user_message");
    expect(getMessage("b-1")?.kind).toBe("assistant_text");
  });

  it("null fields write and read back as undefined (not null)", () => {
    const msg: ChatMessage = {
      id: "min-1", sessionId: "s-test", role: "user", content: "minimal",
      source: { type: "web" }, createdAt: 2000,
    };
    createMessage(msg);
    const read = getMessage("min-1");
    expect(read?.taskId).toBeUndefined();
    expect(read?.parentMessageId).toBeUndefined();
    expect(read?.attachments).toBeUndefined();
    expect(read?.mirroredToTargets).toBeUndefined();
    expect(read?.seq).toBeUndefined();
  });
});
