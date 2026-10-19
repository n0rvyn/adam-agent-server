// @vitest-environment happy-dom
/**
 * DP-001 symmetric dedup test — verifies result_delivery for a single taskId
 * is pushed exactly once regardless of which stream arrives first;
 * also verifies intermediate status_report does NOT block task-stream fallback.
 */
import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useRef, useState } from "react";

describe("DP-001 symmetric dedup with terminal-kind gating", () => {
  function useTestDedup() {
    const [messages, setMessages] = useState<Array<{ taskId: string; via: string; kind?: string }>>([]);
    const seenChat = useRef<Set<string>>(new Set());
    const seenTask = useRef<Set<string>>(new Set());
    const onChat = (taskId: string, kind?: string) => {
      const isTerminal = !kind || kind === "result_delivery" || kind === "assistant_text";
      if (isTerminal && seenTask.current.has(taskId)) {
        seenChat.current.add(taskId);
        return;
      }
      if (isTerminal) seenChat.current.add(taskId);
      setMessages((prev) => [...prev, { taskId, via: "chat", kind }]);
    };
    const onTask = (taskId: string) => {
      if (seenChat.current.has(taskId)) return;
      seenTask.current.add(taskId);
      setMessages((prev) => [...prev, { taskId, via: "task" }]);
    };
    return { messages, onChat, onTask };
  }

  it("chat result_delivery first, task complete second -> only chat pushed", () => {
    const { result } = renderHook(() => useTestDedup());
    act(() => result.current.onChat("T-1", "result_delivery"));
    act(() => result.current.onTask("T-1"));
    expect(result.current.messages).toEqual([{ taskId: "T-1", via: "chat", kind: "result_delivery" }]);
  });

  it("task complete first, chat result_delivery second -> only task pushed", () => {
    const { result } = renderHook(() => useTestDedup());
    act(() => result.current.onTask("T-1"));
    act(() => result.current.onChat("T-1", "result_delivery"));
    expect(result.current.messages).toEqual([{ taskId: "T-1", via: "task" }]);
  });

  it("two different taskIds -> both pushed", () => {
    const { result } = renderHook(() => useTestDedup());
    act(() => result.current.onChat("T-1", "result_delivery"));
    act(() => result.current.onTask("T-2"));
    expect(result.current.messages).toHaveLength(2);
  });

  it("repeats of same terminal envelope -> single push (id-dedup is App.tsx's responsibility but this verifies cross-path)", () => {
    const { result } = renderHook(() => useTestDedup());
    act(() => result.current.onChat("T-1", "result_delivery"));
    act(() => result.current.onTask("T-1"));
    act(() => result.current.onTask("T-1"));
    expect(result.current.messages.filter((m) => m.via === "task")).toHaveLength(0);
  });

  it("chat status_report first does NOT block task-stream fallback (kind != terminal)", () => {
    const { result } = renderHook(() => useTestDedup());
    act(() => result.current.onChat("T-1", "status_report"));
    act(() => result.current.onTask("T-1"));
    // status_report is pushed via chat (non-terminal)
    // task-stream then pushes its fallback because no terminal chat envelope arrived
    expect(result.current.messages).toEqual([
      { taskId: "T-1", via: "chat", kind: "status_report" },
      { taskId: "T-1", via: "task" },
    ]);
  });

  it("chat status_report THEN result_delivery THEN task -> terminal blocks task-stream", () => {
    const { result } = renderHook(() => useTestDedup());
    act(() => result.current.onChat("T-1", "status_report"));
    act(() => result.current.onChat("T-1", "result_delivery"));
    act(() => result.current.onTask("T-1"));
    // status_report + result_delivery both pushed via chat; task-stream noop
    expect(result.current.messages).toHaveLength(2);
    expect(result.current.messages.every((m) => m.via === "chat")).toBe(true);
  });
});
