import { describe, it, expect, vi, afterAll } from "vitest";
import { setupTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

// Defensive isolation: this test only checks typeof on the re-exports and never
// invokes them, but mocking `getDb()` here keeps the safety net in place if a
// future assertion is added that does call a DB-touching function.
vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

import {
  getDb,
  closeDb,
  createTask,
  getTask,
  updateTask,
  listTasks,
  deleteTask,
  createStepLog,
  getStepLogs,
  getStepLogByIndex,
  deleteTaskLogs,
} from "../../store/index.js";

afterAll(() => cleanup());

describe("store/index barrel exports", () => {
  it("re-exports all db functions", () => {
    expect(typeof getDb).toBe("function");
    expect(typeof closeDb).toBe("function");
  });

  it("re-exports all task functions", () => {
    expect(typeof createTask).toBe("function");
    expect(typeof getTask).toBe("function");
    expect(typeof updateTask).toBe("function");
    expect(typeof listTasks).toBe("function");
    expect(typeof deleteTask).toBe("function");
  });

  it("re-exports all log functions", () => {
    expect(typeof createStepLog).toBe("function");
    expect(typeof getStepLogs).toBe("function");
    expect(typeof getStepLogByIndex).toBe("function");
    expect(typeof deleteTaskLogs).toBe("function");
  });
});
