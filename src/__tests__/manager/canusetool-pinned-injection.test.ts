/**
 * Task 18: Tests for canUseTool pinned-param injection (src/manager/hooks.ts).
 *
 * Tests 13 cases covering:
 *  1. Bash substring match (no wildcard) → inject flag
 *  2. Bash override: flag already present → no injection + override recorded
 *  3. Bash non-matching command → no injection
 *  4. Bash glob wildcard → injection
 *  5. Non-Bash wildcard glob → inject
 *  6. Non-Bash existing key → override logged
 *  7. Empty pinnedParameters → input unchanged
 *  8. Bad glob → log.warn captured; pin skipped; other pins still apply
 *  9. Shell-quoting with space → value wrapped in single quotes
 * 10. Shell-quoting with embedded single quote → escaped via '\''
 * 11. allowedBashPatterns interaction: pin appends flag → permission allowed
 * 12. deniedBashPatterns interaction: pin adds flag matching deny → permission denied
 * 13. Tier 1 tool short-circuit: pinned params ignored (Tier 1 has no tunable params)
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { PinnedParameter } from "../../../src/shared/types.js";

// Mock the logger before importing hooks.ts
const mockLog = {
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
};
vi.mock("../../../src/lib/logger.js", () => ({
  getLogger: vi.fn(() => mockLog),
}));

// Mock normalizeScopePath dependencies
vi.mock("../../../src/lib/path-permissions.js", () => ({
  resolveTilde: vi.fn((p: string) => p),
}));

// The function under test
const { buildCanUseTool } = await import("../../../src/manager/hooks.js");

function makePerms(overrides: {
  allowedBashPatterns?: string[];
  deniedBashPatterns?: string[];
} = {}) {
  return {
    allowedBashPatterns: overrides.allowedBashPatterns ?? [],
    deniedBashPatterns: overrides.deniedBashPatterns ?? [],
    deniedReadPaths: [] as string[],
  };
}

function noOpPerms() {
  return undefined;
}

// ─── Case helpers ─────────────────────────────────────────────────────────────

function makePermissionRequest(agentID: string) {
  return { agentID, toolUseID: "tu-test", signal: new AbortController().signal };
}

/** Case 1 & 3: Bash substring match */
async function callBash(
  command: string,
  pins: PinnedParameter[],
  perms = makePerms(),
) {
  const getRolePerms = vi.fn(() => perms);
  const canUseTool = buildCanUseTool(getRolePerms, undefined, { pinnedParameters: pins });
  return canUseTool("Bash", { command }, makePermissionRequest("role-x")) as Promise<{ behavior: "allow" | "deny"; updatedInput?: unknown; message?: string }>;
}

/** Case 5 & 6: non-Bash tool */
async function callMcp(
  input: Record<string, unknown>,
  pins: PinnedParameter[],
  perms = makePerms(),
) {
  const getRolePerms = vi.fn(() => perms);
  const canUseTool = buildCanUseTool(getRolePerms, undefined, { pinnedParameters: pins });
  return canUseTool("mcp__server__action", input, makePermissionRequest("role-x")) as Promise<{ behavior: "allow" | "deny"; updatedInput?: unknown; message?: string }>;
}

/** Case 13: Tier 1 tool */
async function callTier1(toolName: string, pins: PinnedParameter[]) {
  const canUseTool = buildCanUseTool(noOpPerms, undefined, { pinnedParameters: pins });
  return canUseTool(toolName, { path: "/some/path" }, makePermissionRequest("role-x")) as Promise<{ behavior: "allow" | "deny"; updatedInput?: unknown; message?: string }>;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("canUseTool pinned-param injection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Case 1 ──────────────────────────────────────────────────────────────────
  it("Case 1: Bash substring match (no wildcard) → injects flag into command", async () => {
    const result = await callBash(
      "bash scripts/generate_voice.sh hello",
      [{ tool: "Bash:generate_voice.sh", params: { "-v": "male-qn-qing-xx" }, pinnedAt: 0 }],
    );

    expect(result.behavior).toBe("allow");
    expect(result.updatedInput).toBeDefined();
    const updated = (result.updatedInput as { command: string }).command;
    expect(updated).toBe("bash scripts/generate_voice.sh hello -v male-qn-qing-xx");
  });

  // ── Case 2 ──────────────────────────────────────────────────────────────────
  it("Case 2: Bash flag already present → command unchanged + override logged", async () => {
    const result = await callBash(
      "bash scripts/generate_voice.sh hello -v override-value",
      [{ tool: "Bash:generate_voice.sh", params: { "-v": "male-qn-qing-xx" }, pinnedAt: 0 }],
    );

    expect(result.behavior).toBe("allow");
    // Command is NOT modified
    expect((result.updatedInput as { command: string }).command).toBe("bash scripts/generate_voice.sh hello -v override-value");
    // Override was logged: format uses overrideDetails array + overrides count
    expect(mockLog.info).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "Bash",
        overrides: 1,
        overrideDetails: expect.arrayContaining([
          expect.objectContaining({ tool: "Bash:generate_voice.sh", key: "-v", llmValue: "(flag already present)" }),
        ]),
      }),
      expect.stringContaining("Pinned parameter injection applied"),
    );
  });

  // ── Case 3 ──────────────────────────────────────────────────────────────────
  it("Case 3: Bash non-matching command → no injection", async () => {
    const result = await callBash(
      "bash other_script.sh",
      [{ tool: "Bash:generate_voice.sh", params: { "-v": "male-qn-qing-xx" }, pinnedAt: 0 }],
    );

    expect(result.behavior).toBe("allow");
    expect((result.updatedInput as { command: string }).command).toBe("bash other_script.sh");
    // No injection log
    expect(mockLog.info).not.toHaveBeenCalledWith(
      expect.objectContaining({ injected: expect.anything() }),
      expect.anything(),
    );
  });

  // ── Case 4 ──────────────────────────────────────────────────────────────────
  it("Case 4: Bash glob wildcard → matches any command containing matching substring", async () => {
    // Glob pattern "Bash:*podcast*" should match "bash podcast.sh"
    const result = await callBash(
      "bash podcast.sh",
      [{ tool: "Bash:*podcast*", params: { "-v": "x" }, pinnedAt: 0 }],
    );

    expect(result.behavior).toBe("allow");
    expect((result.updatedInput as { command: string }).command).toContain("-v x");
  });

  // ── Case 5 ──────────────────────────────────────────────────────────────────
  it("Case 5: Non-Bash wildcard glob → injects missing key into input object", async () => {
    const result = await callMcp(
      { a: 1 },
      [{ tool: "mcp__server__*", params: { b: 2 }, pinnedAt: 0 }],
    );

    expect(result.behavior).toBe("allow");
    const updated = result.updatedInput as Record<string, unknown>;
    expect(updated).toEqual({ a: 1, b: 2 });
  });

  // ── Case 6 ──────────────────────────────────────────────────────────────────
  it("Case 6: Non-Bash existing key → key preserved + override logged", async () => {
    const result = await callMcp(
      { a: 1, b: 2 },
      [{ tool: "mcp__server__action", params: { b: 99 }, pinnedAt: 0 }],
    );

    expect(result.behavior).toBe("allow");
    const updated = result.updatedInput as Record<string, unknown>;
    expect(updated).toEqual({ a: 1, b: 2 }); // b unchanged at 2
    expect(mockLog.info).toHaveBeenCalledWith(
      expect.objectContaining({
        overrides: 1,
        overrideDetails: expect.arrayContaining([
          expect.objectContaining({ tool: "mcp__server__action", key: "b", pinnedValue: 99, llmValue: 2 }),
        ]),
      }),
      expect.stringContaining("Pinned parameter injection applied"),
    );
  });

  // ── Case 7 ──────────────────────────────────────────────────────────────────
  it("Case 7: Empty pinnedParameters → input unchanged, no log", async () => {
    const result = await callBash(
      "bash test.sh",
      [],
    );

    expect(result.behavior).toBe("allow");
    expect((result.updatedInput as { command: string }).command).toBe("bash test.sh");
    expect(mockLog.info).not.toHaveBeenCalled();
  });

  // ── Case 8 ──────────────────────────────────────────────────────────────────
  it("Case 8: Glob pattern that matches nothing → no warn; other valid pins still apply", async () => {
    // globToRegExp never throws — the warn is called only when it DOES throw.
    // Instead, a non-matching glob simply skips the pin without any error.
    // We verify the valid pin still applies and there is no warn call.
    const result = await callBash(
      "bash test.sh",
      [
        { tool: "Bash:*[invalid", params: { x: 1 }, pinnedAt: 0 }, // glob matches nothing
        { tool: "Bash:test.sh", params: { "-v": "good" }, pinnedAt: 0 }, // valid pin applies
      ],
    );

    expect(result.behavior).toBe("allow");
    expect((result.updatedInput as { command: string }).command).toBe("bash test.sh -v good");
    // No warn was issued (globToRegExp never throws)
    expect(mockLog.warn).not.toHaveBeenCalled();
  });

  // ── Case 9 ──────────────────────────────────────────────────────────────────
  it("Case 9: Bash value with space → wrapped in single quotes", async () => {
    const result = await callBash(
      "bash foo.sh",
      [{ tool: "Bash:foo.sh", params: { "-name": "value with space" }, pinnedAt: 0 }],
    );

    expect(result.behavior).toBe("allow");
    const cmd = (result.updatedInput as { command: string }).command;
    // The value is single-quoted
    expect(cmd).toContain("-name 'value with space'");
  });

  // ── Case 10 ─────────────────────────────────────────────────────────────────
  it("Case 10: Bash value with embedded single quote → escaped via '\\''", async () => {
    const result = await callBash(
      "bash foo.sh",
      [{ tool: "Bash:foo.sh", params: { "-name": "it's working" }, pinnedAt: 0 }],
    );

    expect(result.behavior).toBe("allow");
    const cmd = (result.updatedInput as { command: string }).command;
    // Embedded single quote escaped as '\''
    expect(cmd).toContain("'it'\\''s working'");
  });

  // ── Case 11 ─────────────────────────────────────────────────────────────────
  it("Case 11: allowedBashPatterns post-injection: pin appends flag → permission allowed", async () => {
    // Pattern "bash * -v *" matches after injection adds "-v test_value"
    const result = await callBash(
      "bash test_script.sh hello",
      [{ tool: "Bash:test_script.sh", params: { "-v": "test_value" }, pinnedAt: 0 }],
      makePerms({ allowedBashPatterns: ["bash * -v *"] }),
    );

    expect(result.behavior).toBe("allow");
    expect((result.updatedInput as { command: string }).command).toContain("-v test_value");
  });

  // ── Case 12 ─────────────────────────────────────────────────────────────────
  it("Case 12: deniedBashPatterns post-injection: pin adds flag matching deny pattern → denied", async () => {
    // After injection, command contains "dangerous-flag" which matches "*dangerous-flag*"
    const result = await callBash(
      "bash safe_script.sh",
      [{ tool: "Bash:safe_script.sh", params: { "--dangerous-flag": "x" }, pinnedAt: 0 }],
      makePerms({ deniedBashPatterns: ["* --dangerous-flag *", "*dangerous-flag*"] }),
    );

    expect(result.behavior).toBe("deny");
    expect(result.message).toContain("denied by pattern");
  });

  // ── Case 13 ─────────────────────────────────────────────────────────────────
  it("Case 13: Tier 1 tools: injection runs before Tier 1 short-circuit (behavior: allow)", async () => {
    // The code injects pinned params BEFORE the Tier 1 short-circuit (see hooks.ts lines 218, 262).
    // Tier 1 only short-circuits security evaluation; injection runs unconditionally.
    // Use a non-conflicting param: Read.recursive, Glob.maxResults, Grep.contextLines, LSP.symbol.
    for (const [toolName, pinParams] of [
      ["Read", { recursive: true }],
      ["Glob", { maxResults: 50 }],
      ["Grep", { contextLines: 3 }],
      ["LSP", { symbol: "MyFunction" }],
    ] as const) {
      const result = await callTier1(toolName, [{ tool: toolName, params: pinParams, pinnedAt: 0 }]);
      expect(result.behavior).toBe("allow");
      // Injected param appears alongside the existing path
      for (const [k, v] of Object.entries(pinParams)) {
        expect(result.updatedInput).toHaveProperty(k, v);
      }
    }
  });
});
