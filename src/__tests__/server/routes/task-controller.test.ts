import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../../helpers/test-db.js";

const { cleanup } = setupTestDb();
vi.mock("../../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

import { TaskController } from "../../../server/routes/task-controller.js";
import { getTask } from "../../../store/tasks.js";
import { serverBus } from "../../../server/events/server-bus.js";
import type { Task } from "../../../shared/types.js";

afterAll(() => cleanup());
beforeEach(() => clearTestDb());
afterEach(() => vi.restoreAllMocks());

function insertTask(task: Partial<Task> & { id: string }): void {
  const db = getTestDb();
  const config = JSON.stringify(task.config ?? {
    timeout: 30000,
    approvalRequired: [],
    approvalTimeout: 30000,
  });
  db.prepare(`
    INSERT INTO tasks (id, status, prompt, config, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    task.id,
    task.status ?? "pending",
    task.prompt ?? "test prompt",
    config,
    task.createdAt ?? Date.now(),
  );
}

describe("server/routes/task-controller", () => {
  describe("TaskController.cancelTask", () => {
    it("should cancel a pending task", () => {
      insertTask({ id: "task-cancel-1", status: "pending" });
      const controller = new TaskController();

      controller.cancelTask("task-cancel-1");

      const task = getTask("task-cancel-1");
      expect(task!.status).toBe("cancelled");
      expect(task!.completedAt).toBeDefined();
    });

    it("should cancel a running task", () => {
      insertTask({ id: "task-cancel-2", status: "running" });
      const controller = new TaskController();
      const emitSpy = vi.spyOn(serverBus, "emit");

      controller.cancelTask("task-cancel-2");

      const task = getTask("task-cancel-2");
      expect(task!.status).toBe("cancelled");
      expect(emitSpy).toHaveBeenCalledWith({
        type: "task_abort_requested",
        taskId: "task-cancel-2",
        reason: "cancelled",
      });
    });

    it("should do nothing for non-existent task", () => {
      const controller = new TaskController();

      // Should not throw
      controller.cancelTask("nonexistent-task");
    });
  });

  describe("TaskController.resolveApproval", () => {
    it("should return true (no-op in Pure C)", () => {
      const controller = new TaskController();

      const result = controller.resolveApproval("unknown-approval", "allow");
      expect(result).toBe(true);
    });

    it("should accept deny decision with reason", () => {
      const controller = new TaskController();

      const result = controller.resolveApproval("ap-2", "deny", "not safe");
      expect(result).toBe(true);
    });
  });
});
