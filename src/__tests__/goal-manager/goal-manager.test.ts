import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

// Mock LLM eval so natural language parsing doesn't hit real API
vi.mock("../../lib/llm-eval.js", () => ({
  callClaudeForEvaluation: vi.fn().mockResolvedValue('{"name":"Test Goal","description":"A test goal","metric":"completion","targetValue":1,"deadline_days":7,"budget":5,"role":"engineer"}'),
}));

// Mock logger
vi.mock("../../lib/logger.js", () => ({
  getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { parseGoal, validateSMART, persistGoal, buildMetricTree, getGoalState, updateGoalProgress } from "../../goal-manager/goal-manager.js";
import { getGoal } from "../../store/goals.js";
import { listMetricsByGoal } from "../../store/metrics.js";
import type { GoalState } from "../../goal-manager/types.js";

afterAll(() => cleanup());
beforeEach(() => clearTestDb());

const futureDeadline = Date.now() + 30 * 24 * 60 * 60 * 1000;

function validGoalState(overrides: Partial<GoalState> = {}): GoalState {
  return {
    name: "Grow X followers",
    description: "Reach 1000 followers",
    metric: "follower_count",
    targetValue: 1000,
    currentValue: 0,
    deadline: futureDeadline,
    budget: 100,
    roleId: "content_creator",
    status: "active",
    ...overrides,
  };
}

describe("goal-manager", () => {
  describe("parseGoal", () => {
    it("should parse JSON input into GoalState", async () => {
      const input = JSON.stringify({
        name: "Test coverage",
        metric: "coverage_pct",
        targetValue: 80,
        deadline: futureDeadline,
        budget: 50,
        roleId: "engineer",
      });
      const result = await parseGoal(input);
      expect(result.goalState.name).toBe("Test coverage");
      expect(result.goalState.metric).toBe("coverage_pct");
      expect(result.goalState.targetValue).toBe(80);
      expect(result.goalState.roleId).toBe("engineer");
      expect(result.goalState.status).toBe("active");
      expect(result.rawInput).toBe(input);
    });

    it("should use LLM for non-JSON input", async () => {
      const result = await parseGoal("Grow my X followers to 1000");
      // LLM mock returns structured SMART fields
      expect(result.goalState.name).toBe("Test Goal");
      expect(result.goalState.description).toBe("A test goal");
      expect(result.goalState.metric).toBe("completion");
      expect(result.validationResult.isValid).toBe(true);
    });

    it("should validate parsed goal", async () => {
      const input = JSON.stringify({
        name: "Valid goal",
        description: "A valid goal description",
        metric: "count",
        targetValue: 100,
        deadline: futureDeadline,
        budget: 50,
        roleId: "engineer",
      });
      const result = await parseGoal(input);
      expect(result.validationResult.isValid).toBe(true);
    });
  });

  describe("validateSMART", () => {
    it("should pass for valid goal", () => {
      const result = validateSMART(validGoalState());
      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("should fail S: empty name", () => {
      const result = validateSMART(validGoalState({ name: "" }));
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain("S: name must be non-empty");
    });

    it("should fail S: empty description", () => {
      const result = validateSMART(validGoalState({ description: "" }));
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain("S: description must be non-empty");
    });

    it("should fail S: missing description", () => {
      const result = validateSMART(validGoalState({ description: undefined }));
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain("S: description must be non-empty");
    });

    it("should fail M: empty metric", () => {
      const result = validateSMART(validGoalState({ metric: "" }));
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain("M: metric must be specified");
    });

    it("should fail A: targetValue <= 0", () => {
      const result = validateSMART(validGoalState({ targetValue: 0 }));
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain("A: targetValue must be > 0");
    });

    it("should fail R: empty roleId", () => {
      const result = validateSMART(validGoalState({ roleId: "" }));
      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.startsWith("R:"))).toBe(true);
    });

    it("should fail T: deadline in the past", () => {
      const result = validateSMART(validGoalState({ deadline: Date.now() - 1000 }));
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain("T: deadline must be in the future");
    });

    it("should warn on zero budget", () => {
      const result = validateSMART(validGoalState({ budget: 0 }));
      expect(result.isValid).toBe(true);
      expect(result.warnings.length).toBeGreaterThan(0);
    });

    it("should collect multiple errors", () => {
      const result = validateSMART(validGoalState({ name: "", metric: "", targetValue: -1 }));
      expect(result.errors.length).toBe(3);
    });
  });

  describe("persistGoal", () => {
    it("should save goal to database and return Goal", () => {
      const goal = persistGoal(validGoalState());
      expect(goal.id).toBeDefined();
      expect(goal.name).toBe("Grow X followers");
      expect(goal.status).toBe("active");

      const stored = getGoal(goal.id);
      expect(stored).toBeDefined();
      expect(stored!.name).toBe("Grow X followers");
      expect(stored!.targetValue).toBe(1000);
    });
  });

  describe("buildMetricTree", () => {
    it("should create L0-L3 metric nodes", () => {
      const goal = persistGoal(validGoalState());
      const nodes = buildMetricTree(goal.id, "follower_count");

      expect(nodes).toHaveLength(4);
      expect(nodes[0].level).toBe("L0");
      expect(nodes[1].level).toBe("L1");
      expect(nodes[2].level).toBe("L2");
      expect(nodes[3].level).toBe("L3");

      // Verify parent-child chain
      expect(nodes[1].parentId).toBe(nodes[0].id);
      expect(nodes[2].parentId).toBe(nodes[1].id);
      expect(nodes[3].parentId).toBe(nodes[2].id);

      // Verify stored in DB
      const stored = listMetricsByGoal(goal.id);
      expect(stored).toHaveLength(4);
    });

    it("should assign decreasing weights L0 > L1 > L2 > L3", () => {
      const goal = persistGoal(validGoalState());
      const nodes = buildMetricTree(goal.id, "test_coverage");

      expect(nodes[0].weight).toBeGreaterThan(nodes[1].weight);
      expect(nodes[1].weight).toBeGreaterThan(nodes[2].weight);
      expect(nodes[2].weight).toBeGreaterThan(nodes[3].weight);
    });
  });

  describe("getGoalState", () => {
    it("should return GoalState from stored Goal", () => {
      const goal = persistGoal(validGoalState());
      const state = getGoalState(goal.id);
      expect(state).toBeDefined();
      expect(state!.name).toBe("Grow X followers");
      expect(state!.metric).toBe("follower_count");
      expect(state!.roleId).toBe("content_creator");
    });

    it("should return undefined for non-existent goal", () => {
      expect(getGoalState("nonexistent")).toBeUndefined();
    });
  });

  describe("updateGoalProgress", () => {
    it("should update currentValue", () => {
      const goal = persistGoal(validGoalState());
      updateGoalProgress(goal.id, 250);
      const state = getGoalState(goal.id);
      expect(state!.currentValue).toBe(250);
    });
  });
});
