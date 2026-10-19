import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

import { waitForTaskCompletion } from "../../scheduler/wait-for-task.js";
import { createTask, getTask } from "../../store/tasks.js";
import { serverBus } from "../../server/events/server-bus.js";
import type { Task } from "../../shared/types.js";

afterAll(() => cleanup());

beforeEach(() => {
  clearTestDb();
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000_000);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  const now = Date.now();
  const { id, ...rest } = overrides;
  return {
    id,
    status: "running",
    prompt: "run",
    config: { timeout: 1200, approvalRequired: [], approvalTimeout: 300 },
    createdAt: now,
    startedAt: now,
    ...rest,
  };
}

function insertLog(taskId: string, timestamp: number): void {
  getTestDb().prepare(`
    INSERT INTO step_logs (id, task_id, "index", type, content, timestamp)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(`log-${taskId}-${timestamp}`, taskId, 0, "reasoning", "still working", timestamp);
}

describe("waitForTaskCompletion", () => {
  it("keeps waiting when wall-clock runtime exceeds timeout but step logs are recent", async () => {
    const now = Date.now();
    createTask(makeTask({
      id: "active-task",
      createdAt: now - 25 * 60_000,
      startedAt: now - 25 * 60_000,
    }));
    insertLog("active-task", now - 2 * 60_000);

    let settled = false;
    const promise = waitForTaskCompletion("active-task", 20 * 60_000, 1000).then((status) => {
      settled = true;
      return status;
    });

    await vi.advanceTimersByTimeAsync(1100);

    expect(settled).toBe(false);
    expect(getTask("active-task")?.status).toBe("running");

    serverBus.emit({ type: "task_status_change", taskId: "active-task", oldStatus: "running", newStatus: "completed" });
    await expect(promise).resolves.toBe("completed");
  });

  it("fails and requests abort when no activity exceeds the inactivity timeout", async () => {
    const now = Date.now();
    createTask(makeTask({
      id: "stale-task",
      createdAt: now - 25 * 60_000,
      startedAt: now - 25 * 60_000,
    }));
    const emitSpy = vi.spyOn(serverBus, "emit");

    const promise = waitForTaskCompletion("stale-task", 20 * 60_000, 1000);
    await vi.advanceTimersByTimeAsync(100);

    await expect(promise).resolves.toBe("failed");
    const task = getTask("stale-task");
    expect(task?.status).toBe("failed");
    expect(task?.errorCategory).toBe("TIMEOUT");
    expect(emitSpy).toHaveBeenCalledWith({
      type: "task_abort_requested",
      taskId: "stale-task",
      reason: "inactivity_timeout",
    });
  });

  it("resolves terminal status from task_status_change before polling timeout", async () => {
    const now = Date.now();
    createTask(makeTask({
      id: "event-task",
      createdAt: now,
      startedAt: now,
    }));

    const promise = waitForTaskCompletion("event-task", 20 * 60_000, 1000);
    serverBus.emit({ type: "task_status_change", taskId: "event-task", oldStatus: "running", newStatus: "cancelled" });

    await expect(promise).resolves.toBe("cancelled");
  });

  it("resolves failed when task row is missing", async () => {
    const promise = waitForTaskCompletion("missing-task", 20 * 60_000, 1000);

    await vi.advanceTimersByTimeAsync(100);

    await expect(promise).resolves.toBe("failed");
  });
});
