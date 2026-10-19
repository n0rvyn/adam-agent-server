import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();
vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

import {
  createRoleScore,
  updateRoleScoreWithIntent,
  getLatestRoleScore,
  getScoresByRole,
} from "../../store/role-scores.js";
import { createRole } from "../../store/roles.js";
import { createTask } from "../../store/tasks.js";
import { computeWeighted } from "../../audit/score.js";
import { EMA_ALPHA } from "../../audit/score.js";

afterAll(() => cleanup());
beforeEach(() => clearTestDb());

function seedRole(id: string) {
  createRole({
    id, name: `Role ${id}`, cagPrompt: "", learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
    memoryStreamId: `mem-${id}`, status: "active", preferences: {},
    createdAt: Date.now(),
  });
}

function seedTask(id: string) {
  createTask({
    id, status: "completed", prompt: "test",
    createdAt: Date.now(), completedAt: Date.now(),
    config: { timeout: 600, approvalRequired: [], approvalTimeout: 300 } as any,
  });
}

describe("store/role-scores — updateRoleScoreWithIntent", () => {
  it("successful eval: row score_json gets intentFulfillment + recomputed weighted", () => {
    seedRole("r1");
    seedTask("t1");
    // Insert initial 4-dim row
    createRoleScore({
      id: "rs-1", roleId: "r1", taskId: "t1",
      scores: { taskSuccess: 1, planAccuracy: 1, permissionCompliance: 1, efficiency: 1, weighted: 1 },
      emaScore: 1, createdAt: Date.now(),
    });

    const newEma = updateRoleScoreWithIntent("t1", 0.8, false, computeWeighted, EMA_ALPHA);
    expect(newEma).not.toBeUndefined();

    const scores = getScoresByRole("r1");
    const row = scores.find(s => s.taskId === "t1")!;
    expect(row.scores.intentFulfillment).toBe(0.8);
    expect(row.scores.intentFulfillmentFailed).toBe(false);
    // weighted recomputed with 5-dim: 0.25+0.20+0.20+0.15+0.80*0.20 = 0.96
    expect(row.scores.weighted).toBeCloseTo(0.96, 2);
    expect(row.emaScore).toBeCloseTo(newEma!, 2);
  });

  it("failed eval: intentFulfillment=null, intentFulfillmentFailed=true, weighted uses legacy 4-dim", () => {
    seedRole("r2");
    seedTask("t2");
    createRoleScore({
      id: "rs-2", roleId: "r2", taskId: "t2",
      scores: { taskSuccess: 1, planAccuracy: 1, permissionCompliance: 1, efficiency: 1, weighted: 1 },
      emaScore: 1, createdAt: Date.now(),
    });

    const newEma = updateRoleScoreWithIntent("t2", null, true, computeWeighted, EMA_ALPHA);
    expect(newEma).not.toBeUndefined();

    const scores = getScoresByRole("r2");
    const row = scores.find(s => s.taskId === "t2")!;
    expect(row.scores.intentFulfillment).toBeNull();
    expect(row.scores.intentFulfillmentFailed).toBe(true);
    // weighted: null intentFulfillment → legacy 4-dim (1.0)
    expect(row.scores.weighted).toBeCloseTo(1.0, 2);
  });

  it("missing task_id: returns undefined, no DB write", () => {
    seedRole("r3");
    seedTask("t3");
    createRoleScore({
      id: "rs-3", roleId: "r3", taskId: "t3",
      scores: { taskSuccess: 1, planAccuracy: 1, permissionCompliance: 1, efficiency: 1, weighted: 1 },
      emaScore: 1, createdAt: Date.now(),
    });

    const result = updateRoleScoreWithIntent("nonexistent-task", 0.9, false, computeWeighted, EMA_ALPHA);
    expect(result).toBeUndefined();
  });

  it("multiple rows: UPDATE only affects the row matching task_id", () => {
    seedRole("r4");
    seedTask("t4a");
    seedTask("t4b");
    createRoleScore({
      id: "rs-4a", roleId: "r4", taskId: "t4a",
      scores: { taskSuccess: 1, planAccuracy: 1, permissionCompliance: 1, efficiency: 1, weighted: 1 },
      emaScore: 1, createdAt: Date.now(),
    });
    createRoleScore({
      id: "rs-4b", roleId: "r4", taskId: "t4b",
      scores: { taskSuccess: 1, planAccuracy: 1, permissionCompliance: 1, efficiency: 1, weighted: 1 },
      emaScore: 1, createdAt: Date.now() + 1,
    });

    updateRoleScoreWithIntent("t4a", 0.5, false, computeWeighted, EMA_ALPHA);

    const scores = getScoresByRole("r4");
    const rowA = scores.find(s => s.taskId === "t4a")!;
    const rowB = scores.find(s => s.taskId === "t4b")!;
    expect(rowA.scores.intentFulfillment).toBe(0.5);
    expect(rowB.scores.intentFulfillment).toBeUndefined(); // unmodified
  });

  it("EMA chain integrity: update middle row, verify ema_score matches EMA_ALPHA*new_weighted + (1-EMA_ALPHA)*prev_ema", () => {
    seedRole("r5");
    seedTask("t5a");
    seedTask("t5b");
    seedTask("t5c");
    // Row 1: created_at = 1000
    createRoleScore({
      id: "rs-5a", roleId: "r5", taskId: "t5a",
      scores: { taskSuccess: 1, planAccuracy: 1, permissionCompliance: 1, efficiency: 1, weighted: 1 },
      emaScore: 1, createdAt: 1000,
    });
    // Row 2 (middle): created_at = 2000
    createRoleScore({
      id: "rs-5b", roleId: "r5", taskId: "t5b",
      scores: { taskSuccess: 1, planAccuracy: 1, permissionCompliance: 1, efficiency: 1, weighted: 1 },
      emaScore: 1, createdAt: 2000,
    });
    // Row 3: created_at = 3000
    createRoleScore({
      id: "rs-5c", roleId: "r5", taskId: "t5c",
      scores: { taskSuccess: 1, planAccuracy: 1, permissionCompliance: 1, efficiency: 1, weighted: 1 },
      emaScore: 1, createdAt: 3000,
    });

    // Update row 2 (t5b): prev (t5a) has ema=1, new_weighted=0.96
    const newEma = updateRoleScoreWithIntent("t5b", 0.8, false, computeWeighted, EMA_ALPHA);

    // Expected: prev (t5a) ema=1, new_weighted=0.96 → 0.3*0.96 + 0.7*1 = 0.988
    expect(newEma).toBeCloseTo(0.988, 2);

    // Row 2's ema_score in DB should match
    const scores = getScoresByRole("r5");
    const rowB = scores.find(s => s.taskId === "t5b")!;
    expect(rowB.emaScore).toBeCloseTo(0.988, 2);
  });

  it("getLatestRoleScore returns most recent row by created_at for given roleId", () => {
    seedRole("r6");
    seedTask("t6a");
    seedTask("t6b");
    seedTask("t6c");
    createRoleScore({
      id: "rs-6a", roleId: "r6", taskId: "t6a",
      scores: { taskSuccess: 1, planAccuracy: 1, permissionCompliance: 1, efficiency: 1, weighted: 1 },
      emaScore: 0.5, createdAt: 1000,
    });
    createRoleScore({
      id: "rs-6b", roleId: "r6", taskId: "t6b",
      scores: { taskSuccess: 1, planAccuracy: 1, permissionCompliance: 1, efficiency: 1, weighted: 1 },
      emaScore: 0.6, createdAt: 2000,
    });
    createRoleScore({
      id: "rs-6c", roleId: "r6", taskId: "t6c",
      scores: { taskSuccess: 1, planAccuracy: 1, permissionCompliance: 1, efficiency: 1, weighted: 1 },
      emaScore: 0.7, createdAt: 3000,
    });

    const latest = getLatestRoleScore("r6");
    expect(latest?.taskId).toBe("t6c");
    expect(latest?.emaScore).toBeCloseTo(0.7, 2);
  });
});
