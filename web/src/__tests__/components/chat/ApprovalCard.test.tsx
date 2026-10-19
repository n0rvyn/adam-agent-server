import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { ApprovalCard } from "@/components/chat/ApprovalCard.tsx";
import { useChatStore } from "@/store/useChatStore.ts";
import type { ChatMessageInfo } from "@/store/useChatStore.ts";

const makeMsg = (overrides: Partial<ChatMessageInfo> = {}): ChatMessageInfo => ({
  id: "msg-1",
  sessionId: "sess-1",
  role: "assistant",
  content: "是否批准该变更？",
  source: { type: "web" },
  createdAt: Date.now(),
  kind: "approval_prompt",
  promptId: "A2K7",
  approvalShape: "yes_no",
  ...overrides,
});

describe("ApprovalCard", () => {
  beforeEach(() => {
    // Reset store to a clean base state
    useChatStore.setState({
      sending: false,
      messages: [],
      sessions: [],
      activeSessionId: null,
    });
  });

  // --- Shape: yes_no ---
  it("yes_no renders approve and reject buttons", () => {
    render(<ApprovalCard message={makeMsg({ approvalShape: "yes_no" })} />);
    expect(screen.getByTestId("approval-card")).toBeInTheDocument();
    expect(screen.getByTestId("approve-button")).toBeInTheDocument();
    expect(screen.getByTestId("reject-button")).toBeInTheDocument();
  });

  it("yes_no approve button calls sendApprovalResponse with correct args", async () => {
    const spy = vi
      .spyOn(useChatStore.getState(), "sendApprovalResponse")
      .mockResolvedValue({ sessionId: "s1", messageId: "m1" });
    // Also mock fetchSessions to avoid setTimeout in real timers path
    vi.spyOn(useChatStore.getState(), "fetchSessions").mockResolvedValue();

    render(<ApprovalCard message={makeMsg({ approvalShape: "yes_no" })} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("approve-button"));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(spy).toHaveBeenCalledWith("A2K7", "批准");
    spy.mockRestore();
    useChatStore.getState().fetchSessions.mockRestore?.();
  });

  // --- Shape: choose_one ---
  it("choose_one renders fallback approve/reject buttons", () => {
    render(<ApprovalCard message={makeMsg({ approvalShape: "choose_one" })} />);
    expect(screen.getByTestId("approval-card")).toBeInTheDocument();
    expect(screen.getByTestId("approve-button")).toBeInTheDocument();
    expect(screen.getByTestId("reject-button")).toBeInTheDocument();
    expect(screen.getByTestId("approval-card")).toHaveAttribute("data-shape", "choose_one");
  });

  // --- Shape: free_input ---
  it("free_input renders text input and submit button", () => {
    render(<ApprovalCard message={makeMsg({ approvalShape: "free_input" })} />);
    expect(screen.getByTestId("free-input")).toBeInTheDocument();
    expect(screen.getByTestId("submit-button")).toBeInTheDocument();
    expect(screen.getByTestId("approval-card")).toHaveAttribute("data-shape", "free_input");
  });

  it("free_input submit calls action with trimmed value", async () => {
    const spy = vi
      .spyOn(useChatStore.getState(), "sendApprovalResponse")
      .mockResolvedValue({ sessionId: "s1", messageId: "m1" });
    vi.spyOn(useChatStore.getState(), "fetchSessions").mockResolvedValue();

    render(<ApprovalCard message={makeMsg({ approvalShape: "free_input" })} />);
    fireEvent.change(screen.getByTestId("free-input"), { target: { value: "请稍后" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("submit-button"));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(spy).toHaveBeenCalledWith("A2K7", "请稍后");
    spy.mockRestore();
  });

  // --- submitted state ---
  it("after submit transitions to submitted state with 已提交 text", async () => {
    vi.spyOn(useChatStore.getState(), "sendApprovalResponse").mockResolvedValue({
      sessionId: "s1",
      messageId: "m1",
    });
    vi.spyOn(useChatStore.getState(), "fetchSessions").mockResolvedValue();

    render(<ApprovalCard message={makeMsg({ approvalShape: "yes_no" })} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("approve-button"));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    const card = screen.getByTestId("approval-card");
    expect(card).toHaveAttribute("data-state", "submitted");
    expect(screen.getByText(/已提交「批准」/)).toBeInTheDocument();
    // Buttons should be gone
    expect(screen.queryByTestId("approve-button")).not.toBeInTheDocument();
    expect(screen.queryByTestId("reject-button")).not.toBeInTheDocument();
  });

  // --- no promptId → no-op ---
  it("without promptId submit is no-op (does not call store action)", async () => {
    const spy = vi.spyOn(useChatStore.getState(), "sendApprovalResponse");

    render(<ApprovalCard message={makeMsg({ promptId: undefined })} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("approve-button"));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  // --- stale: matching system_note triggers transition ---
  it("matching system_note with stale keyword transitions to stale state", async () => {
    const submittedAt = Date.now();
    const staleNote: ChatMessageInfo = {
      id: "sys-1",
      sessionId: "sess-1",
      role: "assistant",
      content: "该决策窗口已过期 (#A2K7)",
      source: { type: "web" },
      createdAt: submittedAt + 10,
      kind: "system_note",
    };

    vi.spyOn(useChatStore.getState(), "sendApprovalResponse").mockResolvedValue({
      sessionId: "s1",
      messageId: "m1",
    });
    vi.spyOn(useChatStore.getState(), "fetchSessions").mockResolvedValue();

    render(<ApprovalCard message={makeMsg({ approvalShape: "yes_no" })} />);

    // Submit
    await act(async () => {
      fireEvent.click(screen.getByTestId("approve-button"));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.getByTestId("approval-card")).toHaveAttribute("data-state", "submitted");

    // Inject stale system_note into store → triggers useEffect re-run
    useChatStore.setState({ messages: [staleNote] });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    const card = screen.getByTestId("approval-card");
    expect(card).toHaveAttribute("data-state", "stale");
    expect(screen.getByText("该决策窗口已过期 (#A2K7)")).toBeInTheDocument();
    expect(screen.queryByText(/已提交「批准」/)).not.toBeInTheDocument();
  });

  // --- no stale system_note → stays submitted ---
  it("no stale system_note preserves submitted state (does not wrongly go stale)", async () => {
    vi.spyOn(useChatStore.getState(), "sendApprovalResponse").mockResolvedValue({
      sessionId: "s1",
      messageId: "m1",
    });
    vi.spyOn(useChatStore.getState(), "fetchSessions").mockResolvedValue();

    render(<ApprovalCard message={makeMsg({ approvalShape: "yes_no" })} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("approve-button"));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    // Add a non-stale system_note
    useChatStore.setState({
      messages: [
        {
          id: "sys-2",
          sessionId: "sess-1",
          role: "assistant",
          content: "任务继续执行中",
          source: { type: "web" },
          createdAt: Date.now(),
          kind: "system_note",
        },
      ],
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(screen.getByTestId("approval-card")).toHaveAttribute("data-state", "submitted");
  });

  // --- stale: promptId mismatch is ignored ---
  it("stale system_note with mismatched promptId is ignored (does not go stale)", async () => {
    vi.spyOn(useChatStore.getState(), "sendApprovalResponse").mockResolvedValue({
      sessionId: "s1",
      messageId: "m1",
    });
    vi.spyOn(useChatStore.getState(), "fetchSessions").mockResolvedValue();

    render(<ApprovalCard message={makeMsg({ approvalShape: "yes_no" })} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("approve-button"));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    // Add stale note for a DIFFERENT promptId
    useChatStore.setState({
      messages: [
        {
          id: "sys-3",
          sessionId: "sess-1",
          role: "assistant",
          content: "该决策窗口已过期 (#OTHER)",
          source: { type: "web" },
          createdAt: Date.now() + 100,
          kind: "system_note",
        },
      ],
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(screen.getByTestId("approval-card")).toHaveAttribute("data-state", "submitted");
  });

  // --- silent failure: null result keeps pending ---
  it("null result from sendApprovalResponse keeps card in pending (retry possible)", async () => {
    vi.spyOn(useChatStore.getState(), "sendApprovalResponse").mockResolvedValue(null);

    render(<ApprovalCard message={makeMsg({ approvalShape: "yes_no" })} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("approve-button"));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    // Card should still be pending with buttons available
    expect(screen.getByTestId("approval-card")).toHaveAttribute("data-state", "pending");
    expect(screen.getByTestId("approve-button")).toBeInTheDocument();
    expect(screen.getByTestId("reject-button")).toBeInTheDocument();
  });
});
