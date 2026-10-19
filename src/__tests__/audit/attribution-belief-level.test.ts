/**
 * Task 6 TDD: belief-level attribution in evaluateTaskCompletion step 3 (v3 mechanics).
 *
 * Verifies:
 * 1. applies fitness update to all active beliefs in usedMemoryIds
 * 2. skips archived beliefs
 * 3. noop when usedMemoryIds empty
 * 4. uses post-increment task_seq (seq already +1 by Task 2 before belief update)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type BetterSqlite3 from "better-sqlite3";
import type { Belief } from "../../shared/types.js";

vi.mock("../../store/db.js");

// Mock runtime config
vi.mock("../../config/runtime.js", () => ({
  getRuntimeConfig: () => ({
    memory: {
      scope: { emaAlpha: 0.3 },
      attributionThresholds: { high: 0.7, low: 0.3 },
      antiFlipMinUses: 10,
      antiFlipSuccessEmaThreshold: 0.25,
      globalBudgetTokens: 4000,
      midTaskInjection: { enabled: false },
    },
    anthropic: { defaultHaikuModel: "claude-haiku-4-5" },
  }),
}));

// Mock score module
vi.mock("../../audit/score.js", () => ({
  recordTaskScore: vi.fn().mockReturnValue({ scores: { weighted: 0.8 }, taskId: "task-1" }),
  computeWeighted: vi.fn().mockReturnValue(0.8),
  EMA_ALPHA: 0.3,
}));

// Mock role-scores
vi.mock("../../store/role-scores.js", () => ({
  updateRoleScoreWithIntent: vi.fn().mockReturnValue(0.8),
  getLatestRoleScore: vi.fn().mockReturnValue({ taskId: "task-1", scores: { weighted: 0.8 } }),
}));

// Mock retirement
vi.mock("../../audit/retirement.js", () => ({
  checkRetirement: vi.fn().mockReturnValue(false),
  reinstateAgent: vi.fn(),
  checkProbationGraduation: vi.fn().mockReturnValue(false),
}));

// Mock intent-eval
vi.mock("../../audit/intent-eval.js", () => ({
  evaluateIntentFulfillment: vi.fn().mockResolvedValue({ score: 0.8, failed: false }),
}));

// Mock anti-flip (side effect not under test)
vi.mock("../../audit/anti-flip.js", () => ({
  checkAndFlipAntiPattern: vi.fn().mockResolvedValue(undefined),
}));

// Mock violation-watcher
vi.mock("../../audit/violation-watcher.js", () => ({
  startViolationWatcher: vi.fn(),
  reportViolation: vi.fn(),
  getViolationCount: vi.fn().mockReturnValue(0),
  getRecentViolations: vi.fn().mockReturnValue([]),
}));

// Mock getTask
vi.mock("../../store/tasks.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../store/tasks.js")>();
  return {
    ...actual,
    getTask: vi.fn(),
    getContextMeta: vi.fn(),
  };
});

// Mock roles — getRoleTaskSeq returns 6 (post-increment)
vi.mock("../../store/roles.js", () => ({
  getRole: vi.fn().mockReturnValue({ id: "role-1", name: "TestRole", performanceScore: 0.7 }),
  listRoles: vi.fn().mockReturnValue([]),
  updateRole: vi.fn(),
  incrementRoleTaskSeq: vi.fn(),
  getRoleTaskSeq: vi.fn().mockReturnValue(6),
}));

let db: BetterSqlite3.Database;
let cleanup: () => void;

beforeAll(async () => {
  const { setupTestDb } = await import("../helpers/test-db.js");
  ({ db, cleanup } = setupTestDb());
});

afterAll(() => {
  cleanup();
});

beforeEach(() => {
  vi.doMock("../../store/db.js", () => ({ getDb: () => db }));
  db.prepare("DELETE FROM beliefs").run();
  db.prepare("DELETE FROM tasks").run();
  db.prepare("DELETE FROM roles").run();
  db.prepare("INSERT INTO roles (id, name, status, cag_prompt, memory_stream_id, created_at) VALUES ('role-1', 'TestRole', 'active', '', 'mem-1', ?)").run(Date.now());
});

function makeTask(id: string, roleId: string, contextMeta: Record<string, unknown> = {}) {
  db.prepare(`
    INSERT INTO tasks (id, status, prompt, config, created_at, role_id, context_meta)
    VALUES (?, 'completed', 'test prompt', '{}', ?, ?, ?)
  `).run(id, Date.now(), roleId, JSON.stringify(contextMeta));
}

function makeActiveBelief(id: string, roleId: string, successEma = 0.5): void {
  db.prepare(`
    INSERT INTO beliefs (id, role_id, content, is_anti, evidence_obs_ids,
      created_at, last_used_at, last_validated_at, status, success_ema)
    VALUES (?, ?, 'test belief', 0, '[]', ?, 0, ?, 'active', ?)
  `).run(id, roleId, Date.now(), Date.now(), successEma);
}

function makeArchivedBelief(id: string, roleId: string, successEma = 0.5): void {
  db.prepare(`
    INSERT INTO beliefs (id, role_id, content, is_anti, evidence_obs_ids,
      created_at, last_used_at, last_validated_at, status, success_ema)
    VALUES (?, ?, 'archived belief', 0, '[]', ?, 0, ?, 'archived', ?)
  `).run(id, roleId, Date.now(), Date.now(), successEma);
}

describe("evaluateTaskCompletion — belief-level attribution v3 (Task 6)", () => {
  it("applies fitness update to all active beliefs in usedMemoryIds", async () => {
    const { getBelief } = await import("../../store/beliefs.js");
    const { getTask, getContextMeta } = await import("../../store/tasks.js");
    const { getLatestRoleScore } = await import("../../store/role-scores.js");
    const { evaluateTaskCompletion } = await import("../../audit/audit-manager.js");

    const roleId = "role-1";
    const taskId = "task-multi";

    makeActiveBelief("belief-a", roleId, 0.5);
    makeActiveBelief("belief-b", roleId, 0.5);
    makeActiveBelief("belief-c", roleId, 0.5);

    makeTask(taskId, roleId, { usedMemoryIds: ["belief-a", "belief-b", "belief-c"] });

    vi.mocked(getTask).mockReturnValue({
      id: taskId,
      roleId,
      status: "completed",
      prompt: "test",
      config: { timeout: 30, approvalRequired: [], approvalTimeout: 60 },
      createdAt: Date.now(),
      result: "done",
    });
    vi.mocked(getContextMeta).mockReturnValue({ usedMemoryIds: ["belief-a", "belief-b", "belief-c"] });
    vi.mocked(getLatestRoleScore).mockReturnValue({ taskId, scores: { weighted: 0.8 } } as ReturnType<typeof getLatestRoleScore>);

    await evaluateTaskCompletion(taskId, roleId);

    // Bug #1 fix: materializeOnTouch now mutates in-place, so applyFitnessUpdate uses post-decay EMA.
    // last_used_at=0, task_seq=6 → decay: 0.5 × 0.995^6 ≈ 0.4852
    // EMA update: (1-0.3) × 0.4852 + 0.3 × 0.8 = 0.3396 + 0.24 = 0.5796
    // (old buggy result was 0.59 using stale pre-decay 0.5)
    const a = getBelief("belief-a");
    const b = getBelief("belief-b");
    const c = getBelief("belief-c");

    expect(a?.successEma).toBeCloseTo(0.5796, 3);
    expect(b?.successEma).toBeCloseTo(0.5796, 3);
    expect(c?.successEma).toBeCloseTo(0.5796, 3);
  });

  it("skips archived beliefs", async () => {
    const { getBelief } = await import("../../store/beliefs.js");
    const { getTask, getContextMeta } = await import("../../store/tasks.js");
    const { getLatestRoleScore } = await import("../../store/role-scores.js");
    const { evaluateTaskCompletion } = await import("../../audit/audit-manager.js");

    const roleId = "role-1";
    const taskId = "task-archive";

    makeActiveBelief("active-1", roleId, 0.5);
    makeArchivedBelief("archived-1", roleId, 0.5);

    makeTask(taskId, roleId, { usedMemoryIds: ["active-1", "archived-1"] });

    vi.mocked(getTask).mockReturnValue({
      id: taskId,
      roleId,
      status: "completed",
      prompt: "test",
      config: { timeout: 30, approvalRequired: [], approvalTimeout: 60 },
      createdAt: Date.now(),
      result: "done",
    });
    vi.mocked(getContextMeta).mockReturnValue({ usedMemoryIds: ["active-1", "archived-1"] });
    vi.mocked(getLatestRoleScore).mockReturnValue({ taskId, scores: { weighted: 0.8 } } as ReturnType<typeof getLatestRoleScore>);

    await evaluateTaskCompletion(taskId, roleId);

    const active = getBelief("active-1");
    const archived = getBelief("archived-1");

    // Active gets updated (bug #1 fix: post-decay EMA → 0.5796 not 0.59)
    expect(active?.successEma).toBeCloseTo(0.5796, 3);
    // Archived remains unchanged
    expect(archived?.successEma).toBe(0.5);
  });

  it("noop when usedMemoryIds empty", async () => {
    const { getTask, getContextMeta } = await import("../../store/tasks.js");
    const { getLatestRoleScore } = await import("../../store/role-scores.js");
    const { evaluateTaskCompletion } = await import("../../audit/audit-manager.js");

    const roleId = "role-1";
    const taskId = "task-empty";

    makeTask(taskId, roleId, { usedMemoryIds: [] });

    vi.mocked(getTask).mockReturnValue({
      id: taskId,
      roleId,
      status: "completed",
      prompt: "test",
      config: { timeout: 30, approvalRequired: [], approvalTimeout: 60 },
      createdAt: Date.now(),
      result: "done",
    });
    vi.mocked(getContextMeta).mockReturnValue({ usedMemoryIds: [] });
    vi.mocked(getLatestRoleScore).mockReturnValue({ taskId, scores: { weighted: 0.8 } } as ReturnType<typeof getLatestRoleScore>);

    // Should not throw
    await expect(evaluateTaskCompletion(taskId, roleId)).resolves.toBeUndefined();
  });

  it("uses post-increment task_seq when materializing beliefs", async () => {
    const { getBelief } = await import("../../store/beliefs.js");
    const { getTask, getContextMeta } = await import("../../store/tasks.js");
    const { getLatestRoleScore } = await import("../../store/role-scores.js");
    const { getRoleTaskSeq } = await import("../../store/roles.js");
    const { evaluateTaskCompletion } = await import("../../audit/audit-manager.js");

    const roleId = "role-1";
    const taskId = "task-seq";

    // Set last_used_at = 5 (seq before increment), current seq = 6
    db.prepare(`
      INSERT INTO beliefs (id, role_id, content, is_anti, evidence_obs_ids,
        created_at, last_used_at, last_validated_at, status, success_ema)
      VALUES ('seq-belief', ?, 'seq test belief', 0, '[]', ?, 5, ?, 'active', 0.5)
    `).run(roleId, Date.now(), Date.now());

    makeTask(taskId, roleId, { usedMemoryIds: ["seq-belief"] });

    vi.mocked(getTask).mockReturnValue({
      id: taskId,
      roleId,
      status: "completed",
      prompt: "test",
      config: { timeout: 30, approvalRequired: [], approvalTimeout: 60 },
      createdAt: Date.now(),
      result: "done",
    });
    vi.mocked(getContextMeta).mockReturnValue({ usedMemoryIds: ["seq-belief"] });
    vi.mocked(getLatestRoleScore).mockReturnValue({ taskId, scores: { weighted: 0.8 } } as ReturnType<typeof getLatestRoleScore>);
    // getRoleTaskSeq returns 6 (post-increment) — already mocked at module level
    expect(getRoleTaskSeq(roleId)).toBe(6);

    await evaluateTaskCompletion(taskId, roleId);

    // After fitness update, last_used_at should reflect seq=6
    const belief = getBelief("seq-belief");
    expect(belief?.lastUsedAt).toBe(6);
  });
});
