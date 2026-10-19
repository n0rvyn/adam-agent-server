import { describe, it, expect, beforeEach, vi } from "vitest";
import { StreamManager, transformToWsEvent } from "../../../server/ws/stream.js";

describe("StreamManager", () => {
  let sm: StreamManager;

  beforeEach(() => {
    sm = new StreamManager();
  });

  describe("getNextIndex", () => {
    it("returns 1 for first call on a new task", () => {
      expect(sm.getNextIndex("task-1")).toBe(1);
    });

    it("increments on successive calls", () => {
      expect(sm.getNextIndex("task-1")).toBe(1);
      expect(sm.getNextIndex("task-1")).toBe(2);
      expect(sm.getNextIndex("task-1")).toBe(3);
    });

    it("tracks indices independently per task", () => {
      expect(sm.getNextIndex("task-a")).toBe(1);
      expect(sm.getNextIndex("task-b")).toBe(1);
      expect(sm.getNextIndex("task-a")).toBe(2);
      expect(sm.getNextIndex("task-b")).toBe(2);
    });
  });

  describe("broadcast", () => {
    it("buffers events for a task", () => {
      const event = { taskId: "t-1", index: 1, type: "reasoning" as const, timestamp: Date.now(), data: { content: "hello" } };
      sm.broadcast("t-1", event);

      const buffered = sm.getBufferedEvents("t-1");
      expect(buffered).toHaveLength(1);
      expect(buffered[0]).toEqual(event);
    });

    it("sends to connected sockets", () => {
      const mockSocket = { readyState: 1, send: vi.fn(), on: vi.fn() } as any;
      sm.addConnection("t-1", mockSocket);

      const event = { taskId: "t-1", index: 1, type: "reasoning" as const, timestamp: Date.now(), data: { content: "hello" } };
      sm.broadcast("t-1", event);

      expect(mockSocket.send).toHaveBeenCalledWith(JSON.stringify(event));
    });

    it("does not send to sockets not in OPEN state", () => {
      const closedSocket = { readyState: 3, send: vi.fn(), on: vi.fn() } as any;
      sm.addConnection("t-1", closedSocket);

      const event = { taskId: "t-1", index: 1, type: "reasoning" as const, timestamp: Date.now(), data: {} };
      sm.broadcast("t-1", event);

      // send is called 0 times for closed sockets during broadcast
      // But addConnection replays buffered events immediately, so we need to check the broadcast call
      // Since there are no buffered events at connection time, send should not be called
      const broadcastCalls = closedSocket.send.mock.calls.filter(
        (call: any[]) => call[0] === JSON.stringify(event)
      );
      expect(broadcastCalls).toHaveLength(0);
    });

    it("respects buffer size limit (100)", () => {
      for (let i = 0; i < 120; i++) {
        sm.broadcast("t-1", {
          taskId: "t-1",
          index: i,
          type: "reasoning" as const,
          timestamp: Date.now(),
          data: { content: `msg-${i}` },
        });
      }

      const buffered = sm.getBufferedEvents("t-1");
      expect(buffered).toHaveLength(100);
      // First 20 should have been evicted; buffer starts from index 20
      expect((buffered[0].data as any).content).toBe("msg-20");
    });
  });

  describe("addConnection / removeConnection", () => {
    it("replays buffered events to new connections", () => {
      const event = { taskId: "t-1", index: 1, type: "reasoning" as const, timestamp: Date.now(), data: {} };
      sm.broadcast("t-1", event);

      const mockSocket = { readyState: 1, send: vi.fn(), on: vi.fn() } as any;
      sm.addConnection("t-1", mockSocket);

      expect(mockSocket.send).toHaveBeenCalledWith(JSON.stringify(event));
    });

    it("removes connection on socket close", () => {
      let closeHandler: (() => void) | undefined;
      const mockSocket = {
        readyState: 1,
        send: vi.fn(),
        on: vi.fn((event: string, handler: () => void) => {
          if (event === "close") closeHandler = handler;
        }),
      } as any;

      sm.addConnection("t-1", mockSocket);

      // Simulate socket close
      closeHandler?.();

      // Broadcast should not reach the removed socket
      const event = { taskId: "t-1", index: 2, type: "reasoning" as const, timestamp: Date.now(), data: {} };
      sm.broadcast("t-1", event);

      // The only send call should be the replay at connection time (if any buffered events)
      // No new send after close
      const callsAfterReplay = mockSocket.send.mock.calls.length;
      expect(callsAfterReplay).toBe(0); // no buffered events at connect time
    });
  });

  describe("getBufferedEvents", () => {
    it("returns empty array for unknown task", () => {
      expect(sm.getBufferedEvents("unknown")).toEqual([]);
    });
  });
});

describe("transformToWsEvent", () => {
  it("returns null for null input", () => {
    expect(transformToWsEvent("t-1", 1, null)).toBeNull();
  });

  it("returns null for non-object input", () => {
    expect(transformToWsEvent("t-1", 1, "string")).toBeNull();
  });

  it("returns null for object without type", () => {
    expect(transformToWsEvent("t-1", 1, { foo: "bar" })).toBeNull();
  });

  it("returns null for system event", () => {
    expect(transformToWsEvent("t-1", 1, { type: "system", subtype: "init" })).toBeNull();
  });

  it("returns null for result event", () => {
    expect(transformToWsEvent("t-1", 1, { type: "result", subtype: "success" })).toBeNull();
  });

  it("transforms text_delta stream_event to reasoning", () => {
    const sdkEvent = {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "Hello" },
      },
    };

    const result = transformToWsEvent("t-1", 1, sdkEvent);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("reasoning");
    expect(result!.data).toEqual({ content: "Hello" });
    expect(result!.taskId).toBe("t-1");
    expect(result!.index).toBe(1);
  });

  it("returns null for thinking_delta", () => {
    const sdkEvent = {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "thinking_delta", thinking: "hmm" },
      },
    };

    expect(transformToWsEvent("t-1", 1, sdkEvent)).toBeNull();
  });

  it("transforms tool_use content_block_start to tool_call", () => {
    const sdkEvent = {
      type: "stream_event",
      event: {
        type: "content_block_start",
        content_block: { type: "tool_use", name: "bash", input: { command: "ls" } },
      },
    };

    const result = transformToWsEvent("t-1", 1, sdkEvent);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("tool_call");
    expect(result!.data).toEqual({ toolName: "bash", input: { command: "ls" } });
  });

  it("transforms assistant tool_result to tool_result", () => {
    const sdkEvent = {
      type: "assistant",
      message: {
        content: [{ type: "tool_result", content: "file listing..." }],
      },
    };

    const result = transformToWsEvent("t-1", 1, sdkEvent);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("tool_result");
    expect(result!.data).toEqual({ content: "file listing..." });
  });

  it("returns null for assistant message without tool_result", () => {
    const sdkEvent = {
      type: "assistant",
      message: {
        content: [{ type: "text", text: "Hello" }],
      },
    };

    expect(transformToWsEvent("t-1", 1, sdkEvent)).toBeNull();
  });

  it("returns null for unknown outer type", () => {
    expect(transformToWsEvent("t-1", 1, { type: "custom_unknown" })).toBeNull();
  });
});
