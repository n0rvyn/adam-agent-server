import { useState, useEffect, useCallback } from "react";
import { request } from "../../client.js";
import type { ChatSession } from "../../../shared/types.js";

export interface ChatSessionInfo {
  id: string;
  status: "active" | "archived";
  messageCount: number;
  createdAt: number;
  lastActiveAt: number;
  title?: string;
}

interface SendMessageResult {
  sessionId: string;
  taskId: string;
  messageId: string;
}

function toSessionInfo(session: ChatSession): ChatSessionInfo {
  return {
    id: session.id,
    status: session.status,
    messageCount: session.messageCount,
    createdAt: session.createdAt,
    lastActiveAt: session.lastActiveAt,
    title: session.title,
  };
}

export function useChatSession() {
  const [session, setSession] = useState<ChatSessionInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchActiveSession = useCallback(async (): Promise<ChatSessionInfo | null> => {
    try {
      const response = await request<{ sessions: ChatSession[] }>("/chat/sessions?status=active");
      const tuiSession = response.sessions.find((s) => s.source.type === "tui");
      return tuiSession ? toSessionInfo(tuiSession) : null;
    } catch {
      return null;
    }
  }, []);

  const createNewSession = useCallback(async (): Promise<ChatSessionInfo | null> => {
    try {
      const response = await request<{ session: ChatSession }>("/chat/sessions", {
        method: "POST",
        body: { source: { type: "tui" } },
      });
      const info = toSessionInfo(response.session);
      setSession(info);
      return info;
    } catch {
      setError("Failed to create session");
      return null;
    }
  }, []);

  const sendMessage = useCallback(async (content: string): Promise<SendMessageResult | null> => {
    try {
      const result = await request<SendMessageResult>("/chat/messages", {
        method: "POST",
        body: { content, source: { type: "tui" } },
      });
      // Optimistic local update
      setSession((prev) => prev ? {
        ...prev,
        messageCount: prev.messageCount + 1,
        lastActiveAt: Date.now(),
      } : prev);
      return result;
    } catch {
      return null;
    }
  }, []);

  const archiveCurrentSession = useCallback(async (): Promise<boolean> => {
    if (!session) return false;
    try {
      await request(`/chat/sessions/${session.id}/archive`, { method: "POST" });
      setSession(null);
      return true;
    } catch {
      return false;
    }
  }, [session]);

  const refreshSession = useCallback(async (): Promise<void> => {
    if (!session) return;
    try {
      const response = await request<{ session: ChatSession }>(`/chat/sessions/${session.id}`);
      setSession(toSessionInfo(response.session));
    } catch {
      // Session may have been archived/deleted
      setSession(null);
    }
  }, [session]);

  // Initialize: fetch or create TUI session on mount
  useEffect(() => {
    let cancelled = false;
    async function init() {
      setLoading(true);
      const existing = await fetchActiveSession();
      if (cancelled) return;
      if (existing) {
        setSession(existing);
      } else {
        await createNewSession();
      }
      if (!cancelled) setLoading(false);
    }
    void init();
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    session,
    loading,
    error,
    sendMessage,
    createNewSession,
    archiveCurrentSession,
    refreshSession,
    setSession,
  };
}
