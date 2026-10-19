/**
 * Task 6-tests: Nudge prompt consumes task_files — failing tests
 *
 * Verifies that when dispatchNudge builds its prompt, it pulls the file list
 * from task_files (not step_logs Write/Edit grep) for the prior task.
 *
 * These tests fail before Task 6-impl because buildNudgePrompt is not yet
 * exported from template-executor.ts.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

// Import the function under test — this FAILS before Task 6-impl (buildNudgePrompt not exported)
import { buildNudgePrompt, formatSize } from "../../scheduler/template-executor.js";
import { insertTaskFilesDiff } from "../../store/task-files.js";
import type { SnapshotDiff } from "../../platform/workspace-snapshot.js";

afterAll(() => cleanup());
beforeEach(() => clearTestDb());

function seedTask(taskId: string): void {
  const db = getTestDb();
  db.prepare(
    "INSERT INTO tasks (id, status, prompt, config, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(taskId, "completed", "test task", "{}", Date.now());
}

function makeOutputAs(): string {
  return "podcast.mp3";
}

describe("buildNudgePrompt — sourced from task_files", () => {
  it("includes Bash-written files from task_files (not step_logs grep)", () => {
    const taskId = "nudge-task-1";
    seedTask(taskId);

    // Insert two task_files rows — these were written by Bash, never via Write/Edit tool
    const diff: SnapshotDiff = {
      added: [
        { path: "/role/workspace/podcast.mp3", mtime_ns: 1779234567890123456n, size: 8388608, inode: 1001n },
        { path: "/role/workspace/song_lyrics.txt", mtime_ns: 1779234567890100000n, size: 1024, inode: 1002n },
      ],
      modified: [],
      deleted: [],
    };
    insertTaskFilesDiff(taskId, diff);

    const prompt = buildNudgePrompt({ priorTaskId: taskId, outputAs: makeOutputAs() });

    // Both paths must appear in the prompt
    expect(prompt).toContain("podcast.mp3");
    expect(prompt).toContain("song_lyrics.txt");
    // The old step_logs fallback message must NOT appear
    expect(prompt).not.toContain("no recorded Write/Edit calls");
  });

  it("falls back gracefully when task_files is empty for the prior task", () => {
    const taskId = "nudge-task-empty";
    seedTask(taskId);
    // No task_files rows inserted

    const prompt = buildNudgePrompt({ priorTaskId: taskId, outputAs: makeOutputAs() });

    // Should use the new fallback message (not the old step_logs-era message)
    expect(prompt).toContain("the previous task wrote no files");
    expect(prompt).not.toContain("no recorded Write/Edit calls");
  });

  it("includes file sizes to help LLM judge primary deliverable", () => {
    const taskId = "nudge-task-size";
    seedTask(taskId);

    const diff: SnapshotDiff = {
      added: [
        { path: "/role/workspace/episode.mp3", mtime_ns: 1779234567890123456n, size: 8388608, inode: 1003n },
      ],
      modified: [],
      deleted: [],
    };
    insertTaskFilesDiff(taskId, diff);

    const prompt = buildNudgePrompt({ priorTaskId: taskId, outputAs: makeOutputAs() });

    // Should contain either human-readable "8.0MB" or raw size
    const hasSizeInfo = prompt.includes("8.0MB") || prompt.includes("8388608");
    expect(hasSizeInfo).toBe(true);
  });
});

describe("formatSize — all branches", () => {
  it("returns 'size unknown' for null", () => {
    expect(formatSize(null)).toBe("size unknown");
  });

  it("returns N + 'B' for sub-1024 number", () => {
    expect(formatSize(0)).toBe("0B");
    expect(formatSize(500)).toBe("500B");
    expect(formatSize(1023)).toBe("1023B");
  });

  it("returns X.XKB for 1024 <= n < 1048576", () => {
    expect(formatSize(1024)).toBe("1.0KB");
    expect(formatSize(5000)).toBe("4.9KB");
    expect(formatSize(1048575)).toBe("1024.0KB");
  });

  it("returns X.XMB for n >= 1048576", () => {
    expect(formatSize(1048576)).toBe("1.0MB");
    expect(formatSize(8388608)).toBe("8.0MB");
  });

  it("accepts bigint input (returned by safeIntegers(true) reads from task_files)", () => {
    expect(formatSize(8388608n)).toBe("8.0MB");
    expect(formatSize(1024n)).toBe("1.0KB");
    expect(formatSize(0n)).toBe("0B");
  });
});
