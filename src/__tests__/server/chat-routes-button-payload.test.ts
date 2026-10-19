import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from "vitest";
import { buildApp } from "../../server/app.js";
import { chatRoutes } from "../../server/routes/chat.js";
import type { FastifyInstance } from "fastify";
import type { ChatSource } from "../../shared/types.js";

const TEST_API_KEY = "test-secret-key-12345";

const { mockHandleChatMessage } = vi.hoisted(() => {
  const fn = vi.fn<typeof import("../../chat/message-handler.js").handleChatMessage>();
  fn.mockResolvedValue({ sessionId: "00000000-0000-0000-0000-000000000001", messageId: "msg-001" });
  return { mockHandleChatMessage: fn };
});

vi.mock("../../chat/message-handler.js", () => ({
  handleChatMessage: mockHandleChatMessage,
}));

describe("POST /chat/messages — buttonPayload routing", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildApp({ server: { host: "127.0.0.1", port: 0 }, defaults: {} } as never, TEST_API_KEY);
    await app.register(chatRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    mockHandleChatMessage.mockClear();
  });

  it("passes buttonPayload as inboundMeta to handleChatMessage", async () => {
    const sessionId = "550e8400-e29b-41d4-a716-446655440000";
    const res = await app.inject({
      method: "POST",
      url: "/chat/messages",
      headers: { "x-api-key": TEST_API_KEY, "content-type": "application/json" },
      body: JSON.stringify({
        content: "批准",
        source: { type: "web" },
        sessionId,
        buttonPayload: { promptId: "A2K7", value: "批准" },
      }),
    });
    expect(res.statusCode).toBe(201);
    expect(mockHandleChatMessage).toHaveBeenCalledTimes(1);
    expect(mockHandleChatMessage).toHaveBeenCalledWith(
      "批准",
      expect.objectContaining({ type: "web" }) as ChatSource,
      undefined,
      sessionId,
      { buttonPayload: { promptId: "A2K7", rawValue: "批准" } },
    );
  });

  it("passes undefined inboundMeta when buttonPayload is absent", async () => {
    const sessionId = "550e8400-e29b-41d4-a716-446655440001";
    const res = await app.inject({
      method: "POST",
      url: "/chat/messages",
      headers: { "x-api-key": TEST_API_KEY, "content-type": "application/json" },
      body: JSON.stringify({
        content: "hello",
        source: { type: "tui" },
        sessionId,
      }),
    });
    expect(res.statusCode).toBe(201);
    expect(mockHandleChatMessage).toHaveBeenCalledTimes(1);
    expect(mockHandleChatMessage).toHaveBeenCalledWith(
      "hello",
      expect.objectContaining({ type: "tui" }) as ChatSource,
      undefined,
      sessionId,
      undefined,
    );
  });

  it("returns 400 VALIDATION_ERROR when buttonPayload is missing promptId", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/chat/messages",
      headers: { "x-api-key": TEST_API_KEY, "content-type": "application/json" },
      body: JSON.stringify({
        content: "批准",
        source: { type: "web" },
        buttonPayload: { value: "批准" },
      }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(mockHandleChatMessage).not.toHaveBeenCalled();
  });
});
