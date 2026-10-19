import type { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

type MockSocketHandle = {
  url: string;
  readyState: number;
  sentFrames: Array<Record<string, unknown>>;
  emit: EventEmitter["emit"];
};

vi.mock("../../../lib/logger.js", () => ({
  getLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");
  const sockets = ((globalThis as Record<string, unknown>).__openclawSockets ??= []) as MockSocketHandle[];

  class MockWebSocket extends EventEmitter {
    static OPEN = 1;

    readyState = 0;
    sentFrames: Array<Record<string, unknown>> = [];

    constructor(public readonly url: string) {
      super();
      sockets.push(this as MockSocketHandle);
      queueMicrotask(() => {
        this.readyState = MockWebSocket.OPEN;
        this.emit("open");
      });
    }

    send(data: string) {
      this.sentFrames.push(JSON.parse(data));
    }

    close() {
      this.readyState = 3;
      this.emit("close");
    }
  }

  return { WebSocket: MockWebSocket };
});

import { OpenClawAdapter } from "../../../channels/adapters/openclaw.js";

function socketStore() {
  return (globalThis as Record<string, unknown>).__openclawSockets as MockSocketHandle[];
}

function latestSocket() {
  const socket = socketStore().at(-1);
  expect(socket).toBeDefined();
  return socket!;
}

describe("OpenClawAdapter", () => {
  beforeEach(() => {
    socketStore().length = 0;
  });

  it("creates with correct platform", () => {
    const adapter = new OpenClawAdapter("oc1", { gatewayUrl: "ws://mock-gateway" });
    expect(adapter.platform).toBe("openclaw");
    expect(adapter.getStatus()).toBe("disconnected");
  });

  it("connects to gateway and sends connect frame", async () => {
    const adapter = new OpenClawAdapter("oc1", { gatewayUrl: "ws://mock-gateway" });
    await adapter.connect();
    expect(adapter.getStatus()).toBe("connected");

    expect(latestSocket().sentFrames[0]).toMatchObject({
      type: "req",
      method: "connect",
      params: expect.objectContaining({ role: "node", name: "adam" }),
    });
  });

  it("disconnects from gateway", async () => {
    const adapter = new OpenClawAdapter("oc1", { gatewayUrl: "ws://mock-gateway" });
    await adapter.connect();
    await adapter.disconnect();
    expect(adapter.getStatus()).toBe("disconnected");
  });

  it("handles inbound chat events", async () => {
    const adapter = new OpenClawAdapter("oc1", { gatewayUrl: "ws://mock-gateway" });
    const handler = vi.fn();
    adapter.onMessage(handler);

    await adapter.connect();
    latestSocket().emit("message", Buffer.from(JSON.stringify({
      type: "event",
      event: "chat",
      payload: {
        platform: "whatsapp",
        chatId: "wa-chat-1",
        senderId: "wa-user-1",
        senderName: "John",
        content: "Hello from WhatsApp",
        isGroup: false,
        timestamp: Date.now(),
      },
    })));

    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      platform: "whatsapp",
      chatId: "wa-chat-1",
      content: "Hello from WhatsApp",
    }));

    await adapter.disconnect();
  });

  it("sends outbound messages via req frame", async () => {
    const adapter = new OpenClawAdapter("oc1", { gatewayUrl: "ws://mock-gateway" });
    await adapter.connect();

    const sendPromise = adapter.sendMessage("chat-1", { content: "Reply" });
    const socket = latestSocket();
    const frame = socket.sentFrames[1];

    expect(frame).toMatchObject({
      type: "req",
      method: "chat.send",
      params: { chatId: "chat-1", content: "Reply" },
    });

    socket.emit("message", Buffer.from(JSON.stringify({
      type: "res",
      id: frame.id,
      ok: true,
      payload: "sent-1",
    })));

    await expect(sendPromise).resolves.toBe("sent-1");
    await adapter.disconnect();
  });

  it("registers message handler", () => {
    const adapter = new OpenClawAdapter("oc1", { gatewayUrl: "ws://mock-gateway" });
    adapter.onMessage(vi.fn());
  });
});
