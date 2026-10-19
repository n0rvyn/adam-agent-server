import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();
vi.mock("../../store/db.js", () => ({ getDb: () => getTestDb(), closeDb: () => {} }));

import { createRoleScore, getScoresByRole, getLatestEmaScore, getMedianTokenUsage, getScoresByDateRange } from "../../store/role-scores.js";
import { createRole } from "../../store/roles.js";
import { createTask } from "../../store/tasks.js";

afterAll(() => cleanup());
beforeEach(() => clearTestDb());

function seedAgent(id: string) {
  createRole({
    id, name: `Role ${id}`, cagPrompt: "", learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
    memoryStreamId: `mem-${id}`, status: "active", preferences: {},
    createdAt: Date.now(),
  });
}

function seedTask(id: string, tokenUsage?: { input: number; output: number }, roleId = "score-agent") {
  createTask({
    id, status: "completed", prompt: "test", roleId,
    createdAt: Date.now(), completedAt: Date.now(),
    tokenUsage, config: { timeout: 600, approvalRequired: [], approvalTimeout: 300 } as any,
  });
}

describe("store/role-scores", () => {
  it("creates and retrieves scores", () => {
    seedAgent("score-agent");
    seedTask("st-1");
    createRoleScore({
      id: "as-1", roleId: "score-agent", taskId: "st-1",
      scores: { taskSuccess: 1, planAccuracy: 1, permissionCompliance: 1, efficiency: 0.8, weighted: 0.95 },
      emaScore: 0.95, createdAt: Date.now(),
    });

    const scores = getScoresByRole("score-agent");
    expect(scores).toHaveLength(1);
    expect(scores[0].emaScore).toBe(0.95);
  });

  it("returns latest EMA score", () => {
    seedAgent("ema-agent");
    seedTask("et-1");
    seedTask("et-2");
    createRoleScore({
      id: "as-e1", roleId: "ema-agent", taskId: "et-1",
      scores: { taskSuccess: 1, planAccuracy: 1, permissionCompliance: 1, efficiency: 1, weighted: 1 },
      emaScore: 1.0, createdAt: Date.now() - 1000,
    });
    createRoleScore({
      id: "as-e2", roleId: "ema-agent", taskId: "et-2",
      scores: { taskSuccess: 0, planAccuracy: 1, permissionCompliance: 1, efficiency: 1, weighted: 0.7 },
      emaScore: 0.79, createdAt: Date.now(),
    });

    expect(getLatestEmaScore("ema-agent")).toBe(0.79);
  });

  it("returns undefined EMA for unknown role", () => {
    expect(getLatestEmaScore("nonexistent")).toBeUndefined();
  });

  it("computes median token usage from task history", () => {
    seedAgent("token-agent");
    for (let i = 0; i < 5; i++) {
      seedTask(`tt-${i}`, { input: 1000 * (i + 1), output: 500 * (i + 1) }, "token-agent");
    }

    const median = getMedianTokenUsage("token-agent");
    // Tasks: 1500, 3000, 4500, 6000, 7500 → median = 4500
    expect(median).toBe(4500);
  });

  it("returns fallback for role with no completed tasks", () => {
    expect(getMedianTokenUsage("no-tasks")).toBe(10000);
  });

  it("queries scores by date range", () => {
    seedAgent("range-agent");
    seedTask("rt-1");
    const now = Date.now();
    createRoleScore({
      id: "as-r1", roleId: "range-agent", taskId: "rt-1",
      scores: { taskSuccess: 1, planAccuracy: 1, permissionCompliance: 1, efficiency: 1, weighted: 1 },
      emaScore: 1.0, createdAt: now,
    });

    const inRange = getScoresByDateRange("range-agent", now - 1000, now + 1000);
    expect(inRange).toHaveLength(1);

    const outRange = getScoresByDateRange("range-agent", now + 2000, now + 3000);
    expect(outRange).toHaveLength(0);
  });
});
