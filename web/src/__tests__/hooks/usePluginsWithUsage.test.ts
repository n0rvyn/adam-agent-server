import { describe, expect, it } from "vitest";
import {
  aggregatePluginsWithUsage,
  compareVersions,
  type RawInstalledPlugin,
  type RoleRef,
} from "@/hooks/usePluginsWithUsage";

function makePlugin(overrides: Partial<RawInstalledPlugin>): RawInstalledPlugin {
  return {
    id: "plugin@indie",
    version: "1.0.0",
    scope: "user",
    installPath: "/plugins/plugin",
    enabled: true,
    installedAt: new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
    globalEnabled: true,
    ...overrides,
  };
}

const roles: RoleRef[] = [
  { id: "r1", name: "Engineer", workspacePath: "/work/engineer" },
  { id: "r2", name: "Reviewer", workspacePath: "/work/reviewer" },
];

describe("aggregatePluginsWithUsage", () => {
  it("returns empty arrays for empty inputs", () => {
    expect(aggregatePluginsWithUsage([], [])).toEqual({
      userScope: [],
      projectScope: [],
    });
  });

  it("keeps user-scope plugins without role usage", () => {
    const result = aggregatePluginsWithUsage([
      makePlugin({ id: "dev-workflow@indie", version: "2.0.0" }),
    ], roles);

    expect(result.userScope).toHaveLength(1);
    expect(result.userScope[0].usedByRoles).toEqual([]);
    expect(result.projectScope).toEqual([]);
  });

  it("tracks matching project installs in usedByRoles without showing them as divergence", () => {
    const result = aggregatePluginsWithUsage([
      makePlugin({ id: "dev-workflow@indie", version: "1.0.0" }),
      makePlugin({
        id: "dev-workflow@indie",
        version: "1.0.0",
        scope: "project",
        projectPath: "/work/engineer",
        installPath: "/work/engineer/plugins/dev-workflow",
      }),
    ], roles);

    expect(result.userScope[0].usedByRoles).toHaveLength(1);
    expect(result.userScope[0].usedByRoles[0].roleId).toBe("r1");
    expect(result.projectScope).toEqual([]);
  });

  it("marks outdated project overrides", () => {
    const result = aggregatePluginsWithUsage([
      makePlugin({ id: "dev-workflow@indie", version: "1.2.0" }),
      makePlugin({
        id: "dev-workflow@indie",
        version: "1.0.0",
        scope: "project",
        projectPath: "/work/engineer",
        installPath: "/work/engineer/plugins/dev-workflow",
      }),
    ], roles);

    expect(result.userScope[0].usedByRoles[0].isOutdated).toBe(true);
    expect(result.projectScope[0].plugins[0].isOutdated).toBe(true);
  });

  it("keeps role-only plugins in project scope", () => {
    const result = aggregatePluginsWithUsage([
      makePlugin({
        id: "review-helper@indie",
        version: "1.0.0",
        scope: "project",
        projectPath: "/work/reviewer",
        installPath: "/work/reviewer/plugins/review-helper",
      }),
    ], roles);

    expect(result.userScope).toEqual([]);
    expect(result.projectScope).toHaveLength(1);
    expect(result.projectScope[0].plugins[0].isRoleOnly).toBe(true);
  });

  it("filters out project installs whose workspace path does not match any role", () => {
    const result = aggregatePluginsWithUsage([
      makePlugin({ id: "dev-workflow@indie", version: "1.0.0" }),
      makePlugin({
        id: "dev-workflow@indie",
        version: "0.9.0",
        scope: "project",
        projectPath: "/orphan/workspace",
        installPath: "/orphan/plugins/dev-workflow",
      }),
    ], roles);

    expect(result.userScope[0].usedByRoles).toHaveLength(0);
    expect(result.projectScope).toEqual([]);
  });
});

describe("compareVersions", () => {
  it("compares numeric dotted versions", () => {
    expect(compareVersions("0.6.2", "0.5.0")).toBeGreaterThan(0);
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
    expect(compareVersions("0.5", "0.6")).toBeLessThan(0);
  });
});
