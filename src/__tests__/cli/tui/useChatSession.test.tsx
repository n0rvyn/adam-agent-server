// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import React, { useEffect } from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";

const mockRequest = vi.fn();
vi.mock("../../../cli/client.js", () => ({
  request: (...args: unknown[]) => mockRequest(...args),
}));

import { useChatSession, type ChatSessionInfo } from "../../../cli/tui/hooks/useChatSession.js";

function TestComponent({ onSession }: { onSession: (s: ChatSessionInfo | null) => void }) {
  const { session, sendMessage, createNewSession, archiveCurrentSession } = useChatSession();

  useEffect(() => {
    onSession(session);
  }, [session]);

  return <Text>{session ? `Session: ${session.id}` : "No session"}</Text>;
}

describe("useChatSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches active TUI session on mount", async () => {
    const mockSession = {
      id: "s1",
      status: "active",
      source: { type: "tui" },
      messageCount: 3,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    };
    mockRequest.mockResolvedValueOnce({ sessions: [mockSession] });

    let resolvedSession: ChatSessionInfo | null = null;
    const { lastFrame } = render(
      <TestComponent onSession={(s) => { resolvedSession = s; }} />,
    );

    await vi.waitFor(() => {
      expect(resolvedSession).toBeDefined();
      expect(resolvedSession?.id).toBe("s1");
    });
  });

  it("creates new session when none exists", async () => {
    const mockNewSession = {
      id: "s-new",
      status: "active",
      source: { type: "tui" },
      messageCount: 0,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    };
    mockRequest
      .mockResolvedValueOnce({ sessions: [] })
      .mockResolvedValueOnce({ session: mockNewSession });

    let resolvedSession: ChatSessionInfo | null = null;
    render(
      <TestComponent onSession={(s) => { resolvedSession = s; }} />,
    );

    await vi.waitFor(() => {
      expect(resolvedSession).toBeDefined();
      expect(resolvedSession?.id).toBe("s-new");
    });

    expect(mockRequest).toHaveBeenCalledWith("/chat/sessions", expect.objectContaining({ method: "POST" }));
  });

  it("filters for TUI session among multiple active sessions", async () => {
    mockRequest.mockResolvedValueOnce({
      sessions: [
        { id: "web-s", status: "active", source: { type: "web" }, messageCount: 2, createdAt: Date.now(), lastActiveAt: Date.now() },
        { id: "tui-s", status: "active", source: { type: "tui" }, messageCount: 7, createdAt: Date.now(), lastActiveAt: Date.now() },
      ],
    });

    let resolvedSession: ChatSessionInfo | null = null;
    render(
      <TestComponent onSession={(s) => { resolvedSession = s; }} />,
    );

    await vi.waitFor(() => {
      expect(resolvedSession?.id).toBe("tui-s");
    });
  });

  it("handles fetch error gracefully", async () => {
    const mockNewSession = {
      id: "fallback",
      status: "active",
      source: { type: "tui" },
      messageCount: 0,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    };
    mockRequest
      .mockRejectedValueOnce(new Error("network error")) // fetchActiveSession fails
      .mockResolvedValueOnce({ session: mockNewSession }); // createNewSession succeeds

    let resolvedSession: ChatSessionInfo | null = null;
    render(
      <TestComponent onSession={(s) => { resolvedSession = s; }} />,
    );

    await vi.waitFor(() => {
      expect(resolvedSession?.id).toBe("fallback");
    });
  });
});
