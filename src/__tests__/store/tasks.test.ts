import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

import { createTask, getTask, updateTask, listTasks, deleteTask, listTasksByParent, listTasksByDateRange, appendUsedMemoryIds, getStartSnapshot, updateContextMeta } from "../../store/tasks.js";
import type { Task } from "../../shared/types.js";

afterAll(() => cleanup());
beforeEach(() => clearTestDb());

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    status: "pending",
    prompt: "test prompt",
    config: {
      timeout: 600,
      approvalRequired: [],
      approvalTimeout: 300,
    },
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("store/tasks", () => {
  describe("createTask", () => {
    it("should insert a task", () => {
      createTask(makeTask());
      const task = getTask("task-1");
      expect(task).toBeDefined();
      expect(task!.id).toBe("task-1");
      expect(task!.status).toBe("pending");
      expect(task!.prompt).toBe("test prompt");
    });

    it("should throw on duplicate id", () => {
      createTask(makeTask());
      expect(() => createTask(makeTask())).toThrow();
    });
  });

  describe("getTask", () => {
    it("should return undefined for non-existent task", () => {
      expect(getTask("non-existent")).toBeUndefined();
    });

    it("should deserialize config JSON", () => {
      createTask(makeTask());
      const task = getTask("task-1");
      expect(task!.config.timeout).toBe(600);
    });

    it("roundtrips stepId when present", () => {
      createTask(makeTask({ stepId: "step-a" }));
      const task = getTask("task-1");
      expect(task!.stepId).toBe("step-a");
    });

    it("returns undefined stepId when omitted", () => {
      createTask(makeTask());
      const task = getTask("task-1");
      expect(task!.stepId).toBeUndefined();
    });
  });

  describe("updateTask", () => {
    it("should update status", () => {
      createTask(makeTask());
      updateTask("task-1", { status: "running" });
      const task = getTask("task-1");
      expect(task!.status).toBe("running");
    });

    it("should update multiple fields", () => {
      createTask(makeTask());
      updateTask("task-1", {
        status: "completed",
        result: "done",
        completedAt: 12345,
      });
      const task = getTask("task-1");
      expect(task!.status).toBe("completed");
      expect(task!.result).toBe("done");
      expect(task!.completedAt).toBe(12345);
    });

    it("should no-op with empty updates", () => {
      createTask(makeTask());
      updateTask("task-1", {});
      const task = getTask("task-1");
      expect(task!.status).toBe("pending");
    });
  });

  describe("listTasks", () => {
    it("should list all tasks", () => {
      createTask(makeTask({ id: "task-1" }));
      createTask(makeTask({ id: "task-2" }));
      const tasks = listTasks();
      expect(tasks.length).toBe(2);
    });

    it("should filter by status", () => {
      createTask(makeTask({ id: "task-1", status: "pending" }));
      createTask(makeTask({ id: "task-2", status: "running" }));
      const pending = listTasks("pending");
      expect(pending.length).toBe(1);
      expect(pending[0].id).toBe("task-1");
    });

    it("should respect limit and offset", () => {
      for (let i = 0; i < 5; i++) {
        createTask(makeTask({ id: `task-${i}`, createdAt: 1000 + i }));
      }
      const page = listTasks(undefined, 2, 1);
      expect(page.length).toBe(2);
    });
  });

  describe("deleteTask", () => {
    it("should remove task", () => {
      createTask(makeTask());
      deleteTask("task-1");
      expect(getTask("task-1")).toBeUndefined();
    });

    it("should not throw for non-existent task", () => {
      expect(() => deleteTask("non-existent")).not.toThrow();
    });
  });

  describe("listTasksByParent", () => {
    it("should return tasks with matching parent_id", () => {
      createTask(makeTask({ id: "parent-1" }));
      createTask(makeTask({ id: "child-1", parentId: "parent-1" }));
      createTask(makeTask({ id: "child-2", parentId: "parent-1" }));

      const children = listTasksByParent("parent-1");
      expect(children).toHaveLength(2);
    });

    it("should return empty for non-existent parent", () => {
      expect(listTasksByParent("nonexistent")).toEqual([]);
    });
  });

  describe("listTasksByDateRange", () => {
    it("should return tasks in date range", () => {
      const now = Date.now();

      createTask(makeTask({ id: "t-1" }));
      updateTask("t-1", { status: "completed", completedAt: now - 1000 });

      createTask(makeTask({ id: "t-2" }));
      updateTask("t-2", { status: "completed", completedAt: now });

      const results = listTasksByDateRange("completed", now - 2000, now + 1000);
      expect(results).toHaveLength(2);
    });

    it("should exclude tasks outside date range", () => {
      const now = Date.now();

      createTask(makeTask({ id: "t-old" }));
      updateTask("t-old", { status: "completed", completedAt: now - 100000 });

      const results = listTasksByDateRange("completed", now - 1000, now + 1000);
      expect(results).toHaveLength(0);
    });
  });
});

describe("appendUsedMemoryIds context_meta sibling preservation", () => {
  it("preserves sibling keys (startSnapshot, someOtherKey) when appending usedMemoryIds", () => {
    const db = getTestDb();
    // Seed a task with context_meta containing startSnapshot and another sibling
    const initialMeta = JSON.stringify({
      startSnapshot: [["/x/file.txt", "1779234567890123456", 100, 42]],
      someOtherKey: "preserved",
    });
    db.prepare(
      "INSERT INTO tasks (id, status, prompt, config, context_meta, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("task-sibling-1", "running", "test", "{}", initialMeta, Date.now());

    appendUsedMemoryIds("task-sibling-1", ["belief-a", "belief-b"]);

    const row = db.prepare("SELECT context_meta FROM tasks WHERE id = ?").get("task-sibling-1") as
      | { context_meta: string }
      | undefined;
    expect(row).toBeDefined();
    const parsed = JSON.parse(row!.context_meta);

    // usedMemoryIds should be set
    expect(parsed.usedMemoryIds).toEqual(["belief-a", "belief-b"]);
    // startSnapshot must still be intact
    expect(parsed.startSnapshot).toEqual([["/x/file.txt", "1779234567890123456", 100, 42]]);
    // other sibling keys must be preserved
    expect(parsed.someOtherKey).toBe("preserved");
  });

  it("deduplicates usedMemoryIds while preserving startSnapshot sibling", () => {
    const db = getTestDb();
    const initialMeta = JSON.stringify({
      usedMemoryIds: ["existing"],
      startSnapshot: [["/y/audio.mp3", "123456789012345678", 512, 99]],
    });
    db.prepare(
      "INSERT INTO tasks (id, status, prompt, config, context_meta, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("task-sibling-2", "running", "test", "{}", initialMeta, Date.now());

    appendUsedMemoryIds("task-sibling-2", ["existing", "new"]);

    const row = db.prepare("SELECT context_meta FROM tasks WHERE id = ?").get("task-sibling-2") as
      | { context_meta: string }
      | undefined;
    const parsed = JSON.parse(row!.context_meta);

    // Dedup: "existing" appears once, "new" appended
    expect(parsed.usedMemoryIds).toEqual(["existing", "new"]);
    // startSnapshot must survive the append
    expect(parsed.startSnapshot).toEqual([["/y/audio.mp3", "123456789012345678", 512, 99]]);
  });
});

describe("getStartSnapshot", () => {
  it("returns null when context_meta is null", () => {
    const db = getTestDb();
    db.prepare(
      "INSERT INTO tasks (id, status, prompt, config, context_meta, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("snap-null", "running", "test", "{}", null, Date.now());
    expect(getStartSnapshot("snap-null")).toBeNull();
  });

  it("returns null when startSnapshot key is absent", () => {
    const db = getTestDb();
    const meta = JSON.stringify({ usedMemoryIds: ["a", "b"] });
    db.prepare(
      "INSERT INTO tasks (id, status, prompt, config, context_meta, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("snap-missing-key", "running", "test", "{}", meta, Date.now());
    expect(getStartSnapshot("snap-missing-key")).toBeNull();
  });

  it("returns null when context_meta JSON is malformed", () => {
    const db = getTestDb();
    db.prepare(
      "INSERT INTO tasks (id, status, prompt, config, context_meta, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("snap-bad-json", "running", "test", "{}", "{not json", Date.now());
    expect(getStartSnapshot("snap-bad-json")).toBeNull();
  });

  it("returns the tuple array when startSnapshot is well-formed", () => {
    const db = getTestDb();
    const tuples = [["/r/foo.mp3", "1779234567890123456", 4096, "1001"]];
    const meta = JSON.stringify({ startSnapshot: tuples, usedMemoryIds: ["x"] });
    db.prepare(
      "INSERT INTO tasks (id, status, prompt, config, context_meta, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("snap-ok", "running", "test", "{}", meta, Date.now());
    expect(getStartSnapshot("snap-ok")).toEqual(tuples);
  });
});

describe("updateContextMeta", () => {
  it("creates context_meta when initially null", () => {
    const db = getTestDb();
    db.prepare(
      "INSERT INTO tasks (id, status, prompt, config, context_meta, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("uctx-1", "running", "test", "{}", null, Date.now());

    updateContextMeta("uctx-1", (parsed) => {
      parsed.startSnapshot = [["/x", "1", 10, "100"]];
    });

    const row = db.prepare("SELECT context_meta FROM tasks WHERE id = ?").get("uctx-1") as
      | { context_meta: string }
      | undefined;
    expect(row).toBeDefined();
    const parsed = JSON.parse(row!.context_meta);
    expect(parsed.startSnapshot).toEqual([["/x", "1", 10, "100"]]);
  });

  it("preserves sibling keys when patcher only touches one key", () => {
    const db = getTestDb();
    const initial = JSON.stringify({
      usedMemoryIds: ["b1", "b2"],
      startSnapshot: [["/y", "2", 20, "200"]],
      legacyKey: "still-here",
    });
    db.prepare(
      "INSERT INTO tasks (id, status, prompt, config, context_meta, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("uctx-2", "running", "test", "{}", initial, Date.now());

    updateContextMeta("uctx-2", (parsed) => {
      parsed.usedMemoryIds = ["b1", "b2", "b3"];
    });

    const parsed = JSON.parse(
      (db.prepare("SELECT context_meta FROM tasks WHERE id = ?").get("uctx-2") as { context_meta: string }).context_meta,
    );
    expect(parsed.usedMemoryIds).toEqual(["b1", "b2", "b3"]);
    expect(parsed.startSnapshot).toEqual([["/y", "2", 20, "200"]]);
    expect(parsed.legacyKey).toBe("still-here");
  });

  it("delete on key removes only that key, siblings intact", () => {
    const db = getTestDb();
    const initial = JSON.stringify({
      usedMemoryIds: ["x"],
      startSnapshot: [["/z", "3", 30, "300"]],
    });
    db.prepare(
      "INSERT INTO tasks (id, status, prompt, config, context_meta, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("uctx-3", "running", "test", "{}", initial, Date.now());

    updateContextMeta("uctx-3", (parsed) => {
      delete parsed.startSnapshot;
    });

    const parsed = JSON.parse(
      (db.prepare("SELECT context_meta FROM tasks WHERE id = ?").get("uctx-3") as { context_meta: string }).context_meta,
    );
    expect(parsed.startSnapshot).toBeUndefined();
    expect(parsed.usedMemoryIds).toEqual(["x"]);
  });

  it("recovers from malformed JSON by treating as empty object", () => {
    const db = getTestDb();
    db.prepare(
      "INSERT INTO tasks (id, status, prompt, config, context_meta, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("uctx-4", "running", "test", "{}", "not-json{", Date.now());

    updateContextMeta("uctx-4", (parsed) => {
      parsed.usedMemoryIds = ["recovered"];
    });

    const parsed = JSON.parse(
      (db.prepare("SELECT context_meta FROM tasks WHERE id = ?").get("uctx-4") as { context_meta: string }).context_meta,
    );
    expect(parsed.usedMemoryIds).toEqual(["recovered"]);
  });
});
