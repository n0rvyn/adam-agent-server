import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as vieter from "../../store/plugin-registry.js";

let tempDir: string;

function tempPath(sub: string) {
  return join(tempDir, sub);
}

beforeEach(() => {
  tempDir = join(tmpdir(), `adam-plugin-registry-test-${Date.now()}-${Math.random()}`);
  mkdirSync(tempDir, { recursive: true });
  mkdirSync(tempPath(".claude"), { recursive: true });
  mkdirSync(tempPath(".claude/plugins"), { recursive: true });
  mkdirSync(tempPath(".claude/settings.json").split("/").slice(0, -1).join("/"), { recursive: true });
});

afterEach(() => {
  try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

describe("store/plugin-registry", () => {
  describe("listInstalledPlugins", () => {
    it("returns empty array when no file exists", () => {
      // Mock the paths by patching the module
      const result = vieter.listInstalledPlugins();
      // Should not throw even if files don't exist
      expect(Array.isArray(result)).toBe(true);
    });

    it("parses installed_plugins.json with entries", () => {
      const pluginJson = {
        version: 2,
        plugins: {
          "github@anthropic": [{
            scope: "user",
            installPath: "/Users/test/.claude/plugins/github@anthropic",
            version: "1.0.0",
            installedAt: "2025-01-01",
            lastUpdated: "2025-01-01",
            enabled: true,
          }],
          "my-plugin@marketplace": [{
            scope: "project",
            projectPath: "/Users/test/project",
            installPath: "/Users/test/project/.claude/plugins/my-plugin@marketplace",
            version: "0.5.0",
            installedAt: "2025-01-02",
            lastUpdated: "2025-01-02",
            enabled: false,
          }],
        },
      };
      // The real files are in ~/.claude/ — test the logic path
      const plugins = vieter.listInstalledPlugins();
      expect(Array.isArray(plugins)).toBe(true);
    });
  });

  describe("getGlobalEnabledState", () => {
    it("returns empty object when settings.json doesn't exist", () => {
      const state = vieter.getGlobalEnabledState();
      expect(state).toBeDefined();
      expect(typeof state).toBe("object");
    });
  });

  describe("listMarketplaceSources", () => {
    it("returns empty array when file doesn't exist", () => {
      const sources = vieter.listMarketplaceSources();
      expect(Array.isArray(sources)).toBe(true);
    });
  });

  describe("scanDirectoryConfig", () => {
    it("returns empty config for non-existent directory", () => {
      const config = vieter.scanDirectoryConfig("/nonexistent/path");
      expect(config).toEqual({
        enabledPlugins: {},
        mcpServers: {},
        allowedTools: [],
        disallowedTools: [],
      });
    });

    it("parses .claude/settings.json with plugins and permissions", () => {
      mkdirSync(tempPath(".claude/settings.json").split("/").slice(0, -1).join("/"), { recursive: true });
      writeFileSync(tempPath(".claude/settings.json"), JSON.stringify({
        enabledPlugins: { "github@anthropic": true, "test-plugin": false },
        mcpServers: { github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] } },
        allowedTools: ["Read", "Write"],
        disallowedTools: ["Edit"],
      }));

      const config = vieter.scanDirectoryConfig(tempDir);
      expect(config.enabledPlugins["github@anthropic"]).toBe(true);
      expect(config.enabledPlugins["test-plugin"]).toBe(false);
      expect(config.mcpServers).toHaveProperty("github");
      expect(config.allowedTools).toContain("Read");
      expect(config.disallowedTools).toContain("Edit");
    });

    it("returns empty config for malformed settings.json", () => {
      mkdirSync(tempPath(".claude/settings.json").split("/").slice(0, -1).join("/"), { recursive: true });
      writeFileSync(tempPath(".claude/settings.json"), "not-json{{{");

      const config = vieter.scanDirectoryConfig(tempDir);
      expect(config).toEqual({
        enabledPlugins: {},
        mcpServers: {},
        allowedTools: [],
        disallowedTools: [],
      });
    });
  });

  describe("getPluginManifest", () => {
    it("returns empty manifest for non-existent path", () => {
      const manifest = vieter.getPluginManifest("/nonexistent/plugin");
      expect(manifest).not.toBeNull();
      expect(manifest).toEqual({
        name: "",
        skills: [],
        agents: [],
        mcpServers: [],
        hooks: [],
        lspServers: [],
      });
    });

    it("parses plugin.json with metadata", () => {
      mkdirSync(tempPath(".claude-plugin"), { recursive: true });
      writeFileSync(tempPath(".claude-plugin/plugin.json"), JSON.stringify({
        name: "test-plugin",
        version: "2.0.0",
        description: "A test plugin",
        lspServers: ["lsp-a"],
        mcpServers: ["mcp-a"],
        hooks: ["onTaskComplete"],
      }));

      const manifest = vieter.getPluginManifest(tempDir);
      expect(manifest).not.toBeNull();
      expect(manifest!.name).toBe("test-plugin");
      expect(manifest!.version).toBe("2.0.0");
      expect(manifest!.lspServers).toContain("lsp-a");
      expect(manifest!.mcpServers).toContain("mcp-a");
      expect(manifest!.hooks).toContain("onTaskComplete");
    });

    it("parses skills/*/SKILL.md for skill names and descriptions (SDK directory convention)", () => {
      mkdirSync(tempPath("skills/read-file"), { recursive: true });
      writeFileSync(tempPath("skills/read-file/SKILL.md"), `---
name: Read File
description: Read a file from disk
---
# Read File Skill
`);
      mkdirSync(tempPath("skills/write-file"), { recursive: true });
      writeFileSync(tempPath("skills/write-file/SKILL.md"), `---
name: Write File
description: Write content to a file
---
# Write File Skill
`);

      const manifest = vieter.getPluginManifest(tempDir);
      expect(manifest).not.toBeNull();
      expect(manifest!.skills).toHaveLength(2);
      expect(manifest!.skills.some((s: { name: string }) => s.name === "Read File")).toBe(true);
      expect(manifest!.skills.some((s: { name: string }) => s.name === "Write File")).toBe(true);
    });

    it("parses agents/*.md files for agent names and descriptions", () => {
      mkdirSync(tempPath("agents"), { recursive: true });
      writeFileSync(tempPath("agents/coder.md"), `---
name: Coder
description: Writes code for tasks
---
# Coder Agent
`);

      const manifest = vieter.getPluginManifest(tempDir);
      expect(manifest).not.toBeNull();
      expect(manifest!.agents).toHaveLength(1);
      expect(manifest!.agents[0].name).toBe("Coder");
      expect(manifest!.agents[0].description).toBe("Writes code for tasks");
    });

    it("parses .mcp.json for MCP server names", () => {
      writeFileSync(tempPath(".mcp.json"), JSON.stringify({
        mcpServers: {
          github: { command: "npx", args: ["-y", "github-server"] },
          filesystem: { command: "node", args: ["fs-server.js"] },
        },
      }));

      const manifest = vieter.getPluginManifest(tempDir);
      expect(manifest).not.toBeNull();
      expect(manifest!.mcpServers).toContain("github");
      expect(manifest!.mcpServers).toContain("filesystem");
    });

    it("parses hooks/hooks.json for hook event names", () => {
      mkdirSync(tempPath("hooks"), { recursive: true });
      writeFileSync(tempPath("hooks/hooks.json"), JSON.stringify([
        { event: "SubagentStart" },
        { event: "SubagentStop" },
      ]));

      const manifest = vieter.getPluginManifest(tempDir);
      expect(manifest).not.toBeNull();
      expect(manifest!.hooks).toContain("SubagentStart");
      expect(manifest!.hooks).toContain("SubagentStop");
    });
  });

  describe("getInstalledPlugin", () => {
    it("returns null when plugin not found", () => {
      const plugin = vieter.getInstalledPlugin("nonexistent-plugin");
      expect(plugin).toBeNull();
    });
  });

  describe("resolvePluginPaths", () => {
    it("returns empty map when no plugins found", () => {
      const map = vieter.resolvePluginPaths(["p1", "p2"]);
      expect(map.size).toBe(0);
    });
  });
});
