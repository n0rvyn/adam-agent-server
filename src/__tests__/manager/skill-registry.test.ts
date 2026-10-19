/**
 * Unit tests for SkillRegistry and role-workspace-skills.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { SkillRegistry } from "../../manager/skill-registry.js";

import type { Role, InstalledPluginEntry, PluginManifest } from "../../shared/types.js";
import type { RolePluginCapabilities } from "../../lib/role-capabilities.js";
import type { WorkspaceSkill } from "../../lib/role-workspace-skills.js";

const mockListInstalledPlugins = vi.hoisted(() => vi.fn<() => InstalledPluginEntry[]>(() => []));
const mockGetPluginManifest = vi.hoisted(() => vi.fn<() => PluginManifest | null>(() => null));
const mockListRoles = vi.hoisted(() => vi.fn<() => Role[]>(() => []));
const mockResolveRolePluginCapabilities = vi.hoisted(() => vi.fn<() => RolePluginCapabilities>(() => ({ plugins: [] })));
const mockReadRoleWorkspaceSkills = vi.hoisted(() => vi.fn<() => WorkspaceSkill[]>(() => []));
const mockGetRoleWorkspacePath = vi.hoisted(() => vi.fn<() => string>(() => "/mock/workspace"));

vi.mock("../../store/plugin-registry.js", () => ({
  listInstalledPlugins: mockListInstalledPlugins,
  getPluginManifest: mockGetPluginManifest,
}));

vi.mock("../../store/roles.js", () => ({
  listRoles: mockListRoles,
}));

vi.mock("../../lib/role-capabilities.js", () => ({
  resolveRolePluginCapabilities: mockResolveRolePluginCapabilities,
}));

vi.mock("../../lib/role-workspace-skills.js", () => ({
  readRoleWorkspaceSkills: mockReadRoleWorkspaceSkills,
}));

vi.mock("../../store/role-workspace.js", () => ({
  getRoleWorkspacePath: mockGetRoleWorkspacePath,
}));

// Module-level DB mock for health tests
const mockDbPrepare = vi.fn(() => ({ all: vi.fn(() => []), get: vi.fn(), run: vi.fn() }));
vi.mock("../../store/db.js", () => ({
  getDb: vi.fn(() => ({ prepare: mockDbPrepare })),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SkillRegistry", () => {
  beforeEach(() => {
    SkillRegistry.invalidateCache();
    vi.clearAllMocks();
  });

  describe("build()", () => {
    it("returns empty array when no plugins or roles exist", () => {
      mockListRoles.mockReturnValue([]);
      mockListInstalledPlugins.mockReturnValue([]);

      const result = SkillRegistry.build(true);

      expect(result).toEqual([]);
    });

    it("aggregates plugin skills", () => {
      mockListRoles.mockReturnValue([
        { id: "role-1", name: "TestRole", status: "active" } as Role,
      ]);
      mockListInstalledPlugins.mockReturnValue([
        { id: "test-plugin", name: "test-plugin", enabled: true, installPath: "/plugins/test-plugin" } as InstalledPluginEntry,
      ]);
      mockGetPluginManifest.mockReturnValue({
        name: "test-plugin",
        skills: [
          { name: "skill-one", description: "First skill description" },
          { name: "skill-two", description: "Second skill description" },
        ],
        agents: [],
        mcpServers: [],
        hooks: [],
        lspServers: [],
      } as PluginManifest);
      mockResolveRolePluginCapabilities.mockReturnValue({
        plugins: [{ name: "test-plugin", skills: [{ name: "skill-one", description: "First" }, { name: "skill-two", description: "Second" }], agents: [], mcpServers: [], hooks: [] }],
      } as RolePluginCapabilities);
      mockReadRoleWorkspaceSkills.mockReturnValue([]);

      const result = SkillRegistry.build(true);

      expect(result).toHaveLength(2);
      expect(result.map((s) => s.name)).toContain("skill-one");
      expect(result.map((s) => s.name)).toContain("skill-two");
      const skillOne = result.find((s) => s.name === "skill-one")!;
      expect(skillOne.source).toBe("plugin");
      expect(skillOne.sourceName).toBe("test-plugin");
    });

    it("aggregates workspace skills", () => {
      mockListRoles.mockReturnValue([
        { id: "role-1", name: "IT狗", status: "active" } as Role,
      ]);
      mockListInstalledPlugins.mockReturnValue([]);
      mockReadRoleWorkspaceSkills.mockReturnValue([
        { name: "minimax-quota", description: "Query MiniMax API quota", roleName: "IT狗", roleId: "role-1", path: "/path", rawFrontmatter: {} } as WorkspaceSkill,
      ]);

      const result = SkillRegistry.build(true);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("minimax-quota");
      expect(result[0].source).toBe("role-workspace");
    });

    it("marks adam-automator workspace skills with source=adam-automator", () => {
      mockListRoles.mockReturnValue([
        { id: "automator-role", name: "adam-automator", status: "active" } as Role,
      ]);
      mockListInstalledPlugins.mockReturnValue([]);
      mockReadRoleWorkspaceSkills.mockReturnValue([
        { name: "aggregate_feature", description: "Aggregate feature values", roleName: "adam-automator", roleId: "automator-role", path: "/path", rawFrontmatter: {} } as WorkspaceSkill,
      ]);

      const result = SkillRegistry.build(true);

      expect(result).toHaveLength(1);
      expect(result[0].source).toBe("adam-automator");
      expect(result[0].sourceName).toBe("adam-automator");
    });
  });

  describe("query()", () => {
    beforeEach(() => {
      mockListRoles.mockReturnValue([
        { id: "role-1", name: "IT狗", status: "active" } as Role,
      ]);
      mockListInstalledPlugins.mockReturnValue([
        { id: "quota-plugin", name: "quota-plugin", enabled: true, installPath: "/plugins/quota" } as InstalledPluginEntry,
      ]);
      mockGetPluginManifest.mockReturnValue({
        name: "quota-plugin",
        skills: [
          { name: "minimax-quota", description: "Query MiniMax API quota and usage" },
        ],
        agents: [],
        mcpServers: [],
        hooks: [],
        lspServers: [],
      } as PluginManifest);
      mockResolveRolePluginCapabilities.mockReturnValue({
        plugins: [{ name: "quota-plugin", skills: [{ name: "minimax-quota", description: "Query MiniMax API quota" }], agents: [], mcpServers: [], hooks: [] }],
      } as RolePluginCapabilities);
      mockReadRoleWorkspaceSkills.mockReturnValue([]);
    });

    it("filters by text query", () => {
      const result = SkillRegistry.query({ query: "minimax" });

      expect(result.some((s) => s.name === "minimax-quota")).toBe(true);
    });

    it("filters by roleId", () => {
      const result = SkillRegistry.query({ roleId: "role-1" });

      expect(result.every((s) => s.boundRoles.some((r) => r.roleId === "role-1"))).toBe(true);
    });

    it("filters by source", () => {
      const result = SkillRegistry.query({ source: "plugin" });

      expect(result.every((s) => s.source === "plugin")).toBe(true);
    });

    it("combines filters", () => {
      const result = SkillRegistry.query({ query: "minimax", roleId: "role-1", source: "plugin" });

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("minimax-quota");
    });

    it("returns empty array for no match", () => {
      const result = SkillRegistry.query({ query: "nonexistent-skill-xyz" });

      expect(result).toEqual([]);
    });
  });

  describe("match()", () => {
    beforeEach(() => {
      mockListRoles.mockReturnValue([
        { id: "role-1", name: "IT狗", status: "active" } as Role,
      ]);
      mockListInstalledPlugins.mockReturnValue([
        { id: "quota-plugin", name: "quota-plugin", enabled: true, installPath: "/plugins/quota" } as InstalledPluginEntry,
      ]);
      mockGetPluginManifest.mockReturnValue({
        name: "quota-plugin",
        skills: [
          { name: "minimax-quota", description: "Query MiniMax API quota and usage" },
        ],
        agents: [],
        mcpServers: [],
        hooks: [],
        lspServers: [],
      } as PluginManifest);
      mockResolveRolePluginCapabilities.mockReturnValue({
        plugins: [{ name: "quota-plugin", skills: [{ name: "minimax-quota", description: "Query MiniMax API quota" }], agents: [], mcpServers: [], hooks: [] }],
      } as RolePluginCapabilities);
      mockReadRoleWorkspaceSkills.mockReturnValue([]);
    });

    it("matches minimax-quota for '查 MiniMax 额度'", () => {
      const result = SkillRegistry.match("查 MiniMax 额度");

      expect(result.length).toBeGreaterThan(0);
      expect(result[0].name).toBe("minimax-quota");
    });

    it("returns topK results", () => {
      mockListInstalledPlugins.mockReturnValue([
        { id: "p1", name: "p1", enabled: true, installPath: "/p1" } as InstalledPluginEntry,
        { id: "p2", name: "p2", enabled: true, installPath: "/p2" } as InstalledPluginEntry,
      ]);
      mockGetPluginManifest
        .mockReturnValueOnce({
          name: "p1",
          skills: [{ name: "web-search", description: "Web search capability" }],
          agents: [], mcpServers: [], hooks: [], lspServers: [],
        } as PluginManifest)
        .mockReturnValueOnce({
          name: "p2",
          skills: [{ name: "web-fetch", description: "Web fetch capability" }],
          agents: [], mcpServers: [], hooks: [], lspServers: [],
        } as PluginManifest);
      SkillRegistry.invalidateCache();

      const result = SkillRegistry.match("search the web", 2);

      expect(result.length).toBeLessThanOrEqual(2);
    });

    it("returns empty array for non-matching query", () => {
      const result = SkillRegistry.match("xyzzyfoobar");

      expect(result).toEqual([]);
    });
  });

  describe("caching", () => {
    it("caches results and does not rebuild on repeated calls", () => {
      mockListRoles.mockReturnValue([]);
      mockListInstalledPlugins.mockReturnValue([]);

      SkillRegistry.build();
      SkillRegistry.build();

      expect(mockListRoles).toHaveBeenCalledTimes(1);
    });

    it("forceRefresh bypasses cache", () => {
      mockListRoles.mockReturnValue([]);
      mockListInstalledPlugins.mockReturnValue([]);

      SkillRegistry.build();
      SkillRegistry.build(true);

      expect(mockListRoles).toHaveBeenCalledTimes(2);
    });

    it("invalidateCache clears the cache", () => {
      mockListRoles.mockReturnValue([]);
      mockListInstalledPlugins.mockReturnValue([]);

      SkillRegistry.build();
      SkillRegistry.invalidateCache();
      SkillRegistry.build();

      expect(mockListRoles).toHaveBeenCalledTimes(2);
    });
  });

  describe("errorPatterns from plugin manifest", () => {
    it("populates errorPatterns from plugin manifest", () => {
      mockListRoles.mockReturnValue([
        { id: "role-1", name: "IT狗", status: "active" } as Role,
      ]);
      mockListInstalledPlugins.mockReturnValue([
        { id: "test-plugin", name: "test-plugin", enabled: true, installPath: "/plugins/test-plugin" } as InstalledPluginEntry,
      ]);
      mockGetPluginManifest.mockReturnValue({
        name: "test-plugin",
        skills: [
          {
            name: "minimax-quota",
            description: "Query MiniMax API quota",
            error_patterns: [
              { pattern: "401", category: "AUTH", user_action: "Update API key" },
              { pattern: "429", category: "RATE_LIMIT", user_action: "Wait and retry" },
            ],
          },
        ],
        agents: [],
        mcpServers: [],
        hooks: [],
        lspServers: [],
      } as PluginManifest);
      mockResolveRolePluginCapabilities.mockReturnValue({
        plugins: [{ name: "test-plugin", skills: [{ name: "minimax-quota", description: "Query" }], agents: [], mcpServers: [], hooks: [] }],
      } as RolePluginCapabilities);
      mockReadRoleWorkspaceSkills.mockReturnValue([]);

      const result = SkillRegistry.build(true);

      expect(result).toHaveLength(1);
      expect(result[0].errorPatterns).toHaveLength(2);
      expect(result[0].errorPatterns![0].category).toBe("AUTH");
      expect(result[0].errorPatterns![1].category).toBe("RATE_LIMIT");
    });

    it("omits errorPatterns when not present in manifest", () => {
      mockListRoles.mockReturnValue([]);
      mockListInstalledPlugins.mockReturnValue([
        { id: "test-plugin", name: "test-plugin", enabled: true, installPath: "/plugins/test-plugin" } as InstalledPluginEntry,
      ]);
      mockGetPluginManifest.mockReturnValue({
        name: "test-plugin",
        skills: [{ name: "skill-one", description: "Description" }],
        agents: [],
        mcpServers: [],
        hooks: [],
        lspServers: [],
      } as PluginManifest);
      mockReadRoleWorkspaceSkills.mockReturnValue([]);

      const result = SkillRegistry.build(true);

      expect(result).toHaveLength(1);
      expect(result[0].errorPatterns).toBeUndefined();
    });
  });

  describe("computeSkillHealthMap (indirect via build)", () => {
    // We test the health population via the public API. The computeSkillHealthMap
    // helper is internal to skill-registry.ts. Since getDb is called at module
    // scope inside SkillRegistry.build(), we verify health by checking the
    // result of build() when role_scores data is available.
    // These tests verify the build() output includes health data when present.

    it("health is undefined when skill has no history (no db mock needed)", () => {
      // With the hoisted mocks (no db rows), health should be absent
      mockListRoles.mockReturnValue([
        { id: "role-1", name: "IT狗", status: "active" } as Role,
      ]);
      mockListInstalledPlugins.mockReturnValue([]);
      mockReadRoleWorkspaceSkills.mockReturnValue([
        { name: "new-skill", description: "A new skill", roleName: "IT狗", roleId: "role-1", path: "/path", rawFrontmatter: {} } as WorkspaceSkill,
      ]);

      const result = SkillRegistry.build(true);

      expect(result).toHaveLength(1);
      // health is undefined when no DB rows match
      expect(result[0].health).toBeUndefined();
    });
  });
});
