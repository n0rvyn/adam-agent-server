import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

setupTestDb();

const emitted: unknown[] = [];
vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));
vi.mock("../../server/events/server-bus.js", () => ({
  serverBus: {
    emit: (event: unknown) => emitted.push(event),
    on: vi.fn(),
    off: vi.fn(),
  },
}));

import { createSession, _resetForTest } from "../../chat/session-manager.js";
import { deliverAssistantMessageToSession } from "../../chat/session-delivery.js";
import { getMessagesBySession } from "../../store/messages.js";
import { getSession } from "../../store/sessions.js";

describe("deliverAssistantMessageToSession", () => {
  beforeEach(() => {
    clearTestDb();
    _resetForTest();
    emitted.length = 0;
  });

  it("persists and emits the same assistant message", async () => {
    const session = createSession({ type: "web" });

    const delivered = await deliverAssistantMessageToSession({
      sessionId: session.id,
      content: "status report",
      taskId: "exec-1",
    });

    expect(delivered).toBe(true);
    const messages = getMessagesBySession(session.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual(expect.objectContaining({
      sessionId: session.id,
      role: "assistant",
      content: "status report",
      taskId: "exec-1",
    }));
    const event = emitted.find((candidate) => (candidate as { type?: string }).type === "chat_message") as {
      message: { id: string };
    };
    expect(event.message.id).toBe(messages[0].id);
    expect(getSession(session.id)?.messageCount).toBe(1);
  });

  it("returns false when the session does not exist", async () => {
    await expect(deliverAssistantMessageToSession({ sessionId: "missing", content: "x" })).resolves.toBe(false);
    expect(emitted).toEqual([]);
  });
});
