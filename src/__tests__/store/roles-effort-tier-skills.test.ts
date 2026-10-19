import { afterAll, beforeEach, describe, it, expect, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

import { createRole, getRole, updateRole } from "../../store/roles.js";

afterAll(() => cleanup());
beforeEach(() => clearTestDb());

describe("Role effortTier and skills", () => {
  it("inserts and retrieves role with effortTier: 'high'", () => {
    createRole({
      id: "role-effort-test",
      name: "Effort Test",
      cagPrompt: "Test CAG",
      learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
      memoryStreamId: "mem-abc",
      status: "active",
      preferences: {},
      createdAt: Date.now(),
      effortTier: "high",
    });
    const role = getRole("role-effort-test");
    expect(role?.effortTier).toBe("high");
  });

  it("inserts and retrieves role with skills: ['pdf']", () => {
    createRole({
      id: "role-skills-array-test",
      name: "Skills Array Test",
      cagPrompt: "Test CAG",
      learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
      memoryStreamId: "mem-def",
      status: "active",
      preferences: {},
      createdAt: Date.now(),
      skills: ["pdf"],
    });
    const role = getRole("role-skills-array-test");
    expect(role?.skills).toEqual(["pdf"]);
  });

  it("inserts and retrieves role with skills: 'all'", () => {
    createRole({
      id: "role-skills-all-test",
      name: "Skills All Test",
      cagPrompt: "Test CAG",
      learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
      memoryStreamId: "mem-ghi",
      status: "active",
      preferences: {},
      createdAt: Date.now(),
      skills: "all",
    });
    const role = getRole("role-skills-all-test");
    expect(role?.skills).toBe("all");
  });

  it("updateRole({effortTier: undefined}) clears effortTier", () => {
    createRole({
      id: "role-effort-clear-test",
      name: "Effort Clear Test",
      cagPrompt: "Test CAG",
      learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
      memoryStreamId: "mem-jkl",
      status: "active",
      preferences: {},
      createdAt: Date.now(),
      effortTier: "high",
    });
    updateRole("role-effort-clear-test", { effortTier: undefined });
    const role = getRole("role-effort-clear-test");
    expect(role?.effortTier).toBeUndefined();
  });
});
