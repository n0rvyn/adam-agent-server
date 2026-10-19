import { describe, it, expect } from "vitest";

describe("isPresetRole", () => {
  it("returns true for Engineer", async () => {
    const { isPresetRole } = await import("../../store/role-presets.js");
    expect(isPresetRole({ name: "Engineer" })).toBe(true);
  });

  it("returns true for adam-automator", async () => {
    const { isPresetRole } = await import("../../store/role-presets.js");
    expect(isPresetRole({ name: "adam-automator" })).toBe(true);
  });

  it("returns true for Chat Manager", async () => {
    const { isPresetRole } = await import("../../store/role-presets.js");
    expect(isPresetRole({ name: "Chat Manager" })).toBe(true);
  });

  it("returns false for a custom role", async () => {
    const { isPresetRole } = await import("../../store/role-presets.js");
    expect(isPresetRole({ name: "My Custom Role" })).toBe(false);
  });

  it("returns true when source is 'system'", async () => {
    const { isPresetRole } = await import("../../store/role-presets.js");
    expect(isPresetRole({ name: "anything", source: "system" })).toBe(true);
  });

  it("returns false when source is 'user'", async () => {
    const { isPresetRole } = await import("../../store/role-presets.js");
    expect(isPresetRole({ name: "anything", source: "user" })).toBe(false);
  });

  it("returns false when name matches a preset but source is 'user' (explicit user source overrides name match)", async () => {
    const { isPresetRole } = await import("../../store/role-presets.js");
    expect(isPresetRole({ name: "Engineer", source: "user" })).toBe(false);
  });
});

import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe as _describe, it as _it, expect as _expect, vi, beforeEach, afterEach } from "vitest";
import type BetterSqlite3 from "better-sqlite3";
import { setupTestDb, clearTestDb } from "../helpers/test-db.js";

let testDb: BetterSqlite3.Database;
let cleanup: () => void;

vi.mock("../../store/db.js", () => ({
  getDb: () => testDb,
  closeDb: () => {},
}));

import { listRoles } from "../../store/roles.js";
import { getRoleWorkspacePath } from "../../store/role-workspace.js";

_describe("store/role-presets", () => {
  beforeEach(() => {
    const result = setupTestDb();
    testDb = result.db;
    cleanup = result.cleanup;
    clearTestDb();
  });

  afterEach(() => cleanup());

  _describe("initializeDefaultRoles", () => {
    _it("seeds all preset roles (8 total: 4 default + Chat Manager + adam-automator + Feature Miner + Mistake Digester)", async () => {
      const { initializeDefaultRoles } = await import("../../store/role-presets.js");
      const roles = initializeDefaultRoles();
      _expect(roles).toHaveLength(8);
      const names = new Set(roles.map((r: { name: string }) => r.name));
      _expect(names).toEqual(new Set(["Engineer", "Reviewer", "Researcher", "Writer", "Chat Manager", "adam-automator", "Feature Miner", "Mistake Digester"]));
    });

    _it("sets CAG prompt for each role", async () => {
      const { initializeDefaultRoles } = await import("../../store/role-presets.js");
      const roles = initializeDefaultRoles();
      for (const role of roles) {
        _expect(role.cagPrompt.length).toBeGreaterThan(0);
      }
    });

    _it("is active by default", async () => {
      const { initializeDefaultRoles } = await import("../../store/role-presets.js");
      const roles = initializeDefaultRoles();
      const prudentRole = roles.find((r: { name: string }) => r.name === "Engineer")!;
      _expect(prudentRole.status).toBe("active");
    });

    _it("idempotent — second call returns existing roles without creating new ones", async () => {
      const { initializeDefaultRoles } = await import("../../store/role-presets.js");
      initializeDefaultRoles();
      const dbCountBefore = listRoles().length;
      initializeDefaultRoles();
      const dbCountAfter = listRoles().length;
      _expect(dbCountAfter).toBe(dbCountBefore);
    });

    _it("roles are persisted in DB", async () => {
      const { initializeDefaultRoles } = await import("../../store/role-presets.js");
      initializeDefaultRoles();
      const dbRoles = listRoles();
      // 8 in DB: 4 default + chat-manager + adam-automator + feature-miner + mistake-digester
      _expect(dbRoles).toHaveLength(8);
    });

    _it("writes preset role workspace files under ADAM_TEST_DIR", async () => {
      const runtimeRoot = process.env.ADAM_TEST_DIR;
      _expect(runtimeRoot).toBeDefined();
      const { initializeDefaultRoles } = await import("../../store/role-presets.js");

      initializeDefaultRoles();

      const workspacePath = getRoleWorkspacePath("Engineer");
      _expect(workspacePath.startsWith(join(runtimeRoot!, "roles"))).toBe(true);
      _expect(existsSync(join(workspacePath, "CLAUDE.md"))).toBe(true);
      _expect(existsSync(join(workspacePath, ".claude", "settings.json"))).toBe(true);
    });
  });
});
