import { describe, it, expect } from "vitest";
import { MISTAKE_DIGESTER_PRESET } from "../../presets/roles/mistake-digester.js";
import { FEATURE_MINER_PRESET } from "../../presets/roles/feature-miner.js";
import {
  EXECUTION_TOOLS_MUTATION_TOOLS,
  EXECUTION_TOOLS_READONLY_TOOLS,
  EXECUTION_TOOLS_ALL_TOOL_NAMES,
} from "../../manager/execution-tools.js";
import { isSystemMcpTool, SYSTEM_MCP_PREFIXES } from "../../manager/role-mcp-registry.js";

describe("preset role system-MCP fence", () => {
  it("mistake-digester disallows every execution-tools mutation tool", () => {
    const disallowed = new Set(MISTAKE_DIGESTER_PRESET.disallowedTools ?? []);
    for (const tool of EXECUTION_TOOLS_MUTATION_TOOLS) {
      expect(disallowed.has(tool), `mistake-digester must disallow ${tool} (in EXECUTION_TOOLS_MUTATION_TOOLS)`).toBe(true);
    }
  });

  it("feature-miner disallows every execution-tools mutation tool", () => {
    const disallowed = new Set(FEATURE_MINER_PRESET.disallowedTools ?? []);
    for (const tool of EXECUTION_TOOLS_MUTATION_TOOLS) {
      expect(disallowed.has(tool), `feature-miner must disallow ${tool} (in EXECUTION_TOOLS_MUTATION_TOOLS)`).toBe(true);
    }
  });

  it("read-only execution-tools are NOT in either preset's disallowedTools (protects read capability)", () => {
    const digester = new Set(MISTAKE_DIGESTER_PRESET.disallowedTools ?? []);
    const miner = new Set(FEATURE_MINER_PRESET.disallowedTools ?? []);
    for (const tool of EXECUTION_TOOLS_READONLY_TOOLS) {
      expect(digester.has(tool), `mistake-digester must NOT disallow read-only tool ${tool}`).toBe(false);
      expect(miner.has(tool), `feature-miner must NOT disallow read-only tool ${tool}`).toBe(false);
    }
  });
});

describe("EXECUTION_TOOLS_* classification — drift gate", () => {
  it("MUTATION ∪ READONLY equals ALL_TOOL_NAMES (every registered tool is classified)", () => {
    const classified = new Set<string>([
      ...EXECUTION_TOOLS_MUTATION_TOOLS,
      ...EXECUTION_TOOLS_READONLY_TOOLS,
    ]);
    const manifest = new Set(EXECUTION_TOOLS_ALL_TOOL_NAMES);

    // Every classified tool must appear in the manifest (no fictional entries)
    for (const tool of classified) {
      expect(manifest.has(tool), `${tool} is classified but NOT in EXECUTION_TOOLS_ALL_TOOL_NAMES — fictional entry?`).toBe(true);
    }
    // Every manifest entry must be classified (no orphans — caught when adding a tool() registration without classifying it)
    for (const tool of manifest) {
      expect(classified.has(tool), `${tool} is in the manifest but NOT classified — add to EXECUTION_TOOLS_MUTATION_TOOLS or _READONLY_TOOLS`).toBe(true);
    }
    expect(classified.size).toBe(manifest.size);
  });

  it("MUTATION ∩ READONLY is empty (no tool is double-classified)", () => {
    const mutation = new Set(EXECUTION_TOOLS_MUTATION_TOOLS);
    for (const tool of EXECUTION_TOOLS_READONLY_TOOLS) {
      expect(mutation.has(tool), `${tool} appears in BOTH MUTATION and READONLY — pick one`).toBe(false);
    }
  });

  it("every classified tool has the mcp__execution-tools__ prefix", () => {
    for (const tool of EXECUTION_TOOLS_ALL_TOOL_NAMES) {
      expect(tool.startsWith("mcp__execution-tools__"), `${tool} missing required prefix`).toBe(true);
    }
  });
});

describe("isSystemMcpTool", () => {
  it("returns true for every SYSTEM_MCP_PREFIXES member's namespace", () => {
    for (const prefix of SYSTEM_MCP_PREFIXES) {
      expect(isSystemMcpTool(`${prefix}some_tool`)).toBe(true);
    }
  });

  it("returns false for tools outside the system namespace", () => {
    expect(isSystemMcpTool("mcp__plugin-xyz__foo")).toBe(false);
    expect(isSystemMcpTool("mcp__user-mcp__bar")).toBe(false);
    expect(isSystemMcpTool("Bash")).toBe(false);
    expect(isSystemMcpTool("Read")).toBe(false);
  });

  it("returns false for empty / null-shaped inputs", () => {
    expect(isSystemMcpTool("")).toBe(false);
    // The function is typed `(toolName: string): boolean` — non-string inputs are a TS error,
    // but the runtime guard at the top of the function returns false for falsy inputs.
    expect(isSystemMcpTool(undefined as unknown as string)).toBe(false);
    expect(isSystemMcpTool(null as unknown as string)).toBe(false);
  });

  it("returns false for partial prefix matches (no false positives)", () => {
    // Must match the full namespace boundary, not just be a substring.
    expect(isSystemMcpTool("mcp__execution-tool__write")).toBe(false); // singular
    expect(isSystemMcpTool("execution-tools__write_artifact")).toBe(false); // missing mcp__ prefix
    expect(isSystemMcpTool("mcp__")).toBe(false);
  });
});
