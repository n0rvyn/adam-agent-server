import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";
import { insertTaskFilesDiff, getTaskFiles, queryTaskFilesByPath } from "../../store/task-files.js";
import type { SnapshotDiff, DiffEntry } from "../../platform/workspace-snapshot.js";

const { cleanup } = setupTestDb();
vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

afterAll(() => cleanup());
beforeEach(() => clearTestDb());

function seedTask(id = "task-1"): void {
  getTestDb()
    .prepare("INSERT INTO tasks (id, status, prompt, config, created_at) VALUES (?, 'completed', '', '{}', ?)")
    .run(id, Date.now());
}

function makeDiffEntry(path: string, extra?: Partial<DiffEntry>): DiffEntry {
  return {
    path,
    mtime_ns: 1700000000000000000n,
    size: 100,
    inode: 12345n,
    ...extra,
  };
}

describe("insertTaskFilesDiff", () => {
  it("inserts added/modified/deleted rows with correct op", () => {
    seedTask("t1");
    const d: SnapshotDiff = {
      added: [makeDiffEntry("/workspace/added.mp3")],
      modified: [makeDiffEntry("/workspace/modified.txt", { size: 200 })],
      deleted: [],
    };
    // Manually add a deleted entry by building SnapshotDiff with deleted path
    const d2: SnapshotDiff = {
      added: [makeDiffEntry("/workspace/added.mp3")],
      modified: [makeDiffEntry("/workspace/modified.txt", { size: 200 })],
      deleted: ["/workspace/deleted.log"],
    };
    insertTaskFilesDiff("t1", d2);
    const rows = getTaskFiles("t1");
    expect(rows).toHaveLength(3);
    const addedRow = rows.find((r) => r.path === "/workspace/added.mp3");
    const modifiedRow = rows.find((r) => r.path === "/workspace/modified.txt");
    const deletedRow = rows.find((r) => r.path === "/workspace/deleted.log");
    expect(addedRow?.op).toBe("added");
    expect(modifiedRow?.op).toBe("modified");
    expect(deletedRow?.op).toBe("deleted");
    expect(deletedRow?.size_bytes).toBeNull();
    expect(deletedRow?.mtime_ns).toBeNull();
  });

  it("noop on empty diff", () => {
    seedTask("t2");
    const empty: SnapshotDiff = { added: [], modified: [], deleted: [] };
    insertTaskFilesDiff("t2", empty);
    expect(getTaskFiles("t2")).toHaveLength(0);
  });

  it("preserves bigint mtime_ns roundtrip", () => {
    seedTask("t3");
    const bigMtime = 1779234567890123456n; // > Number.MAX_SAFE_INTEGER
    const d: SnapshotDiff = {
      added: [makeDiffEntry("/workspace/big.mp3", { mtime_ns: bigMtime })],
      modified: [],
      deleted: [],
    };
    insertTaskFilesDiff("t3", d);
    const rows = getTaskFiles("t3");
    expect(rows).toHaveLength(1);
    const stored = rows[0].mtime_ns;
    expect(BigInt(stored!)).toBe(bigMtime);
  });
});

describe("queryTaskFilesByPath", () => {
  it("returns rows for given path across tasks", () => {
    seedTask("ta");
    seedTask("tb");
    const sharedPath = "/workspace/shared.mp3";
    const dA: SnapshotDiff = {
      added: [makeDiffEntry(sharedPath)],
      modified: [],
      deleted: [],
    };
    const dB: SnapshotDiff = {
      added: [makeDiffEntry(sharedPath)],
      modified: [],
      deleted: [],
    };
    insertTaskFilesDiff("ta", dA);
    insertTaskFilesDiff("tb", dB);
    const rows = queryTaskFilesByPath(sharedPath);
    expect(rows).toHaveLength(2);
    const taskIds = rows.map((r) => r.task_id);
    expect(taskIds).toContain("ta");
    expect(taskIds).toContain("tb");
  });
});

describe("CASCADE deletion", () => {
  it("removes task_files rows when parent task is deleted", () => {
    seedTask("tc");
    const d: SnapshotDiff = {
      added: [makeDiffEntry("/workspace/output.mp4")],
      modified: [],
      deleted: [],
    };
    insertTaskFilesDiff("tc", d);
    expect(getTaskFiles("tc")).toHaveLength(1);
    getTestDb().prepare("DELETE FROM tasks WHERE id = ?").run("tc");
    expect(getTaskFiles("tc")).toHaveLength(0);
  });
});

describe("queryTaskFilesByPath empty result", () => {
  it("returns empty array when no rows match the path", () => {
    seedTask("tq");
    insertTaskFilesDiff("tq", {
      added: [makeDiffEntry("/seen.txt")],
      modified: [],
      deleted: [],
    });
    expect(queryTaskFilesByPath("/nonexistent.txt")).toEqual([]);
  });
});
