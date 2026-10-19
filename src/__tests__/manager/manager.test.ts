import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

// Mock the SDK query to avoid real API calls
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(() => ({
    [Symbol.asyncIterator]: async function* () {
      yield { type: "result", result: "Hello! How can I help you?" };
    },
  })),
}));

// Mock adam-tools MCP server and hooks
vi.mock("../../manager/adam-tools.js", () => ({
  createAdamTools: vi.fn(() => ({})),
}));

vi.mock("../../manager/hooks.js", () => ({
  buildSessionHooks: vi.fn(() => ({})),
  buildCanUseTool: vi.fn(() => () => true),
}));

vi.mock("../../agent/persona.js", () => ({
  writeRolePersona: vi.fn(),
  buildRoleSystemPrompt: vi.fn(() => "[Agent Identity]"),
}));

vi.mock("../../server/events/server-bus.js", () => ({
  serverBus: {
    emit: vi.fn(),
    on: vi.fn(),
  },
}));

vi.mock("../../store/server-state.js", () => ({
  getServerState: vi.fn().mockReturnValue({ userTaskSessionId: undefined }),
}));

vi.mock("../../agent/memory-service.js", () => ({
  getRelevantMemoryContext: vi.fn().mockResolvedValue(""),
}));

vi.mock("../../config/runtime.js", () => ({
  getRuntimeConfig: vi.fn().mockReturnValue({
    defaults: { maxBudgetUsd: 5.0 },
    execution: { maxConcurrent: 3, pollIntervalMs: 30_000 },
  }),
  buildSdkAuthEnv: vi.fn(() => ({})),
  buildSdkEnv: vi.fn(() => ({})),
}));

vi.mock("../../store/goals.js", () => ({
  listGoals: vi.fn().mockReturnValue([]),
}));

vi.mock("../../store/tasks.js", () => ({
  listTasks: vi.fn().mockReturnValue([]),
  getTaskTraceId: vi.fn().mockReturnValue(undefined),
}));

import { ChatManager } from "../../manager/chat-manager.js";

afterAll(() => cleanup());
beforeEach(() => clearTestDb());

describe("ChatManager", () => {
  it("should initialize without sessionId arg", () => {
    const chat = new ChatManager();
    expect(chat.isHealthy()).toBe(false); // not started yet
  });

  it("should set running = true after start", async () => {
    const chat = new ChatManager();
    await chat.start();
    expect(chat.isHealthy()).toBe(true);
    chat.stop();
  });

  it("should stop cleanly", async () => {
    const chat = new ChatManager();
    await chat.start();
    chat.stop();
    expect(chat.isHealthy()).toBe(false);
  });

  it("should not start twice", async () => {
    const chat = new ChatManager();
    await chat.start();
    await chat.start(); // second call should be no-op
    chat.stop();
  });

  it("should queue messages and process sequentially", async () => {
    const chat = new ChatManager();
    await chat.start();
    // Queue two messages and verify both are returned
    const res1 = await chat.handleMessage("first");
    const res2 = await chat.handleMessage("second");
    expect(res1).toBeDefined();
    expect(res2).toBeDefined();
    expect(typeof res1).toBe("string");
    expect(typeof res2).toBe("string");
    chat.stop();
  });

  it("should have healthy state when running", async () => {
    const chat = new ChatManager();
    expect(chat.isHealthy()).toBe(false);
    await chat.start();
    expect(chat.isHealthy()).toBe(true);
    chat.stop();
    expect(chat.isHealthy()).toBe(false);
  });

  it("does not increment stale count on restartSession (AR-2: decoupled from watchdog escalation)", async () => {
    // restartSession used to bump consecutiveStaleCount as the escalation signal. AR-2 moved
    // escalation to the watchdog's own managerRestartAttempts counter, so restartSession no
    // longer touches the stale count. It rebuilds the session and resolves without throwing.
    const chat = new ChatManager();
    await chat.start();
    const before = chat.getConsecutiveStaleCount();
    await expect(chat.restartSession()).resolves.toBeUndefined();
    expect(chat.getConsecutiveStaleCount()).toBe(before);
    chat.stop();
  });

  it("subscribes to task_complete_event via serverBus", async () => {
    const { serverBus } = await import("../../server/events/server-bus.js");
    vi.mocked(serverBus.on).mockClear();

    const chat = new ChatManager();
    await chat.start();

    expect(serverBus.on).toHaveBeenCalledWith("task_complete_event", expect.any(Function));
    chat.stop();
  });
});
