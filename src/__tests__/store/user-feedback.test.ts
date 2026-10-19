/**
 * Task 7 TDD: user-feedback broadcast to all active beliefs in usedMemoryIds (v3 mechanics).
 *
 * Verifies:
 * 1. broadcast to all active beliefs in usedMemoryIds (good feedback → ema rises)
 * 2. archived beliefs are skipped
 * 3. step-mode: only the step's task usedMemoryIds are updated
 * 4. execution-mode: all steps' usedMemoryIds are updated
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type BetterSqlite3 from "better-sqlite3";

vi.mock("../../store/db.js");

// Mock runtime config
vi.mock("../../config/runtime.js", () => ({
  getRuntimeConfig: () => ({
    memory: {
      scope: { emaAlpha: 0.3, humanFeedbackWeight: 3.0 },
    },
  }),
}));

// Mock template-executions
vi.mock("../../store/template-executions.js", () => ({
  getTemplateExecution: vi.fn(),
}));

// Mock tasks
vi.mock("../../store/tasks.js", () => ({
  getTask: vi.fn(),
  getContextMeta: vi.fn(),
}));

// Mock roles (for getRoleTaskSeq)
vi.mock("../../store/roles.js", () => ({
  getRoleTaskSeq: vi.fn().mockReturnValue(5),
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
  db.prepare("DELETE FROM user_feedback").run();
  vi.clearAllMocks();
});

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

describe("recordUserFeedback — v3 broadcast attribution (Task 7)", () => {
  it("broadcasts good feedback to all active beliefs in usedMemoryIds", async () => {
    const { getTemplateExecution } = await import("../../store/template-executions.js");
    const { getContextMeta, getTask } = await import("../../store/tasks.js");
    const { getBelief } = await import("../../store/beliefs.js");
    const { recordUserFeedback } = await import("../../store/user-feedback.js");

    const roleId = "role-1";

    makeActiveBelief("bel-a", roleId, 0.5);
    makeActiveBelief("bel-b", roleId, 0.5);
    makeActiveBelief("bel-c", roleId, 0.5);

    vi.mocked(getTemplateExecution).mockReturnValue({
      id: "exec-1",
      templateId: "tpl-1",
      status: "completed",
      stepStatuses: { "step-1": { taskId: "task-1", status: "completed" } },
      startedAt: Date.now(),
    });
    vi.mocked(getContextMeta).mockReturnValue({ usedMemoryIds: ["bel-a", "bel-b", "bel-c"] });
    vi.mocked(getTask).mockReturnValue({ id: "task-1", roleId, status: "completed", prompt: "test", config: { timeout: 30, approvalRequired: [], approvalTimeout: 60 }, createdAt: Date.now() });

    recordUserFeedback({ executionId: "exec-1", rating: "good" });

    // After 3 rounds of EMA toward 1.0:
    // round1: 0.7*0.5 + 0.3*1.0 = 0.65
    // round2: 0.7*0.65 + 0.3*1.0 = 0.755
    // round3: 0.7*0.755 + 0.3*1.0 = 0.8285
    const a = getBelief("bel-a");
    const b = getBelief("bel-b");
    const c = getBelief("bel-c");

    expect(a?.successEma).toBeGreaterThan(0.5);
    expect(b?.successEma).toBeGreaterThan(0.5);
    expect(c?.successEma).toBeGreaterThan(0.5);
  });

  it("skips archived beliefs during broadcast", async () => {
    const { getTemplateExecution } = await import("../../store/template-executions.js");
    const { getContextMeta, getTask } = await import("../../store/tasks.js");
    const { getBelief } = await import("../../store/beliefs.js");
    const { recordUserFeedback } = await import("../../store/user-feedback.js");

    const roleId = "role-1";

    makeActiveBelief("active-1", roleId, 0.5);
    makeArchivedBelief("archived-1", roleId, 0.5);

    vi.mocked(getTemplateExecution).mockReturnValue({
      id: "exec-2",
      templateId: "tpl-1",
      status: "completed",
      stepStatuses: { "step-1": { taskId: "task-2", status: "completed" } },
      startedAt: Date.now(),
    });
    vi.mocked(getContextMeta).mockReturnValue({ usedMemoryIds: ["active-1", "archived-1"] });
    vi.mocked(getTask).mockReturnValue({ id: "task-2", roleId, status: "completed", prompt: "test", config: { timeout: 30, approvalRequired: [], approvalTimeout: 60 }, createdAt: Date.now() });

    recordUserFeedback({ executionId: "exec-2", rating: "good" });

    const active = getBelief("active-1");
    const archived = getBelief("archived-1");

    expect(active?.successEma).toBeGreaterThan(0.5);
    expect(archived?.successEma).toBe(0.5); // unchanged
  });

  it("step-mode: only updates beliefs from the specified step's task", async () => {
    const { getTemplateExecution } = await import("../../store/template-executions.js");
    const { getContextMeta, getTask } = await import("../../store/tasks.js");
    const { getBelief } = await import("../../store/beliefs.js");
    const { recordUserFeedback } = await import("../../store/user-feedback.js");

    const roleId = "role-1";

    makeActiveBelief("step1-bel", roleId, 0.5);
    makeActiveBelief("step2-bel", roleId, 0.5);

    vi.mocked(getTemplateExecution).mockReturnValue({
      id: "exec-3",
      templateId: "tpl-1",
      status: "completed",
      stepStatuses: {
        "step-1": { taskId: "task-s1", status: "completed" },
        "step-2": { taskId: "task-s2", status: "completed" },
      },
      startedAt: Date.now(),
    });

    // step-1 uses step1-bel, step-2 uses step2-bel
    vi.mocked(getContextMeta).mockImplementation((taskId: string) => {
      if (taskId === "task-s1") return { usedMemoryIds: ["step1-bel"] };
      if (taskId === "task-s2") return { usedMemoryIds: ["step2-bel"] };
      return null;
    });
    vi.mocked(getTask).mockImplementation((taskId: string) => ({
      id: taskId, roleId, status: "completed", prompt: "test",
      config: { timeout: 30, approvalRequired: [], approvalTimeout: 60 }, createdAt: Date.now(),
    }));

    // Feedback only for step-1
    recordUserFeedback({ executionId: "exec-3", stepId: "step-1", rating: "good" });

    const s1 = getBelief("step1-bel");
    const s2 = getBelief("step2-bel");

    expect(s1?.successEma).toBeGreaterThan(0.5); // updated
    expect(s2?.successEma).toBe(0.5);            // not touched
  });

  it("returns cleanly when executionId does not exist", async () => {
    const { getTemplateExecution } = await import("../../store/template-executions.js");
    const { recordUserFeedback } = await import("../../store/user-feedback.js");

    // executionId not found → getTemplateExecution returns undefined
    vi.mocked(getTemplateExecution).mockReturnValue(undefined);

    // Should not throw; attribution silently skipped
    await expect(
      Promise.resolve(recordUserFeedback({ executionId: "nonexistent", rating: "good" }))
    ).resolves.not.toThrow();

    // user_feedback row must still be written
    const row = db.prepare("SELECT * FROM user_feedback WHERE execution_id = ?").get("nonexistent");
    expect(row).toBeDefined();
  });

  it("execution-mode: updates beliefs from all steps", async () => {
    const { getTemplateExecution } = await import("../../store/template-executions.js");
    const { getContextMeta, getTask } = await import("../../store/tasks.js");
    const { getBelief } = await import("../../store/beliefs.js");
    const { recordUserFeedback } = await import("../../store/user-feedback.js");

    const roleId = "role-1";

    makeActiveBelief("exec-bel-1", roleId, 0.5);
    makeActiveBelief("exec-bel-2", roleId, 0.5);

    vi.mocked(getTemplateExecution).mockReturnValue({
      id: "exec-4",
      templateId: "tpl-1",
      status: "completed",
      stepStatuses: {
        "step-1": { taskId: "task-e1", status: "completed" },
        "step-2": { taskId: "task-e2", status: "completed" },
      },
      startedAt: Date.now(),
    });

    vi.mocked(getContextMeta).mockImplementation((taskId: string) => {
      if (taskId === "task-e1") return { usedMemoryIds: ["exec-bel-1"] };
      if (taskId === "task-e2") return { usedMemoryIds: ["exec-bel-2"] };
      return null;
    });
    vi.mocked(getTask).mockImplementation((taskId: string) => ({
      id: taskId, roleId, status: "completed", prompt: "test",
      config: { timeout: 30, approvalRequired: [], approvalTimeout: 60 }, createdAt: Date.now(),
    }));

    // No stepId — all steps
    recordUserFeedback({ executionId: "exec-4", rating: "bad" });

    const b1 = getBelief("exec-bel-1");
    const b2 = getBelief("exec-bel-2");

    // bad feedback → ema converges toward 0.0, so should decrease
    expect(b1?.successEma).toBeLessThan(0.5);
    expect(b2?.successEma).toBeLessThan(0.5);
  });

  it("skips silently when task exists but has null roleId (no throw, beliefs untouched)", async () => {
    const { recordUserFeedback } = await import("../../store/user-feedback.js");
    const { getContextMeta, getTask } = await import("../../store/tasks.js");
    const { getTemplateExecution } = await import("../../store/template-executions.js");
    const { getBelief } = await import("../../store/beliefs.js");

    makeActiveBelief("bel-untouched", "role-null-task", 0.5);

    vi.mocked(getTemplateExecution).mockReturnValue({
      id: "exec-null", templateId: "tpl-1", status: "completed",
      stepStatuses: { "step-1": { taskId: "task-no-role", status: "completed" } },
      startedAt: Date.now(),
    });
    vi.mocked(getContextMeta).mockReturnValue({ usedMemoryIds: ["bel-untouched"] });
    vi.mocked(getTask).mockReturnValue({
      id: "task-no-role",
      roleId: null as unknown as string, // task exists but no role bound
      status: "completed",
      prompt: "test",
      config: { timeout: 30, approvalRequired: [], approvalTimeout: 60 },
      createdAt: Date.now(),
    });

    expect(() => recordUserFeedback({ executionId: "exec-null", rating: "good" })).not.toThrow();
    // Belief EMA unchanged because the loop skipped via `if (!task.roleId) continue`
    const after = getBelief("bel-untouched");
    expect(after?.successEma).toBeCloseTo(0.5, 6);
  });
});
