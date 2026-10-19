import { create } from "zustand";
import { api } from "@/lib/api.ts";

// Envelope protocol types (Phase 7 — aligned with src/shared/types.ts)
export type ChatEnvelopeKind =
  | "user_message"
  | "assistant_text"
  | "status_report"
  | "result_delivery"
  | "approval_prompt"
  | "system_note"
  | "audit_note";

export type ApprovalShape = "yes_no" | "choose_one" | "free_input";

export interface ChatAttachmentInfo {
  artifactId: string;
  locator: string;
  filename: string;
  mimeType: string;
  size: number;
  purpose?: "report" | "media" | "data" | "scratch" | "archive";
  contentHash?: string;
  preview?: { thumbnail?: string; excerpt?: string };
}

export interface DeliveryTargetInfo {
  channelId?: string;
  chatId?: string;
  sessionId?: string;
}

export interface ChatSessionInfo {
  id: string;
  status: "active" | "archived";
  source: { type: string; channelId?: string; chatId?: string };
  agentId?: string;
  title?: string;
  createdAt: number;
  lastActiveAt: number;
  archivedAt?: number;
  messageCount: number;
}

export interface ChatMessageInfo {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  source: { type: string };
  taskId?: string;
  createdAt: number;
  // Envelope protocol fields (Phase 7)
  kind?: ChatEnvelopeKind;
  parentMessageId?: string;
  threadRoot?: string;
  promptId?: string;
  approvalShape?: ApprovalShape;
  roleId?: string;
  attachments?: ChatAttachmentInfo[];
  mirroredToTargets?: DeliveryTargetInfo[];
  platformMessageId?: string;
  seq?: number;
}

interface SendMessageResult {
  sessionId: string;
  messageId: string;
}

interface ChatStreamEvent {
  type: string;
  sessionId?: string;
  message?: ChatMessageInfo;
}

interface ChatState {
  sessions: ChatSessionInfo[];
  activeSessionId: string | null;
  messages: ChatMessageInfo[];
  loading: boolean;
  sending: boolean;
  _chatWs: WebSocket | null;
  _chatWsReconnectDelay: number;

  fetchSessions: () => Promise<void>;
  fetchMessages: (sessionId: string) => Promise<void>;
  sendMessage: (content: string) => Promise<SendMessageResult | null>;
  sendApprovalResponse: (promptId: string, value: string) => Promise<SendMessageResult | null>;
  createSession: () => Promise<ChatSessionInfo | null>;
  archiveSession: (id: string) => Promise<void>;
  restoreSession: (id: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  setActiveSession: (id: string | null) => void;
  connectChatStream: () => void;
  disconnectChatStream: () => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  messages: [],
  loading: false,
  sending: false,
  _chatWs: null,
  _chatWsReconnectDelay: 1000,

  fetchSessions: async () => {
    try {
      const data = await api<{ sessions: ChatSessionInfo[] }>("/chat/sessions");
      set({ sessions: data.sessions });
    } catch {
      // Silently fail
    }
  },

  fetchMessages: async (sessionId: string) => {
    set({ loading: true });
    try {
      const data = await api<{ session: ChatSessionInfo; messages: ChatMessageInfo[] }>(
        `/chat/sessions/${sessionId}`,
      );
      set({ messages: data.messages, loading: false });
    } catch {
      set({ messages: [], loading: false });
    }
  },

  sendMessage: async (content: string) => {
    if (get().sending) return null;
    set({ sending: true });
    try {
      const result = await api<SendMessageResult>("/chat/messages", {
        method: "POST",
        body: JSON.stringify({ content, source: { type: "web" }, sessionId: get().activeSessionId ?? undefined }),
      });
      // POST returns immediately (~50ms) — messages arrive via WebSocket
      set({ activeSessionId: result.sessionId, sending: false });
      void get().fetchSessions();
      return result;
    } catch {
      set({ sending: false });
      return null;
    }
  },

  sendApprovalResponse: async (promptId: string, value: string) => {
    if (get().sending) return null;
    set({ sending: true });
    try {
      const result = await api<SendMessageResult>("/chat/messages", {
        method: "POST",
        body: JSON.stringify({
          content: value,
          source: { type: "web" },
          sessionId: get().activeSessionId ?? undefined,
          buttonPayload: { promptId, value },
        }),
      });
      set({ activeSessionId: result.sessionId, sending: false });
      void get().fetchSessions();
      return result;
    } catch {
      set({ sending: false });
      return null;
    }
  },

  createSession: async () => {
    try {
      const data = await api<{ session: ChatSessionInfo }>("/chat/sessions", {
        method: "POST",
        body: JSON.stringify({ source: { type: "web" } }),
      });
      set((state) => ({
        sessions: [data.session, ...state.sessions],
        activeSessionId: data.session.id,
        messages: [],
      }));
      return data.session;
    } catch {
      return null;
    }
  },

  archiveSession: async (id: string) => {
    try {
      await api(`/chat/sessions/${id}/archive`, { method: "POST" });
      set((state) => ({
        sessions: state.sessions.map((s) =>
          s.id === id ? { ...s, status: "archived" as const } : s,
        ),
        activeSessionId: state.activeSessionId === id ? null : state.activeSessionId,
        messages: state.activeSessionId === id ? [] : state.messages,
      }));
    } catch {
      // Silently fail
    }
  },

  restoreSession: async (id: string) => {
    try {
      await api(`/chat/sessions/${id}/restore`, { method: "POST" });
      set((state) => ({
        sessions: state.sessions.map((s) =>
          s.id === id ? { ...s, status: "active" as const } : s,
        ),
      }));
    } catch {
      // Silently fail
    }
  },

  deleteSession: async (id: string) => {
    try {
      await api(`/chat/sessions/${id}`, { method: "DELETE" });
      set((state) => ({
        sessions: state.sessions.filter((s) => s.id !== id),
        activeSessionId: state.activeSessionId === id ? null : state.activeSessionId,
        messages: state.activeSessionId === id ? [] : state.messages,
      }));
    } catch {
      // Silently fail
    }
  },

  setActiveSession: (id: string | null) => {
    set({ activeSessionId: id, messages: [] });
    if (id) {
      void get().fetchMessages(id);
    }
  },

  connectChatStream: () => {
    const existing = get()._chatWs;
    if (existing && existing.readyState <= 1) return;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const apiKey = localStorage.getItem("adam_api_key");
    const wsUrl = new URL(`${protocol}//${window.location.host}/chat/stream`);
    if (apiKey) wsUrl.searchParams.set("api_key", apiKey);
    const ws = new WebSocket(wsUrl.toString());
    let everOpened = false;

    ws.onopen = () => {
      everOpened = true;
      set({ _chatWs: ws, _chatWsReconnectDelay: 1000 });
    };

    ws.onclose = async () => {
      if (!everOpened && apiKey) {
        const { verifyApiKey, clearStoredApiKey, redirectToLogin } = await import("@/lib/api.ts");
        const valid = await verifyApiKey(apiKey).catch(() => true);
        if (!valid) {
          clearStoredApiKey();
          redirectToLogin();
          return;
        }
      }
      const delay = get()._chatWsReconnectDelay;
      const nextDelay = Math.min(delay * 2, 10_000);
      set({ _chatWs: null, _chatWsReconnectDelay: nextDelay });
      setTimeout(() => {
        get().connectChatStream();
      }, delay);
    };

    ws.onerror = () => {
      ws.close();
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as ChatStreamEvent;
        if (data.type === "chat_message" && data.message) {
          const msg = data.message;
          const { activeSessionId, messages } = get();
          if (msg.sessionId !== activeSessionId) return;
          if (messages.some((m) => m.id === msg.id)) return;
          set((state) => ({ messages: [...state.messages, msg] }));
        } else if (data.type === "session_created") {
          void get().fetchSessions();
        }
      } catch {
        // Ignore malformed messages
      }
    };

    set({ _chatWs: ws });
  },

  disconnectChatStream: () => {
    const ws = get()._chatWs;
    if (ws) {
      ws.onclose = null;
      ws.onerror = null;
      ws.onmessage = null;
      ws.close();
      set({ _chatWs: null });
    }
  },
}));
