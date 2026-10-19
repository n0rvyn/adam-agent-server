import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

import { createStepLog, getStepLogs, getStepLogByIndex, deleteTaskLogs } from "../../store/logs.js";
import { createTask } from "../../store/tasks.js";
import type { StepLog, Task } from "../../shared/types.js";

afterAll(() => cleanup());
beforeEach(() => clearTestDb());

function makeTask(): Task {
  return {
    id: "task-1",
    status: "running",
    prompt: "test",
    config: {
      timeout: 600,
      approvalRequired: [],
      approvalTimeout: 300,
    },
    createdAt: Date.now(),
  };
}

function makeLog(overrides: Partial<StepLog> = {}): StepLog {
  return {
    id: "log-1",
    taskId: "task-1",
    index: 0,
    type: "tool_result",
    content: "test content",
    truncated: false,
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("store/logs", () => {
  beforeEach(() => {
    createTask(makeTask());
  });

  describe("createStepLog", () => {
    it("should insert a step log", () => {
      createStepLog(makeLog());
      const logs = getStepLogs("task-1");
      expect(logs.length).toBe(1);
      expect(logs[0].content).toBe("test content");
    });

    it("should store tool metadata", () => {
      createStepLog(
        makeLog({
          toolName: "Read",
          toolInput: { file_path: "/test.txt" },
          toolOutput: "file contents",
        }),
      );
      const logs = getStepLogs("task-1");
      expect(logs[0].toolName).toBe("Read");
      expect(logs[0].toolInput).toEqual({ file_path: "/test.txt" });
      expect(logs[0].toolOutput).toBe("file contents");
    });

    it("should store truncated flag", () => {
      createStepLog(makeLog({ truncated: true }));
      const logs = getStepLogs("task-1");
      expect(logs[0].truncated).toBe(true);
    });
  });

  describe("getStepLogs", () => {
    it("should return logs in index order", () => {
      createStepLog(makeLog({ id: "log-3", index: 2, content: "third" }));
      createStepLog(makeLog({ id: "log-1", index: 0, content: "first" }));
      createStepLog(makeLog({ id: "log-2", index: 1, content: "second" }));
      const logs = getStepLogs("task-1");
      expect(logs.map((l) => l.content)).toEqual(["first", "second", "third"]);
    });

    it("should respect limit and offset", () => {
      for (let i = 0; i < 5; i++) {
        createStepLog(makeLog({ id: `log-${i}`, index: i }));
      }
      const logs = getStepLogs("task-1", 2, 1);
      expect(logs.length).toBe(2);
      expect(logs[0].index).toBe(1);
    });

    it("should return empty array for unknown task", () => {
      expect(getStepLogs("non-existent")).toEqual([]);
    });
  });

  describe("getStepLogByIndex", () => {
    it("should return specific log by index", () => {
      createStepLog(makeLog({ id: "log-0", index: 0, content: "zero" }));
      createStepLog(makeLog({ id: "log-1", index: 1, content: "one" }));
      const log = getStepLogByIndex("task-1", 1);
      expect(log).toBeDefined();
      expect(log!.content).toBe("one");
    });

    it("should return undefined for non-existent index", () => {
      expect(getStepLogByIndex("task-1", 99)).toBeUndefined();
    });
  });

  describe("deleteTaskLogs", () => {
    it("should delete all logs for a task", () => {
      createStepLog(makeLog({ id: "log-0", index: 0 }));
      createStepLog(makeLog({ id: "log-1", index: 1 }));
      deleteTaskLogs("task-1");
      expect(getStepLogs("task-1")).toEqual([]);
    });
  });
});
