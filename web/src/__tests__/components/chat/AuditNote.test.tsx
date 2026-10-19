import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { AuditNote } from "@/components/chat/AuditNote.tsx";
import type { ChatMessageInfo } from "@/store/useChatStore.ts";

const makeMsg = (content: string): ChatMessageInfo =>
  ({
    id: "m1",
    sessionId: "s1",
    role: "assistant",
    content,
    source: { type: "web" },
    createdAt: Date.now(),
    kind: "audit_note",
  }) as ChatMessageInfo;

describe("AuditNote", () => {
  it("renders with data-testid audit-note", () => {
    render(<AuditNote message={makeMsg("本轮没有实际调用任何工具、无执行证据")} />);
    expect(screen.getByTestId("audit-note")).toBeInTheDocument();
  });

  it("has the chat-audit-note CSS class", () => {
    const { container } = render(<AuditNote message={makeMsg("test")} />);
    expect(container.firstChild).toHaveClass("chat-audit-note");
  });

  it("has role=note accessibility attribute", () => {
    render(<AuditNote message={makeMsg("test")} />);
    expect(screen.getByTestId("audit-note")).toHaveAttribute("role", "note");
  });

  it("shows the 自检 · 审计边车 label so the source is unmistakable", () => {
    render(<AuditNote message={makeMsg("无执行证据")} />);
    expect(screen.getByText("自检 · 审计边车")).toBeInTheDocument();
  });

  it("renders the dynamic message content text", () => {
    render(<AuditNote message={makeMsg("声称的变更缺少对应执行证据")} />);
    expect(screen.getByText("声称的变更缺少对应执行证据")).toBeInTheDocument();
  });
});
