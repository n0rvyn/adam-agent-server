// @vitest-environment happy-dom
/**
 * App component tests — covers view routing, command handling, approval banner.
 * Uses renderToStaticMarkup (React DOM) instead of ink-testing-library
 * because App requires mocking 12+ child components.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMockApproval } from "../../helpers/tui.js";

// Mock Ink as HTML elements
vi.mock("ink", () => ({
  Box: ({ children }: { children?: React.ReactNode }) => React.createElement("div", null, children),
  Text: ({ children }: { children?: React.ReactNode }) => React.createElement("span", null, children),
  useInput: vi.fn(),
  Newline: () => React.createElement("br"),
}));

// Mock all child components
vi.mock("../../../cli/tui/components/StatusBar.js", () => ({
  StatusBar: () => React.createElement("span", null, "[StatusBar]"),
}));
let capturedOnSubmit: ((v: string) => void) | null = null;
vi.mock("../../../cli/tui/components/InputBar.js", () => ({
  InputBar: ({ onSubmit }: { onSubmit: (v: string) => void }) => {
    capturedOnSubmit = onSubmit;
    return React.createElement("span", null, "[InputBar]");
  },
}));
vi.mock("../../../cli/tui/components/StreamView.js", () => ({
  StreamView: () => React.createElement("span", null, "[StreamView]"),
}));
vi.mock("../../../cli/tui/components/MessageHistory.js", () => ({
  MessageHistory: ({ messages }: { messages: Array<{ role: string; content: string }> }) =>
    React.createElement(
      "span",
      null,
      `[Messages:${messages.length}]`,
      ...messages.map((m, i) =>
        React.createElement("span", { key: i }, m.role === "assistant" ? `Adam:${m.content}` : `User:${m.content}`),
      ),
    ),
}));
vi.mock("../../../cli/tui/components/ApprovalBanner.js", () => ({
  ApprovalBanner: () => React.createElement("span", null, "[ApprovalBanner]"),
}));
vi.mock("../../../cli/tui/components/TaskList.js", () => ({
  TaskList: () => React.createElement("span", null, "[TaskList]"),
}));
vi.mock("../../../cli/tui/components/ConfigView.js", () => ({
  ConfigView: () => React.createElement("span", null, "[ConfigView]"),
}));
vi.mock("../../../cli/tui/components/EvolutionView.js", () => ({
  EvolutionView: () => React.createElement("span", null, "[EvolutionView]"),
}));
// AgentList removed in Phase 2
vi.mock("../../../cli/tui/components/GoalDashboard.js", () => ({
  GoalDashboard: () => React.createElement("span", null, "[GoalDashboard]"),
}));
vi.mock("../../../cli/tui/components/WorkView.js", () => ({
  WorkView: () => React.createElement("span", null, "[WorkView]"),
}));
vi.mock("../../../cli/tui/components/StrategyLab.js", () => ({
  StrategyLab: () => React.createElement("span", null, "[StrategyLab]"),
}));
vi.mock("ink-text-input", () => ({
  default: () => React.createElement("span", null, "[TextInput]"),
}));

// Mock hooks
const { mockSendMessage, mockDispatch, mockUseTaskStream, mockCreateNewSession, mockArchiveCurrentSession } = vi.hoisted(() => ({
  mockSendMessage: vi.fn(),
  mockCreateNewSession: vi.fn(),
  mockArchiveCurrentSession: vi.fn(),
  mockDispatch: vi.fn(),
  mockUseTaskStream: vi.fn(() => ({
    events: [] as Array<{ type: string; content: string; timestamp?: number; metadata?: Record<string, unknown> }>,
    isStreaming: false,
    clearEvents: vi.fn(),
  })),
}));
let mockState: Record<string, unknown> = {};

vi.mock("../../../cli/tui/hooks/useTuiState.js", () => ({
  TuiProvider: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  useTuiState: () => ({ state: mockState, dispatch: mockDispatch }),
}));

vi.mock("../../../cli/tui/hooks/useChatSession.js", () => ({
  useChatSession: () => ({
    session: { id: "test-session", status: "active", messageCount: 0, createdAt: Date.now(), lastActiveAt: Date.now() },
    sendMessage: mockSendMessage,
    createNewSession: mockCreateNewSession,
    archiveCurrentSession: mockArchiveCurrentSession,
  }),
}));

vi.mock("../../../cli/tui/hooks/useGlobalEvents.js", () => ({
  useGlobalEvents: vi.fn(),
}));

vi.mock("../../../cli/tui/hooks/useTaskStream.js", () => ({
  useTaskStream: mockUseTaskStream,
}));

import { createRoot } from "react-dom/client";
import { act } from "react";
import App from "../../../cli/tui/App.js";

describe("App", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedOnSubmit = null;
    mockState = {
      connected: true, serverInfo: null, activeTasks: 0,
      queuedTasks: 0, costToday: 0, activeTaskId: null, activeTaskSubmitted: false,
      pendingApproval: null, serverUnreachable: false, view: "chat", configVersion: 0,
    };
  });

  it("renders chat view with StatusBar, StreamView, InputBar", () => {
    const html = renderToStaticMarkup(React.createElement(App));
    expect(html).toContain("[StatusBar]");
    expect(html).toContain("[StreamView]");
    expect(html).toContain("[InputBar]");
  });

  it("renders WorkView when view is work", () => {
    mockState.view = "work";
    const html = renderToStaticMarkup(React.createElement(App));
    expect(html).toContain("[WorkView]");
  });

  it("renders ConfigView when view is config", () => {
    mockState.view = "config";
    const html = renderToStaticMarkup(React.createElement(App));
    expect(html).toContain("[ConfigView]");
  });

  it("renders EvolutionView when view is evolution", () => {
    mockState.view = "evolution";
    const html = renderToStaticMarkup(React.createElement(App));
    expect(html).toContain("[EvolutionView]");
  });

  // AgentList removed in Phase 2; "skills" view now serves skill management

  // GoalDashboard is now rendered inside WorkView, tested via WorkView mock

  it("renders StrategyLab when view is strategies", () => {
    mockState.view = "strategies";
    const html = renderToStaticMarkup(React.createElement(App));
    expect(html).toContain("[StrategyLab]");
  });

  it("renders ApprovalBanner when pendingApproval exists", () => {
    mockState.pendingApproval = createMockApproval();
    const html = renderToStaticMarkup(React.createElement(App));
    expect(html).toContain("[ApprovalBanner]");
    expect(html).not.toContain("[InputBar]");
  });

  it("shows server unreachable message", () => {
    mockState.serverUnreachable = true;
    const html = renderToStaticMarkup(React.createElement(App));
    expect(html).toContain("Server unreachable");
  });

  it("dispatches SET_VIEW for /work command", () => {
    renderToStaticMarkup(React.createElement(App));
    capturedOnSubmit!("/work");
    expect(mockDispatch).toHaveBeenCalledWith({ type: "SET_VIEW", view: "work" });
  });

  it("dispatches SET_VIEW for /config command", () => {
    renderToStaticMarkup(React.createElement(App));
    capturedOnSubmit!("/config");
    expect(mockDispatch).toHaveBeenCalledWith({ type: "SET_VIEW", view: "config" });
  });

  it("dispatches SET_VIEW for /evolution command", () => {
    renderToStaticMarkup(React.createElement(App));
    capturedOnSubmit!("/evolution");
    expect(mockDispatch).toHaveBeenCalledWith({ type: "SET_VIEW", view: "evolution" });
  });

  // /agents command removed in Phase 2; replaced by /skills

  it("dispatches SET_VIEW chat for /back command", () => {
    renderToStaticMarkup(React.createElement(App));
    capturedOnSubmit!("/back");
    expect(mockDispatch).toHaveBeenCalledWith({ type: "SET_VIEW", view: "chat" });
  });

  it("sends message via chat API for non-command input", async () => {
    mockSendMessage.mockResolvedValue({ sessionId: "s1", taskId: "task-123", messageId: "m1" });
    renderToStaticMarkup(React.createElement(App));
    await capturedOnSubmit!("Write tests");
    expect(mockSendMessage).toHaveBeenCalledWith("Write tests");
  });

  it("handles sendMessage failure", async () => {
    mockSendMessage.mockResolvedValue(null);
    renderToStaticMarkup(React.createElement(App));
    await capturedOnSubmit!("Do something");
    expect(mockSendMessage).toHaveBeenCalledWith("Do something");
  });

  it("persists assistant response to MessageHistory on task complete", async () => {
    mockState.activeTaskId = "task-persist-1";
    mockUseTaskStream.mockReturnValue({
      events: [
        { type: "complete" as const, content: "test response", timestamp: Date.now() },
      ],
      isStreaming: false,
      clearEvents: vi.fn(),
    });

    const container = document.createElement("div");
    document.body.appendChild(container);
    await act(async () => {
      createRoot(container).render(React.createElement(App));
    });

    expect(container.innerHTML).toContain("Adam:");
    expect(container.innerHTML).toContain("test response");
    document.body.removeChild(container);
  });

  it("uses reasoning events as fallback when result is empty", async () => {
    mockState.activeTaskId = "task-reasoning-1";
    mockUseTaskStream.mockReturnValue({
      events: [
        { type: "reasoning" as const, content: "reasoning text", timestamp: Date.now() },
        { type: "complete" as const, content: "", timestamp: Date.now() },
      ],
      isStreaming: false,
      clearEvents: vi.fn(),
    });

    const container = document.createElement("div");
    document.body.appendChild(container);
    await act(async () => {
      createRoot(container).render(React.createElement(App));
    });

    expect(container.innerHTML).toContain("Adam:");
    expect(container.innerHTML).toContain("reasoning text");
    document.body.removeChild(container);
  });

  it("handles /new command: archives and creates new session", async () => {
    mockArchiveCurrentSession.mockResolvedValue(true);
    mockCreateNewSession.mockResolvedValue({ id: "new-session-id-xxxx", status: "active", messageCount: 0, createdAt: Date.now(), lastActiveAt: Date.now() });
    renderToStaticMarkup(React.createElement(App));
    await capturedOnSubmit!("/new");
    expect(mockArchiveCurrentSession).toHaveBeenCalled();
    expect(mockCreateNewSession).toHaveBeenCalled();
  });

  it("handles /session command: shows session info", async () => {
    renderToStaticMarkup(React.createElement(App));
    await capturedOnSubmit!("/session");
    // Verify dispatch was not called with SET_VIEW (it's not a view command)
    expect(mockDispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: "SET_VIEW" }));
  });
});
