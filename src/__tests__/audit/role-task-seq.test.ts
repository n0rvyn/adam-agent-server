/**
 * Task 2-tests: roles.task_seq counter test
 *
 * Verifies that evaluateTaskCompletion increments roles.task_seq for active roles
 * and does NOT increment for retired/inactive roles.
 *
 * Pre-impl: tests FAIL (task_seq stays 0 — incrementRoleTaskSeq not yet called).
 * Post-impl (Task 2-impl): tests pass.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

// KB postmortem 2026-04-05: all tests importing store/*.ts MUST mock store/db.js
// Use getTestDb() so real roles.ts / beliefs.ts functions operate on the test DB.
vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

// Mock dependencies of evaluateTaskCompletion that are not under test
vi.mock("../../config/runtime.js", () => ({
  getRuntimeConfig: () => ({
    memory: {
      scope: {
        archiveThreshold: 0.2,
        decayBase: 0.995,
        emaAlpha: 0.3,
        reflectionPoolMax: 100,
        humanFeedbackWeight: 3.0,
      },
      attributionThresholds: { high: 0.7, low: 0.3 },
      antiFlipMinUses: 10,
      antiFlipSuccessEmaThreshold: 0.25,
      globalBudgetTokens: 4000,
      midTaskInjection: { enabled: false },
    },
    anthropic: { defaultHaikuModel: "claude-haiku-4-5" },
  }),
}));

vi.mock("../../audit/score.js", () => ({
  recordTaskScore: vi.fn().mockReturnValue(0.7),
  computeWeighted: vi.fn().mockReturnValue(0.7),
  EMA_ALPHA: 0.3,
}));

vi.mock("../../store/role-scores.js", () => ({
  updateRoleScoreWithIntent: vi.fn().mockReturnValue(0.7),
  getLatestRoleScore: vi.fn().mockReturnValue(null),
}));

vi.mock("../../audit/retirement.js", () => ({
  checkRetirement: vi.fn().mockReturnValue(false),
  reinstateAgent: vi.fn(),
  checkProbationGraduation: vi.fn().mockReturnValue(false),
}));

vi.mock("../../audit/intent-eval.js", () => ({
  evaluateIntentFulfillment: vi.fn().mockResolvedValue({ score: 0.8, failed: false }),
}));

vi.mock("../../audit/anti-flip.js", () => ({
  checkAndFlipAntiPattern: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../audit/violation-watcher.js", () => ({
  startViolationWatcher: vi.fn(),
  reportViolation: vi.fn(),
  getViolationCount: vi.fn().mockReturnValue(0),
  getRecentViolations: vi.fn().mockReturnValue([]),
}));

vi.mock("../../store/tasks.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../store/tasks.js")>();
  return {
    ...actual,
    getTask: vi.fn().mockReturnValue({ id: "task-seq-1", config: { taskType: "test" }, roleId: "role-active-seq" }),
    getContextMeta: vi.fn().mockReturnValue(null),
  };
});

const { cleanup } = setupTestDb();

afterAll(() => cleanup());
beforeEach(() => {
  clearTestDb();
  // Seed server_state (required by some DB paths)
  getTestDb().exec("INSERT OR IGNORE INTO server_state (id, schema_version, created_at) VALUES (1, 81, 0)");
});

describe("roles.task_seq counter", () => {
  it("increments task_seq for active role after evaluateTaskCompletion", async () => {
    const { evaluateTaskCompletion } = await import("../../audit/audit-manager.js");
    const db = getTestDb();

    db.prepare(`
      INSERT INTO roles (id, name, memory_stream_id, status, created_at)
      VALUES ('role-active-seq', 'test-role', 'stream-1', 'active', 0)
    `).run();

    db.prepare(`
      INSERT INTO tasks (id, status, prompt, config, role_id, created_at, completed_at)
      VALUES ('task-seq-1', 'completed', 'test prompt', '{"taskType":"test"}', 'role-active-seq', 0, 1)
    `).run();

    const seqBefore = (db.prepare("SELECT task_seq FROM roles WHERE id = 'role-active-seq'").get() as { task_seq: number }).task_seq;
    expect(seqBefore).toBe(0);

    await evaluateTaskCompletion("task-seq-1", "role-active-seq");

    const seqAfter = (db.prepare("SELECT task_seq FROM roles WHERE id = 'role-active-seq'").get() as { task_seq: number }).task_seq;
    expect(seqAfter).toBe(1);
  });

  it("does NOT increment task_seq for retired role (early return)", async () => {
    const { evaluateTaskCompletion } = await import("../../audit/audit-manager.js");
    const db = getTestDb();

    db.prepare(`
      INSERT INTO roles (id, name, memory_stream_id, status, created_at)
      VALUES ('role-retired-seq', 'retired-role', 'stream-2', 'retired', 0)
    `).run();

    db.prepare(`
      INSERT INTO tasks (id, status, prompt, config, role_id, created_at)
      VALUES ('task-seq-2', 'completed', 'test prompt', '{}', 'role-retired-seq', 0)
    `).run();

    await evaluateTaskCompletion("task-seq-2", "role-retired-seq");

    const seqAfter = (db.prepare("SELECT task_seq FROM roles WHERE id = 'role-retired-seq'").get() as { task_seq: number }).task_seq;
    // Retired roles early-return before task_seq increment
    expect(seqAfter).toBe(0);
  });

  it("evaluateTaskCompletion calls checkAndFlipAntiPattern with the task's non-empty usedIds", async () => {
    const { evaluateTaskCompletion } = await import("../../audit/audit-manager.js");
    const { checkAndFlipAntiPattern } = await import("../../audit/anti-flip.js");
    const { getContextMeta } = await import("../../store/tasks.js");
    const { getLatestRoleScore } = await import("../../store/role-scores.js");
    const db = getTestDb();

    db.prepare(`
      INSERT INTO roles (id, name, memory_stream_id, status, created_at)
      VALUES ('role-anti-flip', 'flip-role', 'stream-3', 'active', 0)
    `).run();

    db.prepare(`
      INSERT INTO tasks (id, status, prompt, config, role_id, created_at, completed_at)
      VALUES ('task-flip-1', 'completed', 'test', '{"taskType":"test"}', 'role-anti-flip', 0, 1)
    `).run();

    // Override mocks to satisfy the `latest && latest.taskId === taskId && usedIds.length > 0` gate
    // at audit-manager.ts:108 which guards checkAndFlipAntiPattern.
    vi.mocked(getContextMeta).mockReturnValueOnce({ usedMemoryIds: ["bel-x", "bel-y", "bel-z"] });
    vi.mocked(getLatestRoleScore).mockReturnValueOnce({
      taskId: "task-flip-1",
      scores: { weighted: 0.7 },
    } as unknown as ReturnType<typeof getLatestRoleScore>);
    vi.mocked(checkAndFlipAntiPattern).mockClear();

    await evaluateTaskCompletion("task-flip-1", "role-anti-flip");

    expect(checkAndFlipAntiPattern).toHaveBeenCalledTimes(1);
    const call = vi.mocked(checkAndFlipAntiPattern).mock.calls[0];
    // First arg = beliefIds (usedIds) from context_meta
    expect(call[0]).toEqual(["bel-x", "bel-y", "bel-z"]);
  });
});
