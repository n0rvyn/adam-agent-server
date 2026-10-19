/**
 * Task 5-tests: Watchdog crash reconciliation — failing tests
 *
 * Verifies that reconcileOrphanedSnapshots():
 * - Detects running tasks with startSnapshot in context_meta that are not live
 *   in workspace-watcher, diffs their workspace, writes task_files rows, clears
 *   startSnapshot, and marks status='failed' with error_category='KILLED_NO_END_TASK'.
 * - Ignores tasks that lack startSnapshot in context_meta.
 * - Is idempotent: a second call produces no extra rows.
 *
 * These tests FAIL before Task 5-impl because reconcileOrphanedSnapshots is not
 * exported from watchdog.ts yet.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

vi.mock("../../config/runtime.js", () => ({
  getRuntimeConfig: vi.fn(() => ({
    anthropic: { apiKey: "", baseUrl: "", model: "", defaultOpusModel: "", defaultSonnetModel: "", defaultHaikuModel: "", smallFastModel: "" },
    defaults: {},
  })),
  initRuntimeConfig: vi.fn(),
  loadPersistedConfig: vi.fn(),
}));

vi.mock("../../store/roles.js", () => ({
  getRole: vi.fn(() => ({
    id: "role-test",
    name: "test-role",
    status: "active",
    createdAt: Date.now(),
  })),
}));

// Import reconcileOrphanedSnapshots — this will fail before impl (module exports it)
import { reconcileOrphanedSnapshots } from "../../platform/watchdog.js";
import { getTaskFiles } from "../../store/task-files.js";
import { _resetForTests } from "../../platform/workspace-watcher.js";

afterAll(() => cleanup());

let workspace: string;

beforeEach(async () => {
  clearTestDb();
  _resetForTests();
  workspace = await mkdtemp(join(tmpdir(), "wd-reconcile-"));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

function seedRunningTask(
  taskId: string,
  contextMeta: string,
  workspacePath: string = workspace,
): void {
  const db = getTestDb();
  const config = JSON.stringify({ workspacePath });
  db.prepare(
    "INSERT INTO tasks (id, status, prompt, config, context_meta, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(taskId, "running", "test task", config, contextMeta, Date.now());
}

describe("reconcileOrphanedSnapshots", () => {
  it("processes a running task with startSnapshot but no live process", async () => {
    const taskId = "reconcile-test-1";

    // Serialize a baseline empty snapshot (workspace was empty at task start)
    const startSnapshot: Array<[string, string, number, number]> = [];
    const contextMeta = JSON.stringify({ startSnapshot });

    seedRunningTask(taskId, contextMeta);

    // Simulate role activity after task was killed: write a file
    await writeFile(join(workspace, "killed.mp3"), "fake audio bytes");

    await reconcileOrphanedSnapshots();

    // Should have one added row for killed.mp3
    const files = getTaskFiles(taskId);
    expect(files).toHaveLength(1);
    expect(files[0].op).toBe("added");
    expect(files[0].path).toContain("killed.mp3");

    // Task status should be failed with KILLED_NO_END_TASK
    const db = getTestDb();
    const row = db.prepare("SELECT status, error_category, context_meta FROM tasks WHERE id = ?").get(taskId) as
      | { status: string; error_category: string | null; context_meta: string | null }
      | undefined;
    expect(row).toBeDefined();
    expect(row!.status).toBe("failed");
    expect(row!.error_category).toBe("KILLED_NO_END_TASK");

    // startSnapshot must be cleared from context_meta
    if (row!.context_meta) {
      const parsed = JSON.parse(row!.context_meta) as Record<string, unknown>;
      expect(parsed).not.toHaveProperty("startSnapshot");
    }
  });

  it("ignores tasks without startSnapshot in context_meta", async () => {
    const taskId = "reconcile-test-no-snap";
    // context_meta present but no startSnapshot key
    seedRunningTask(taskId, "{}");

    await reconcileOrphanedSnapshots();

    // No task_files rows written
    const files = getTaskFiles(taskId);
    expect(files).toHaveLength(0);

    // Task status unchanged
    const db = getTestDb();
    const row = db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as
      | { status: string }
      | undefined;
    expect(row!.status).toBe("running");
  });

  it("is idempotent — second call produces no extra rows", async () => {
    const taskId = "reconcile-test-idempotent";
    const startSnapshot: Array<[string, string, number, number]> = [];
    seedRunningTask(taskId, JSON.stringify({ startSnapshot }));

    await writeFile(join(workspace, "once.txt"), "content");

    await reconcileOrphanedSnapshots();
    const countAfterFirst = getTaskFiles(taskId).length;

    // Second call — task is now 'failed', not 'running', so it should be skipped
    await reconcileOrphanedSnapshots();
    const countAfterSecond = getTaskFiles(taskId).length;

    expect(countAfterSecond).toBe(countAfterFirst);
  });

  it("skips a task that is still live (workspace-watcher has the taskId registered)", async () => {
    const { registerTask } = await import("../../platform/workspace-watcher.js");
    const taskId = "reconcile-test-live";
    const startSnapshot: Array<[string, string, number, number]> = [];
    seedRunningTask(taskId, JSON.stringify({ startSnapshot }));

    // Mark as live — workspace-watcher knows about it, ExecutionManager is still finishing.
    registerTask(taskId, workspace);

    // Even though there's a new file, reconcile should NOT touch this task.
    await writeFile(join(workspace, "still-running.txt"), "content");
    await reconcileOrphanedSnapshots();

    expect(getTaskFiles(taskId)).toHaveLength(0);
    const row = getTestDb().prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string };
    expect(row.status).toBe("running"); // untouched
  });

  it("quarantines a task whose startSnapshot tuples have corrupt bigint strings", async () => {
    const { _resetReconcileStateForTests } = await import("../../platform/watchdog.js");
    _resetReconcileStateForTests(); // clear any quarantine state from prior tests

    const taskId = "reconcile-test-corrupt";
    // Malformed mtime_ns_str — BigInt() will throw
    const startSnapshot = [["/x/file.txt", "NOT_A_BIGINT_STR", 100, "42"]];
    seedRunningTask(taskId, JSON.stringify({ startSnapshot }));

    await reconcileOrphanedSnapshots();

    const row = getTestDb()
      .prepare("SELECT status, error_category, context_meta FROM tasks WHERE id = ?")
      .get(taskId) as { status: string; error_category: string; context_meta: string };
    expect(row.status).toBe("failed");
    expect(row.error_category).toBe("CORRUPT_CONTEXT_META");
    // startSnapshot was cleared even on the corrupt path
    const parsed = JSON.parse(row.context_meta);
    expect(parsed.startSnapshot).toBeUndefined();
    expect(getTaskFiles(taskId)).toHaveLength(0); // no diff rows for the corrupted task
  });
});
