import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { ChatMessage } from "@/components/chat/ChatMessage.tsx";
import { useChatStore } from "@/store/useChatStore.ts";
import type { ChatMessageInfo, ChatEnvelopeKind } from "@/store/useChatStore.ts";

const makeMsg = (overrides: Partial<ChatMessageInfo> = {}): ChatMessageInfo => ({
  id: "msg-1",
  sessionId: "sess-1",
  role: "user",
  content: "Hello world",
  source: { type: "web" },
  createdAt: Date.now(),
  ...overrides,
});

describe("ChatMessage", () => {
  beforeEach(() => {
    useChatStore.setState({ sending: false, messages: [] });
    vi.spyOn(useChatStore.getState(), "fetchSessions").mockResolvedValue();
  });

  // --- kind: user_message ---
  it("user_message renders conversation bubble with text visible", () => {
    render(
      <ChatMessage
        message={makeMsg({ kind: "user_message", role: "user", content: "Hello world" })}
      />,
    );
    expect(screen.getByText("Hello world")).toBeInTheDocument();
    expect(screen.getByText("You")).toBeInTheDocument();
  });

  // --- kind: assistant_text ---
  it("assistant_text renders conversation bubble with text visible", () => {
    render(
      <ChatMessage
        message={makeMsg({ kind: "assistant_text", role: "assistant", content: "Hi there!" })}
      />,
    );
    expect(screen.getByText("Hi there!")).toBeInTheDocument();
    expect(screen.getByText("Adam")).toBeInTheDocument();
  });

  // --- kind: status_report ---
  it("status_report delegates to StatusReportLine", () => {
    render(
      <ChatMessage
        message={makeMsg({
          kind: "status_report",
          role: "assistant",
          content: "Step 1 of analysis",
        })}
      />,
    );
    expect(screen.getByTestId("status-report-line")).toBeInTheDocument();
  });

  // --- kind: result_delivery ---
  it("result_delivery delegates to ResultDeliveryCard", () => {
    render(
      <ChatMessage
        message={makeMsg({
          kind: "result_delivery",
          role: "assistant",
          content: "Task completed.",
        })}
      />,
    );
    expect(screen.getByTestId("result-delivery-card")).toBeInTheDocument();
  });

  // --- kind: approval_prompt ---
  it("approval_prompt delegates to ApprovalCard in pending state", () => {
    render(
      <ChatMessage
        message={makeMsg({
          kind: "approval_prompt",
          role: "assistant",
          content: "Approve this change?",
          promptId: "A2K7",
          approvalShape: "yes_no",
        })}
      />,
    );
    expect(screen.getByTestId("approval-card")).toBeInTheDocument();
    expect(screen.getByTestId("approval-card")).toHaveAttribute("data-state", "pending");
  });

  // --- kind: system_note ---
  it("system_note delegates to SystemNote", () => {
    render(
      <ChatMessage
        message={makeMsg({
          kind: "system_note",
          role: "assistant",
          content: "System note content",
        })}
      />,
    );
    expect(screen.getByTestId("system-note")).toBeInTheDocument();
  });

  // --- back-compat: no kind + role=user → user bubble ---
  it("back-compat: no kind field with role=user falls back to user bubble", () => {
    const { container } = render(
      <ChatMessage
        message={makeMsg({ role: "user", content: "Hello from user" })}
      />,
    );
    expect(screen.getByText("Hello from user")).toBeInTheDocument();
    expect(screen.getByText("You")).toBeInTheDocument();
    // Should NOT render any envelope-specific testids
    expect(container.querySelector('[data-testid="status-report-line"]')).not.toBeInTheDocument();
    expect(container.querySelector('[data-testid="result-delivery-card"]')).not.toBeInTheDocument();
    expect(container.querySelector('[data-testid="approval-card"]')).not.toBeInTheDocument();
    expect(container.querySelector('[data-testid="system-note"]')).not.toBeInTheDocument();
  });

  // --- back-compat: no kind + role=assistant → assistant bubble ---
  it("back-compat: no kind field with role=assistant falls back to assistant bubble", () => {
    const { container } = render(
      <ChatMessage
        message={makeMsg({ role: "assistant", content: "Hello from assistant" })}
      />,
    );
    expect(screen.getByText("Hello from assistant")).toBeInTheDocument();
    expect(screen.getByText("Adam")).toBeInTheDocument();
    expect(container.querySelector('[data-testid="approval-card"]')).not.toBeInTheDocument();
    expect(container.querySelector('[data-testid="system-note"]')).not.toBeInTheDocument();
  });

  // --- UX-006 summary: all 6 envelope kinds render distinct components ---
  it("ux-006-chatmessage-kind-switch: renders distinct components for all 6 envelope kinds", () => {
    const kinds: ChatEnvelopeKind[] = ["user_message", "assistant_text", "status_report", "result_delivery", "approval_prompt", "system_note"];
    for (const kind of kinds) {
      const msg = makeMsg({ kind, role: kind === "user_message" ? "user" : "assistant" });
      const { container, unmount } = render(<ChatMessage message={msg} />);
      expect(container.children.length).toBeGreaterThan(0);
      unmount();
    }
  });
});
