import type { AdditionalDirectory, PluginManifest, Role } from "../shared/types.js";
import { scanDirectoryConfig, resolvePluginPaths, getPluginManifest, listInstalledPlugins } from "../store/plugin-registry.js";
import { getRoleWorkspacePath } from "../store/role-workspace.js";
import { getOsCapabilityMeta } from "../shared/os-capabilities.js";

/**
 * Maps SDK tool names to human-readable capability descriptions.
 * Used by generateCapabilitySummary() to produce structured role capability strings.
 */
const TOOL_CAPABILITY_MAP: Record<string, { category: string; label: string }> = {
  Read:         { category: "File", label: "read" },
  Write:        { category: "File", label: "write" },
  Edit:         { category: "File", label: "edit" },
  Glob:         { category: "Search", label: "find files" },
  Grep:         { category: "Search", label: "search content" },
  Bash:         { category: "Execution", label: "shell commands" },
  WebSearch:    { category: "Web", label: "web search" },
  WebFetch:     { category: "Web", label: "fetch pages" },
  NotebookEdit: { category: "Execution", label: "Jupyter notebooks" },
};

/**
 * Generate a human-readable capability summary from a Role's tool permissions,
 * MCP servers, and additional directories.
 *
 * Output format: "File (read, write, edit) · Search (find files, content) · Execution (shell)"
 * With optional suffixes for MCP servers and extra directories.
 */
export function generateCapabilitySummary(
  role: Pick<Role, "allowedTools" | "mcpServers" | "additionalDirectories" | "osCapabilities">,
  pluginCapabilities?: RolePluginCapabilities,
): string {
  const tools = role.allowedTools ?? [];
  const osCaps = role.osCapabilities ?? [];

  if (
    tools.length === 0 &&
    osCaps.length === 0 &&
    Object.keys(role.mcpServers ?? {}).length === 0 &&
    (role.additionalDirectories?.length ?? 0) === 0 &&
    (!pluginCapabilities || pluginCapabilities.plugins.length === 0)
  ) {
    return "No tool permissions";
  }

  // Group tools by category
  const groups = new Map<string, string[]>();
  const unmapped: string[] = [];

  for (const tool of tools) {
    const entry = TOOL_CAPABILITY_MAP[tool];
    if (entry) {
      const existing = groups.get(entry.category) ?? [];
      existing.push(entry.label);
      groups.set(entry.category, existing);
    } else {
      unmapped.push(tool);
    }
  }

  // Build category strings
  const parts: string[] = [];
  for (const [category, labels] of groups) {
    parts.push(`${category} (${labels.join(", ")})`);
  }

  // Append unmapped tools directly
  if (unmapped.length > 0) {
    parts.push(unmapped.join(", "));
  }

  let summary = parts.join(" · ");
  const appendSection = (section: string): void => {
    summary = summary ? `${summary} · ${section}` : section;
  };

  // Append MCP servers
  const mcpNames = Object.keys(role.mcpServers ?? {});
  if (mcpNames.length > 0) {
    appendSection(`MCP: ${mcpNames.join(", ")}`);
  }

  // Append additional directories
  const dirs = role.additionalDirectories ?? [];
  if (dirs.length > 0) {
    appendSection(`Dirs: ${dirs.map(d => d.path).join(", ")}`);
  }

  if (osCaps.length > 0) {
    const osLabels = osCaps.map((cap) => {
      const meta = getOsCapabilityMeta(cap.id);
      if (cap.id === "automation" && cap.targets?.length) {
        return `${meta.label} (${cap.targets.join(", ")})`;
      }
      return meta.label;
    });
    appendSection(`OS: ${osLabels.join(", ")}`);
  }

  // Append plugin capabilities
  if (pluginCapabilities && pluginCapabilities.plugins.length > 0) {
    const pluginParts = pluginCapabilities.plugins.map((p) => {
      const details: string[] = [];
      if (p.skills.length > 0) details.push(`skills: ${p.skills.map((s) => s.name).join(", ")}`);
      if (p.agents.length > 0) details.push(`agents: ${p.agents.map((a) => a.name).join(", ")}`);
      return details.length > 0 ? `${p.name} (${details.join("; ")})` : p.name;
    });
    appendSection(`Plugins: ${pluginParts.join(", ")}`);
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Role plugin resolution
// ---------------------------------------------------------------------------

export interface RolePluginCapabilities {
  plugins: Array<{
    name: string;
    description?: string;
    skills: Array<{ name: string; description: string }>;
    agents: Array<{ name: string; description: string }>;
    mcpServers: string[];
    hooks: string[];
  }>;
}

/**
 * Resolve all plugin install paths for a Role.
 * Scans additionalDirectories (inheritPlugins) + project-scope plugins in Role workspace.
 * Returns deduplicated list of plugin install paths.
 */
export function resolveRolePluginPaths(role: Pick<Role, "name" | "additionalDirectories">): string[] {
  const paths: string[] = [];

  const addDirs: AdditionalDirectory[] = role.additionalDirectories ?? [];
  for (const addDir of addDirs) {
    if (!addDir.inheritPlugins && !addDir.inheritMcp) continue;
    const dirConfig = scanDirectoryConfig(addDir.path);
    const enabledIds = Object.entries(dirConfig.enabledPlugins)
      .filter(([, enabled]) => enabled)
      .map(([id]) => id);
    const resolved = resolvePluginPaths(enabledIds);
    for (const [, path] of resolved) {
      if (!paths.includes(path)) paths.push(path);
    }
  }

  // Project-scope plugins in Role workspace
  try {
    const roleCwd = getRoleWorkspacePath(role.name);
    const projectPlugins = listInstalledPlugins({ scope: "project", projectPath: roleCwd });
    for (const p of projectPlugins) {
      if (p.installPath && !paths.includes(p.installPath)) {
        paths.push(p.installPath);
      }
    }
  } catch {
    // Role workspace may not exist yet
  }

  return paths;
}

/**
 * Resolve a Role's full plugin capability set by reading plugin manifests.
 * Returns structured capabilities for each bound plugin.
 */
export function resolveRolePluginCapabilities(role: Pick<Role, "name" | "additionalDirectories">): RolePluginCapabilities {
  const pluginPaths = resolveRolePluginPaths(role);
  const plugins: RolePluginCapabilities["plugins"] = [];

  for (const path of pluginPaths) {
    const manifest: PluginManifest | null = getPluginManifest(path);
    if (!manifest) continue;
    plugins.push({
      name: manifest.name || path.split("/").pop() || "unknown",
      description: manifest.description,
      skills: manifest.skills,
      agents: manifest.agents,
      mcpServers: manifest.mcpServers,
      hooks: manifest.hooks,
    });
  }

  return { plugins };
}
