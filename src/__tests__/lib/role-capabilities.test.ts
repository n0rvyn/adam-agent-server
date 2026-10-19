import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies before importing
vi.mock("../../store/plugin-registry.js", () => ({
  scanDirectoryConfig: vi.fn(),
  resolvePluginPaths: vi.fn(),
  getPluginManifest: vi.fn(),
  listInstalledPlugins: vi.fn(),
}));

vi.mock("../../store/role-workspace.js", () => ({
  getRoleWorkspacePath: vi.fn(),
}));

import {
  generateCapabilitySummary,
  resolveRolePluginPaths,
  resolveRolePluginCapabilities,
  type RolePluginCapabilities,
} from "../../lib/role-capabilities.js";
import {
  scanDirectoryConfig,
  resolvePluginPaths,
  getPluginManifest,
  listInstalledPlugins,
} from "../../store/plugin-registry.js";
import { getRoleWorkspacePath } from "../../store/role-workspace.js";

const mockScanDirectoryConfig = vi.mocked(scanDirectoryConfig);
const mockResolvePluginPaths = vi.mocked(resolvePluginPaths);
const mockGetPluginManifest = vi.mocked(getPluginManifest);
const mockListInstalledPlugins = vi.mocked(listInstalledPlugins);
const mockGetRoleWorkspacePath = vi.mocked(getRoleWorkspacePath);

beforeEach(() => {
  vi.clearAllMocks();
  mockListInstalledPlugins.mockReturnValue([]);
  mockGetRoleWorkspacePath.mockReturnValue("/home/.adam/roles/test-role");
});

// ---------------------------------------------------------------------------
// generateCapabilitySummary
// ---------------------------------------------------------------------------

describe("generateCapabilitySummary", () => {
  it("returns 'No tool permissions' when allowedTools is empty", () => {
    expect(generateCapabilitySummary({ allowedTools: [] })).toBe("No tool permissions");
  });

  it("groups known tools by category", () => {
    const result = generateCapabilitySummary({
      allowedTools: ["Read", "Write", "Grep"],
    });
    expect(result).toContain("File (read, write)");
    expect(result).toContain("Search (search content)");
  });

  it("appends MCP server names", () => {
    const result = generateCapabilitySummary({
      allowedTools: ["Bash"],
      mcpServers: { "my-server": {} },
    });
    expect(result).toContain("MCP: my-server");
  });

  it("appends directory paths", () => {
    const result = generateCapabilitySummary({
      allowedTools: ["Bash"],
      additionalDirectories: [{ path: "/projects/foo" }],
    });
    expect(result).toContain("Dirs: /projects/foo");
  });

  it("returns OS capability summary even when no tools are granted", () => {
    const result = generateCapabilitySummary({
      allowedTools: [],
      osCapabilities: [{ id: "accessibility" }],
    });
    expect(result).toBe("OS: Accessibility");
  });

  it("includes automation targets in the OS capability summary", () => {
    const result = generateCapabilitySummary({
      allowedTools: ["Bash"],
      osCapabilities: [{ id: "automation", targets: ["com.apple.mail"] }],
    });
    expect(result).toContain("OS: Automation (com.apple.mail)");
  });

  it("works without optional plugin param (backward compatible)", () => {
    const result = generateCapabilitySummary({ allowedTools: ["Read"] });
    expect(result).toBe("File (read)");
    expect(result).not.toContain("Plugins");
  });

  it("appends plugin capabilities when provided", () => {
    const pluginCaps: RolePluginCapabilities = {
      plugins: [
        {
          name: "dev-workflow",
          skills: [
            { name: "commit", description: "Commit changes" },
            { name: "fix-bug", description: "Fix bugs" },
          ],
          agents: [{ name: "flow-tracer", description: "Trace flows" }],
          mcpServers: [],
          hooks: [],
        },
      ],
    };
    const result = generateCapabilitySummary({ allowedTools: ["Bash"] }, pluginCaps);
    expect(result).toContain("Plugins: dev-workflow (skills: commit, fix-bug; agents: flow-tracer)");
  });

  it("shows plugin name only when no skills or agents", () => {
    const pluginCaps: RolePluginCapabilities = {
      plugins: [
        { name: "simple-plugin", skills: [], agents: [], mcpServers: ["mcp1"], hooks: ["preToolUse"] },
      ],
    };
    const result = generateCapabilitySummary({ allowedTools: ["Read"] }, pluginCaps);
    expect(result).toContain("Plugins: simple-plugin");
    // No skill/agent parentheses after plugin name
    expect(result).not.toContain("simple-plugin (");
  });

  it("handles multiple plugins", () => {
    const pluginCaps: RolePluginCapabilities = {
      plugins: [
        { name: "plugin-a", skills: [{ name: "skill1", description: "" }], agents: [], mcpServers: [], hooks: [] },
        { name: "plugin-b", skills: [], agents: [{ name: "agent1", description: "" }], mcpServers: [], hooks: [] },
      ],
    };
    const result = generateCapabilitySummary({ allowedTools: ["Bash"] }, pluginCaps);
    expect(result).toContain("plugin-a (skills: skill1)");
    expect(result).toContain("plugin-b (agents: agent1)");
  });

  it("does not append Plugins section when plugins array is empty", () => {
    const pluginCaps: RolePluginCapabilities = { plugins: [] };
    const result = generateCapabilitySummary({ allowedTools: ["Read"] }, pluginCaps);
    expect(result).not.toContain("Plugins");
  });
});

// ---------------------------------------------------------------------------
// resolveRolePluginPaths
// ---------------------------------------------------------------------------

describe("resolveRolePluginPaths", () => {
  it("returns empty array when role has no additionalDirectories", () => {
    const result = resolveRolePluginPaths({ name: "test", additionalDirectories: [] });
    expect(result).toEqual([]);
  });

  it("skips directories without inheritPlugins or inheritMcp", () => {
    const result = resolveRolePluginPaths({
      name: "test",
      additionalDirectories: [{ path: "/projects/foo", inheritPlugins: false, inheritMcp: false }],
    });
    expect(mockScanDirectoryConfig).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  it("resolves plugins from directories with inheritPlugins", () => {
    mockScanDirectoryConfig.mockReturnValue({
      enabledPlugins: { "dev-workflow@indie-toolkit": true, "disabled-plugin@foo": false },
      mcpServers: {},
      allowedTools: [],
      disallowedTools: [],
    });
    mockResolvePluginPaths.mockReturnValue(
      new Map([["dev-workflow@indie-toolkit", "/home/.claude/plugins/dev-workflow"]])
    );

    const result = resolveRolePluginPaths({
      name: "test",
      additionalDirectories: [{ path: "/projects/foo", inheritPlugins: true }],
    });

    expect(mockScanDirectoryConfig).toHaveBeenCalledWith("/projects/foo");
    expect(mockResolvePluginPaths).toHaveBeenCalledWith(["dev-workflow@indie-toolkit"]);
    expect(result).toContain("/home/.claude/plugins/dev-workflow");
  });

  it("resolves plugins from directories with inheritMcp (MCP inheritance requires plugin loading)", () => {
    mockScanDirectoryConfig.mockReturnValue({
      enabledPlugins: { "mcp-plugin@foo": true },
      mcpServers: {},
      allowedTools: [],
      disallowedTools: [],
    });
    mockResolvePluginPaths.mockReturnValue(
      new Map([["mcp-plugin@foo", "/home/.claude/plugins/mcp-plugin"]])
    );

    const result = resolveRolePluginPaths({
      name: "test",
      additionalDirectories: [{ path: "/projects/bar", inheritMcp: true }],
    });

    expect(mockScanDirectoryConfig).toHaveBeenCalledWith("/projects/bar");
    expect(result).toContain("/home/.claude/plugins/mcp-plugin");
  });

  it("deduplicates plugin paths across multiple directories", () => {
    mockScanDirectoryConfig.mockReturnValue({
      enabledPlugins: { "shared-plugin@foo": true },
      mcpServers: {},
      allowedTools: [],
      disallowedTools: [],
    });
    mockResolvePluginPaths.mockReturnValue(
      new Map([["shared-plugin@foo", "/home/.claude/plugins/shared"]])
    );

    const result = resolveRolePluginPaths({
      name: "test",
      additionalDirectories: [
        { path: "/projects/a", inheritPlugins: true },
        { path: "/projects/b", inheritPlugins: true },
      ],
    });

    expect(result).toEqual(["/home/.claude/plugins/shared"]);
  });

  it("includes project-scope plugins from role workspace", () => {
    mockListInstalledPlugins.mockReturnValue([
      {
        id: "project-plugin@local",
        name: "project-plugin",
        version: "1.0",
        scope: "project",
        installPath: "/home/.adam/roles/test/plugins/project-plugin",
        enabled: true,
        installedAt: "",
        lastUpdated: "",
      },
    ]);
    mockGetRoleWorkspacePath.mockReturnValue("/home/.adam/roles/test");

    const result = resolveRolePluginPaths({ name: "test", additionalDirectories: [] });

    expect(mockListInstalledPlugins).toHaveBeenCalledWith({ scope: "project", projectPath: "/home/.adam/roles/test" });
    expect(result).toContain("/home/.adam/roles/test/plugins/project-plugin");
  });

  it("handles getRoleWorkspacePath throwing (workspace not yet created)", () => {
    mockGetRoleWorkspacePath.mockImplementation(() => {
      throw new Error("Invalid role name");
    });

    const result = resolveRolePluginPaths({ name: "", additionalDirectories: [] });
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// resolveRolePluginCapabilities
// ---------------------------------------------------------------------------

describe("resolveRolePluginCapabilities", () => {
  it("returns empty plugins when role has no plugin paths", () => {
    const result = resolveRolePluginCapabilities({ name: "test", additionalDirectories: [] });
    expect(result.plugins).toEqual([]);
  });

  it("resolves plugin manifests from plugin paths", () => {
    mockScanDirectoryConfig.mockReturnValue({
      enabledPlugins: { "dev-workflow@indie": true },
      mcpServers: {},
      allowedTools: [],
      disallowedTools: [],
    });
    mockResolvePluginPaths.mockReturnValue(
      new Map([["dev-workflow@indie", "/plugins/dev-workflow"]])
    );
    mockGetPluginManifest.mockReturnValue({
      name: "dev-workflow",
      description: "Development workflow tools",
      skills: [
        { name: "commit", description: "Commit changes" },
        { name: "fix-bug", description: "Fix bugs systematically" },
      ],
      agents: [{ name: "flow-tracer", description: "Trace call chains" }],
      mcpServers: ["dev-mcp"],
      hooks: ["PostToolUse"],
      lspServers: [],
    });

    const result = resolveRolePluginCapabilities({
      name: "test-role",
      additionalDirectories: [{ path: "/projects/foo", inheritPlugins: true }],
    });

    expect(result.plugins).toHaveLength(1);
    expect(result.plugins[0].name).toBe("dev-workflow");
    expect(result.plugins[0].description).toBe("Development workflow tools");
    expect(result.plugins[0].skills).toHaveLength(2);
    expect(result.plugins[0].skills[0].name).toBe("commit");
    expect(result.plugins[0].agents).toHaveLength(1);
    expect(result.plugins[0].agents[0].name).toBe("flow-tracer");
    expect(result.plugins[0].mcpServers).toEqual(["dev-mcp"]);
    expect(result.plugins[0].hooks).toEqual(["PostToolUse"]);
  });

  it("skips plugins with null manifest (corrupt or missing)", () => {
    mockScanDirectoryConfig.mockReturnValue({
      enabledPlugins: { "good-plugin@x": true, "bad-plugin@x": true },
      mcpServers: {},
      allowedTools: [],
      disallowedTools: [],
    });
    mockResolvePluginPaths.mockReturnValue(
      new Map([
        ["good-plugin@x", "/plugins/good"],
        ["bad-plugin@x", "/plugins/bad"],
      ])
    );
    mockGetPluginManifest.mockImplementation((path: string) => {
      if (path === "/plugins/bad") return null;
      return {
        name: "good-plugin",
        skills: [],
        agents: [],
        mcpServers: [],
        hooks: [],
        lspServers: [],
      };
    });

    const result = resolveRolePluginCapabilities({
      name: "test",
      additionalDirectories: [{ path: "/proj", inheritPlugins: true }],
    });

    expect(result.plugins).toHaveLength(1);
    expect(result.plugins[0].name).toBe("good-plugin");
  });

  it("uses directory name as fallback when manifest has no name", () => {
    mockScanDirectoryConfig.mockReturnValue({
      enabledPlugins: { "unnamed@x": true },
      mcpServers: {},
      allowedTools: [],
      disallowedTools: [],
    });
    mockResolvePluginPaths.mockReturnValue(
      new Map([["unnamed@x", "/plugins/my-unnamed-plugin"]])
    );
    mockGetPluginManifest.mockReturnValue({
      name: "",
      skills: [],
      agents: [],
      mcpServers: [],
      hooks: [],
      lspServers: [],
    });

    const result = resolveRolePluginCapabilities({
      name: "test",
      additionalDirectories: [{ path: "/proj", inheritPlugins: true }],
    });

    expect(result.plugins[0].name).toBe("my-unnamed-plugin");
  });
});
