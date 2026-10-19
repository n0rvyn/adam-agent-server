/**
 * Unit tests for readRoleWorkspaceSkills.
 * In a separate file to avoid vi.resetModules() interfering with other tests.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Role, InstalledPluginEntry, PluginManifest } from "../../shared/types.js";
import type { RolePluginCapabilities } from "../../lib/role-capabilities.js";
import type { WorkspaceSkill } from "../../lib/role-workspace-skills.js";

const mockListInstalledPlugins = vi.hoisted(() => vi.fn<() => InstalledPluginEntry[]>(() => []));
const mockGetPluginManifest = vi.hoisted(() => vi.fn<() => PluginManifest | null>(() => null));
const mockListRoles = vi.hoisted(() => vi.fn<() => Role[]>(() => []));
const mockResolveRolePluginCapabilities = vi.hoisted(() => vi.fn<() => RolePluginCapabilities>(() => ({ plugins: [] })));
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

vi.mock("../../store/role-workspace.js", () => ({
  getRoleWorkspacePath: mockGetRoleWorkspacePath,
}));

describe("readRoleWorkspaceSkills", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty array when workspace does not exist", async () => {
    vi.resetModules();
    // Mock getRoleWorkspacePath to throw
    vi.doMock("../../store/role-workspace.js", () => ({
      getRoleWorkspacePath: () => { throw new Error("workspace not found"); },
    }));

    const { readRoleWorkspaceSkills: readSkills } = await import("../../lib/role-workspace-skills.js");
    const result = readSkills("role-id", "SomeRole");
    expect(result).toEqual([]);
  });
});
