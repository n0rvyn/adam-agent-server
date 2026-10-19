/**
 * Plugin Registry — unified read layer for Claude Code CLI plugin data.
 *
 * Reads directly from CLI's JSON files:
 *   - ~/.claude/plugins/installed_plugins.json
 *   - ~/.claude/plugins/known_marketplaces.json
 *   - ~/.claude/settings.json
 *
 * All file reads are wrapped in try/catch with graceful fallback.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import os from "node:os";
import type {
  AdditionalDirectory,
  InstalledPluginEntry,
  MarketplaceInfo,
  PluginErrorPattern,
  PluginManifest,
} from "../shared/types.js";

// ---------------------------------------------------------------------------
// Internal types (mirror installed_plugins.json v2 schema)
// ---------------------------------------------------------------------------

interface InstalledPluginsJson {
  version: number;
  plugins: Record<string, InstalledPluginEntry[]>;
}

interface KnownMarketplacesJson {
  version: number;
  marketplaces: MarketplaceInfo[];
}

interface SettingsJson {
  enabledPlugins?: Record<string, boolean>;
  mcpServers?: Record<string, unknown>;
  allowedTools?: string[];
  disallowedTools?: string[];
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const PLUGINS_DIR = () => join(os.homedir(), ".claude", "plugins");
const INSTALLED_PLUGINS_PATH = () => join(PLUGINS_DIR(), "installed_plugins.json");
const KNOWN_MARKETPLACES_PATH = () => join(PLUGINS_DIR(), "known_marketplaces.json");
const SETTINGS_PATH = () => join(os.homedir(), ".claude", "settings.json");

// ---------------------------------------------------------------------------
// Low-level file readers
// ---------------------------------------------------------------------------

function readJsonFile<T>(path: string): T | null {
  try {
    if (!existsSync(path)) return null;
    const content = readFileSync(path, "utf-8");
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Settings helpers
// ---------------------------------------------------------------------------

/**
 * Read global enabled state from ~/.claude/settings.json enabledPlugins map.
 * Returns { [pluginId]: true/false }.
 */
export function getGlobalEnabledState(): Record<string, boolean> {
  const settings = readJsonFile<SettingsJson>(SETTINGS_PATH());
  return settings?.enabledPlugins ?? {};
}

// ---------------------------------------------------------------------------
// Plugin manifest parsing
// ---------------------------------------------------------------------------

/**
 * Parse a plugin's manifest files and return a PluginManifest.
 * Returns null if the directory is not a valid plugin.
 */
export function getPluginManifest(installPath: string): PluginManifest | null {
  const base = installPath;

  // Helper to read YAML frontmatter from a markdown file
  function parseYamlFrontmatter(filePath: string, fields: string[]): Record<string, string> {
    const result: Record<string, string> = {};
    try {
      if (!existsSync(filePath)) return result;
      const content = readFileSync(filePath, "utf-8");
      // Strip code fences at the start
      const trimmed = content.replace(/^```yaml\r?\n/, "").replace(/^```\r?\n/, "");
      for (const field of fields) {
        const re = new RegExp(`^${field}:\\s*(.+)$`, "m");
        const m = trimmed.match(re);
        if (m) result[field] = m[1].trim();
      }
    } catch { /* ignore */ }
    return result;
  }

  // Full YAML frontmatter parser — handles list blocks like error_patterns
  function parseSkillFrontmatter(filePath: string): {
    name?: string;
    description?: string;
    error_patterns?: PluginErrorPattern[];
  } {
    try {
      if (!existsSync(filePath)) return {};
      const content = readFileSync(filePath, "utf-8");
      const match = content.match(/^```yaml\r?\n([\s\S]*?)\r?\n```\r?\n/);
      if (!match) {
        // Fallback: simple line-by-line parse
        const fm: Record<string, string> = {};
        for (const line of content.split(/\r?\n/)) {
          const sm = line.match(/^(\w+):\s*(.+)$/);
          if (sm) fm[sm[1]] = sm[2];
        }
        return { name: fm["name"], description: fm["description"] };
      }
      const yamlBlock = match[1];
      const result: Record<string, string | PluginErrorPattern[]> = {};
      // Extract top-level scalar fields
      for (const line of yamlBlock.split(/\r?\n/)) {
        const sm = line.match(/^(\w+):\s*(.*)$/);
        if (sm) {
          const [, key, val] = sm;
          if (val.trim()) result[key] = val.trim();
        }
      }
      // Extract error_patterns list block
      const epMatch = yamlBlock.match(/error_patterns:\r?\n([\s\S]*?)(?=\n\w|\n$)/);
      if (epMatch) {
        const epLines = epMatch[1];
        const entries: PluginErrorPattern[] = [];
        let current: Partial<PluginErrorPattern> = {};
        for (const line of epLines.split(/\r?\n/)) {
          const pat = line.match(/^\s*-\s*pattern:\s*(.+)$/);
          if (pat) { if (current.pattern) entries.push(current as PluginErrorPattern); current = { pattern: pat[1].replace(/^["']|["']$/g, "") }; continue; }
          const cat = line.match(/^\s*category:\s*(.+)$/);
          if (cat) { current.category = cat[1].trim(); continue; }
          const ua = line.match(/^\s*user_action:\s*(.+)$/);
          if (ua) { current.user_action = ua[1].replace(/^["']|["']$/g, ""); if (current.pattern && current.category && current.user_action) { entries.push(current as PluginErrorPattern); current = {}; } continue; }
        }
        if (current.pattern) entries.push(current as PluginErrorPattern);
        if (entries.length > 0) result["error_patterns"] = entries;
      }
      return {
        name: result["name"] as string | undefined,
        description: result["description"] as string | undefined,
        error_patterns: result["error_patterns"] as PluginErrorPattern[] | undefined,
      };
    } catch { /* ignore */ }
    return {};
  }

  try {
    const manifest: PluginManifest = {
      name: "",
      skills: [],
      agents: [],
      mcpServers: [],
      hooks: [],
      lspServers: [],
    };

    // Parse plugin.json
    const pluginJsonPath = join(base, ".claude-plugin", "plugin.json");
    if (existsSync(pluginJsonPath)) {
      try {
        const pluginJson = JSON.parse(readFileSync(pluginJsonPath, "utf-8"));
        manifest.name = pluginJson.name ?? "";
        manifest.version = pluginJson.version;
        manifest.description = pluginJson.description;
        if (Array.isArray(pluginJson.lspServers)) manifest.lspServers = pluginJson.lspServers;
        if (Array.isArray(pluginJson.mcpServers)) manifest.mcpServers = pluginJson.mcpServers;
        if (Array.isArray(pluginJson.hooks)) manifest.hooks = pluginJson.hooks;
      } catch { /* ignore */ }
    }

    // Parse skills: each skill is a subdirectory containing SKILL.md (matches SDK behavior)
    const skillsDir = join(base, "skills");
    if (existsSync(skillsDir)) {
      const entries = readdirSync(skillsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        const skillMd = join(skillsDir, entry.name, "SKILL.md");
        const fm = parseSkillFrontmatter(skillMd);
        if (fm.name) {
          manifest.skills.push({
            name: fm.name,
            description: fm.description ?? "",
            error_patterns: fm.error_patterns,
          });
        }
      }
    }

    // Parse agents/*.md files
    const agentsDir = join(base, "agents");
    if (existsSync(agentsDir)) {
      const entries = readdirSync(agentsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
        const fm = parseYamlFrontmatter(join(agentsDir, entry.name), ["name", "description"]);
        if (fm["name"]) {
          manifest.agents.push({ name: fm["name"], description: fm["description"] ?? "" });
        }
      }
    }

    // Parse .mcp.json for MCP server names
    const mcpJsonPath = join(base, ".mcp.json");
    if (existsSync(mcpJsonPath)) {
      try {
        const mcpJson = JSON.parse(readFileSync(mcpJsonPath, "utf-8"));
        if (mcpJson.mcpServers && typeof mcpJson.mcpServers === "object") {
          manifest.mcpServers = Object.keys(mcpJson.mcpServers);
        }
      } catch { /* ignore */ }
    }

    // Parse hooks/hooks.json for hook event names
    const hooksJsonPath = join(base, "hooks", "hooks.json");
    if (existsSync(hooksJsonPath)) {
      try {
        const hooksJson = JSON.parse(readFileSync(hooksJsonPath, "utf-8"));
        if (Array.isArray(hooksJson)) {
          manifest.hooks = hooksJson.map((h: unknown) => typeof h === "object" && h !== null && "event" in h ? String((h as Record<string, unknown>)["event"]) : String(h));
        }
      } catch { /* ignore */ }
    }

    return manifest;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Installed plugins
// ---------------------------------------------------------------------------

/**
 * List all installed plugins, optionally filtered by scope and projectPath.
 * Merges enabled state from ~/.claude/settings.json.
 */
export function listInstalledPlugins(options?: {
  scope?: "user" | "project" | "local";
  projectPath?: string;
}): InstalledPluginEntry[] {
  const data = readJsonFile<InstalledPluginsJson>(INSTALLED_PLUGINS_PATH());
  if (!data?.plugins) return [];

  const globalEnabled = getGlobalEnabledState();
  const all: InstalledPluginEntry[] = [];

  for (const [pluginId, entries] of Object.entries(data.plugins)) {
    if (!Array.isArray(entries) || entries.length === 0) continue;
    // A plugin can have multiple scope entries (user + project + local)
    for (const entry of entries) {
      const scope = (entry.scope ?? "user") as InstalledPluginEntry["scope"];

      if (options?.scope && scope !== options.scope) continue;
      if (options?.projectPath && entry.projectPath !== options.projectPath) continue;

      all.push({
        id: pluginId,
        name: pluginId.split("@")[0],
        version: entry.version ?? "",
        scope,
        projectPath: entry.projectPath,
        installPath: entry.installPath ?? join(PLUGINS_DIR(), pluginId),
        enabled: globalEnabled[pluginId] ?? entry.enabled ?? true,
        installedAt: entry.installedAt ?? "",
        lastUpdated: entry.lastUpdated ?? "",
      });
    }
  }

  return all;
}

/**
 * Get a single installed plugin by id (name@marketplace format).
 */
export function getInstalledPlugin(pluginId: string): InstalledPluginEntry | null {
  const data = readJsonFile<InstalledPluginsJson>(INSTALLED_PLUGINS_PATH());
  if (!data?.plugins?.[pluginId]) return null;
  const entries = data.plugins[pluginId];
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const entry = entries[0];
  const globalEnabled = getGlobalEnabledState();
  return {
    id: pluginId,
    name: pluginId.split("@")[0],
    version: entry.version ?? "",
    scope: (entry.scope ?? "user") as InstalledPluginEntry["scope"],
    projectPath: entry.projectPath,
    installPath: entry.installPath ?? join(PLUGINS_DIR(), pluginId),
    enabled: globalEnabled[pluginId] ?? entry.enabled ?? true,
    installedAt: entry.installedAt ?? "",
    lastUpdated: entry.lastUpdated ?? "",
  };
}

/**
 * Resolve plugin IDs to their install paths via installed_plugins.json.
 */
export function resolvePluginPaths(pluginIds: string[]): Map<string, string> {
  const data = readJsonFile<InstalledPluginsJson>(INSTALLED_PLUGINS_PATH());
  const result = new Map<string, string>();
  for (const id of pluginIds) {
    const entries = data?.plugins?.[id];
    if (Array.isArray(entries) && entries.length > 0) {
      result.set(id, entries[0].installPath ?? join(PLUGINS_DIR(), id));
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Marketplace sources
// ---------------------------------------------------------------------------

/**
 * List marketplace sources from known_marketplaces.json.
 */
export function listMarketplaceSources(): MarketplaceInfo[] {
  const data = readJsonFile<KnownMarketplacesJson>(KNOWN_MARKETPLACES_PATH());
  return data?.marketplaces ?? [];
}

// ---------------------------------------------------------------------------
// Directory config scanning
// ---------------------------------------------------------------------------

export interface DirectoryConfig {
  enabledPlugins: Record<string, boolean>;
  mcpServers: Record<string, unknown>;
  allowedTools: string[];
  disallowedTools: string[];
}

/**
 * Read {dir}/.claude/settings.json and extract enabledPlugins, mcpServers,
 * allowedTools, and disallowedTools.
 */
export function scanDirectoryConfig(dirPath: string): DirectoryConfig {
  const settingsPath = join(dirPath, ".claude", "settings.json");
  const settings = readJsonFile<SettingsJson>(settingsPath);

  return {
    enabledPlugins: settings?.enabledPlugins ?? {},
    mcpServers: settings?.mcpServers ?? {},
    allowedTools: settings?.allowedTools ?? [],
    disallowedTools: settings?.disallowedTools ?? [],
  };
}
