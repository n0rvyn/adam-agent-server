import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

import { createGoal } from "../../store/goals.js";
import { createRole } from "../../store/roles.js";
import { expandGoalTemplateSteps, parseGoalReviewResult } from "../../scheduler/goal-template-expansion.js";
import type { Goal, Role, TaskTemplate } from "../../shared/types.js";

afterAll(() => cleanup());
beforeEach(() => clearTestDb());

function seedRole(id: string): void {
  const role: Role = {
    id,
    name: id,
    cagPrompt: "test role",
    learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
    memoryStreamId: `ms-${id}`,
    status: "active",
    preferences: {},
    createdAt: Date.now(),
  };
  createRole(role);
}

function seedGoal(id: string, overrides: Partial<Goal> = {}): Goal {
  const goal: Goal = {
    id,
    name: `Goal ${id}`,
    description: "Goal description",
    roleId: "role-goal",
    metricType: "completion",
    targetValue: 1,
    currentValue: 0,
    deadline: Date.now() + 86_400_000,
    budgetUsd: 5,
    status: "active",
    createdAt: Date.now(),
    ...overrides,
  };
  createGoal(goal);
  return goal;
}

function template(overrides: Partial<TaskTemplate> = {}): TaskTemplate {
  return {
    id: "tmpl-goal",
    name: "Goal Template",
    trigger: { type: "manual" },
    steps: [{ id: "write", prompt: "Write report", roleId: "role-user" }],
    enabled: true,
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("goal template expansion", () => {
  it("returns original steps when the Template has no Goals", () => {
    const result = expandGoalTemplateSteps(template());

    expect(result.goalSteps).toEqual([]);
    expect(result.steps).toEqual([{ id: "write", prompt: "Write report", roleId: "role-user" }]);
  });

  it("adds decompose and review steps for one Goal and rewrites root dependencies", () => {
    seedRole("role-goal");
    seedGoal("goal-1");

    const result = expandGoalTemplateSteps(template({ goalIds: ["goal-1"] }));

    expect(result.steps.map((step) => step.id)).toEqual(["goal-1-decompose", "write", "goal-1-review"]);
    expect(result.steps[1].dependsOn).toEqual(["goal-1-decompose"]);
    expect(result.steps[1].prompt).toContain("{{goal-1-decompose.result}}");
    expect(result.steps[2].dependsOn).toEqual(["write"]);
    expect(result.steps[2].prompt).toContain('"goalAchieved"');
  });

  it("adds four synthetic steps for two Goals", () => {
    seedGoal("goal-a");
    seedGoal("goal-b");

    const result = expandGoalTemplateSteps(template({
      rolePreference: "role-template",
      steps: [{ id: "draft", prompt: "Draft" }],
      goalIds: ["goal-a", "goal-b"],
    }));

    expect(result.steps.map((step) => step.id)).toEqual([
      "goal-1-decompose",
      "goal-2-decompose",
      "draft",
      "goal-1-review",
      "goal-2-review",
    ]);
    expect(result.steps[2].dependsOn).toEqual(["goal-1-decompose", "goal-2-decompose"]);
  });

  it("preserves existing user dependencies", () => {
    seedGoal("goal-1");

    const result = expandGoalTemplateSteps(template({
      rolePreference: "role-template",
      goalIds: ["goal-1"],
      steps: [
        { id: "research", prompt: "Research" },
        { id: "write", prompt: "Write", dependsOn: ["research"] },
      ],
    }));

    expect(result.steps.find((step) => step.id === "research")?.dependsOn).toEqual(["goal-1-decompose"]);
    expect(result.steps.find((step) => step.id === "write")?.dependsOn).toEqual(["research"]);
    expect(result.steps.find((step) => step.id === "goal-1-review")?.dependsOn).toEqual(["write"]);
  });

  it("skips missing Goal IDs", () => {
    seedGoal("goal-found");

    const result = expandGoalTemplateSteps(template({
      rolePreference: "role-template",
      goalIds: ["missing", "goal-found"],
    }));

    expect(result.goalSteps).toHaveLength(1);
    expect(result.goalSteps[0].goal.id).toBe("goal-found");
    expect(result.steps.map((step) => step.id)).toEqual(["goal-1-decompose", "write", "goal-1-review"]);
  });

  it("avoids collisions between synthetic Goal step IDs and user step IDs", () => {
    seedGoal("goal-1");

    const result = expandGoalTemplateSteps(template({
      rolePreference: "role-template",
      goalIds: ["goal-1"],
      steps: [
        { id: "goal-1-decompose", prompt: "User-owned step" },
        { id: "write", prompt: "Write" },
      ],
    }));

    expect(result.goalSteps[0].decomposeStepId).toBe("goal-1-decompose-2");
    expect(result.steps.map((step) => step.id)).toEqual([
      "goal-1-decompose-2",
      "goal-1-decompose",
      "write",
      "goal-1-review",
    ]);
    expect(result.steps.find((step) => step.id === "goal-1-decompose")?.prompt).toContain("User-owned step");
    expect(result.steps.find((step) => step.id === "goal-1-decompose")?.dependsOn).toEqual(["goal-1-decompose-2"]);
  });

  it("parses bounded review JSON and rejects malformed output", () => {
    expect(parseGoalReviewResult('{"goalAchieved":true,"currentValue":1,"status":"completed","reason":"done"}')).toEqual({
      goalAchieved: true,
      currentValue: 1,
      status: "completed",
      reason: "done",
    });
    expect(parseGoalReviewResult("not json")).toBeUndefined();
    expect(parseGoalReviewResult('{"status":"paused","currentValue":"1"}')).toBeUndefined();
  });
});
