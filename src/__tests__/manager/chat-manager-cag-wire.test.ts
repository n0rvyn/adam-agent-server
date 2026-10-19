/**
 * Unit test for ChatManager CAG wire-up (Task 3 isolated coverage).
 *
 * Tests that runQuery (via the extracted buildChatManagerPrompt helper) correctly:
 * - Passes role-chat-manager.cagPrompt to buildChatSystemPrompt as storedCagPrompt
 * - Passes undefined when role-chat-manager has no cagPrompt
 * - Passes undefined when role-chat-manager does not exist (defensive)
 * - Calls getRole with CHAT_MANAGER_ROLE_ID ("role-chat-manager")
 *
 * Critical: Does NOT call chatManager.start() — avoids setInterval + event-bus leaks.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---- vi.hoisted: creates variables accessible inside hoisted vi.mock factories ----
const { mockGetRole, mockBuildChatSystemPrompt } = vi.hoisted(() => ({
  mockGetRole: vi.fn(),
  mockBuildChatSystemPrompt: vi.fn(
    (_arg: { currentTime: number; storedCagPrompt?: string }) => "MOCKED_PROMPT"
  ),
}));

// ---- Mock modules BEFORE importing ChatManager ----
vi.mock("../../store/roles.js", () => ({
  getRole: mockGetRole,
}));

vi.mock("../../manager/chat-system-prompt.js", () => ({
  buildChatSystemPrompt: mockBuildChatSystemPrompt,
}));

// ---- Mock SDK: query returns an empty async iterator ----
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(() => ({
    [Symbol.asyncIterator]: async function*() {},
  })),
}));

// ---- Mock other ChatManager dependencies to avoid instantiation errors ----
vi.mock("../../lib/logger.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  }),
}));

vi.mock("../../store/server-state.js", () => ({
  getServerState: vi.fn().mockReturnValue({ sdkSessionId: undefined, userTaskSessionId: undefined }),
}));

vi.mock("../server/events/server-bus.js", () => ({
  serverBus: {
    on: vi.fn(),
    emit: vi.fn(),
    off: vi.fn(),
  },
}));

vi.mock("../../store/goals.js", () => ({
  getGoal: vi.fn(),
  updateGoal: vi.fn(),
}));

vi.mock("../../store/tasks.js", () => ({
  getTask: vi.fn(),
  updateTask: vi.fn(),
  listTasksByParent: vi.fn(),
  getTaskTraceId: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../chat/session-manager.js", () => ({
  createSession: vi.fn(),
  getSession: vi.fn(),
  updateSessionActivity: vi.fn(),
}));

vi.mock("../../chat/context-builder.js", () => ({
  buildSessionContext: vi.fn().mockResolvedValue(""),
}));

vi.mock("../../delivery/outbound-gateway.js", () => ({
  getOutboundGateway: vi.fn(() => ({ redeliverExecutionTo: vi.fn().mockResolvedValue(undefined), deliver: vi.fn(), queue: vi.fn() })),
}));

vi.mock("../../config/runtime.js", () => ({
  buildSdkEnv: vi.fn(() => ({})),
  getRuntimeConfig: vi.fn(() => ({
    defaults: { maxBudgetUsd: 5 },
    anthropic: {},
  })),
}));

vi.mock("../../manager/adam-tools.js", () => ({
  createAdamTools: vi.fn(() => ({
    getTools: vi.fn(() => []),
    callTool: vi.fn(),
  })),
}));

// ---- Import ChatManager AFTER mocks ----
import { ChatManager } from "../../manager/chat-manager.js";

describe("chat-manager-cag-wire: ChatManager CAG passthrough", () => {

  beforeEach(() => {
    vi.clearAllMocks();
    mockBuildChatSystemPrompt.mockReturnValue("MOCKED_PROMPT");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("buildChatManagerPrompt", () => {

    it("passes role-chat-manager.cagPrompt to buildChatSystemPrompt as storedCagPrompt", () => {
      mockGetRole.mockReturnValue({
        id: "role-chat-manager",
        name: "chat-manager",
        cagPrompt: "TEST_CAG_VALUE",
      });

      const cm = new ChatManager();
      cm.buildChatManagerPrompt();

      expect(mockBuildChatSystemPrompt).toHaveBeenCalledTimes(1);
      const callArg = mockBuildChatSystemPrompt.mock.calls[0]![0] as unknown as { storedCagPrompt?: string };
      expect(callArg.storedCagPrompt).toBe("TEST_CAG_VALUE");
    });

    it("passes undefined storedCagPrompt when role-chat-manager has no cagPrompt", () => {
      mockGetRole.mockReturnValue({
        id: "role-chat-manager",
        name: "chat-manager",
        cagPrompt: undefined,
      });

      const cm = new ChatManager();
      cm.buildChatManagerPrompt();

      const callArg = mockBuildChatSystemPrompt.mock.calls[0]![0] as unknown as { storedCagPrompt?: string };
      expect(callArg.storedCagPrompt).toBeUndefined();
    });

    it("passes undefined storedCagPrompt when role-chat-manager does not exist (defensive)", () => {
      mockGetRole.mockReturnValue(undefined);

      const cm = new ChatManager();
      cm.buildChatManagerPrompt();

      const callArg = mockBuildChatSystemPrompt.mock.calls[0]![0] as unknown as { storedCagPrompt?: string };
      expect(callArg.storedCagPrompt).toBeUndefined();
    });

    it("calls getRole with CHAT_MANAGER_ROLE_ID", () => {
      mockGetRole.mockReturnValue({
        id: "role-chat-manager",
        name: "chat-manager",
        cagPrompt: "CM_CAG",
      });

      const cm = new ChatManager();
      cm.buildChatManagerPrompt();

      expect(mockGetRole).toHaveBeenCalledTimes(1);
      expect(mockGetRole.mock.calls[0]).toEqual(["role-chat-manager"]);
    });

  });
});
