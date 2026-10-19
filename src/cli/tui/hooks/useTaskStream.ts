import { useEffect, useRef, useState, useCallback } from "react";
import { TaskStreamSocket } from "../../client.js";
import type { StreamEvent } from "../components/StreamView.js";

export function useTaskStream(taskId: string | null) {
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const socketRef = useRef<TaskStreamSocket | null>(null);

  const clearEvents = useCallback(() => {
    setEvents([]);
    setIsStreaming(false);
  }, []);

  useEffect(() => {
    if (!taskId) return;

    let isMounted = true;
    setEvents([]);
    setIsStreaming(true);

    try {
      const socket = new TaskStreamSocket(taskId);
      socketRef.current = socket;

      socket.on("reasoning", (data: unknown) => {
        if (!isMounted) return;
        const d = data as { content?: string };
        const content = d.content ?? "";
        setEvents((prev) => {
          const last = prev[prev.length - 1];
          if (last?.type === "reasoning") {
            const merged = [...prev];
            merged[merged.length - 1] = {
              ...last,
              content: last.content + content,
            };
            return merged;
          }
          return [...prev, { type: "reasoning", content, timestamp: Date.now() }];
        });
      });

      socket.on("tool_call", (data: unknown) => {
        if (!isMounted) return;
        const d = data as { toolName?: string; input?: unknown };
        setEvents((prev) => [...prev, {
          type: "tool_call",
          content: d.toolName ?? "unknown tool",
          timestamp: Date.now(),
          metadata: { toolName: d.toolName },
        }]);
      });

      socket.on("tool_result", (data: unknown) => {
        if (!isMounted) return;
        const d = data as { content?: string };
        setEvents((prev) => [...prev, {
          type: "tool_result",
          content: d.content ?? "",
          timestamp: Date.now(),
        }]);
      });

      socket.on("error", (data: unknown) => {
        if (!isMounted) return;
        const d = data as { error?: string };
        setEvents((prev) => [...prev, {
          type: "error",
          content: d.error ?? "unknown error",
          timestamp: Date.now(),
        }]);
      });

      socket.on("complete", (data: unknown) => {
        if (!isMounted) return;
        const d = data as { result?: string; costUsd?: number; numTurns?: number; totalDurationMs?: number };
        setEvents((prev) => [...prev, {
          type: "complete",
          content: d.result ?? "", // preserve result for MessageHistory persistence
          timestamp: Date.now(),
          metadata: {
            cost: d.costUsd,
            turns: d.numTurns,
            duration: d.totalDurationMs,
          },
        }]);
        setIsStreaming(false);
      });

      socket.connect().catch(() => {
        if (isMounted) {
          setEvents((prev) => [...prev, {
            type: "error",
            content: "Failed to connect to task stream",
            timestamp: Date.now(),
          }]);
          setIsStreaming(false);
        }
      });

      return () => {
        isMounted = false;
        socket.close();
      };
    } catch {
      setIsStreaming(false);
    }
  }, [taskId]);

  return { events, isStreaming, clearEvents };
}
