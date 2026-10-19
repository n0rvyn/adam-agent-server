import { describe, it, expect, vi } from "vitest";
import { serverBus } from "../../server/events/server-bus.js";

describe("serverBus", () => {
  describe("task_status_change", () => {
    it("emits and receives task_status_change events", () => {
      const handler = vi.fn();
      serverBus.on("task_status_change", handler);

      serverBus.emit({
        type: "task_status_change",
        taskId: "task-1",
        oldStatus: "pending",
        newStatus: "queued",
      });

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith({
        type: "task_status_change",
        taskId: "task-1",
        oldStatus: "pending",
        newStatus: "queued",
      });
    });
  });

  describe("approval_request", () => {
    it("emits and receives approval_request events", () => {
      const handler = vi.fn();
      serverBus.on("approval_request", handler);

      serverBus.emit({
        type: "approval_request",
        taskId: "task-2",
        approvalId: "appr-1",
        toolName: "Bash",
        toolInput: { command: "rm -rf /tmp" },
        matchedPattern: "rm -rf",
      });

      expect(handler).toHaveBeenCalledOnce();
      expect(handler.mock.calls[0][0]).toMatchObject({
        type: "approval_request",
        taskId: "task-2",
        toolName: "Bash",
        matchedPattern: "rm -rf",
      });
    });
  });

  describe("stats_update", () => {
    it("emits and receives stats_update events", () => {
      const handler = vi.fn();
      serverBus.on("stats_update", handler);

      serverBus.emit({
        type: "stats_update",
        activeTasks: 2,
        queuedTasks: 3,
        totalCostToday: 1.5,
      });

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith({
        type: "stats_update",
        activeTasks: 2,
        queuedTasks: 3,
        totalCostToday: 1.5,
      });
    });
  });

  describe("task_complete_event", () => {
    it("emits and receives task_complete_event events", () => {
      const handler = vi.fn();
      serverBus.on("task_complete_event", handler);

      serverBus.emit({
        type: "task_complete_event",
        taskId: "t-1",
        result: "done",
      });

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith({
        type: "task_complete_event",
        taskId: "t-1",
        result: "done",
      });
    });
  });

  describe("event isolation", () => {
    it("does not cross-deliver events between types", () => {
      const taskHandler = vi.fn();
      const completeHandler = vi.fn();
      serverBus.on("task_status_change", taskHandler);
      serverBus.on("task_complete_event", completeHandler);

      serverBus.emit({
        type: "task_complete_event",
        taskId: "t-1",
        result: "done",
      });

      expect(completeHandler).toHaveBeenCalledOnce();
      expect(taskHandler).not.toHaveBeenCalled();
    });
  });
});
