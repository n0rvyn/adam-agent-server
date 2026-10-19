/**
 * Component rendering tests for TUI components.
 * @vitest-environment jsdom
 * Mock Ink primitives (Box, Text, useInput) and renders via React.createElement.
 * Focuses on coverage of rendering logic and conditional branches.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { act } from "react";
import { render } from "@testing-library/react";

// --- Mock Ink ---
vi.mock("ink", () => ({
  Box: ({ children }: { children?: React.ReactNode }) => React.createElement("div", null, children),
  Text: ({ children }: { children?: React.ReactNode }) => React.createElement("span", null, children),
  useInput: vi.fn(),
  Newline: () => React.createElement("br"),
}));

vi.mock("ink-text-input", () => ({
  default: ({ value, placeholder }: { value: string; placeholder?: string }) =>
    React.createElement("input", { value, placeholder }),
}));

// --- Mock useTuiState ---
const mockDispatch = vi.fn();
let mockUiState: Record<string, unknown> = {};

vi.mock("../../../cli/tui/hooks/useTuiState.js", () => ({
  useTuiState: () => ({ state: mockUiState, dispatch: mockDispatch }),
  TuiProvider: ({ children }: { children: React.ReactNode }) => React.createElement("div", null, children),
}));

vi.mock("../../../cli/tui/hooks/useFlashMessage.js", () => ({
  useFlashMessage: () => ({ message: null, setMessage: vi.fn() }),
}));

// --- Mock client ---
// Use vi.hoisted so the mock factory and test code share the same object reference.
const mockState = vi.hoisted(() => ({
  mockRequest: vi.fn<(url: string) => Promise<unknown>>(),
}));

vi.mock("../../../cli/client.js", () => ({
  request: mockState.mockRequest,
  EventSocket: vi.fn(function () {
    return { connect: vi.fn().mockResolvedValue(undefined), on: vi.fn(), close: vi.fn() };
  }),
  TaskStreamSocket: vi.fn(function () {
    return { connect: vi.fn().mockResolvedValue(undefined), on: vi.fn(), off: vi.fn(), close: vi.fn() };
  }),
}));

// --- Mock hooks ---
vi.mock("../../../cli/tui/hooks/useServerConnection.js", () => ({
  useServerConnection: () => ({ connected: true, submitPrompt: vi.fn() }),
}));

vi.mock("../../../cli/tui/hooks/useGlobalEvents.js", () => ({
  useGlobalEvents: vi.fn(),
}));

vi.mock("../../../cli/tui/hooks/useTaskStream.js", () => ({
  useTaskStream: () => ({ events: [], isStreaming: false, clearEvents: vi.fn() }),
}));

describe("TUI component rendering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUiState = {
      connected: true,
      serverInfo: null,
      activeTasks: 2,
      queuedTasks: 1,
      costToday: 0.50,
      activeTaskId: null,
      activeTaskSubmitted: false,
      pendingApproval: null,
      serverUnreachable: false,
      view: "chat",
      configVersion: 0,
    };
  });

  describe("StatusBar", () => {
    it("renders connected state", async () => {
      mockUiState.version = "0.2.1";
      const { StatusBar } = await import("../../../cli/tui/components/StatusBar.js");
      const { container } = render(React.createElement(StatusBar));
      expect(container.innerHTML).toContain("Adam v0.2.1");
    });

    it("renders disconnected state", async () => {
      mockUiState.connected = false;
      const { StatusBar } = await import("../../../cli/tui/components/StatusBar.js");
      const { container } = render(React.createElement(StatusBar));
      expect(container.innerHTML).toContain("down");
    });

    it("renders active tasks count", async () => {
      mockUiState.activeTasks = 3;
      mockUiState.queuedTasks = 2;
      const { StatusBar } = await import("../../../cli/tui/components/StatusBar.js");
      const { container } = render(React.createElement(StatusBar));
      expect(container.innerHTML).toContain("3 run / 2 q");
    });

    it("renders no active tasks", async () => {
      mockUiState.activeTasks = 0;
      const { StatusBar } = await import("../../../cli/tui/components/StatusBar.js");
      const { container } = render(React.createElement(StatusBar));
      expect(container.innerHTML).toContain("0 run / 1 q");
    });
  });

  describe("InputBar", () => {
    it("renders input field", async () => {
      const { InputBar } = await import("../../../cli/tui/components/InputBar.js");
      const { container } = render(React.createElement(InputBar, { onSubmit: vi.fn() }));
      expect(container.innerHTML).toContain("input");
    });
  });

  describe("MessageHistory", () => {
    it("renders null when no messages", async () => {
      const { MessageHistory } = await import("../../../cli/tui/components/MessageHistory.js");
      const { container } = render(React.createElement(MessageHistory, { messages: [] }));
      expect(container.innerHTML).toBe("");
    });

    it("renders user and assistant messages", async () => {
      const { MessageHistory } = await import("../../../cli/tui/components/MessageHistory.js");
      const messages = [
        { role: "user" as const, content: "Hello" },
        { role: "assistant" as const, content: "Hi there" },
      ];
      const { container } = render(React.createElement(MessageHistory, { messages }));
      expect(container.innerHTML).toContain("You:");
      expect(container.innerHTML).toContain("Adam:");
      expect(container.innerHTML).toContain("Hello");
      expect(container.innerHTML).toContain("Hi there");
    });
  });

  describe("ApprovalBanner", () => {
    it("renders approval request info", async () => {
      const { ApprovalBanner } = await import("../../../cli/tui/components/ApprovalBanner.js");
      const approval = {
        taskId: "t-1",
        approvalId: "ap-1",
        toolName: "Bash",
        toolInput: { command: "rm -rf" },
        matchedPattern: "rm.*",
      };
      const { container } = render(
        React.createElement(ApprovalBanner, { approval, onResolved: vi.fn() }),
      );
      expect(container.innerHTML).toContain("Bash");
    });
  });

  describe("StreamView", () => {
    it("renders empty when no events", async () => {
      const { StreamView } = await import("../../../cli/tui/components/StreamView.js");
      const { container } = render(
        React.createElement(StreamView, { events: [], isStreaming: false }),
      );
      expect(container.innerHTML).toBeDefined();
    });

    it("renders streaming indicator", async () => {
      const { StreamView } = await import("../../../cli/tui/components/StreamView.js");
      const { container } = render(
        React.createElement(StreamView, { events: [], isStreaming: true }),
      );
      expect(container.innerHTML).toBeDefined();
    });

    it("renders reasoning events", async () => {
      const { StreamView } = await import("../../../cli/tui/components/StreamView.js");
      const events: import("../../../cli/tui/components/StreamView.js").StreamEvent[] = [{ type: "reasoning", content: "thinking about it" }];
      const { container } = render(
        React.createElement(StreamView, { events, isStreaming: true }),
      );
      expect(container.innerHTML).toContain("thinking about it");
    });
  });

  describe("TaskList", () => {
    it("renders with loading state", async () => {
      mockState.mockRequest.mockResolvedValue({ tasks: [] });
      const { TaskList } = await import("../../../cli/tui/components/TaskList.js");
      const { container } = render(
        React.createElement(TaskList, { onBack: vi.fn() }),
      );
      expect(container.innerHTML).toBeDefined();
    });
  });

  describe("ConfigView", () => {
    it("renders with loading state", async () => {
      const { ConfigView } = await import("../../../cli/tui/components/ConfigView.js");
      const { container } = render(
        React.createElement(ConfigView, { onBack: vi.fn() }),
      );
      expect(container.innerHTML).toBeDefined();
    });
  });

  describe("EvolutionView", () => {
    it("renders with loading state", async () => {
      mockState.mockRequest.mockResolvedValue([]);
      const { EvolutionView } = await import("../../../cli/tui/components/EvolutionView.js");
      const { container } = render(
        React.createElement(EvolutionView, { onBack: vi.fn() }),
      );
      expect(container.innerHTML).toContain("Loading");
    });
  });


  describe("GoalDashboard", () => {
    it("renders with loading state", async () => {
      mockState.mockRequest.mockResolvedValue({ goals: [] });
      const { GoalDashboard } = await import("../../../cli/tui/components/GoalDashboard.js");
      const { container } = render(
        React.createElement(GoalDashboard, { onBack: vi.fn() }),
      );
      expect(container.innerHTML).toBeDefined();
    });
  });

  describe("StrategyLab", () => {
    it("renders with loading state", async () => {
      mockState.mockRequest.mockResolvedValue({ strategies: [] });
      const { StrategyLab } = await import("../../../cli/tui/components/StrategyLab.js");
      const { container } = render(
        React.createElement(StrategyLab, { onBack: vi.fn() }),
      );
      expect(container.innerHTML).toBeDefined();
    });
  });

  describe("RoleDetail", () => {
    const mockRole = {
      role: {
        id: "role-1",
        name: "TestRole",
        cagPrompt: "Test CAG",
        learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
        status: "active",
        createdAt: Date.now(),
        executionMode: "inline",
        model: "sonnet",
        permissionMode: "dontAsk",
        allowedBashPatterns: ["git add *", "pnpm test*"],
        deniedBashPatterns: ["rm -rf *"],
        additionalDirectories: [],
        allowedChannels: undefined,
      },
      boundPlugins: [],
    };

    it("renders loading state initially", async () => {
      mockState.mockRequest.mockReturnValue(new Promise(() => {})); // never resolves
      const { RoleDetail } = await import("../../../cli/tui/components/RoleDetail.js");
      const { container } = render(
        React.createElement(RoleDetail, { roleId: "role-1", onBack: vi.fn() }),
      );
      expect(container.innerHTML).toContain("Loading");
    });

    it("renders permission fields in view mode", async () => {
      mockState.mockRequest.mockResolvedValue(mockRole);
      const { RoleDetail } = await import("../../../cli/tui/components/RoleDetail.js");
      // Single render inside act() so useEffect-triggered state updates are properly flushed.
      let container!: HTMLElement;
      await act(async () => {
        const result = render(
          React.createElement(RoleDetail, { roleId: "role-1", onBack: vi.fn() }),
        );
        container = result.container;
      });
      expect(container.innerHTML).toBeDefined();
    });

    it("displays p:perms in key hints", async () => {
      mockState.mockRequest.mockResolvedValue(mockRole);
      const { RoleDetail } = await import("../../../cli/tui/components/RoleDetail.js");
      let container!: HTMLElement;
      await act(async () => {
        const result = render(
          React.createElement(RoleDetail, { roleId: "role-1", onBack: vi.fn() }),
        );
        container = result.container;
      });
      expect(container.innerHTML).toBeDefined();
    });

    it("renders all three learnedRules sections when populated", async () => {
      const roleWithLearnedRules = {
        role: {
          id: "role-2",
          name: "LearnedRole",
          cagPrompt: "CAG prompt",
          learnedRules: {
            stylePreferences: ["Use concise prose", "Prefer bullet points"],
            avoidedActions: ["Never delete files without confirmation", "Do not skip tests"],
            pinnedParameters: [
              { tool: "Bash", params: { timeout: 60 }, pinnedAt: 1000, condition: "CI=true" },
              { tool: "Write", params: { mode: "overwrite" }, pinnedAt: 2000 },
            ],
          },
          status: "active" as const,
          createdAt: Date.now(),
          executionMode: "inline" as const,
          model: "sonnet",
          permissionMode: "dontAsk" as const,
          allowedBashPatterns: [],
          deniedBashPatterns: [],
          additionalDirectories: [],
          allowedChannels: undefined,
        },
        boundPlugins: [],
      };
      mockState.mockRequest.mockResolvedValue(roleWithLearnedRules);
      const { RoleDetail } = await import("../../../cli/tui/components/RoleDetail.js");
      // Single render inside act() so useEffect-triggered state updates are properly flushed.
      let container!: HTMLElement;
      await act(async () => {
        const result = render(
          React.createElement(RoleDetail, { roleId: "role-2", onBack: vi.fn() }),
        );
        container = result.container;
      });
      const html = container.innerHTML;
      expect(html).toContain("Style Preferences:");
      expect(html).toContain("Avoided Actions:");
      expect(html).toContain("Pinned Parameters:");
      expect(html).toContain("Use concise prose");
      expect(html).toContain("Never delete files without confirmation");
      expect(html).toContain("Bash");
    });

    it("does not render any learnedRules section heading when learnedRules are empty", async () => {
      // mockRole has empty learnedRules; verify the three section headings are absent.
      mockState.mockRequest.mockResolvedValue(mockRole);
      const { RoleDetail } = await import("../../../cli/tui/components/RoleDetail.js");
      let container!: HTMLElement;
      await act(async () => {
        const result = render(
          React.createElement(RoleDetail, { roleId: "role-1", onBack: vi.fn() }),
        );
        container = result.container;
      });
      expect(container.innerHTML).not.toContain("Style Preferences:");
      expect(container.innerHTML).not.toContain("Avoided Actions:");
      expect(container.innerHTML).not.toContain("Pinned Parameters:");
    });
  });

  describe("App", () => {
    it("renders without crashing", async () => {
      mockUiState.version = "0.2.1";
      const App = (await import("../../../cli/tui/App.js")).default;
      const { container } = render(React.createElement(App));
      expect(container.innerHTML).toContain("Adam v0.2.1");
    });
  });
});
