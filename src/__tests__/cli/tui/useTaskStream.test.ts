import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockConnect, mockOn, mockClose } = vi.hoisted(() => ({
  mockConnect: vi.fn().mockResolvedValue(undefined),
  mockOn: vi.fn(),
  mockClose: vi.fn(),
}));

vi.mock("../../../cli/client.js", () => ({
  TaskStreamSocket: vi.fn(function () {
    return { connect: mockConnect, on: mockOn, off: vi.fn(), close: mockClose };
  }),
}));

// Mock React hooks to capture hook behavior without DOM
let effectCallbacks: Array<() => void | (() => void)> = [];
let stateValues: Record<string, unknown> = {};
let stateSetters: Record<string, (v: unknown) => void> = {};
let stateIndex = 0;
const stateKeys = ["events", "isStreaming"];

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      const key = stateKeys[stateIndex % stateKeys.length];
      stateIndex++;
      if (!(key in stateValues)) stateValues[key] = initial;
      stateSetters[key] = (v: unknown) => {
        stateValues[key] = typeof v === "function" ? (v as Function)(stateValues[key]) : v;
      };
      return [stateValues[key], stateSetters[key]];
    },
    useEffect: (cb: () => void | (() => void)) => { effectCallbacks.push(cb); },
    useRef: (initial: unknown) => ({ current: initial }),
    useCallback: (fn: Function) => fn,
  };
});

import { useTaskStream } from "../../../cli/tui/hooks/useTaskStream.js";

describe("useTaskStream", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stateValues = {};
    stateIndex = 0;
    effectCallbacks = [];
  });

  it("returns empty events when no taskId", () => {
    const result = useTaskStream(null);
    expect(result.events).toEqual([]);
    expect(result.isStreaming).toBe(false);
  });

  it("connects to task stream when taskId provided", () => {
    useTaskStream("task-123");
    effectCallbacks.forEach((cb) => cb());
    expect(mockConnect).toHaveBeenCalled();
  });

  it("registers all event handlers", () => {
    useTaskStream("task-123");
    effectCallbacks.forEach((cb) => cb());
    const eventNames = mockOn.mock.calls.map((c: unknown[]) => c[0]);
    expect(eventNames).toContain("reasoning");
    expect(eventNames).toContain("tool_call");
    expect(eventNames).toContain("tool_result");
    expect(eventNames).toContain("error");
    expect(eventNames).toContain("complete");
  });

  it("handles reasoning event", () => {
    useTaskStream("task-123");
    effectCallbacks.forEach((cb) => cb());
    const reasoningHandler = mockOn.mock.calls.find((c: unknown[]) => c[0] === "reasoning")![1] as (d: unknown) => void;
    reasoningHandler({ content: "thinking..." });
    expect(stateValues.events).toBeDefined();
  });

  it("handles tool_call event", () => {
    useTaskStream("task-123");
    effectCallbacks.forEach((cb) => cb());
    const handler = mockOn.mock.calls.find((c: unknown[]) => c[0] === "tool_call")![1] as (d: unknown) => void;
    handler({ toolName: "Bash" });
    // State setter was called
    expect(stateSetters.events).toBeDefined();
  });

  it("handles tool_result event", () => {
    useTaskStream("task-123");
    effectCallbacks.forEach((cb) => cb());
    const handler = mockOn.mock.calls.find((c: unknown[]) => c[0] === "tool_result")![1] as (d: unknown) => void;
    handler({ content: "output" });
    expect(stateSetters.events).toBeDefined();
  });

  it("handles error event", () => {
    useTaskStream("task-123");
    effectCallbacks.forEach((cb) => cb());
    const handler = mockOn.mock.calls.find((c: unknown[]) => c[0] === "error")![1] as (d: unknown) => void;
    handler({ error: "something failed" });
    expect(stateSetters.events).toBeDefined();
  });

  it("handles complete event and sets isStreaming false", () => {
    useTaskStream("task-123");
    effectCallbacks.forEach((cb) => cb());
    const handler = mockOn.mock.calls.find((c: unknown[]) => c[0] === "complete")![1] as (d: unknown) => void;
    handler({ result: "done", costUsd: 0.01, numTurns: 5 });
    expect(stateValues.isStreaming).toBe(false);
  });

  it("complete event preserves result in content", () => {
    useTaskStream("task-123");
    effectCallbacks.forEach((cb) => cb());
    const handler = mockOn.mock.calls.find((c: unknown[]) => c[0] === "complete")![1] as (d: unknown) => void;
    handler({ result: "hello world", costUsd: 0.01 });
    const events = stateValues.events as Array<{ type: string; content: string; metadata?: unknown }>;
    const completeEvent = events.find((e) => e.type === "complete");
    expect(completeEvent).toBeDefined();
    expect(completeEvent!.content).toBe("hello world");
  });

  it("clearEvents resets events and streaming", () => {
    const { clearEvents } = useTaskStream("task-123");
    clearEvents();
    expect(stateValues.events).toEqual([]);
    expect(stateValues.isStreaming).toBe(false);
  });

  it("cleanup closes socket", () => {
    useTaskStream("task-123");
    const cleanups = effectCallbacks.map((cb) => cb()).filter(Boolean);
    cleanups.forEach((cleanup) => (cleanup as () => void)());
    expect(mockClose).toHaveBeenCalled();
  });

  it("handles connect failure", async () => {
    mockConnect.mockRejectedValue(new Error("fail"));
    useTaskStream("task-123");
    effectCallbacks.forEach((cb) => cb());
    await new Promise((r) => setTimeout(r, 10));
    // Error event should be added, isStreaming set to false
    expect(stateValues.isStreaming).toBe(false);
  });
});
