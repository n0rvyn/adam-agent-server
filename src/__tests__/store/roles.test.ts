import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type BetterSqlite3 from "better-sqlite3";
import { vi } from "vitest";
import { setupTestDb, clearTestDb } from "../helpers/test-db.js";

let testDb: BetterSqlite3.Database;
let cleanup: () => void;

vi.mock("../../store/db.js", () => ({
  getDb: () => testDb,
  closeDb: () => {},
}));

import { createRole, getRole, getRoleByName, updateRole, listRoles, deleteRole, incrementRoleTaskSeq, getRoleTaskSeq } from "../../store/roles.js";
import type { Role } from "../../shared/types.js";

describe("store/roles", () => {
  beforeEach(() => {
    const result = setupTestDb();
    testDb = result.db;
    cleanup = result.cleanup;
    clearTestDb();
  });

  afterEach(() => cleanup());

  const makeRole = (overrides: Partial<Role> = {}): Role => ({
    id: `role-${Math.random().toString(36).slice(2)}`,
    name: "测试角色",
    cagPrompt: "Test CAG prompt",
    learnedRules: { stylePreferences: ["rule1", "rule2"], avoidedActions: [], pinnedParameters: [] },
    memoryStreamId: `mem-${Math.random().toString(36).slice(2)}`,
    status: "active",
    preferences: { effort: "medium" },
    createdAt: Date.now(),
    ...overrides,
  });

  describe("createRole + getRole", () => {
    it("creates and retrieves a role", () => {
      const role = makeRole({ name: "审慎者" });
      createRole(role);
      const found = getRole(role.id);
      expect(found).toBeDefined();
      expect(found!.id).toBe(role.id);
      expect(found!.name).toBe("审慎者");
      expect(found!.cagPrompt).toBe("Test CAG prompt");
      expect(found!.learnedRules).toEqual({ stylePreferences: ["rule1", "rule2"], avoidedActions: [], pinnedParameters: [] });
      expect(found!.status).toBe("active");
    });

    it("returns undefined for non-existent role", () => {
      const found = getRole("non-existent");
      expect(found).toBeUndefined();
    });
  });

  describe("getRoleByName", () => {
    it("retrieves a role by name", () => {
      const role = makeRole({ name: "敏捷者" });
      createRole(role);
      const found = getRoleByName("敏捷者");
      expect(found).toBeDefined();
      expect(found!.id).toBe(role.id);
    });

    it("returns undefined for non-existent name", () => {
      const found = getRoleByName("不存在的角色");
      expect(found).toBeUndefined();
    });
  });

  describe("updateRole", () => {
    it("updates CAG prompt and learned rules", () => {
      const role = makeRole();
      createRole(role);
      updateRole(role.id, {
        cagPrompt: "Updated prompt",
        learnedRules: { stylePreferences: ["newRule1"], avoidedActions: [], pinnedParameters: [] },
      });
      const updated = getRole(role.id);
      expect(updated!.cagPrompt).toBe("Updated prompt");
      expect(updated!.learnedRules).toEqual({ stylePreferences: ["newRule1"], avoidedActions: [], pinnedParameters: [] });
    });

    it("updates status to inactive", () => {
      const role = makeRole();
      createRole(role);
      updateRole(role.id, { performanceScore: 0.85 });
      const updated = getRole(role.id);
      expect(updated!.performanceScore).toBe(0.85);
    });
  });

  describe("listRoles", () => {
    it("lists all roles", () => {
      createRole(makeRole({ name: "审慎者" }));
      createRole(makeRole({ name: "敏捷者" }));
      createRole(makeRole({ name: "探索者" }));
      const roles = listRoles();
      expect(roles).toHaveLength(3);
    });

    it("filters by status", () => {
      createRole(makeRole({ name: "审慎者", status: "active" }));
      createRole(makeRole({ name: "敏捷者", status: "inactive" }));
      const activeRoles = listRoles("active");
      expect(activeRoles).toHaveLength(1);
      expect(activeRoles[0].name).toBe("审慎者");
    });

    it("respects limit and offset", () => {
      for (let i = 0; i < 5; i++) {
        createRole(makeRole({ name: `Role ${i}` }));
      }
      const page = listRoles(undefined, 2, 2);
      expect(page).toHaveLength(2);
    });
  });

  describe("absorbed fields (tool permissions, execution config)", () => {
    it("creates a role with all absorbed fields and reads them back", () => {
      const role = makeRole({
        name: "全能者",
        allowedTools: ["Read", "Write", "Bash"],
        disallowedTools: ["rm", "curl"],
        evaluationCriteria: { accuracy: 0.8, speed: 0.2 },
        executionMode: "isolated",
        model: "claude-sonnet-4-20250514",
        maxBudgetUsd: 10.5,
        approvalRequired: ["git push", "rm -rf"],
        source: "user",
      });
      createRole(role);

      const found = getRole(role.id);
      expect(found).toBeDefined();
      expect(found!.allowedTools).toEqual(["Read", "Write", "Bash"]);
      expect(found!.disallowedTools).toEqual(["rm", "curl"]);
      expect(found!.evaluationCriteria).toEqual({ accuracy: 0.8, speed: 0.2 });
      expect(found!.executionMode).toBe("isolated");
      expect(found!.model).toBe("claude-sonnet-4-20250514");
      expect(found!.maxBudgetUsd).toBe(10.5);
      expect(found!.approvalRequired).toEqual(["git push", "rm -rf"]);
      expect(found!.source).toBe("user");
    });

    it("defaults absorbed fields to undefined when not provided", () => {
      const role = makeRole({ name: "基础者" });
      createRole(role);

      const found = getRole(role.id);
      expect(found).toBeDefined();
      expect(found!.allowedTools).toBeUndefined();
      expect(found!.disallowedTools).toBeUndefined();
      expect(found!.evaluationCriteria).toBeUndefined();
      expect(found!.executionMode).toBeUndefined();
      expect(found!.model).toBeUndefined();
      expect(found!.maxBudgetUsd).toBeUndefined();
      expect(found!.approvalRequired).toBeUndefined();
      expect(found!.source).toBeUndefined();
    });

    it("updates individual absorbed fields via updateRole", () => {
      const role = makeRole({ name: "变化者" });
      createRole(role);

      updateRole(role.id, { allowedTools: ["Read"] });
      expect(getRole(role.id)!.allowedTools).toEqual(["Read"]);

      updateRole(role.id, { model: "claude-opus-4-20250514" });
      expect(getRole(role.id)!.model).toBe("claude-opus-4-20250514");
      // allowedTools should still be set
      expect(getRole(role.id)!.allowedTools).toEqual(["Read"]);

      updateRole(role.id, { maxBudgetUsd: 25.0 });
      expect(getRole(role.id)!.maxBudgetUsd).toBe(25.0);

      updateRole(role.id, { evaluationCriteria: { quality: 1.0 } });
      expect(getRole(role.id)!.evaluationCriteria).toEqual({ quality: 1.0 });

      updateRole(role.id, { executionMode: "inline" });
      expect(getRole(role.id)!.executionMode).toBe("inline");

      updateRole(role.id, { source: "system" });
      expect(getRole(role.id)!.source).toBe("system");

      updateRole(role.id, { approvalRequired: ["curl.*POST"] });
      expect(getRole(role.id)!.approvalRequired).toEqual(["curl.*POST"]);

      updateRole(role.id, { disallowedTools: ["dangerous-tool"] });
      expect(getRole(role.id)!.disallowedTools).toEqual(["dangerous-tool"]);
    });

    it("persists and updates osCapabilities", () => {
      const role = makeRole({
        name: "系统操作者",
        osCapabilities: [
          { id: "automation", targets: ["com.apple.mail", "com.apple.systemevents"] },
          { id: "accessibility" },
        ],
      });
      createRole(role);

      expect(getRole(role.id)!.osCapabilities).toEqual([
        { id: "accessibility" },
        { id: "automation", targets: ["com.apple.mail", "com.apple.systemevents"] },
      ]);

      updateRole(role.id, {
        osCapabilities: [{ id: "automation", targets: ["com.apple.mail"] }],
      });
      expect(getRole(role.id)!.osCapabilities).toEqual([
        { id: "automation", targets: ["com.apple.mail"] },
      ]);

      updateRole(role.id, { osCapabilities: [] });
      expect(getRole(role.id)!.osCapabilities).toBeUndefined();
    });
  });

  describe("deleteRole", () => {
    it("deletes a role", () => {
      const role = makeRole();
      createRole(role);
      deleteRole(role.id);
      const found = getRole(role.id);
      expect(found).toBeUndefined();
    });

    it("deletes role completely", () => {
      const role = makeRole();
      createRole(role);

      deleteRole(role.id);

      const found = getRole(role.id);
      expect(found).toBeUndefined();
    });
  });

  describe("task_seq (belief evolution v3 clock)", () => {
    it("getRoleTaskSeq returns 0 for an unknown role", () => {
      expect(getRoleTaskSeq("role-does-not-exist")).toBe(0);
    });

    it("getRoleTaskSeq returns 0 for a newly created role", () => {
      const role = makeRole();
      createRole(role);
      expect(getRoleTaskSeq(role.id)).toBe(0);
    });

    it("incrementRoleTaskSeq bumps the counter monotonically", () => {
      const role = makeRole();
      createRole(role);
      incrementRoleTaskSeq(role.id);
      expect(getRoleTaskSeq(role.id)).toBe(1);
      incrementRoleTaskSeq(role.id);
      incrementRoleTaskSeq(role.id);
      expect(getRoleTaskSeq(role.id)).toBe(3);
    });

    it("incrementRoleTaskSeq on an unknown role is a silent no-op (no throw, no row created)", () => {
      expect(() => incrementRoleTaskSeq("role-unknown")).not.toThrow();
      expect(getRoleTaskSeq("role-unknown")).toBe(0);
    });

    it("task_seq is isolated per role", () => {
      const a = makeRole({ name: "role-a" });
      const b = makeRole({ name: "role-b" });
      createRole(a);
      createRole(b);
      incrementRoleTaskSeq(a.id);
      incrementRoleTaskSeq(a.id);
      incrementRoleTaskSeq(b.id);
      expect(getRoleTaskSeq(a.id)).toBe(2);
      expect(getRoleTaskSeq(b.id)).toBe(1);
    });
  });
});
