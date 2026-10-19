import { useEffect, useRef, useState } from "react";
import { EventSocket } from "../../client.js";
import type {
  ChatEnvelopeKind,
  ApprovalShape,
  ChatAttachment,
  DeliveryTarget,
} from "../../../shared/types.js";

export interface ChatStreamMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  source: { type: string };
  taskId?: string;
  createdAt: number;
  // Envelope protocol fields (Phase 8) — wire-only fields carried by chat_message event
  kind?: ChatEnvelopeKind;
  threadRoot?: string;
  parentMessageId?: string;
  promptId?: string;
  approvalShape?: ApprovalShape;
  roleId?: string;
  attachments?: ChatAttachment[];
  mirroredToTargets?: DeliveryTarget[];
  platformMessageId?: string;
  seq?: number;
}

/**
 * Subscribe to /chat/stream WebSocket for real-time chat_message events.
 * Filters messages to the given sessionId and assistant role.
 * Returns the latest unprocessed message.
 */
export function useChatStream(sessionId: string | null) {
  const [latestMessage, setLatestMessage] = useState<ChatStreamMessage | null>(null);
  const seenIdsRef = useRef(new Set<string>());

  useEffect(() => {
    if (!sessionId) return;

    let isMounted = true;
    let socket: EventSocket | null = null;

    try {
      socket = new EventSocket("/chat/stream");

      socket.on("chat_message", (data: unknown) => {
        if (!isMounted) return;
        const d = data as { sessionId?: string; message?: ChatStreamMessage };
        const msg = d.message;
        if (!msg) return;
        if (msg.sessionId !== sessionId) return;
        if (msg.role !== "assistant") return;
        if (seenIdsRef.current.has(msg.id)) return;

        seenIdsRef.current.add(msg.id);
        setLatestMessage(msg);
      });

      socket.connect().catch(() => {
        // Non-fatal: chat stream is a supplementary channel
      });
    } catch {
      // EventSocket constructor fails if server not running — non-fatal
    }

    return () => {
      isMounted = false;
      socket?.close();
    };
  }, [sessionId]);

  // Clear seen IDs when session changes
  useEffect(() => {
    seenIdsRef.current.clear();
    setLatestMessage(null);
  }, [sessionId]);

  return { latestMessage };
}
