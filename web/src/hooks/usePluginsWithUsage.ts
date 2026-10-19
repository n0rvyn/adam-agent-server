import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api.ts";

export interface PluginManifest {
  name: string;
  version?: string;
  description?: string;
  skills: { name: string; description: string }[];
  agents: { name: string; description: string }[];
  mcpServers: string[];
  hooks: string[];
  lspServers: string[];
}

export interface RawInstalledPlugin {
  id: string;
  version: string;
  scope: "user" | "project" | "local";
  projectPath?: string;
  installPath: string;
  enabled: boolean;
  installedAt: string;
  lastUpdated: string;
  globalEnabled: boolean;
  manifest?: PluginManifest;
}

export interface RoleRef {
  id: string;
  name: string;
  workspacePath: string;
}

export interface RoleUsage {
  roleId: string;
  roleName: string;
  workspacePath: string;
  version: string;
  installPath: string;
  isOutdated: boolean;
  userScopeVersion: string | null;
}

export interface UserScopePlugin {
  id: string;
  name: string;
  version: string;
  marketplace: string;
  scope: "user";
  globalEnabled: boolean;
  installPath: string;
  manifest?: PluginManifest;
  usedByRoles: RoleUsage[];
}

export interface RoleGroupedProjectPlugin {
  pluginId: string;
  name: string;
  version: string;
  installPath: string;
  userScopeVersion: string | null;
  isOutdated: boolean;
  isRoleOnly: boolean;
}

export interface RoleGroup {
  roleId: string;
  roleName: string;
  workspacePath: string;
  plugins: RoleGroupedProjectPlugin[];
}

export interface PluginsWithUsage {
  userScope: UserScopePlugin[];
  projectScope: RoleGroup[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  rawPlugins: RawInstalledPlugin[];
  roles: RoleRef[];
}

export function parseMarketplace(pluginId: string): string {
  const at = pluginId.indexOf("@");
  return at === -1 ? "" : pluginId.slice(at + 1);
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}

export function aggregatePluginsWithUsage(
  plugins: RawInstalledPlugin[],
  roles: RoleRef[],
): { userScope: UserScopePlugin[]; projectScope: RoleGroup[] } {
  const userScopeEntries = plugins.filter((p) => p.scope === "user");
  const projectScopeEntries = plugins.filter((p) => p.scope === "project" && p.projectPath);

  const userScopeByPluginId = new Map<string, RawInstalledPlugin>();
  for (const plugin of userScopeEntries) {
    userScopeByPluginId.set(plugin.id, plugin);
  }

  const workspacePathToRole = new Map<string, RoleRef>();
  for (const role of roles) {
    workspacePathToRole.set(role.workspacePath, role);
  }

  const userScope: UserScopePlugin[] = userScopeEntries.map((plugin) => {
    const roleUsages: RoleUsage[] = projectScopeEntries
      .filter((projectPlugin) => projectPlugin.id === plugin.id && workspacePathToRole.has(projectPlugin.projectPath!))
      .map((projectPlugin) => {
        const role = workspacePathToRole.get(projectPlugin.projectPath!)!;
        return {
          roleId: role.id,
          roleName: role.name,
          workspacePath: role.workspacePath,
          version: projectPlugin.version,
          installPath: projectPlugin.installPath,
          isOutdated: compareVersions(projectPlugin.version, plugin.version) < 0,
          userScopeVersion: plugin.version,
        };
      });

    return {
      id: plugin.id,
      name: plugin.id.split("@")[0],
      version: plugin.version,
      marketplace: parseMarketplace(plugin.id),
      scope: "user",
      globalEnabled: plugin.globalEnabled,
      installPath: plugin.installPath,
      manifest: plugin.manifest,
      usedByRoles: roleUsages,
    };
  });

  const byRole = new Map<string, RoleGroupedProjectPlugin[]>();
  for (const projectPlugin of projectScopeEntries) {
    const role = workspacePathToRole.get(projectPlugin.projectPath!);
    if (!role) continue;

    const userEntry = userScopeByPluginId.get(projectPlugin.id);
    const userScopeVersion = userEntry?.version ?? null;
    const isOutdated = userScopeVersion ? compareVersions(projectPlugin.version, userScopeVersion) < 0 : false;
    const isRoleOnly = !userEntry;
    const matchesUserScope = userEntry && userEntry.version === projectPlugin.version;
    if (matchesUserScope) continue;

    const pluginsForRole = byRole.get(role.id) ?? [];
    pluginsForRole.push({
      pluginId: projectPlugin.id,
      name: projectPlugin.id.split("@")[0],
      version: projectPlugin.version,
      installPath: projectPlugin.installPath,
      userScopeVersion,
      isOutdated,
      isRoleOnly,
    });
    byRole.set(role.id, pluginsForRole);
  }

  const projectScope: RoleGroup[] = roles
    .filter((role) => byRole.has(role.id))
    .map((role) => ({
      roleId: role.id,
      roleName: role.name,
      workspacePath: role.workspacePath,
      plugins: byRole.get(role.id)!,
    }));

  return { userScope, projectScope };
}

export function usePluginsWithUsage(): PluginsWithUsage {
  const [rawPlugins, setRawPlugins] = useState<RawInstalledPlugin[]>([]);
  const [roles, setRoles] = useState<RoleRef[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [pluginsRes, rolesRes] = await Promise.all([
        api<{ plugins: RawInstalledPlugin[] }>("/plugins"),
        api<{ roles: RoleRef[] }>("/roles"),
      ]);
      setRawPlugins(pluginsRes.plugins);
      setRoles(rolesRes.roles);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load plugins");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const { userScope, projectScope } = aggregatePluginsWithUsage(rawPlugins, roles);

  return { userScope, projectScope, loading, error, refresh, rawPlugins, roles };
}
