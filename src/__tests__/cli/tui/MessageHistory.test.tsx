// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { simulateKey, waitForInputReady, waitForRender } from "../../helpers/tui.js";

// Must use vi.hoisted so the mock is available at hoisting time
const mockRequest = vi.hoisted(() => vi.fn().mockResolvedValue({}));
vi.mock("../../../cli/client.js", () => ({
  request: mockRequest,
}));

// Mock useRoleNames so role name lookup is deterministic in tests
vi.mock("../../../cli/tui/hooks/useRoleNames.js", () => ({
  useRoleNames: () => ({
    getName: (roleId: string | undefined | null) => {
      if (roleId === "role-审慎") return "审慎者";
      if (roleId === "role-敏捷") return "敏捷者";
      return "?";
    },
    loaded: true,
  }),
}));

import { MessageHistory, type Message } from "../../../cli/tui/components/MessageHistory.js";

describe("MessageHistory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequest.mockResolvedValue({});
  });

  it("renders empty state as null", () => {
    const { lastFrame } = render(<MessageHistory messages={[]} />);
    expect(lastFrame()).toBe("");
  });

  it("renders default user/assistant bubble for legacy messages without kind", () => {
    const messages: Message[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];
    const { lastFrame } = render(<MessageHistory messages={messages} />);
    expect(lastFrame()).toContain("You:");
    expect(lastFrame()).toContain("hello");
    expect(lastFrame()).toContain("Adam:");
    expect(lastFrame()).toContain("hi");
  });

  it("ux-007-tui-thread-group-with-role-gutter: groups messages by threadRoot into ThreadBox with derived roleName + taskShortId", () => {
    const messages: Message[] = [
      { role: "user", content: "do PR review", kind: "user_message" },
      { role: "assistant", content: "step 1", kind: "status_report", threadRoot: "t1", taskId: "abc12345-6789", roleId: "role-审慎" },
      { role: "assistant", content: "result done", kind: "result_delivery", threadRoot: "t1", taskId: "abc12345-6789", roleId: "role-审慎" },
    ];
    const { lastFrame } = render(<MessageHistory messages={messages} />);
    expect(lastFrame()).toContain("do PR review");
    expect(lastFrame()).toContain("[Thread");
    // taskShortId derived from taskId: "abc12345-6789" → "T-ABC12345"
    expect(lastFrame()).toContain("T-ABC12345");
    // roleName from useRoleNames mock: "role-审慎" → "审慎者"
    expect(lastFrame()).toContain("审慎者");
    expect(lastFrame()).toContain("step 1");
    expect(lastFrame()).toContain("result done");
  });

  it("compresses >=3 consecutive status_reports into single line", () => {
    // Note: head.content becomes the thread header brief (head.content.slice(0, 30)),
    // so the first status_report's content WILL appear in the header even after
    // body compression. To distinguish, the body should not contain step labels
    // beyond the synthetic "N 条进展" entry.
    const messages: Message[] = Array.from({ length: 4 }, (_, i) => ({
      role: "assistant" as const,
      content: `进展报告 ${i + 1}`,
      kind: "status_report" as const,
      threadRoot: "t1",
      taskId: "abc12345-6789",
    }));
    const { lastFrame } = render(<MessageHistory messages={messages} />);
    expect(lastFrame()).toContain("4 条进展");
    // Synthetic "最近:" entry shows lastContent
    expect(lastFrame()).toMatch(/最近:.*进展报告 4/);
    // Middle entries 进展报告 2 / 进展报告 3 must NOT appear individually in body
    expect(lastFrame()).not.toContain("进展报告 2");
    expect(lastFrame()).not.toContain("进展报告 3");
  });

  it("does NOT compress 2 consecutive status_reports", () => {
    const messages: Message[] = [
      { role: "assistant", content: "step 0", kind: "status_report", threadRoot: "t1" },
      { role: "assistant", content: "step 1", kind: "status_report", threadRoot: "t1" },
    ];
    const { lastFrame } = render(<MessageHistory messages={messages} />);
    expect(lastFrame()).toContain("step 0");
    expect(lastFrame()).toContain("step 1");
    expect(lastFrame()).not.toContain("条进展");
  });

  it("renders system_note as dimmed bullet line", () => {
    const messages: Message[] = [
      { role: "assistant", content: "该决策已在 Web 端批准", kind: "system_note" },
    ];
    const { lastFrame } = render(<MessageHistory messages={messages} />);
    expect(lastFrame()).toContain("·");
    expect(lastFrame()).toContain("该决策已在 Web 端批准");
  });

  it("renders audit_note with a self-check label distinct from a neutral system note", () => {
    const messages: Message[] = [
      { role: "assistant", content: "本轮没有实际调用任何工具、无执行证据", kind: "audit_note" },
    ];
    const { lastFrame } = render(<MessageHistory messages={messages} />);
    expect(lastFrame()).toContain("自检 · 审计边车");
    expect(lastFrame()).toContain("无执行证据");
  });

  it("renders mirror suffix on result_delivery", () => {
    const ts = new Date("2026-05-07T10:42:00").getTime();
    const messages: Message[] = [
      {
        role: "assistant",
        content: "merged",
        kind: "result_delivery",
        threadRoot: "t1",
        taskId: "abc12345-6789",
        roleId: "role-审慎",
        mirroredToTargets: [{ type: "channel", channelId: "wechat" }],
        createdAt: ts,
      },
    ];
    const { lastFrame } = render(<MessageHistory messages={messages} />);
    expect(lastFrame()).toMatch(/also delivered to: wechat @ \d\d:\d\d/);
  });

  it("renders approval_prompt as ApprovalSelect with prompt id", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: "Approve git push?",
        kind: "approval_prompt",
        promptId: "A2K7",
        approvalShape: "yes_no",
      },
    ];
    const { lastFrame } = render(<MessageHistory messages={messages} />);
    expect(lastFrame()).toContain("A2K7");
    expect(lastFrame()).toContain("Approve git push?");
    expect(lastFrame()).toContain("批准");
  });

  it("invokes onApprovalSubmitted prop chain when ApprovalSelect submits", async () => {
    const onSubmitted = vi.fn();
    const messages: Message[] = [
      {
        role: "assistant",
        content: "?",
        kind: "approval_prompt",
        promptId: "A2K7",
        approvalShape: "yes_no",
      },
    ];
    const { stdin } = render(<MessageHistory messages={messages} onApprovalSubmitted={onSubmitted} />);
    await waitForInputReady();
    simulateKey(stdin, "return"); // select first option (批准)
    await waitForRender();
    expect(onSubmitted).toHaveBeenCalledWith("A2K7");
  });
});
