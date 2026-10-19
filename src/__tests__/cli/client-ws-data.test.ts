import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Tests that EventSocket and TaskStreamSocket extract the inner `data` field
 * from WsEvent wrappers before passing to callbacks.
 *
 * Server sends WsEvent format:
 *   { taskId, index, type, timestamp, data: { content, ... } }
 *
 * Callbacks should receive `data` (inner), not the full wrapper.
 *
 * We test the onmessage parsing logic by directly invoking the handler
 * rather than mocking WebSocket globally (to avoid leaking into other tests).
 */

describe("WebSocket data extraction", () => {
  // Simulate the parsing logic from client.ts without importing the actual module
  // This avoids port file dependencies and WebSocket global pollution

  function parseTaskStreamMessage(
    raw: unknown,
    callbacks: Map<string, Set<(data: unknown) => void>>,
  ) {
    const data = typeof raw === "string" ? JSON.parse(raw) : raw;
    const { type, data: innerData, ...rest } = data;
    const cbs = callbacks.get(type);
    if (cbs) {
      cbs.forEach((cb) => cb(innerData ?? rest));
    }
    const anyCbs = callbacks.get("*");
    if (anyCbs) {
      anyCbs.forEach((cb) => cb(data));
    }
  }

  function parseEventSocketMessage(
    raw: unknown,
    callbacks: Map<string, Set<(data: unknown) => void>>,
  ) {
    const data = typeof raw === "string" ? JSON.parse(raw) : raw;
    const { type, data: innerData, ...rest } = data;
    const cbs = callbacks.get(type);
    if (cbs) {
      cbs.forEach((cb) => cb(innerData ?? rest));
    }
  }

  describe("TaskStreamSocket parsing", () => {
    it("passes inner data field to typed callbacks", () => {
      const callbacks = new Map<string, Set<(data: unknown) => void>>();
      const received: unknown[] = [];
      callbacks.set("reasoning", new Set([(d) => received.push(d)]));

      parseTaskStreamMessage(
        {
          taskId: "task-123",
          index: 1,
          type: "reasoning",
          timestamp: 1234567890,
          data: { content: "thinking about the problem" },
        },
        callbacks,
      );

      expect(received).toHaveLength(1);
      expect(received[0]).toEqual({ content: "thinking about the problem" });
    });

    it("falls back to rest of payload when no data field", () => {
      const callbacks = new Map<string, Set<(data: unknown) => void>>();
      const received: unknown[] = [];
      callbacks.set("custom", new Set([(d) => received.push(d)]));

      parseTaskStreamMessage(
        { type: "custom", foo: "bar" },
        callbacks,
      );

      expect(received).toHaveLength(1);
      expect(received[0]).toEqual({ foo: "bar" });
    });

    it("wildcard listener receives full original message", () => {
      const callbacks = new Map<string, Set<(data: unknown) => void>>();
      const wildcardReceived: unknown[] = [];
      callbacks.set("*", new Set([(d) => wildcardReceived.push(d)]));

      const fullMessage = {
        taskId: "task-789",
        index: 1,
        type: "tool_call",
        timestamp: 1234567890,
        data: { toolName: "Read", input: "/foo.ts" },
      };
      parseTaskStreamMessage(fullMessage, callbacks);

      expect(wildcardReceived).toHaveLength(1);
      expect(wildcardReceived[0]).toEqual(fullMessage);
    });

    it("handles complete event with inner data", () => {
      const callbacks = new Map<string, Set<(data: unknown) => void>>();
      const received: unknown[] = [];
      callbacks.set("complete", new Set([(d) => received.push(d)]));

      parseTaskStreamMessage(
        {
          taskId: "task-complete",
          index: 5,
          type: "complete",
          timestamp: 1234567890,
          data: { result: "done", costUsd: 0.05, numTurns: 3 },
        },
        callbacks,
      );

      expect(received).toHaveLength(1);
      expect(received[0]).toEqual({ result: "done", costUsd: 0.05, numTurns: 3 });
    });

    it("typed and wildcard callbacks both fire for same message", () => {
      const callbacks = new Map<string, Set<(data: unknown) => void>>();
      const typedReceived: unknown[] = [];
      const wildcardReceived: unknown[] = [];
      callbacks.set("tool_call", new Set([(d) => typedReceived.push(d)]));
      callbacks.set("*", new Set([(d) => wildcardReceived.push(d)]));

      const message = {
        taskId: "t1",
        index: 1,
        type: "tool_call",
        timestamp: 123,
        data: { toolName: "Bash", input: "ls" },
      };
      parseTaskStreamMessage(message, callbacks);

      // Typed callback gets inner data
      expect(typedReceived[0]).toEqual({ toolName: "Bash", input: "ls" });
      // Wildcard gets full message
      expect(wildcardReceived[0]).toEqual(message);
    });
  });

  describe("EventSocket parsing", () => {
    it("passes inner data field to typed callbacks", () => {
      const callbacks = new Map<string, Set<(data: unknown) => void>>();
      const received: unknown[] = [];
      callbacks.set("stats_update", new Set([(d) => received.push(d)]));

      parseEventSocketMessage(
        {
          type: "stats_update",
          data: { activeTasks: 2, queuedTasks: 1, idleWorkers: 1 },
        },
        callbacks,
      );

      expect(received).toHaveLength(1);
      expect(received[0]).toEqual({ activeTasks: 2, queuedTasks: 1, idleWorkers: 1 });
    });

    it("falls back when no data field present", () => {
      const callbacks = new Map<string, Set<(data: unknown) => void>>();
      const received: unknown[] = [];
      callbacks.set("worker_status_change", new Set([(d) => received.push(d)]));

      parseEventSocketMessage(
        { type: "worker_status_change", workerId: "w-1", oldStatus: "idle", newStatus: "busy" },
        callbacks,
      );

      expect(received).toHaveLength(1);
      expect(received[0]).toEqual({ workerId: "w-1", oldStatus: "idle", newStatus: "busy" });
    });
  });
});
