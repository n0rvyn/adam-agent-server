import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

import { buildNudgePrompt } from "../../scheduler/template-executor.js";
import { insertTaskFilesDiff } from "../../store/task-files.js";
import type { SnapshotDiff } from "../../platform/workspace-snapshot.js";

afterAll(() => cleanup());
beforeEach(() => clearTestDb());

function seedTask(taskId: string): void {
  const db = getTestDb();
  db.prepare(
    "INSERT INTO tasks (id, status, prompt, config, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(taskId, "completed", "test", "{}", Date.now());
}

describe("buildNudgePrompt — no-scavenge reframe", () => {
  it("frames the task_files list as exhaustive, not a starting point for further search", () => {
    const taskId = "nudge-exhaustive-test";
    seedTask(taskId);
    insertTaskFilesDiff(taskId, {
      added: [{ path: "/role/workspace/script.md", mtime_ns: 1n, size: 18000, inode: 1n }],
      modified: [], deleted: [],
    });
    const prompt = buildNudgePrompt({ priorTaskId: taskId, outputAs: "audio-file" });
    expect(prompt).toMatch(/exhaustive|complete list|the only files/i);
    expect(prompt).toMatch(/do not.+(search|scan|browse|ls).+workspace/i);
  });

  it("presents write_artifact no_content as a primary option, not a fallback", () => {
    const taskId = "nudge-equal-tier-test";
    seedTask(taskId);
    const prompt = buildNudgePrompt({ priorTaskId: taskId, outputAs: "audio-file" });
    // Confirm no_content appears BEFORE or alongside publish_artifact_file, not buried at step 3
    const noContentIdx = prompt.indexOf("no_content");
    const publishIdx = prompt.indexOf("publish_artifact_file");
    expect(noContentIdx).toBeGreaterThan(-1);
    expect(publishIdx).toBeGreaterThan(-1);
    // Both should appear within the same primary-options section (within 500 chars of each other)
    expect(Math.abs(noContentIdx - publishIdx)).toBeLessThan(500);
  });

  it("explicitly forbids publishing files not listed in task_files", () => {
    const taskId = "nudge-forbid-pre-existing";
    seedTask(taskId);
    insertTaskFilesDiff(taskId, {
      added: [{ path: "/role/workspace/script.md", mtime_ns: 1n, size: 18000, inode: 1n }],
      modified: [], deleted: [],
    });
    const prompt = buildNudgePrompt({ priorTaskId: taskId, outputAs: "audio-file" });
    // The prompt should mention that files NOT in the list = leftovers from prior executions = forbidden
    expect(prompt).toMatch(/(prior|previous|earlier).+execution/i);
    expect(prompt).toMatch(/(forbidden|do not publish|never publish)/i);
  });
});
