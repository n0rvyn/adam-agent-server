/**
 * Unit tests for ExecutionPool.runPostCompletion
 *
 * Tests the three post-completion pipeline hooks:
 * - Pipeline B: processTaskCompletion (memory extraction + reflection)
 * - Pipeline C1: processTaskReview (deviation → rules → CLAUDE.md)
 * - Pipeline C2: evaluateTaskCompletion (scoring → EMA → retirement)
 *
 * Key: mock ONLY the 3 direct dynamic import targets. Do NOT mock transitive
 * deps (embedding, db, etc.) — vitest intercepts `await import()` at runtime
 * and never resolves the heavy dep chain.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Infrastructure mocks (same as execution-pool.test.ts)
vi.mock("../../server/events/server-bus.js", () => ({
  serverBus: { emit: vi.fn(), on: vi.fn() },
}));
vi.mock("../../store/tasks.js", () => ({
  listTasks: vi.fn().mockReturnValue([]),
  getTotalCostSince: vi.fn().mockReturnValue(0),
  getTaskTraceId: vi.fn().mockReturnValue(undefined),
}));
vi.mock("../../lib/time.js", () => ({
  getStartOfDayMs: vi.fn().mockReturnValue(0),
}));
vi.mock("../../config/runtime.js", () => ({
  buildSdkAuthEnv: vi.fn(() => ({})),
  buildSdkEnv: vi.fn(() => ({})),
  getRuntimeConfig: vi.fn().mockReturnValue({
    execution: { maxConcurrent: 3, pollIntervalMs: 10 },
  }),
}));
vi.mock("../../lib/logger.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock the 3 dynamic import targets (the core of this test)
const mockProcessTaskCompletion = vi.fn().mockResolvedValue(3);
const mockProcessTaskReview = vi.fn().mockResolvedValue(undefined);
const mockEvaluateTaskCompletion = vi.fn();

vi.mock("../../agent/memory-extractor.js", () => ({
  processTaskCompletion: (...args: unknown[]) => mockProcessTaskCompletion(...args),
}));
vi.mock("../../agent/learner.js", () => ({
  processTaskReview: (...args: unknown[]) => mockProcessTaskReview(...args),
}));
vi.mock("../../audit/audit-manager.js", () => ({
  evaluateTaskCompletion: (...args: unknown[]) => mockEvaluateTaskCompletion(...args),
}));

import { ExecutionPool } from "../../manager/execution-pool.js";
import { serverBus } from "../../server/events/server-bus.js";

// Access the private method via type cast
function getRunPostCompletion(pool: ExecutionPool) {
  return (pool as unknown as { runPostCompletion: (taskId: string, roleId?: string) => Promise<void> })
    .runPostCompletion.bind(pool);
}

describe("ExecutionPool.runPostCompletion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls all three post-completion functions with correct args", async () => {
    const pool = new ExecutionPool(1);
    const runPostCompletion = getRunPostCompletion(pool);

    await runPostCompletion("task-1", "role-1");

    expect(mockProcessTaskCompletion).toHaveBeenCalledWith("task-1", "role-1");
    expect(mockProcessTaskReview).toHaveBeenCalledWith("task-1");
    expect(mockEvaluateTaskCompletion).toHaveBeenCalledWith("task-1", "role-1");
  });

  it("skips all hooks when roleId is undefined", async () => {
    const pool = new ExecutionPool(1);
    const runPostCompletion = getRunPostCompletion(pool);

    await runPostCompletion("task-1", undefined);

    expect(mockProcessTaskCompletion).not.toHaveBeenCalled();
    expect(mockProcessTaskReview).not.toHaveBeenCalled();
    expect(mockEvaluateTaskCompletion).not.toHaveBeenCalled();
  });

  it("continues remaining hooks when one fails (failure isolation)", async () => {
    mockProcessTaskCompletion.mockRejectedValueOnce(new Error("memory extraction crashed"));

    const pool = new ExecutionPool(1);
    const runPostCompletion = getRunPostCompletion(pool);

    await runPostCompletion("task-1", "role-1");

    expect(mockProcessTaskCompletion).toHaveBeenCalledWith("task-1", "role-1");
    expect(mockProcessTaskReview).toHaveBeenCalledWith("task-1");
    expect(mockEvaluateTaskCompletion).toHaveBeenCalledWith("task-1", "role-1");
  });

  it("slot is freed before post-completion runs (ordering)", async () => {
    const callOrder: string[] = [];

    (serverBus.emit as ReturnType<typeof vi.fn>).mockImplementation((event: { type: string }) => {
      if (event.type === "execution_task_end") callOrder.push("slot_freed");
    });

    mockProcessTaskCompletion.mockImplementation(async () => {
      callOrder.push("post_completion_start");
      return 1;
    });

    const mockExecutor = {
      execute: vi.fn().mockResolvedValue({
        taskId: "task-order",
        status: "completed" as const,
        result: "done",
        durationMs: 10,
      }),
    };

    const { listTasks } = await import("../../store/tasks.js");
    (listTasks as ReturnType<typeof vi.fn>).mockReturnValueOnce([
      { id: "task-order", status: "pending", prompt: "test", config: {}, roleId: "role-1", createdAt: Date.now() },
    ]);

    const pool = new ExecutionPool(1, mockExecutor);
    await pool.start();

    const p = pool as unknown as { pickupPendingTasks: () => Promise<void> };
    await p.pickupPendingTasks();
    await new Promise((r) => setTimeout(r, 200));
    pool.stop();

    const slotIdx = callOrder.indexOf("slot_freed");
    const postIdx = callOrder.indexOf("post_completion_start");
    expect(slotIdx).toBeGreaterThanOrEqual(0);
    expect(postIdx).toBeGreaterThanOrEqual(0);
    expect(slotIdx).toBeLessThan(postIdx);
  });
});
