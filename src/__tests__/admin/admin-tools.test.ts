import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

vi.mock("../../config/index.js", () => ({
  getDefaults: () => ({
    plugins: [],
    allowedTools: ["Read", "Write", "Edit", "Bash"],
    disallowedTools: [],
    approvalRequired: [],
    maxBudgetUsd: 5.0,
  }),
}));

import {
  viewRolePermissions,
  modifyRolePermissions,
  adminRetireRole,
  adminCreateRole,
  viewAuditLog,
  viewApprovalRules,
  adminCreateApprovalRule,
  adminDeleteApprovalRule,
  executeAdminTool,
} from "../../admin/admin-tools.js";
import { listEvolutionAudit } from "../../store/evolution-audit.js";
import type { } from "../../shared/types.js";

afterAll(() => cleanup());
beforeEach(() => clearTestDb());

function seedAgent(id: string, _role = "engineer"): void {
  createRole({
    id, name: `Agent ${id}`, cagPrompt: "",
    preferences: {}, learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] }, memoryStreamId: `mem-${id}`,
    status: "active", createdAt: Date.now(),
  });
}

describe("admin/admin-tools", () => {
  describe("viewRolePermissions", () => {
    it("returns role's permission fields for existing role", () => {
      seedAgent("agent-view");
      const result = viewRolePermissions("agent-view");
      expect(result.success).toBe(true);
      expect((result.data as any).roleId).toBe("agent-view");
    });

    it("returns error for non-existent role", () => {
      const result = viewRolePermissions("not-exist");
      expect(result.success).toBe(false);
      expect(result.error).toContain("not found");
    });
  });

  describe("modifyRolePermissions", () => {
    it("updates role permissions and creates audit record", () => {
      seedAgent("admin-1", "admin");
      seedAgent("target-1");
      const result = modifyRolePermissions("admin-1", "target-1", {
        allowedTools: ["Read", "Write"],
      });
      expect(result.success).toBe(true);

      const audits = listEvolutionAudit();
      expect(audits.some(a => a.roleId === "target-1" && a.source === "admin")).toBe(true);
    });

    it("blocks self-modification and creates audit record", () => {
      seedAgent("self-mod", "admin");
      const result = modifyRolePermissions("self-mod", "self-mod", {
        maxBudgetUsd: 1000,
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("Cannot modify your own permissions");

      const audits = listEvolutionAudit();
      expect(audits.some(a => a.diff.includes("BLOCKED"))).toBe(true);
    });
  });

  describe("adminRetireRole", () => {
    it("retires a role and creates audit record", () => {
      seedAgent("admin-3", "admin");
      seedAgent("target-retire");
      const result = adminRetireRole("admin-3", "target-retire");
      expect(result.success).toBe(true);
      expect((result.data as any).status).toBe("retired");

      const audits = listEvolutionAudit();
      expect(audits.some(a => a.roleId === "target-retire" && a.source === "admin")).toBe(true);
    });

    it("returns error for non-existent role", () => {
      seedAgent("admin-4", "admin");
      const result = adminRetireRole("admin-4", "not-exist");
      expect(result.success).toBe(false);
    });
  });

  describe("adminCreateRole", () => {
    it("creates a role with cagPrompt and creates audit record", () => {
      const result = adminCreateRole("TestRole", "engineer", "A test CAG prompt");
      expect(result.success).toBe(true);
      const newId = (result.data as any).roleId;
      expect(newId).toBeDefined();

      const audits = listEvolutionAudit();
      expect(audits.some(a => a.roleId === newId && a.source === "admin")).toBe(true);
    });
  });

  describe("approval rules", () => {
    it("creates, lists, and deletes approval rules", () => {
      const createResult = adminCreateApprovalRule(undefined, "deploy.*", "high");
      expect(createResult.success).toBe(true);

      const listResult = viewApprovalRules();
      expect(listResult.success).toBe(true);
      expect((listResult.data as any[]).length).toBe(1);

      const ruleId = (createResult.data as any).id;
      const deleteResult = adminDeleteApprovalRule(ruleId);
      expect(deleteResult.success).toBe(true);

      const afterDelete = viewApprovalRules();
      expect((afterDelete.data as any[]).length).toBe(0);
    });
  });

  describe("executeAdminTool", () => {
    it("dispatches to viewRolePermissions correctly", () => {
      seedAgent("dispatch-target");
      const result = executeAdminTool("viewRolePermissions", { targetRoleId: "dispatch-target" });
      expect(result.success).toBe(true);
      expect((result.data as any).roleId).toBe("dispatch-target");
    });

    it("returns error for unknown tool", () => {
      const result = executeAdminTool("unknownTool", {});
      expect(result.success).toBe(false);
      expect(result.error).toContain("Unknown admin tool");
    });
  });
});
import { createRole, getRole } from "../../store/roles.js";
