/**
 * Tests for task terminal → immediate-expire of open pending prompts (Task 12):
 * When a task transitions to completed/failed/blocked/cancelled, all open
 * pending_prompts linked to that task are expired with reason="task_terminated".
 *
 * Companion test: prompt-expiry.test.ts covers the sweep function in isolation.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";
import { ChatManager } from "../../manager/chat-manager.js";
import { createPendingPrompt, getPendingPrompt, listOpenPromptsByTask } from "../../store/pending-prompts.js";

// ---------------------------------------------------------------------------
// Mock: store/db — use test DB singleton
// ---------------------------------------------------------------------------
vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

// ---------------------------------------------------------------------------
// Mock: serverBus — capture handlers and support synchronous emit
// ---------------------------------------------------------------------------
const busHandlers = new Map<string, Array<(data: Record<string, unknown>) => void>>();

vi.mock("../../server/events/server-bus.js", () => ({
  serverBus: {
    emit: vi.fn((event: Record<string, unknown>) => {
      const handlers = busHandlers.get(event.type as string);
      if (handlers) handlers.forEach((h) => h(event));
    }),
    on: vi.fn((event: string, handler: (data: Record<string, unknown>) => void) => {
      if (!busHandlers.has(event)) busHandlers.set(event, []);
      busHandlers.get(event)!.push(handler);
    }),
  },
}));

// ---------------------------------------------------------------------------
// Mock: SDK
// ---------------------------------------------------------------------------
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(() => ({
    [Symbol.asyncIterator]: async function* () {
      yield { type: "result", result: "ok" };
    },
  })),
}));

vi.mock("../../manager/adam-tools.js", () => ({
  createAdamTools: vi.fn(() => ({})),
}));

vi.mock("../../manager/hooks.js", () => ({
  buildSessionHooks: vi.fn(() => ({})),
  buildCanUseTool: vi.fn(() => () => true),
}));

vi.mock("../../store/server-state.js", () => ({
  getServerState: vi.fn().mockReturnValue({ userTaskSessionId: undefined }),
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

const { cleanup } = setupTestDb();

afterAll(() => cleanup());

describe("task terminal → immediate-expire (Task 12)", () => {
  beforeAll(() => {
    clearTestDb();
  });

  afterAll(() => {
    busHandlers.clear();
  });

  beforeEach(async () => {
    clearTestDb();
    busHandlers.clear();
  });

  // =======================================================================
  // Helper: create ChatManager and trigger task_status_change
  // =======================================================================
  async function triggerTaskTerminal(taskId: string, newStatus: string) {
    const cm = new ChatManager();
    await cm.start();

    // Find the terminal-status listener registered by the constructor
    const terminalHandlers = busHandlers.get("task_status_change");
    expect(terminalHandlers).toBeDefined();
    expect(terminalHandlers!.length).toBeGreaterThan(0);

    // Call the terminal handler directly (synchronously — the listener calls handleTaskTerminalForPrompts)
    // We need to wait for the async handler to complete
    const handler = terminalHandlers![terminalHandlers!.length - 1]; // last registered = terminal-status handler
    const wait = handler({ taskId, oldStatus: "running", newStatus } as Record<string, unknown>);
    await wait; // handler returns Promise<void>
    cm.stop();
  }

  // =======================================================================
  // Test: completed → expires open prompts
  // =======================================================================
  it("expires open prompts linked to a completed task", async () => {
    const taskId = "T-COMPLETED";

    // Create two open pending_prompts for this task
    createPendingPrompt({
      id: "PROMPT-TC-1",
      sessionId: "s-terminal",
      messageId: "msg-tc1",
      taskId,
      shape: "yes_no",
      askedAt: Date.now() - 60_000,
      expiresAt: Date.now() + 3_600_000,
    });
    createPendingPrompt({
      id: "PROMPT-TC-2",
      sessionId: "s-terminal",
      messageId: "msg-tc2",
      taskId,
      shape: "yes_no",
      askedAt: Date.now() - 60_000,
      expiresAt: Date.now() + 3_600_000,
    });

    // Verify both are open
    expect(listOpenPromptsByTask(taskId)).toHaveLength(2);

    await triggerTaskTerminal(taskId, "completed");

    // Both should be expired with task_terminated
    const p1 = getPendingPrompt("PROMPT-TC-1");
    expect(p1?.expiredReason).toBe("task_terminated");

    const p2 = getPendingPrompt("PROMPT-TC-2");
    expect(p2?.expiredReason).toBe("task_terminated");
  });

  // =======================================================================
  // Test: failed → expires open prompts
  // =======================================================================
  it("expires open prompts linked to a failed task", async () => {
    const taskId = "T-FAILED";

    createPendingPrompt({
      id: "PROMPT-TF",
      sessionId: "s-failed",
      messageId: "msg-tf",
      taskId,
      shape: "yes_no",
      askedAt: Date.now() - 60_000,
      expiresAt: Date.now() + 3_600_000,
    });

    expect(listOpenPromptsByTask(taskId)).toHaveLength(1);
    await triggerTaskTerminal(taskId, "failed");

    const p = getPendingPrompt("PROMPT-TF");
    expect(p?.expiredReason).toBe("task_terminated");
  });

  // =======================================================================
  // Test: blocked → expires open prompts
  // =======================================================================
  it("expires open prompts linked to a blocked task", async () => {
    const taskId = "T-BLOCKED";

    createPendingPrompt({
      id: "PROMPT-TB",
      sessionId: "s-blocked",
      messageId: "msg-tb",
      taskId,
      shape: "yes_no",
      askedAt: Date.now() - 60_000,
      expiresAt: Date.now() + 3_600_000,
    });

    await triggerTaskTerminal(taskId, "blocked");

    const p = getPendingPrompt("PROMPT-TB");
    expect(p?.expiredReason).toBe("task_terminated");
  });

  // =======================================================================
  // Test: cancelled → expires open prompts
  // =======================================================================
  it("expires open prompts linked to a cancelled task", async () => {
    const taskId = "T-CANCELLED";

    createPendingPrompt({
      id: "PROMPT-TCAN",
      sessionId: "s-cancelled",
      messageId: "msg-tcan",
      taskId,
      shape: "yes_no",
      askedAt: Date.now() - 60_000,
      expiresAt: Date.now() + 3_600_000,
    });

    await triggerTaskTerminal(taskId, "cancelled");

    const p = getPendingPrompt("PROMPT-TCAN");
    expect(p?.expiredReason).toBe("task_terminated");
  });

  // =======================================================================
  // Test: running → does NOT expire (non-terminal)
  // =======================================================================
  it("does not expire prompts when task is running", async () => {
    const taskId = "T-RUNNING";

    createPendingPrompt({
      id: "PROMPT-TRUN",
      sessionId: "s-running",
      messageId: "msg-trun",
      taskId,
      shape: "yes_no",
      askedAt: Date.now() - 60_000,
      expiresAt: Date.now() + 3_600_000,
    });

    const cm = new ChatManager();
    await cm.start();

    const terminalHandlers = busHandlers.get("task_status_change");
    const handler = terminalHandlers![terminalHandlers!.length - 1];
    await handler({ taskId, oldStatus: "pending", newStatus: "running" } as Record<string, unknown>);

    cm.stop();

    const p = getPendingPrompt("PROMPT-TRUN");
    expect(p?.expiredReason).toBeUndefined();
    expect(p?.resolvedAt).toBeUndefined();
  });

  // =======================================================================
  // Test: task with no linked prompts → no-op (no error)
  // =======================================================================
  it("task with no linked prompts is a no-op", async () => {
    const taskId = "T-NO-PROMPTS";

    // No pending_prompts for this task
    await triggerTaskTerminal(taskId, "completed");

    // No assertion needed — just verify no exception thrown
    expect(true).toBe(true);
  });

  // =======================================================================
  // Test: all N prompts expire (transaction atomicity)
  // =======================================================================
  it("expires all N open prompts atomically when task terminates", async () => {
    const taskId = "T-ATOMIC";
    const count = 5;

    for (let i = 1; i <= count; i++) {
      createPendingPrompt({
        id: `PROMPT-ATOMIC-${i}`,
        sessionId: "s-atomic",
        messageId: `msg-atomic-${i}`,
        taskId,
        shape: "yes_no",
        askedAt: Date.now() - 60_000,
        expiresAt: Date.now() + 3_600_000,
      });
    }

    expect(listOpenPromptsByTask(taskId)).toHaveLength(count);
    await triggerTaskTerminal(taskId, "completed");

    for (let i = 1; i <= count; i++) {
      const p = getPendingPrompt(`PROMPT-ATOMIC-${i}`);
      expect(p?.expiredReason).toBe("task_terminated");
    }
  });
});
