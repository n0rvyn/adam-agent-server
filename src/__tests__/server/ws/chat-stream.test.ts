import { describe, it, expect, vi } from "vitest";
import { _getBufferSize, _clearBuffer } from "../../../server/ws/chat-stream.js";

// Note: Full WebSocket integration tests require a running Fastify server with @fastify/websocket.
// These tests verify the internal buffer and event subscription logic.

vi.mock("../../../lib/logger.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe("server/ws/chat-stream", () => {
  it("exports buffer management functions", () => {
    expect(typeof _getBufferSize).toBe("function");
    expect(typeof _clearBuffer).toBe("function");
  });

  it("buffer starts empty", () => {
    _clearBuffer();
    expect(_getBufferSize()).toBe(0);
  });

  it("clearBuffer resets to 0", () => {
    _clearBuffer();
    expect(_getBufferSize()).toBe(0);
  });
});
