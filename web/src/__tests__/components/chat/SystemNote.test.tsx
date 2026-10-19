import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SystemNote } from "@/components/chat/SystemNote.tsx";
import type { ChatMessageInfo } from "@/store/useChatStore.ts";

const makeMsg = (content: string): ChatMessageInfo =>
  ({
    id: "m1",
    sessionId: "s1",
    role: "assistant",
    content,
    source: { type: "web" },
    createdAt: Date.now(),
    kind: "system_note",
  }) as ChatMessageInfo;

describe("SystemNote", () => {
  it("renders with data-testid system-note", () => {
    render(<SystemNote message={makeMsg("该决策已在 Web 端批准 ✓")} />);
    expect(screen.getByTestId("system-note")).toBeInTheDocument();
  });

  it("has the chat-system-note CSS class", () => {
    const { container } = render(<SystemNote message={makeMsg("test")} />);
    expect(container.firstChild).toHaveClass("chat-system-note");
  });

  it("has role=note accessibility attribute", () => {
    render(<SystemNote message={makeMsg("test")} />);
    expect(screen.getByTestId("system-note")).toHaveAttribute("role", "note");
  });

  it("renders the message content text", () => {
    render(<SystemNote message={makeMsg("该决策已在 Web 端批准 ✓")} />);
    expect(screen.getByText("该决策已在 Web 端批准 ✓")).toBeInTheDocument();
  });
});
