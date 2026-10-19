import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { serverBus } from "../../server/events/server-bus.js";
import { listTasks } from "../../store/tasks.js";
import { getRuntimeConfig } from "../../config/runtime.js";

vi.mock("../../server/events/server-bus.js", () => ({
  serverBus: {
    emit: vi.fn(),
    on: vi.fn(),
  },
}));

vi.mock("../../store/tasks.js", () => ({
  listTasks: vi.fn().mockImplementation((status?: string) => {
    if (status === "pending") return [...sharedTaskList];
    return [];
  }),
  getTotalCostSince: vi.fn().mockReturnValue(0),
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


// --- Mock executor passed directly via constructor ---
const DEFAULT_RESULT = {
  taskId: "task-default",
  status: "completed" as const,
  result: "Done",
  durationMs: 100,
};

const mockExecute = vi.fn<(task: unknown, signal?: unknown) => Promise<typeof DEFAULT_RESULT>>();
const mockExecutor = { execute: mockExecute };

import { ExecutionPool } from "../../manager/execution-pool.js";

// Shared mutable task list used by the listTasks mock factory.
const sharedTaskList: Array<{
  id: string;
  status: string;
  prompt: string;
  config: Record<string, unknown>;
  createdAt: number;
}> = [];

beforeEach(() => {
  sharedTaskList.length = 0;
  vi.clearAllMocks();
  mockExecute.mockReset();
  mockExecute.mockResolvedValue(DEFAULT_RESULT);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ExecutionPool", () => {
  describe("constructor", () => {
    it("creates N slots for the given maxConcurrent", () => {
      const pool = new ExecutionPool(5, mockExecutor);
      const status = pool.getStatus();
      expect(status.max).toBe(5);
    });

    it("defaults queued and active counts to 0 when no tasks exist", () => {
      const pool = new ExecutionPool(2, mockExecutor);
      const status = pool.getStatus();
      expect(status.queued).toBe(0);
      expect(status.active).toBe(0);
    });
  });

  describe("start", () => {
    it("subscribes to task_created event", async () => {
      const pool = new ExecutionPool(2, mockExecutor);
      await pool.start();

      expect(serverBus.on).toHaveBeenCalledWith(
        "task_created",
        expect.any(Function),
      );
      pool.stop();
    });

    it("subscribes to task_status_change event", async () => {
      const pool = new ExecutionPool(2, mockExecutor);
      await pool.start();

      expect(serverBus.on).toHaveBeenCalledWith(
        "task_status_change",
        expect.any(Function),
      );
      pool.stop();
    });

    it("sets running to true", async () => {
      const pool = new ExecutionPool(2, mockExecutor);
      expect(pool.isHealthy()).toBe(false);
      await pool.start();
      expect(pool.isHealthy()).toBe(true);
      pool.stop();
    });
  });

  describe("stop", () => {
    it("sets running to false", async () => {
      const pool = new ExecutionPool(2, mockExecutor);
      await pool.start();
      pool.stop();
      expect(pool.isHealthy()).toBe(false);
    });

    it("aborts in-flight tasks", async () => {
      const pool = new ExecutionPool(2, mockExecutor);
      await pool.start();

      const slot0 = (pool as unknown as {
        slots: Array<{
          index: number;
          taskId: string | null;
          abortController: AbortController | null;
        }>;
      }).slots[0];
      slot0.taskId = "task-running";
      slot0.abortController = new AbortController();
      const abortSpy = vi.spyOn(slot0.abortController, "abort");

      pool.stop();

      expect(abortSpy).toHaveBeenCalled();
    });
  });

  describe("getStatus", () => {
    it("returns correct active/max/queued counts", () => {
      sharedTaskList.push(
        { id: "p1", status: "pending", prompt: "", config: {}, createdAt: 1 },
        { id: "p2", status: "pending", prompt: "", config: {}, createdAt: 2 },
      );

      const pool = new ExecutionPool(3, mockExecutor);
      const status = pool.getStatus();

      expect(status.max).toBe(3);
      expect(status.active).toBe(0);
      expect(status.queued).toBe(2);
    });

    it("reflects claimed slots in active count", () => {
      const pool = new ExecutionPool(2, mockExecutor);
      (pool as unknown as {
        slots: Array<{ index: number; taskId: string | null }>;
      }).slots[0].taskId = "task-claimed";

      const status = pool.getStatus();
      expect(status.active).toBe(1);
      expect(status.max).toBe(2);
    });
  });

  describe("isHealthy", () => {
    it("returns false before start, true after start", async () => {
      const pool = new ExecutionPool(1, mockExecutor);
      expect(pool.isHealthy()).toBe(false);
      await pool.start();
      expect(pool.isHealthy()).toBe(true);
      pool.stop();
    });
  });

  describe("event-driven task pickup", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it("respects maxConcurrent: skips pickup when all slots are full", async () => {
      const pool = new ExecutionPool(2, mockExecutor);
      await pool.start();

      const slots = pool as unknown as {
        slots: Array<{
          index: number;
          taskId: string | null;
          abortController: AbortController | null;
        }>;
      };
      slots.slots[0].taskId = "task-running-1";
      slots.slots[0].abortController = new AbortController();
      slots.slots[1].taskId = "task-running-2";
      slots.slots[1].abortController = new AbortController();

      sharedTaskList.push({
        id: "p1",
        status: "pending",
        prompt: "Task",
        config: {},
        createdAt: Date.now(),
      });

      const pickupPendingTasks = pool as unknown as {
        pickupPendingTasks: () => Promise<void>;
      };
      await pickupPendingTasks.pickupPendingTasks();

      expect(mockExecute).not.toHaveBeenCalled();
      pool.stop();
    });

    it("picks up oldest pending task first (FIFO)", async () => {
      sharedTaskList.push(
        { id: "task-newer", status: "pending", prompt: "Newer", config: {}, createdAt: 200 },
        { id: "task-older", status: "pending", prompt: "Older", config: {}, createdAt: 100 },
      );

      const pool = new ExecutionPool(1, mockExecutor);
      await pool.start();

      const pickupPendingTasks = pool as unknown as {
        pickupPendingTasks: () => Promise<void>;
      };
      await pickupPendingTasks.pickupPendingTasks();

      expect(mockExecute).toHaveBeenCalledWith(
        expect.objectContaining({ id: "task-older" }),
        expect.anything(),
      );
    });

    it("dispatches pending task to ExecutionManager", async () => {
      sharedTaskList.push({
        id: "task-pickup",
        status: "pending",
        prompt: "Task pickup",
        config: {},
        createdAt: Date.now(),
      });

      const pool = new ExecutionPool(1, mockExecutor);
      await pool.start();

      const pickupPendingTasks = pool as unknown as {
        pickupPendingTasks: () => Promise<void>;
      };
      await pickupPendingTasks.pickupPendingTasks();

      expect(mockExecute).toHaveBeenCalledWith(
        expect.objectContaining({ id: "task-pickup" }),
        expect.anything(),
      );
    });
  });

  describe("emitSlotChange", () => {
    it("emits execution_slot_change with active/max/queued counts", () => {
      sharedTaskList.push({
        id: "q1",
        status: "pending",
        prompt: "",
        config: {},
        createdAt: 1,
      });

      const pool = new ExecutionPool(3, mockExecutor);
      (pool as unknown as {
        slots: Array<{ index: number; taskId: string | null }>;
      }).slots[0].taskId = "task-1";

      const emitSlotChange = pool as unknown as { emitSlotChange: () => void };
      emitSlotChange.emitSlotChange();

      expect(serverBus.emit).toHaveBeenCalledWith({
        type: "execution_slot_change",
        active: 1,
        max: 3,
        queued: 1,
      });
    });
  });

});
