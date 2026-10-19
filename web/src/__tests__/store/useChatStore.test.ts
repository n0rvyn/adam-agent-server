import { describe, it, expect, vi, beforeEach } from "vitest";
import { useChatStore } from "@/store/useChatStore";

// Mock the api module
vi.mock("@/lib/api", () => ({
  api: vi.fn(),
  ApiError: class extends Error {
    status: number;
    code: string;
    constructor(s: number, c: string, m: string) { super(m); this.status = s; this.code = c; }
  },
}));

describe("useChatStore", () => {
  beforeEach(() => {
    useChatStore.setState({
      sessions: [],
      activeSessionId: null,
      messages: [],
      loading: false,
      sending: false,
    });
  });

  it("has correct initial state", () => {
    const state = useChatStore.getState();
    expect(state.sessions).toEqual([]);
    expect(state.activeSessionId).toBeNull();
    expect(state.messages).toEqual([]);
    expect(state.loading).toBe(false);
    expect(state.sending).toBe(false);
  });

  it("setActiveSession updates state", () => {
    useChatStore.getState().setActiveSession("s1");
    expect(useChatStore.getState().activeSessionId).toBe("s1");
    expect(useChatStore.getState().messages).toEqual([]);
  });

  it("setActiveSession to null clears messages", () => {
    useChatStore.setState({ messages: [{ id: "m1", sessionId: "s1", role: "user", content: "hi", source: { type: "web" }, createdAt: Date.now() }] });
    useChatStore.getState().setActiveSession(null);
    expect(useChatStore.getState().activeSessionId).toBeNull();
    expect(useChatStore.getState().messages).toEqual([]);
  });

  it("fetchSessions calls API", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api).mockResolvedValueOnce({ sessions: [{ id: "s1", status: "active" }] });

    await useChatStore.getState().fetchSessions();
    expect(useChatStore.getState().sessions).toHaveLength(1);
    expect(useChatStore.getState().sessions[0].id).toBe("s1");
  });

  it("fetchSessions handles error gracefully", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api).mockRejectedValueOnce(new Error("fail"));

    await useChatStore.getState().fetchSessions();
    expect(useChatStore.getState().sessions).toEqual([]);
  });

  it("sendMessage sets activeSessionId and returns result", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api)
      .mockResolvedValueOnce({ sessionId: "s1", messageId: "m1" }) // sendMessage
      .mockResolvedValueOnce({ sessions: [] }); // fetchSessions refresh

    const result = await useChatStore.getState().sendMessage("hello");
    expect(result).toEqual({ sessionId: "s1", messageId: "m1" });
    // Messages arrive via WebSocket, not from sendMessage
    expect(useChatStore.getState().messages).toHaveLength(0);
    expect(useChatStore.getState().activeSessionId).toBe("s1");
    expect(useChatStore.getState().sending).toBe(false);
  });

  it("sendMessage blocks duplicate sends", async () => {
    useChatStore.setState({ sending: true });
    const result = await useChatStore.getState().sendMessage("hello");
    expect(result).toBeNull();
  });

  it("sendMessage returns null on error", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api).mockRejectedValueOnce(new Error("fail"));

    const result = await useChatStore.getState().sendMessage("hello");
    expect(result).toBeNull();
    expect(useChatStore.getState().sending).toBe(false);
  });

  it("createSession adds to sessions list", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api).mockResolvedValueOnce({
      session: { id: "s-new", status: "active", source: { type: "web" }, messageCount: 0, createdAt: Date.now(), lastActiveAt: Date.now() },
    });

    const session = await useChatStore.getState().createSession();
    expect(session).toBeDefined();
    expect(session!.id).toBe("s-new");
    expect(useChatStore.getState().sessions).toHaveLength(1);
    expect(useChatStore.getState().activeSessionId).toBe("s-new");
  });

  it("archiveSession updates session status", async () => {
    useChatStore.setState({
      sessions: [{ id: "s1", status: "active" as const, source: { type: "web" }, messageCount: 0, createdAt: Date.now(), lastActiveAt: Date.now() }],
      activeSessionId: "s1",
    });

    const { api } = await import("@/lib/api");
    vi.mocked(api).mockResolvedValueOnce({});

    await useChatStore.getState().archiveSession("s1");
    expect(useChatStore.getState().sessions[0].status).toBe("archived");
    expect(useChatStore.getState().activeSessionId).toBeNull();
  });

  it("deleteSession removes from list", async () => {
    useChatStore.setState({
      sessions: [{ id: "s1", status: "active" as const, source: { type: "web" }, messageCount: 0, createdAt: Date.now(), lastActiveAt: Date.now() }],
    });

    const { api } = await import("@/lib/api");
    vi.mocked(api).mockResolvedValueOnce({});

    await useChatStore.getState().deleteSession("s1");
    expect(useChatStore.getState().sessions).toHaveLength(0);
  });

  // ── Phase 7: sendApprovalResponse ─────────────────────────────────────────

  it("sendApprovalResponse POSTs with buttonPayload and correct content", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api)
      .mockResolvedValueOnce({ sessionId: "s1", messageId: "m2" })
      .mockResolvedValueOnce({ sessions: [] });

    const result = await useChatStore.getState().sendApprovalResponse("A2K7", "批准");
    expect(result).toEqual({ sessionId: "s1", messageId: "m2" });
    expect(vi.mocked(api)).toHaveBeenCalledWith(
      "/chat/messages",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          content: "批准",
          source: { type: "web" },
          sessionId: undefined,
          buttonPayload: { promptId: "A2K7", value: "批准" },
        }),
      }),
    );
  });

  it("ChatMessageInfo accepts Phase 7 envelope fields", () => {
    // TypeScript compile-time check: if this compiles, the interface is correct.
    const m: import("@/store/useChatStore").ChatMessageInfo = {
      id: "m1",
      sessionId: "s1",
      role: "assistant",
      content: "请确认",
      source: { type: "web" },
      createdAt: Date.now(),
      kind: "approval_prompt",
      threadRoot: "t1",
      promptId: "A2K7",
      approvalShape: "yes_no",
    };
    expect(m.kind).toBe("approval_prompt");
    expect(m.approvalShape).toBe("yes_no");
  });
});
