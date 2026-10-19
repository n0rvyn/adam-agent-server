import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ThreadContainer } from "@/components/chat/ThreadContainer.tsx";
import type { ChatMessageInfo } from "@/store/useChatStore.ts";

const makeMsg = (overrides: Partial<ChatMessageInfo> = {}): ChatMessageInfo => ({
  id: "msg-1",
  sessionId: "sess-1",
  role: "assistant",
  content: "Sample content",
  source: { type: "web" },
  createdAt: Date.now(),
  ...overrides,
});

const SESSION_ID = "session-abc";
const THREAD_ROOT = "thread-xyz";

const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value;
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key];
    }),
    clear: () => {
      store = {};
    },
  };
})();

Object.defineProperty(window, "localStorage", { value: localStorageMock });

describe("ThreadContainer", () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
  });

  it("closed thread (has result_delivery, no open approval) defaults to collapsed", () => {
    const messages = [
      makeMsg({ id: "m1", kind: "user_message", content: "Do the thing" }),
      makeMsg({ id: "m2", kind: "result_delivery", taskId: "task-1" }),
    ];
    render(
      <ThreadContainer
        sessionId={SESSION_ID}
        threadRoot={THREAD_ROOT}
        messages={messages}
      >
        <div>child content</div>
      </ThreadContainer>,
    );
    expect(screen.getByTestId("thread-container")).toHaveAttribute("data-collapsed", "1");
  });

  it("active thread (no result_delivery) defaults to expanded", () => {
    const messages = [makeMsg({ id: "m1", kind: "status_report", content: "step 1" })];
    render(
      <ThreadContainer
        sessionId={SESSION_ID}
        threadRoot={THREAD_ROOT}
        messages={messages}
      >
        <div>child content</div>
      </ThreadContainer>,
    );
    expect(screen.getByTestId("thread-container")).toHaveAttribute("data-collapsed", "0");
    // Children should be visible
    expect(screen.getByText("child content")).toBeInTheDocument();
  });

  it("localStorage overrides default collapse state", () => {
    localStorageMock.getItem.mockReturnValueOnce("1");
    const messages = [
      makeMsg({ id: "m1", kind: "status_report", content: "step 1" }),
    ];
    render(
      <ThreadContainer
        sessionId={SESSION_ID}
        threadRoot={THREAD_ROOT}
        messages={messages}
      >
        <div>child content</div>
      </ThreadContainer>,
    );
    expect(screen.getByTestId("thread-container")).toHaveAttribute("data-collapsed", "1");
    // Children should be hidden
    expect(screen.queryByText("child content")).not.toBeInTheDocument();
  });

  it("clicking toggle switches collapsed state and writes localStorage", () => {
    const messages = [
      makeMsg({ id: "m1", kind: "user_message", content: "Task request" }),
    ];
    render(
      <ThreadContainer
        sessionId={SESSION_ID}
        threadRoot={THREAD_ROOT}
        messages={messages}
      >
        <div>child content</div>
      </ThreadContainer>,
    );
    // Default: expanded (active thread)
    expect(screen.getByTestId("thread-container")).toHaveAttribute("data-collapsed", "0");

    fireEvent.click(screen.getByTestId("thread-toggle"));

    expect(screen.getByTestId("thread-container")).toHaveAttribute("data-collapsed", "1");
    expect(screen.queryByText("child content")).not.toBeInTheDocument();
    expect(localStorageMock.setItem).toHaveBeenCalledWith(
      `chat:thread-fold:${SESSION_ID}:${THREAD_ROOT}`,
      "1",
    );
  });

  it("renders task short ID in header when taskId is present", () => {
    const messages = [
      makeMsg({
        id: "m1",
        kind: "user_message",
        taskId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        content: "Start task",
      }),
    ];
    render(
      <ThreadContainer
        sessionId={SESSION_ID}
        threadRoot={THREAD_ROOT}
        messages={messages}
      >
        <div>child</div>
      </ThreadContainer>,
    );
    expect(screen.getByText("T-A1B2C3D4")).toBeInTheDocument();
  });

  it("truncates long user_message content to 30 chars in header", () => {
    // Use ASCII so character count is unambiguous: 35 chars > threshold of 30
    const longContent = "abcdefghijklmnopqrstuvwxyzABCDEFGHI";
    expect(longContent.length).toBe(35);
    const messages = [
      makeMsg({ id: "m1", kind: "user_message", content: longContent }),
    ];
    render(
      <ThreadContainer
        sessionId={SESSION_ID}
        threadRoot={THREAD_ROOT}
        messages={messages}
      >
        <div>child</div>
      </ThreadContainer>,
    );
    const toggle = screen.getByTestId("thread-toggle");
    expect(toggle.textContent).toContain("...");
  });

  it("uses first message as excerpt when no user_message present", () => {
    const messages = [
      makeMsg({ id: "m1", kind: "status_report", content: "Status update message" }),
    ];
    render(
      <ThreadContainer
        sessionId={SESSION_ID}
        threadRoot={THREAD_ROOT}
        messages={messages}
      >
        <div>child</div>
      </ThreadContainer>,
    );
    expect(screen.getByText("Status update message")).toBeInTheDocument();
  });
});
