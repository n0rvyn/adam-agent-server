import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, render, screen, fireEvent, within } from "../utils/test-utils";
import { Chat } from "@/pages/Chat";
import { useChatStore } from "@/store/useChatStore";

// Mock the chat store with initial state
const mockSendMessage = vi.fn().mockResolvedValue({ sessionId: "s1", taskId: "t1", messageId: "m1" });
const mockCreateSession = vi.fn().mockResolvedValue({ id: "s-new", status: "active", messageCount: 0, createdAt: Date.now(), lastActiveAt: Date.now() });
const mockFetchSessions = vi.fn();
const mockSetActiveSession = vi.fn();

describe("Chat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useChatStore.setState({
      sessions: [],
      activeSessionId: null,
      messages: [],
      loading: false,
      sending: false,
      fetchSessions: mockFetchSessions,
      sendMessage: mockSendMessage,
      createSession: mockCreateSession,
      setActiveSession: mockSetActiveSession,
      connectChatStream: vi.fn(),
      disconnectChatStream: vi.fn(),
    });
  });

  it("renders empty state when no messages", () => {
    render(<Chat />);
    expect(screen.getByText("Start a conversation with Adam")).toBeInTheDocument();
  });

  it("renders message input", () => {
    render(<Chat />);
    expect(screen.getByPlaceholderText("Type a message...")).toBeInTheDocument();
  });

  it("renders send button", () => {
    render(<Chat />);
    expect(screen.getByLabelText("Send message")).toBeInTheDocument();
  });

  it("renders session sidebar on large screens", () => {
    render(<Chat />);
    // "Sessions" appears twice: PageHeader eyebrow + SessionList heading
    expect(screen.getAllByText("Sessions").length).toBeGreaterThan(0);
  });

  it("opens session manager from the mobile action", () => {
    useChatStore.setState({
      sessions: [
        { id: "s1", title: "Primary session", status: "active", source: { type: "web" }, messageCount: 3, createdAt: Date.now(), lastActiveAt: Date.now() },
      ],
    });
    render(<Chat />);

    fireEvent.click(screen.getByRole("button", { name: "Manage sessions" }));

    const dialog = screen.getByRole("dialog", { name: "Session manager" });
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByText("Primary session")).toBeInTheDocument();
  });

  it("renders messages when present", () => {
    useChatStore.setState({
      messages: [
        { id: "m1", sessionId: "s1", role: "user", content: "Hello", source: { type: "web" }, createdAt: Date.now() },
        { id: "m2", sessionId: "s1", role: "assistant", content: "Hi there!", source: { type: "web" }, createdAt: Date.now() + 100 },
      ],
    });
    render(<Chat />);
    expect(screen.getByText("Hello")).toBeInTheDocument();
    expect(screen.getByText("Hi there!")).toBeInTheDocument();
  });

  it("renders session list with sessions", () => {
    useChatStore.setState({
      sessions: [
        { id: "s1", status: "active", source: { type: "web" }, messageCount: 3, createdAt: Date.now(), lastActiveAt: Date.now() },
        { id: "s2", status: "archived", source: { type: "web" }, messageCount: 1, createdAt: Date.now() - 86400000, lastActiveAt: Date.now() - 86400000 },
      ],
    });
    render(<Chat />);
    expect(screen.getByText("3 turns")).toBeInTheDocument();
    expect(screen.getByText("archived")).toBeInTheDocument();
  });

  it("uses a working state instead of onboarding when sessions already exist", () => {
    useChatStore.setState({
      sessions: [
        { id: "s1", title: "Primary session", status: "active", source: { type: "web" }, messageCount: 3, createdAt: Date.now(), lastActiveAt: Date.now() },
      ],
    });
    render(<Chat />);
    expect(screen.queryByText("Start a conversation with Adam")).not.toBeInTheDocument();
    expect(screen.getByText("Working Surface")).toBeInTheDocument();
  });

  it("auto-selects the most recent active session", () => {
    useChatStore.setState({
      sessions: [
        { id: "s1", title: "Older session", status: "active", source: { type: "web" }, messageCount: 3, createdAt: Date.now() - 1000, lastActiveAt: Date.now() - 1000 },
        { id: "s2", title: "Latest session", status: "active", source: { type: "web" }, messageCount: 5, createdAt: Date.now(), lastActiveAt: Date.now() },
      ],
    });
    render(<Chat />);
    expect(mockSetActiveSession).toHaveBeenCalledWith("s2");
  });

  it("fetches sessions on mount", () => {
    render(<Chat />);
    expect(mockFetchSessions).toHaveBeenCalled();
  });

  it("disables input when sending", () => {
    useChatStore.setState({ sending: true });
    render(<Chat />);
    const textarea = screen.getByPlaceholderText("Type a message...");
    expect(textarea).toBeDisabled();
  });

  it("displays relative timestamps on messages", () => {
    useChatStore.setState({
      messages: [
        { id: "m1", sessionId: "s1", role: "user", content: "Hello", source: { type: "web" as const }, createdAt: Date.now() - 30000 },
        { id: "m2", sessionId: "s1", role: "assistant", content: "Hi there!", source: { type: "web" as const }, createdAt: Date.now() },
      ],
    });
    render(<Chat />);
    // Timestamps should use relative format (e.g. "30s ago", "just now")
    expect(screen.getAllByText(/ago|just now/).length).toBeGreaterThan(0);
  });

  it("only shows starter actions while the conversation is empty", () => {
    const { rerender } = render(<Chat />);
    expect(screen.getByRole("button", { name: "Debug a failure" })).toBeInTheDocument();

    act(() => {
      useChatStore.setState({
        messages: [
          { id: "m1", sessionId: "s1", role: "user", content: "Hello", source: { type: "web" as const }, createdAt: Date.now() },
        ],
      });
    });
    rerender(<Chat />);

    expect(screen.queryByRole("button", { name: "Debug a failure" })).not.toBeInTheDocument();
  });

  // --- Phase 7: Thread-grouped rendering ---

  it("back-compat: messages without kind/threadRoot render in free conversation bucket (legacy bubble)", () => {
    useChatStore.setState({
      sessions: [
        { id: "s1", status: "active", source: { type: "web" }, messageCount: 2, createdAt: Date.now(), lastActiveAt: Date.now() },
      ],
      activeSessionId: "s1",
      messages: [
        { id: "m1", sessionId: "s1", role: "user", content: "Hello", source: { type: "web" }, createdAt: Date.now() },
        { id: "m2", sessionId: "s1", role: "assistant", content: "Hi there!", source: { type: "web" }, createdAt: Date.now() + 100 },
      ],
    });
    render(<Chat />);
    // Legacy messages without kind fall through to ConversationBubble
    expect(screen.getByText("Hello")).toBeInTheDocument();
    expect(screen.getByText("Hi there!")).toBeInTheDocument();
    // No thread containers — free conversation is rendered flat
    expect(screen.queryByTestId("thread-container")).not.toBeInTheDocument();
  });

  it("thread grouping: free messages render flat; threaded messages render in separate ThreadContainers", () => {
    useChatStore.setState({
      sessions: [
        { id: "s1", status: "active", source: { type: "web" }, messageCount: 7, createdAt: Date.now(), lastActiveAt: Date.now() },
      ],
      activeSessionId: "s1",
      messages: [
        // Free conversation
        { id: "m1", sessionId: "s1", role: "user", content: "Free message 1", source: { type: "web" }, createdAt: 100 },
        { id: "m2", sessionId: "s1", role: "assistant", content: "Free response", source: { type: "web" }, createdAt: 200 },
        // Thread t1 — active (no result_delivery yet)
        { id: "m3", sessionId: "s1", role: "user", content: "Task 1 request", source: { type: "web" }, taskId: "task-uuid-1", kind: "user_message", threadRoot: "t1", createdAt: 300 },
        { id: "m4", sessionId: "s1", role: "assistant", content: "Status 1", source: { type: "web" }, kind: "status_report", threadRoot: "t1", taskId: "task-uuid-1", createdAt: 400 },
        { id: "m5", sessionId: "s1", role: "assistant", content: "Status 2", source: { type: "web" }, kind: "status_report", threadRoot: "t1", taskId: "task-uuid-1", createdAt: 500 },
        { id: "m6", sessionId: "s1", role: "assistant", content: "Status 3", source: { type: "web" }, kind: "status_report", threadRoot: "t1", taskId: "task-uuid-1", createdAt: 600 },
        { id: "m7", sessionId: "s1", role: "assistant", content: "Status 4", source: { type: "web" }, kind: "status_report", threadRoot: "t1", taskId: "task-uuid-1", createdAt: 700 },
        { id: "m8", sessionId: "s1", role: "assistant", content: "Result 1", source: { type: "web" }, kind: "result_delivery", threadRoot: "t1", taskId: "task-uuid-1", createdAt: 800 },
        // Thread t2 — active (no result_delivery yet)
        { id: "m9", sessionId: "s1", role: "user", content: "Task 2 request", source: { type: "web" }, taskId: "task-uuid-2", kind: "user_message", threadRoot: "t2", createdAt: 900 },
        { id: "m10", sessionId: "s1", role: "assistant", content: "Result 2", source: { type: "web" }, kind: "result_delivery", threadRoot: "t2", taskId: "task-uuid-2", createdAt: 1000 },
      ],
    });
    render(<Chat />);

    // Free conversation: 2 messages rendered flat (no thread container wrapper)
    expect(screen.getByText("Free message 1")).toBeInTheDocument();
    expect(screen.getByText("Free response")).toBeInTheDocument();

    // 2 thread containers exist (toggle buttons always visible)
    const threads = screen.getAllByTestId("thread-container");
    expect(threads).toHaveLength(2);
    expect(threads[0]).toHaveAttribute("data-thread-root", "t1");
    expect(threads[1]).toHaveAttribute("data-thread-root", "t2");
  });

  it("status_report >= 3: consecutive status_reports collapse into one StatusReportGroup with 'N 步进展' header", () => {
    useChatStore.setState({
      sessions: [
        { id: "s1", status: "active", source: { type: "web" }, messageCount: 5, createdAt: Date.now(), lastActiveAt: Date.now() },
      ],
      activeSessionId: "s1",
      messages: [
        { id: "m1", sessionId: "s1", role: "user", content: "Do the thing", source: { type: "web" }, kind: "user_message", threadRoot: "t1", taskId: "task-1", createdAt: 100 },
        { id: "m2", sessionId: "s1", role: "assistant", content: "Step 1", source: { type: "web" }, kind: "status_report", threadRoot: "t1", createdAt: 200 },
        { id: "m3", sessionId: "s1", role: "assistant", content: "Step 2", source: { type: "web" }, kind: "status_report", threadRoot: "t1", createdAt: 300 },
        { id: "m4", sessionId: "s1", role: "assistant", content: "Step 3", source: { type: "web" }, kind: "status_report", threadRoot: "t1", createdAt: 400 },
        { id: "m5", sessionId: "s1", role: "assistant", content: "Step 4", source: { type: "web" }, kind: "status_report", threadRoot: "t1", createdAt: 500 },
        { id: "m6", sessionId: "s1", role: "assistant", content: "Done", source: { type: "web" }, kind: "result_delivery", threadRoot: "t1", createdAt: 600 },
      ],
    });
    render(<Chat />);

    // Closed thread (result_delivery present) is collapsed by default — click to expand
    const threadToggle = screen.getByTestId("thread-toggle");
    fireEvent.click(threadToggle);

    const group = screen.getByTestId("status-report-group");
    expect(group).toBeInTheDocument();
    expect(screen.getByText("4 步进展")).toBeInTheDocument();

    // No individual status-report-line in the DOM when grouped (collapsed by default)
    expect(screen.queryByTestId("status-report-line")).not.toBeInTheDocument();
  });

  it("status_report < 3: consecutive status_reports do NOT collapse — render as individual StatusReportLines", () => {
    useChatStore.setState({
      sessions: [
        { id: "s1", status: "active", source: { type: "web" }, messageCount: 4, createdAt: Date.now(), lastActiveAt: Date.now() },
      ],
      activeSessionId: "s1",
      messages: [
        { id: "m1", sessionId: "s1", role: "user", content: "Quick task", source: { type: "web" }, kind: "user_message", threadRoot: "t3", taskId: "task-3", createdAt: 100 },
        { id: "m2", sessionId: "s1", role: "assistant", content: "Sub-step A", source: { type: "web" }, kind: "status_report", threadRoot: "t3", createdAt: 200 },
        { id: "m3", sessionId: "s1", role: "assistant", content: "Sub-step B", source: { type: "web" }, kind: "status_report", threadRoot: "t3", createdAt: 300 },
        { id: "m4", sessionId: "s1", role: "assistant", content: "Result for t3", source: { type: "web" }, kind: "result_delivery", threadRoot: "t3", createdAt: 400 },
      ],
    });
    render(<Chat />);

    // Closed thread (result_delivery present) is collapsed by default — click to expand
    const threadToggle = screen.getByTestId("thread-toggle");
    fireEvent.click(threadToggle);

    // No group (threshold not reached)
    expect(screen.queryByTestId("status-report-group")).not.toBeInTheDocument();
    // 2 individual lines
    const lines = screen.getAllByTestId("status-report-line");
    expect(lines).toHaveLength(2);
    expect(screen.getByText("Sub-step A")).toBeInTheDocument();
    expect(screen.getByText("Sub-step B")).toBeInTheDocument();
  });

  it("thread with only result_delivery (no status_report): renders ResultDeliveryCard without status group or lines", () => {
    useChatStore.setState({
      sessions: [
        { id: "s1", status: "active", source: { type: "web" }, messageCount: 2, createdAt: Date.now(), lastActiveAt: Date.now() },
      ],
      activeSessionId: "s1",
      messages: [
        { id: "m1", sessionId: "s1", role: "user", content: "Task t2", source: { type: "web" }, kind: "user_message", threadRoot: "t2", taskId: "task-t2", createdAt: 100 },
        { id: "m2", sessionId: "s1", role: "assistant", content: "Completed successfully", source: { type: "web" }, kind: "result_delivery", threadRoot: "t2", taskId: "task-t2", createdAt: 200 },
      ],
    });
    render(<Chat />);

    // Closed thread (result_delivery present) is collapsed by default — click to expand
    const threadToggle = screen.getByTestId("thread-toggle");
    fireEvent.click(threadToggle);

    const card = screen.getByTestId("result-delivery-card");
    expect(card).toBeInTheDocument();
    expect(screen.getByText("Completed successfully")).toBeInTheDocument();

    // No status report artifacts
    expect(screen.queryByTestId("status-report-group")).not.toBeInTheDocument();
    expect(screen.queryByTestId("status-report-line")).not.toBeInTheDocument();
  });
});
