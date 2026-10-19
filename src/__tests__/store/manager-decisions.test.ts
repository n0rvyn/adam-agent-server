import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();
vi.mock("../../store/db.js", () => ({ getDb: () => getTestDb(), closeDb: () => {} }));

import { recordManagerDecision, recordRoutingDecision, getManagerDecisions } from "../../store/manager-decisions.js";
import { createTask } from "../../store/tasks.js";

afterAll(() => cleanup());
beforeEach(() => clearTestDb());

function seedTask(id: string) {
  createTask({
    id, status: "pending", prompt: "test", createdAt: Date.now(),
    config: { timeout: 600, approvalRequired: [], approvalTimeout: 300 } as any,
  });
}

describe("store/manager-decisions", () => {
  it("records and retrieves a dispatch decision", () => {
    createRole({
      id: "agent-1", name: "Test", cagPrompt: "",
      preferences: {}, learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] }, memoryStreamId: "mem-1",
      status: "active", createdAt: Date.now(),
    });
    seedTask("md-task-1");
    recordManagerDecision("md-task-1", "agent-1", "dispatch", { expandedPermissions: {} }, "Task routed to engineer");

    const decisions = getManagerDecisions("md-task-1");
    expect(decisions).toHaveLength(1);
    expect(decisions[0].decisionType).toBe("dispatch");
    expect(decisions[0].reason).toBe("Task routed to engineer");
  });

  it("records boundary denial", () => {
    seedTask("md-task-2");
    recordManagerDecision("md-task-2", undefined, "boundary_denial", { requestedPath: "/etc" }, "Outside agent boundary");

    const decisions = getManagerDecisions("md-task-2");
    expect(decisions).toHaveLength(1);
    expect(decisions[0].decisionType).toBe("boundary_denial");
  });

  it("returns empty for unknown task", () => {
    expect(getManagerDecisions("nonexistent")).toHaveLength(0);
  });

  describe("recordRoutingDecision (admission audit)", () => {
    it("persists requirements, fitScore, candidates, and tieBreakReason", () => {
      createRole({
        id: "role-admit",
        name: "Admit",
        cagPrompt: "",
        preferences: {},
        learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
        memoryStreamId: "mem-a",
        status: "active",
        createdAt: Date.now(),
      });
      seedTask("md-admit-1");

      recordRoutingDecision({
        taskId: "md-admit-1",
        chosenRoleId: "role-admit",
        requirements: { tools: ["Read", "Write"], paths: [{ path: "/tmp/x", access: "rw" }] },
        fitScore: 0.87,
        tieBreakReason: "fitScore tie at 0.87; chose Admit by performanceScore",
        candidates: [
          { roleId: "role-admit", name: "Admit", fitScore: 0.87, fits: true },
          { roleId: "role-other", name: "Other", fitScore: 0.5, fits: false },
        ],
      });

      const decisions = getManagerDecisions("md-admit-1");
      expect(decisions).toHaveLength(1);
      const d = decisions[0];
      expect(d.decisionType).toBe("admission");
      expect(d.roleId).toBe("role-admit");
      expect(d.requirements).toEqual({ tools: ["Read", "Write"], paths: [{ path: "/tmp/x", access: "rw" }] });
      expect(d.fitScore).toBeCloseTo(0.87);
      expect(d.candidates).toHaveLength(2);
      expect(d.candidates?.[0].fits).toBe(true);
      expect(d.tieBreakReason).toContain("fitScore tie");
    });

    it("handles undefined tieBreakReason as null in storage", () => {
      createRole({
        id: "role-admit-2",
        name: "Admit2",
        cagPrompt: "",
        preferences: {},
        learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
        memoryStreamId: "mem-b",
        status: "active",
        createdAt: Date.now(),
      });
      seedTask("md-admit-2");

      recordRoutingDecision({
        taskId: "md-admit-2",
        chosenRoleId: "role-admit-2",
        requirements: {},
        fitScore: 1.0,
        candidates: [{ roleId: "role-admit-2", name: "Admit2", fitScore: 1.0, fits: true }],
      });

      const decisions = getManagerDecisions("md-admit-2");
      expect(decisions).toHaveLength(1);
      expect(decisions[0].tieBreakReason).toBeUndefined();
    });

    it("coexists with dispatch-type decisions on the same task", () => {
      createRole({
        id: "role-mix",
        name: "Mix",
        cagPrompt: "",
        preferences: {},
        learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
        memoryStreamId: "mem-c",
        status: "active",
        createdAt: Date.now(),
      });
      seedTask("md-admit-3");

      recordRoutingDecision({
        taskId: "md-admit-3",
        chosenRoleId: "role-mix",
        requirements: { tools: ["Read"] },
        fitScore: 0.9,
        candidates: [{ roleId: "role-mix", name: "Mix", fitScore: 0.9, fits: true }],
      });
      recordManagerDecision("md-admit-3", "role-mix", "dispatch", undefined, "routed");

      const decisions = getManagerDecisions("md-admit-3");
      expect(decisions).toHaveLength(2);
      const types = decisions.map((d) => d.decisionType).sort();
      expect(types).toEqual(["admission", "dispatch"]);
    });
  });
});
import { createRole } from "../../store/roles.js";
