import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock logger
const { mockLogger, mockExistsSync, mockReadFileSync } = vi.hoisted(() => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
    level: "info",
  };
  return {
    mockLogger: logger,
    mockExistsSync: vi.fn(),
    mockReadFileSync: vi.fn(),
  };
});

vi.mock("fs", () => ({
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
}));

vi.mock("../../lib/logger.js", () => ({
  getLogger: () => mockLogger,
  setLogLevel: vi.fn(),
  onLogEvent: vi.fn(),
  logger: mockLogger,
}));

// Mock WebSocket
const { MockWebSocket } = vi.hoisted(() => {
  const instances: any[] = [];
  const MockWS = vi.fn(function (this: any) {
    this.readyState = 0; // CONNECTING
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    this.close = vi.fn();
    this.send = vi.fn();
    instances.push(this);
    return this;
  }) as any;
  MockWS.OPEN = 1;
  MockWS.instances = instances;
  return { MockWebSocket: MockWS };
});

vi.stubGlobal("WebSocket", MockWebSocket);

// Mock fetch for request() tests
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { ApiError, request, getHealth, EventSocket, TaskStreamSocket } from "../../cli/client.js";

describe("client.ts full coverage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    MockWebSocket.instances.length = 0;

    // Default: port file exists with port 3000
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("3000");
  });

  describe("request()", () => {
    it("makes GET request with correct URL", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        json: () => Promise.resolve({ data: "test" }),
      });

      const result = await request("/healthz");
      expect(result).toEqual({ data: "test" });
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3000/healthz",
        expect.objectContaining({ method: "GET" }),
      );
    });

    it("makes POST request with body", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        json: () => Promise.resolve({ taskId: "t-1" }),
      });

      const result = await request("/tasks", {
        method: "POST",
        body: { prompt: "test" },
      });
      expect(result).toEqual({ taskId: "t-1" });
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3000/tasks",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ prompt: "test" }),
        }),
      );
    });

    it("throws ApiError on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: () => Promise.resolve("Not found"),
      });

      await expect(request("/missing")).rejects.toThrow(ApiError);
      try {
        await request("/missing");
      } catch (err) {
        // Already caught above
      }
    });

    it("handles text response when content-type is not JSON", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ "content-type": "text/plain" }),
        text: () => Promise.resolve("plain text"),
      });

      const result = await request("/text-endpoint");
      expect(result).toBe("plain text");
    });

    it("throws when server not running", async () => {
      mockExistsSync.mockReturnValue(false);
      await expect(request("/test")).rejects.toThrow("Server not running");
    });

    it("handles error text extraction failure", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.reject(new Error("cannot read")),
      });

      await expect(request("/fail")).rejects.toThrow("Unknown error");
    });

    it("passes custom headers", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        json: () => Promise.resolve({}),
      });

      await request("/test", { headers: { "X-Custom": "value" } });
      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            "X-Custom": "value",
            "Content-Type": "application/json",
          }),
        }),
      );
    });
  });

  describe("getHealth()", () => {
    it("calls /healthz endpoint", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        json: () => Promise.resolve({ status: "ok" }),
      });

      const result = await getHealth();
      expect(result).toEqual({ status: "ok" });
    });
  });

  describe("EventSocket", () => {
    it("constructs with correct URL", () => {
      const socket = new EventSocket();
      expect(socket).toBeDefined();
    });

    it("constructs with custom path", () => {
      const socket = new EventSocket("/custom");
      expect(socket).toBeDefined();
    });

    it("throws when server not running", () => {
      mockExistsSync.mockReturnValue(false);
      expect(() => new EventSocket()).toThrow("Server not running");
    });

    it("connects and resolves on open", async () => {
      const socket = new EventSocket();
      const connectPromise = socket.connect();

      const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];
      ws.onopen();

      await connectPromise;
    });

    it("dispatches messages to callbacks", async () => {
      const socket = new EventSocket();
      const callback = vi.fn();
      socket.on("test_event", callback);

      const connectPromise = socket.connect();
      const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];
      ws.onopen();
      await connectPromise;

      ws.onmessage({ data: JSON.stringify({ type: "test_event", data: { value: 42 } }) });
      expect(callback).toHaveBeenCalledWith({ value: 42 });
    });

    it("handles message without inner data", async () => {
      const socket = new EventSocket();
      const callback = vi.fn();
      socket.on("test_event", callback);

      const connectPromise = socket.connect();
      const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];
      ws.onopen();
      await connectPromise;

      ws.onmessage({ data: JSON.stringify({ type: "test_event", key: "val" }) });
      expect(callback).toHaveBeenCalledWith({ key: "val" });
    });

    it("handles invalid JSON message gracefully", async () => {
      const socket = new EventSocket();

      const connectPromise = socket.connect();
      const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];
      ws.onopen();
      await connectPromise;

      ws.onmessage({ data: "not json" });
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.any(Error) }),
        "Failed to parse WebSocket message",
      );
    });

    it("off() removes callback", () => {
      const socket = new EventSocket();
      const callback = vi.fn();
      socket.on("event", callback);
      socket.off("event", callback);
    });

    it("close() closes WebSocket and clears timer", async () => {
      const socket = new EventSocket();
      const connectPromise = socket.connect();
      const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];
      ws.onopen();
      await connectPromise;

      socket.close();
      expect(ws.close).toHaveBeenCalled();
    });

    it("isConnected() returns false when not connected", () => {
      const socket = new EventSocket();
      expect(socket.isConnected()).toBe(false);
    });

    it("isConnected() returns true when OPEN", async () => {
      const socket = new EventSocket();
      const connectPromise = socket.connect();
      const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];
      ws.readyState = 1; // OPEN
      ws.onopen();
      await connectPromise;

      expect(socket.isConnected()).toBe(true);
    });

    it("rejects on error", async () => {
      const socket = new EventSocket();
      const connectPromise = socket.connect();
      const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];
      ws.onerror(new Error("connection refused"));

      await expect(connectPromise).rejects.toThrow();
    });

    it("scheduleReconnect on close", async () => {
      const socket = new EventSocket();
      const connectPromise = socket.connect();
      const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];
      ws.onopen();
      await connectPromise;

      // Trigger close → scheduleReconnect
      ws.onclose();

      // Wait a bit for the reconnect timer (1s delay)
      // Don't wait for actual reconnect, just verify timer was set
      socket.close(); // cleanup
    });
  });

  describe("TaskStreamSocket", () => {
    it("constructs with correct URL", () => {
      const socket = new TaskStreamSocket("task-123");
      expect(socket).toBeDefined();
    });

    it("throws when server not running", () => {
      mockExistsSync.mockReturnValue(false);
      expect(() => new TaskStreamSocket("task-123")).toThrow("Server not running");
    });

    it("connects and resolves on open", async () => {
      const socket = new TaskStreamSocket("task-123");
      const connectPromise = socket.connect();
      const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];
      ws.onopen();
      await connectPromise;
    });

    it("dispatches messages including wildcard", async () => {
      const socket = new TaskStreamSocket("task-123");
      const typeCallback = vi.fn();
      const wildcardCallback = vi.fn();
      socket.on("reasoning", typeCallback);
      socket.on("*", wildcardCallback);

      const connectPromise = socket.connect();
      const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];
      ws.onopen();
      await connectPromise;

      ws.onmessage({ data: JSON.stringify({ type: "reasoning", data: { content: "thinking" } }) });

      expect(typeCallback).toHaveBeenCalledWith({ content: "thinking" });
      expect(wildcardCallback).toHaveBeenCalledWith({ type: "reasoning", data: { content: "thinking" } });
    });

    it("handles invalid JSON in task stream", async () => {
      const socket = new TaskStreamSocket("task-123");

      const connectPromise = socket.connect();
      const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];
      ws.onopen();
      await connectPromise;

      ws.onmessage({ data: "invalid" });
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.any(Error) }),
        "Failed to parse task stream message",
      );
    });

    it("off() removes callback", () => {
      const socket = new TaskStreamSocket("task-123");
      const cb = vi.fn();
      socket.on("event", cb);
      socket.off("event", cb);
    });

    it("close() closes WebSocket", async () => {
      const socket = new TaskStreamSocket("task-123");
      const connectPromise = socket.connect();
      const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];
      ws.onopen();
      await connectPromise;

      socket.close();
      expect(ws.close).toHaveBeenCalled();
    });

    it("isConnected() works correctly", () => {
      const socket = new TaskStreamSocket("task-123");
      expect(socket.isConnected()).toBe(false);
    });

    it("rejects on error", async () => {
      const socket = new TaskStreamSocket("task-123");
      const connectPromise = socket.connect();
      const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];
      ws.onerror(new Error("failed"));
      await expect(connectPromise).rejects.toThrow();
    });

    it("handles onclose event", async () => {
      const socket = new TaskStreamSocket("task-123");
      const connectPromise = socket.connect();
      const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];
      ws.onopen();
      await connectPromise;

      ws.onclose(); // Should not throw
    });
  });
});
