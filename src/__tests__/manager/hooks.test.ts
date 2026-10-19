import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, getTestDb } from "../helpers/test-db.js";
import {
  SYSTEM_MCP_PREFIXES,
  isExternalOAuthMcpTool,
  externalOAuthDenyGlobs,
} from "../../manager/role-mcp-registry.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

vi.mock("../../agent/memory-service.js", () => ({
  getRelevantMemoryContext: vi.fn().mockResolvedValue(""),
  queryMemoryByTier: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../agent/belief-injection.js", () => ({
  selectInjectionBeliefs: vi.fn().mockResolvedValue([]),
  formatInjectionContext: vi.fn().mockReturnValue(""),
}));

vi.mock("../../store/logs.js", () => ({
  createStepLog: vi.fn(),
}));

const { buildCanUseTool, buildSessionHooks } = await import("../../manager/hooks.js");

describe("hooks", () => {
  afterAll(() => cleanup());

  describe("buildCanUseTool", () => {
    const mockGetRolePermissions = vi.fn();

    beforeEach(() => {
      mockGetRolePermissions.mockReset();
    });

    describe("Tier 1: Read-only tools auto-allow (when role doesn't forbid them)", () => {
      const tier1Tools = ["Read", "Glob", "Grep", "LSP"];

      for (const toolName of tier1Tools) {
        it(`should auto-allow ${toolName} when role has no prohibition`, async () => {
          // Role exists but disallowedTools/allowedTools are empty/undefined → auto-allow.
          mockGetRolePermissions.mockReturnValue({});
          const canUseTool = buildCanUseTool(mockGetRolePermissions);
          const result = await canUseTool(toolName, { file_path: "/some/path" }, { agentID: "skill-1", toolUseID: "tu-1", signal: new AbortController().signal });

          expect(result.behavior).toBe("allow");
        });
      }
    });

    describe("Tier 2: Write tools auto-allow (when role doesn't forbid them)", () => {
      it("should auto-allow Edit when role has no prohibition", async () => {
        mockGetRolePermissions.mockReturnValue({});
        const canUseTool = buildCanUseTool(mockGetRolePermissions);
        const result = await canUseTool("Edit", {}, { agentID: "skill-1", toolUseID: "tu-1", signal: new AbortController().signal });

        expect(result.behavior).toBe("allow");
      });

      it("should auto-allow Write when role has no prohibition", async () => {
        mockGetRolePermissions.mockReturnValue({});
        const canUseTool = buildCanUseTool(mockGetRolePermissions);
        const result = await canUseTool("Write", { file_path: "/any/path.txt" }, { agentID: "skill-1", toolUseID: "tu-1", signal: new AbortController().signal });

        expect(result.behavior).toBe("allow");
      });

      it("should auto-allow NotebookEdit when role has no prohibition", async () => {
        mockGetRolePermissions.mockReturnValue({});
        const canUseTool = buildCanUseTool(mockGetRolePermissions);
        const result = await canUseTool("NotebookEdit", {}, { agentID: "skill-1", toolUseID: "tu-1", signal: new AbortController().signal });

        expect(result.behavior).toBe("allow");
      });
    });

    // Regression coverage for #202: tool-prohibition gate must precede Tier 1/2 auto-allow
    // and blockedPath approval. disallowedTools is absolute; allowedTools (when non-empty) is a hard allowlist.
    describe("tool-prohibition gate (#202)", () => {
      it("should deny disallowed Tier 1 tools (CE1: Tier 1 auto-allow ran before disallowed check)", async () => {
        // role-15827594 case: disallowedTools includes Read but task issued Read calls anyway
        mockGetRolePermissions.mockReturnValue({ disallowedTools: ["Read", "Glob", "Grep"] });
        const canUseTool = buildCanUseTool(mockGetRolePermissions);
        const result = await canUseTool("Read", { file_path: "/x" }, { agentID: "role-15827594", toolUseID: "tu-1", signal: new AbortController().signal });

        expect(result.behavior).toBe("deny");
        expect((result as { message: string }).message).toContain("not allowed");
      });

      it("should deny disallowed Tier 2 write tools", async () => {
        mockGetRolePermissions.mockReturnValue({ disallowedTools: ["Edit", "Write"] });
        const canUseTool = buildCanUseTool(mockGetRolePermissions);
        const result = await canUseTool("Write", { file_path: "/x" }, { agentID: "role-15827594", toolUseID: "tu-1", signal: new AbortController().signal });

        expect(result.behavior).toBe("deny");
      });

      it("should deny disallowed Bash even when blockedPath would normally trigger approval (CE2)", async () => {
        // CE2: blockedPath escalation ran before tool-level disallow → role could approve a forbidden Bash
        mockGetRolePermissions.mockReturnValue({ disallowedTools: ["Bash"] });
        const requestApproval = vi.fn().mockResolvedValue({ behavior: "allow", updatedInput: { command: "ls" } });
        const canUseTool = buildCanUseTool(
          mockGetRolePermissions,
          requestApproval,
          { roleScope: ["/role/cwd"] },
        );

        const result = await canUseTool(
          "Bash",
          { command: "ls /outside" },
          { agentID: "role-15827594", toolUseID: "tu-1", signal: new AbortController().signal, blockedPath: "/outside/x" },
        );

        expect(result.behavior).toBe("deny");
        expect(requestApproval).not.toHaveBeenCalled();
      });

      it("should treat allowedTools as a hard allowlist when non-empty (CE3)", async () => {
        // role-15827594 had allowedTools: ["mcp__audit-tools__aggregate_mistakes"] but called Bash, Read, ...
        mockGetRolePermissions.mockReturnValue({
          allowedTools: ["mcp__audit-tools__aggregate_mistakes"],
        });
        const canUseTool = buildCanUseTool(mockGetRolePermissions);

        const bashResult = await canUseTool("Bash", { command: "echo" }, { agentID: "role-15827594", toolUseID: "tu-1", signal: new AbortController().signal });
        expect(bashResult.behavior).toBe("deny");
        expect((bashResult as { message: string }).message).toContain("allowlist");

        const readResult = await canUseTool("Read", { file_path: "/x" }, { agentID: "role-15827594", toolUseID: "tu-2", signal: new AbortController().signal });
        expect(readResult.behavior).toBe("deny");

        const allowedResult = await canUseTool(
          "mcp__audit-tools__aggregate_mistakes",
          {},
          { agentID: "role-15827594", toolUseID: "tu-3", signal: new AbortController().signal },
        );
        expect(allowedResult.behavior).toBe("allow");
      });

      it("should not enforce allowlist when allowedTools is empty/undefined (no restriction)", async () => {
        mockGetRolePermissions.mockReturnValue({ allowedTools: [] });
        const canUseTool = buildCanUseTool(mockGetRolePermissions);
        const result = await canUseTool("Bash", { command: "ls" }, { agentID: "skill-1", toolUseID: "tu-1", signal: new AbortController().signal });

        expect(result.behavior).toBe("allow");
      });
    });

    describe("system MCP carve-out (publish_artifact_file et al.)", () => {
      // Test A: positive carve-out — must FAIL before Task 1-impl and PASS after.
      // Reproduces production failure from execution ddf6c8ea-9925-43a5-bd33-9f47d7d4fb7a
      // where 达芬奇's allowedTools whitelist blocked publish_artifact_file.
      it("A: should allow mcp__execution-tools__publish_artifact_file even when not in allowedTools", async () => {
        mockGetRolePermissions.mockReturnValue({
          allowedTools: ["WebSearch", "WebFetch", "Read", "Write", "Bash", "Grep", "Glob", "Agent"],
        });
        const canUseTool = buildCanUseTool(mockGetRolePermissions);
        const result = await canUseTool(
          "mcp__execution-tools__publish_artifact_file",
          {},
          { agentID: "role-x", toolUseID: "tu-1", signal: new AbortController().signal },
        );

        expect(result.behavior).toBe("allow");
      });

      // Test B: regression shield — carve-out only covers SYSTEM_MCP_PREFIXES; user/plugin MCPs
      // are still subject to allowlist. Using mcp__plugin-xyz__ (not a system MCP) to verify.
      it("B: should still deny mcp__plugin-xyz__some_other_tool when not in allowedTools", async () => {
        mockGetRolePermissions.mockReturnValue({
          allowedTools: ["mcp__audit-tools__aggregate_mistakes"],
        });
        const canUseTool = buildCanUseTool(mockGetRolePermissions);
        const result = await canUseTool(
          "mcp__plugin-xyz__some_other_tool",
          {},
          { agentID: "role-x", toolUseID: "tu-1", signal: new AbortController().signal },
        );

        expect(result.behavior).toBe("deny");
        expect((result as { message: string }).message).toContain("allowlist");
      });

      // Test C: disallowedTools override — admin block still wins even against carve-out tools.
      it("C: should deny mcp__execution-tools__publish_artifact_file when in disallowedTools", async () => {
        mockGetRolePermissions.mockReturnValue({
          disallowedTools: ["mcp__execution-tools__publish_artifact_file"],
        });
        const canUseTool = buildCanUseTool(mockGetRolePermissions);
        const result = await canUseTool(
          "mcp__execution-tools__publish_artifact_file",
          {},
          { agentID: "role-x", toolUseID: "tu-1", signal: new AbortController().signal },
        );

        expect(result.behavior).toBe("deny");
        expect((result as { message: string }).message).toContain("not allowed");
      });

      // Test D: positive control — empty allowedTools means no allowlist, write_artifact passes through.
      it("D: should allow mcp__execution-tools__write_artifact when allowedTools is empty (no restriction)", async () => {
        mockGetRolePermissions.mockReturnValue({ allowedTools: [] });
        const canUseTool = buildCanUseTool(mockGetRolePermissions);
        const result = await canUseTool(
          "mcp__execution-tools__write_artifact",
          {},
          { agentID: "role-x", toolUseID: "tu-1", signal: new AbortController().signal },
        );

        expect(result.behavior).toBe("allow");
      });
    });

    describe("SYSTEM_MCP_PREFIXES — all 3 system MCPs", () => {
      // Case M1 — mining-tools carve-out positive.
      // FAIL pre-impl: current carve-out only recognizes execution-tools.
      it("M1: should allow mcp__mining-tools__record_feature_request even when not in allowedTools", async () => {
        mockGetRolePermissions.mockReturnValue({
          allowedTools: ["WebSearch", "Read"],
        });
        const canUseTool = buildCanUseTool(mockGetRolePermissions);
        const result = await canUseTool(
          "mcp__mining-tools__record_feature_request",
          {},
          { agentID: "role-x", toolUseID: "tu-1", signal: new AbortController().signal },
        );

        expect(result.behavior).toBe("allow");
      });

      // Case M2 — audit-tools carve-out positive.
      // FAIL pre-impl: current carve-out only recognizes execution-tools.
      it("M2: should allow mcp__audit-tools__aggregate_mistakes even when not in allowedTools", async () => {
        mockGetRolePermissions.mockReturnValue({
          allowedTools: ["WebSearch", "Read"],
        });
        const canUseTool = buildCanUseTool(mockGetRolePermissions);
        const result = await canUseTool(
          "mcp__audit-tools__aggregate_mistakes",
          {},
          { agentID: "role-x", toolUseID: "tu-1", signal: new AbortController().signal },
        );

        expect(result.behavior).toBe("allow");
      });

      // Case M3 — non-system MCP gated. PASS pre- and post-impl (regression shield).
      it("M3: should deny mcp__plugin-xyz__some_tool when not in allowedTools (non-system MCP)", async () => {
        mockGetRolePermissions.mockReturnValue({
          allowedTools: ["WebSearch"],
        });
        const canUseTool = buildCanUseTool(mockGetRolePermissions);
        const result = await canUseTool(
          "mcp__plugin-xyz__some_tool",
          {},
          { agentID: "role-x", toolUseID: "tu-1", signal: new AbortController().signal },
        );

        expect(result.behavior).toBe("deny");
        expect((result as { message: string }).message).toContain("allowlist");
      });

      // Case M4 — disallowedTools override on mining-tools. PASS pre- and post-impl.
      it("M4: should deny mcp__mining-tools__record_feature_request when in disallowedTools (admin override)", async () => {
        mockGetRolePermissions.mockReturnValue({
          disallowedTools: ["mcp__mining-tools__record_feature_request"],
        });
        const canUseTool = buildCanUseTool(mockGetRolePermissions);
        const result = await canUseTool(
          "mcp__mining-tools__record_feature_request",
          {},
          { agentID: "role-x", toolUseID: "tu-1", signal: new AbortController().signal },
        );

        expect(result.behavior).toBe("deny");
        expect((result as { message: string }).message).toContain("not allowed");
      });

      // Case M5 — disallowedTools override on audit-tools. PASS pre- and post-impl.
      it("M5: should deny mcp__audit-tools__aggregate_mistakes when in disallowedTools (admin override)", async () => {
        mockGetRolePermissions.mockReturnValue({
          disallowedTools: ["mcp__audit-tools__aggregate_mistakes"],
        });
        const canUseTool = buildCanUseTool(mockGetRolePermissions);
        const result = await canUseTool(
          "mcp__audit-tools__aggregate_mistakes",
          {},
          { agentID: "role-x", toolUseID: "tu-1", signal: new AbortController().signal },
        );

        expect(result.behavior).toBe("deny");
        expect((result as { message: string }).message).toContain("not allowed");
      });

      // Case M6 — blockedPath + system MCP carve-out.
      // carve-out returns BEFORE blockedPath branch; path safety enforced at the tool-handler
      // layer (src/manager/execution-tools.ts validatePathInWorkspace).
      it("M6: should allow mcp__execution-tools__publish_artifact_file with blockedPath (carve-out bypasses blockedPath branch)", async () => {
        mockGetRolePermissions.mockReturnValue({
          allowedTools: ["WebSearch"],
        });
        const canUseTool = buildCanUseTool(
          mockGetRolePermissions,
          undefined,
          { roleScope: ["/Users/x/role-cwd"] },
        );
        const result = await canUseTool(
          "mcp__execution-tools__publish_artifact_file",
          {},
          { agentID: "role-x", toolUseID: "tu-1", signal: new AbortController().signal, blockedPath: "/Users/x/role-cwd/some-file.md" },
        );

        expect(result.behavior).toBe("allow");
      });

      // Case M7 — pinned-parameter pass-through: carve-out returns effectiveInput after pin injection.
      it("M7: should return updatedInput with pinned step_id when carve-out allows publish_artifact_file", async () => {
        mockGetRolePermissions.mockReturnValue({
          allowedTools: ["WebSearch"],
        });
        const canUseTool = buildCanUseTool(
          mockGetRolePermissions,
          undefined,
          {
            pinnedParameters: [
              { tool: "mcp__execution-tools__publish_artifact_file", params: { step_id: "step-pinned" }, pinnedAt: Date.now() },
            ],
          },
        );
        const result = await canUseTool(
          "mcp__execution-tools__publish_artifact_file",
          { key: "k", sourcePath: "/x" },
          { agentID: "role-x", toolUseID: "tu-1", signal: new AbortController().signal },
        );

        expect(result.behavior).toBe("allow");
        expect((result as { updatedInput: Record<string, unknown> }).updatedInput.step_id).toBe("step-pinned");
      });

      // Case M8 — agentID=undefined fallthrough.
      // perms-undefined → carve-out branch is skipped; Tier 3 default-allow takes over.
      it("M8: should allow mcp__execution-tools__publish_artifact_file when agentID is undefined (no perms to check)", async () => {
        const canUseTool = buildCanUseTool(mockGetRolePermissions);
        const result = await canUseTool(
          "mcp__execution-tools__publish_artifact_file",
          {},
          { agentID: undefined as unknown as string, toolUseID: "tu-1", signal: new AbortController().signal },
        );

        expect(result.behavior).toBe("allow");
      });
    });

    describe("SYSTEM_MCP_PREFIXES — invariants", () => {
      // Case I1 — set is non-empty.
      it("I1: SYSTEM_MCP_PREFIXES.size >= 3", () => {
        expect(SYSTEM_MCP_PREFIXES.size).toBeGreaterThanOrEqual(3);
      });

      // Case I2 — execution-tools prefix in set.
      it("I2: SYSTEM_MCP_PREFIXES contains execution-tools prefix", () => {
        expect(SYSTEM_MCP_PREFIXES.has("mcp__execution-tools__")).toBe(true);
      });

      // Case I3 — mining-tools prefix in set.
      it("I3: SYSTEM_MCP_PREFIXES contains mining-tools prefix", () => {
        expect(SYSTEM_MCP_PREFIXES.has("mcp__mining-tools__")).toBe(true);
      });

      // Case I4 — audit-tools prefix in set.
      it("I4: SYSTEM_MCP_PREFIXES contains audit-tools prefix", () => {
        expect(SYSTEM_MCP_PREFIXES.has("mcp__audit-tools__")).toBe(true);
      });

      // Case I5 — prefix↔MCP_NAME shape consistency.
      it("I5: every SYSTEM_MCP_PREFIXES entry has correct structural shape (mcp__...__ with content)", () => {
        for (const prefix of SYSTEM_MCP_PREFIXES) {
          expect(prefix.startsWith("mcp__")).toBe(true);
          expect(prefix.endsWith("__")).toBe(true);
          // More than "mcp____" (length 7 is "mcp____", 8 minimum for "mcp__x__")
          expect(prefix.length).toBeGreaterThan(7);
        }
      });
    });

    describe("Tier 3: Full evaluation", () => {
      it("should allow Bash when not in disallowed tools", async () => {
        mockGetRolePermissions.mockReturnValue({
          disallowedTools: [],
        });
        const canUseTool = buildCanUseTool(mockGetRolePermissions);
        const result = await canUseTool("Bash", { command: "ls" }, { agentID: "skill-1", toolUseID: "tu-1", signal: new AbortController().signal });

        expect(result.behavior).toBe("allow");
      });

      it("should deny Bash when in disallowed tools", async () => {
        mockGetRolePermissions.mockReturnValue({
          disallowedTools: ["Bash"],
        });
        const canUseTool = buildCanUseTool(mockGetRolePermissions);
        const result = await canUseTool("Bash", { command: "rm -rf /" }, { agentID: "skill-1", toolUseID: "tu-1", signal: new AbortController().signal });

        expect(result.behavior).toBe("deny");
        expect(result).toHaveProperty("message");
        expect((result as { message: string }).message).toContain("not allowed");
      });

      it("should allow WebFetch when not disallowed", async () => {
        mockGetRolePermissions.mockReturnValue({
          disallowedTools: [],
        });
        const canUseTool = buildCanUseTool(mockGetRolePermissions);
        const result = await canUseTool("WebFetch", { url: "https://example.com" }, { agentID: "skill-1", toolUseID: "tu-1", signal: new AbortController().signal });

        expect(result.behavior).toBe("allow");
      });
    });

    describe("deny-and-continue behavior (D-016)", () => {
      it("should return message (not interrupt) on deny for Tier 3", async () => {
        mockGetRolePermissions.mockReturnValue({
          disallowedTools: ["Agent"],
        });
        const canUseTool = buildCanUseTool(mockGetRolePermissions);
        const result = await canUseTool("Agent", {}, { agentID: "skill-1", toolUseID: "tu-1", signal: new AbortController().signal });

        expect(result.behavior).toBe("deny");
        const msg = (result as { message: string }).message;
        expect(msg).toBeTruthy();
        // The deny response should NOT have an "interrupt" field set to true
        expect(result).not.toHaveProperty("interrupt");
      });
    });

    describe("agentID handling", () => {
      it("should allow Tier 3 tools when no agentID (no permissions to check)", async () => {
        const canUseTool = buildCanUseTool(mockGetRolePermissions);
        const result = await canUseTool("Bash", { command: "echo hello" }, { agentID: undefined as unknown as string, toolUseID: "tu-1", signal: new AbortController().signal });

        expect(result.behavior).toBe("allow");
      });
    });

    describe("blockedPath handling (D-S01)", () => {
      it("should allow blockedPath when it is still inside roleScope", async () => {
        mockGetRolePermissions.mockReturnValue({});
        const requestApproval = vi.fn();
        const canUseTool = buildCanUseTool(
          mockGetRolePermissions,
          requestApproval,
          {
            deniedReadPaths: ["/Users/x/.ssh"],
            roleScope: ["/Users/x/roles/worker-1"],
          },
        );

        const result = await canUseTool(
          "Bash",
          { command: "printf 'ok' > runtime_relative_probe.txt" },
          {
            agentID: "role-1",
            toolUseID: "tu-1",
            blockedPath: "/Users/x/roles/worker-1/runtime_relative_probe.txt",
            signal: new AbortController().signal,
          },
        );

        expect(result.behavior).toBe("allow");
        expect(requestApproval).not.toHaveBeenCalled();
      });

      it("should deny when blockedPath is in deniedReadPaths", async () => {
        mockGetRolePermissions.mockReturnValue({});
        const canUseTool = buildCanUseTool(
          mockGetRolePermissions,
          undefined,
          { deniedReadPaths: ["/Users/x/.ssh"] },
        );

        const result = await canUseTool(
          "Read",
          { file_path: "/Users/x/.ssh/id_rsa" },
          { agentID: "role-1", toolUseID: "tu-1", blockedPath: "/Users/x/.ssh/id_rsa", signal: new AbortController().signal },
        );

        expect(result.behavior).toBe("deny");
        expect((result as { message: string }).message).toContain("denied read paths");
      });

      it("should call requestApproval when blockedPath is not in deniedReadPaths", async () => {
        mockGetRolePermissions.mockReturnValue({});
        const requestApproval = vi.fn().mockResolvedValue({ behavior: "allow", updatedInput: {} });
        const canUseTool = buildCanUseTool(
          mockGetRolePermissions,
          requestApproval,
          {
            deniedReadPaths: ["/Users/x/.ssh"],
            roleScope: ["/Users/x/roles/worker-1"],
          },
        );

        const result = await canUseTool(
          "Read",
          { file_path: "/Users/x/Documents/file.pdf" },
          { agentID: "role-1", toolUseID: "tu-1", blockedPath: "/Users/x/Documents/file.pdf", signal: new AbortController().signal },
        );

        expect(requestApproval).toHaveBeenCalledWith(
          "Read",
          { file_path: "/Users/x/Documents/file.pdf" },
          "blockedPath:/Users/x/Documents/file.pdf",
          "role-1",
        );
        expect(result.behavior).toBe("allow");
      });

      it("should deny without requestApproval when blockedPath is outside scope", async () => {
        mockGetRolePermissions.mockReturnValue({});
        const canUseTool = buildCanUseTool(
          mockGetRolePermissions,
          undefined, // no requestApproval
          { deniedReadPaths: [] },
        );

        const result = await canUseTool(
          "Read",
          { file_path: "/Users/x/Documents/file.pdf" },
          { agentID: "role-1", toolUseID: "tu-1", blockedPath: "/Users/x/Documents/file.pdf", signal: new AbortController().signal },
        );

        expect(result.behavior).toBe("deny");
        expect((result as { message: string }).message).toContain("outside this role's allowed scope");
      });

      it("should allow when no blockedPath (existing tier logic unchanged)", async () => {
        mockGetRolePermissions.mockReturnValue({ disallowedTools: [] });
        const canUseTool = buildCanUseTool(mockGetRolePermissions);

        const result = await canUseTool(
          "Bash",
          { command: "ls" },
          { agentID: "role-1", toolUseID: "tu-1", signal: new AbortController().signal },
        );

        expect(result.behavior).toBe("allow");
      });
    });

    describe("Bash three-tier control (D-002)", () => {
      it("should auto-allow Bash when command matches allowedBashPatterns", async () => {
        mockGetRolePermissions.mockReturnValue({
          allowedBashPatterns: ["git status", "pnpm test*"],
          deniedBashPatterns: [],
          disallowedTools: [],
        });
        const canUseTool = buildCanUseTool(mockGetRolePermissions);

        const result = await canUseTool(
          "Bash",
          { command: "git status" },
          { agentID: "role-1", toolUseID: "tu-1", signal: new AbortController().signal },
        );

        expect(result.behavior).toBe("allow");
      });

      it("should auto-deny Bash when command matches deniedBashPatterns", async () => {
        mockGetRolePermissions.mockReturnValue({
          allowedBashPatterns: [],
          deniedBashPatterns: ["rm -rf /", "ssh *"],
          disallowedTools: [],
        });
        const canUseTool = buildCanUseTool(mockGetRolePermissions);

        const result = await canUseTool(
          "Bash",
          { command: "rm -rf /" },
          { agentID: "role-1", toolUseID: "tu-1", signal: new AbortController().signal },
        );

        expect(result.behavior).toBe("deny");
        expect((result as { message: string }).message).toContain("rm -rf");
      });

      it("should fall through to approvalRequired when no Bash pattern matches", async () => {
        mockGetRolePermissions.mockReturnValue({
          allowedBashPatterns: ["git status"],
          deniedBashPatterns: ["rm -rf /"],
          approvalRequired: ["curl *"],
          disallowedTools: [],
        });
        const requestApproval = vi.fn().mockResolvedValue({ behavior: "allow", updatedInput: {} });
        const canUseTool = buildCanUseTool(mockGetRolePermissions, requestApproval);

        const result = await canUseTool(
          "Bash",
          { command: "curl https://api.example.com" },
          { agentID: "role-1", toolUseID: "tu-1", signal: new AbortController().signal },
        );

        expect(requestApproval).toHaveBeenCalled();
        expect(result.behavior).toBe("allow");
      });

      it("should skip invalid glob patterns without crashing", async () => {
        mockGetRolePermissions.mockReturnValue({
          allowedBashPatterns: ["[invalid"],
          deniedBashPatterns: [],
          approvalRequired: [],
          disallowedTools: [],
        });
        const canUseTool = buildCanUseTool(mockGetRolePermissions);

        // Should not throw even though "[invalid" is not a valid glob
        const result = await canUseTool(
          "Bash",
          { command: "ls" },
          { agentID: "role-1", toolUseID: "tu-1", signal: new AbortController().signal },
        );

        expect(result.behavior).toBe("allow");
      });
    });

    describe("privilege escalation (D-001/D-002): approvalRequired glob pattern matching", () => {
      it("should call requestApproval when Bash command matches approvalRequired glob pattern", async () => {
        mockGetRolePermissions.mockReturnValue({ disallowedTools: [], approvalRequired: ["rm -rf *"] });
        const requestApproval = vi.fn().mockResolvedValue({ behavior: "allow", updatedInput: { command: "rm -rf /tmp" } });
        const canUseTool = buildCanUseTool(mockGetRolePermissions, requestApproval);

        const result = await canUseTool("Bash", { command: "rm -rf /tmp/test" }, { agentID: "role-1", toolUseID: "tu-1", signal: new AbortController().signal });

        expect(requestApproval).toHaveBeenCalledWith("Bash", { command: "rm -rf /tmp/test" }, "rm -rf *", "role-1");
        expect(result.behavior).toBe("allow");
      });

      it("should NOT call requestApproval when no approvalRequired patterns match", async () => {
        mockGetRolePermissions.mockReturnValue({ disallowedTools: [], approvalRequired: ["rm -rf *"] });
        const requestApproval = vi.fn();
        const canUseTool = buildCanUseTool(mockGetRolePermissions, requestApproval);

        const result = await canUseTool("Bash", { command: "ls -la" }, { agentID: "role-1", toolUseID: "tu-1", signal: new AbortController().signal });

        expect(requestApproval).not.toHaveBeenCalled();
        expect(result.behavior).toBe("allow");
      });

      it("should match approvalRequired pattern against full toolName + JSON input for non-Bash tools", async () => {
        mockGetRolePermissions.mockReturnValue({ disallowedTools: [], approvalRequired: ["*api*"] });
        const requestApproval = vi.fn().mockResolvedValue({ behavior: "allow", updatedInput: {} });
        const canUseTool = buildCanUseTool(mockGetRolePermissions, requestApproval);

        const result = await canUseTool("WebFetch", { url: "https://api.example.com/data" }, { agentID: "role-1", toolUseID: "tu-1", signal: new AbortController().signal });

        expect(requestApproval).toHaveBeenCalled();
        expect(result.behavior).toBe("allow");
      });

      it("should skip invalid glob patterns without throwing", async () => {
        mockGetRolePermissions.mockReturnValue({ disallowedTools: [], approvalRequired: ["[invalid"] });
        const requestApproval = vi.fn();
        const canUseTool = buildCanUseTool(mockGetRolePermissions, requestApproval);

        // Should not throw even though "[invalid" is not a valid glob
        const result = await canUseTool("Bash", { command: "ls" }, { agentID: "role-1", toolUseID: "tu-1", signal: new AbortController().signal });

        expect(requestApproval).not.toHaveBeenCalled();
        expect(result.behavior).toBe("allow");
      });

      it("should call requestApproval with correct matchedPattern on multiple pattern match", async () => {
        mockGetRolePermissions.mockReturnValue({ disallowedTools: [], approvalRequired: ["curl * -X POST*", "rm -rf *", "git push*"] });
        const requestApproval = vi.fn().mockResolvedValue({ behavior: "deny", message: "denied" });
        const canUseTool = buildCanUseTool(mockGetRolePermissions, requestApproval);

        const result = await canUseTool("Bash", { command: "curl https://api.example.com -X POST" }, { agentID: "role-1", toolUseID: "tu-1", signal: new AbortController().signal });

        expect(requestApproval).toHaveBeenCalledWith("Bash", { command: "curl https://api.example.com -X POST" }, "curl * -X POST*", "role-1");
        expect(result.behavior).toBe("deny");
      });

      it("should deny when requestApproval resolves to deny", async () => {
        mockGetRolePermissions.mockReturnValue({ disallowedTools: [], approvalRequired: ["git push*"] });
        const requestApproval = vi.fn().mockResolvedValue({ behavior: "deny", message: "Not authorized" });
        const canUseTool = buildCanUseTool(mockGetRolePermissions, requestApproval);

        const result = await canUseTool("Bash", { command: "git push origin main" }, { agentID: "role-1", toolUseID: "tu-1", signal: new AbortController().signal });

        expect(result.behavior).toBe("deny");
        expect((result as { message: string }).message).toBe("Not authorized");
      });

      it("should NOT escalate when requestApproval is not provided", async () => {
        // Even with matching patterns, no requestApproval means direct allow
        mockGetRolePermissions.mockReturnValue({ disallowedTools: [], approvalRequired: ["rm -rf *"] });
        const canUseTool = buildCanUseTool(mockGetRolePermissions); // no second arg

        const result = await canUseTool("Bash", { command: "rm -rf /tmp" }, { agentID: "role-1", toolUseID: "tu-1", signal: new AbortController().signal });

        expect(result.behavior).toBe("allow");
      });
    });

    describe("external OAuth MCP default-deny (#114)", () => {
      it("should deny mcp__claude_ai_Gmail__gmail_search_messages when role has empty allowlist", async () => {
        mockGetRolePermissions.mockReturnValue({});
        const canUseTool = buildCanUseTool(mockGetRolePermissions);
        const result = await canUseTool(
          "mcp__claude_ai_Gmail__gmail_search_messages",
          { q: "is:unread" },
          { agentID: "skill-1", toolUseID: "tu-1", signal: new AbortController().signal },
        );

        expect(result.behavior).toBe("deny");
      });

      it("should allow mcp__claude_ai_Gmail__gmail_search_messages when role opts in via glob", async () => {
        mockGetRolePermissions.mockReturnValue({ allowedTools: ["mcp__claude_ai_Gmail__*"] });
        const canUseTool = buildCanUseTool(mockGetRolePermissions);
        const result = await canUseTool(
          "mcp__claude_ai_Gmail__gmail_search_messages",
          { q: "is:unread" },
          { agentID: "skill-1", toolUseID: "tu-1", signal: new AbortController().signal },
        );

        expect(result.behavior).toBe("allow");
      });

      it("should deny mcp__claude_ai_Notion__notion_search when role only opted into Gmail", async () => {
        mockGetRolePermissions.mockReturnValue({ allowedTools: ["mcp__claude_ai_Gmail__*"] });
        const canUseTool = buildCanUseTool(mockGetRolePermissions);
        const result = await canUseTool(
          "mcp__claude_ai_Notion__notion_search",
          { query: "test" },
          { agentID: "skill-1", toolUseID: "tu-1", signal: new AbortController().signal },
        );

        expect(result.behavior).toBe("deny");
      });

      it("should deny OAuth MCP tool when perms is undefined (fail-closed)", async () => {
        mockGetRolePermissions.mockReturnValue(undefined);
        const canUseTool = buildCanUseTool(mockGetRolePermissions);
        const result = await canUseTool(
          "mcp__claude_ai_Gmail__gmail_search_messages",
          { q: "is:unread" },
          { agentID: "skill-1", toolUseID: "tu-1", signal: new AbortController().signal },
        );

        expect(result.behavior).toBe("deny");
      });

      it("should still deny when disallowedTools lists the OAuth tool (admin absolute)", async () => {
        mockGetRolePermissions.mockReturnValue({
          allowedTools: ["mcp__claude_ai_Gmail__*"],
          disallowedTools: ["mcp__claude_ai_Gmail__gmail_search_messages"],
        });
        const canUseTool = buildCanUseTool(mockGetRolePermissions);
        const result = await canUseTool(
          "mcp__claude_ai_Gmail__gmail_search_messages",
          { q: "is:unread" },
          { agentID: "skill-1", toolUseID: "tu-1", signal: new AbortController().signal },
        );

        expect(result.behavior).toBe("deny");
      });

      it("should allow system MCP tool even when allowlist excludes it (carve-out intact)", async () => {
        mockGetRolePermissions.mockReturnValue({ allowedTools: ["Read", "Edit"] });
        const canUseTool = buildCanUseTool(mockGetRolePermissions);
        const result = await canUseTool(
          "mcp__execution-tools__publish_artifact_file",
          {},
          { agentID: "skill-1", toolUseID: "tu-1", signal: new AbortController().signal },
        );

        expect(result.behavior).toBe("allow");
      });

      it("should not deny non-OAuth role MCP tool via OAuth gate (falls through to normal handling)", async () => {
        mockGetRolePermissions.mockReturnValue({});
        const canUseTool = buildCanUseTool(mockGetRolePermissions);
        const result = await canUseTool(
          "mcp__some-role-mcp__do_thing",
          {},
          { agentID: "skill-1", toolUseID: "tu-1", signal: new AbortController().signal },
        );

        expect(result.behavior).toBe("allow");
      });
    });
  });

  describe("externalOAuthDenyGlobs (SDK-options layer helper)", () => {
    it("returns the OAuth deny glob when allowedTools is undefined", () => {
      expect(externalOAuthDenyGlobs(undefined)).toEqual(["mcp__claude_ai_*"]);
    });

    it("returns the OAuth deny glob when allowedTools is empty", () => {
      expect(externalOAuthDenyGlobs([])).toEqual(["mcp__claude_ai_*"]);
    });

    it("returns the OAuth deny glob when allowedTools has no OAuth entries", () => {
      expect(externalOAuthDenyGlobs(["Read", "Bash"])).toEqual(["mcp__claude_ai_*"]);
    });

    it("returns [] when role opts in via an OAuth glob", () => {
      expect(externalOAuthDenyGlobs(["mcp__claude_ai_Gmail__*"])).toEqual([]);
    });

    it("returns [] when role opts in via an exact OAuth tool name", () => {
      expect(externalOAuthDenyGlobs(["mcp__claude_ai_Gmail__gmail_search_messages"])).toEqual([]);
    });
  });

  describe("isExternalOAuthMcpTool", () => {
    it("returns true for Gmail OAuth tools", () => {
      expect(isExternalOAuthMcpTool("mcp__claude_ai_Gmail__gmail_search_messages")).toBe(true);
    });

    it("returns false for system execution-tools MCP", () => {
      expect(isExternalOAuthMcpTool("mcp__execution-tools__publish_artifact_file")).toBe(false);
    });

    it("returns false for built-in tier tools (Read)", () => {
      expect(isExternalOAuthMcpTool("Read")).toBe(false);
    });

    it("returns false for empty string", () => {
      expect(isExternalOAuthMcpTool("")).toBe(false);
    });
  });

  describe("buildSessionHooks", () => {
    it("should return hooks for SessionStart, SubagentStart, SubagentStop, PostToolUse, PreCompact, PostCompact", () => {
      const hooks = buildSessionHooks({ currentTaskId: "task-1", roleId: "role-1" });

      expect(hooks).toHaveProperty("SessionStart");
      expect(hooks).toHaveProperty("SubagentStart");
      expect(hooks).toHaveProperty("SubagentStop");
      expect(hooks).toHaveProperty("PostToolUse");
      expect(hooks).toHaveProperty("PreCompact");
      expect(hooks).toHaveProperty("PostCompact");
    });

    it("should return hook arrays with at least one entry each", () => {
      const hooks = buildSessionHooks({ currentTaskId: "task-1", roleId: "role-1" });

      for (const key of ["SessionStart", "SubagentStart", "SubagentStop", "PostToolUse", "PreCompact", "PostCompact"]) {
        const matchers = hooks[key];
        expect(Array.isArray(matchers)).toBe(true);
        expect(matchers!.length).toBeGreaterThan(0);
        expect(matchers![0]).toHaveProperty("hooks");
        expect(Array.isArray(matchers![0].hooks)).toBe(true);
      }
    });

    it("SessionStart hook fires on startup source with taskPrompt", async () => {
      const { queryMemoryByTier } = await import("../../agent/memory-service.js");
      const mockQuery = vi.mocked(queryMemoryByTier);
      mockQuery.mockResolvedValueOnce([
        { id: "m1", roleId: "role-1", type: "event", content: "some memory", tier: "semantic", keywords: [], importance: 3, sourceType: "task_complete", createdAt: 0, lastAccessed: 0, retrievedCount: 0, score: 0.8 },
      ]);

      const hooks = buildSessionHooks({ currentTaskId: "task-1", roleId: "role-1", taskPrompt: "play relaxing music" });
      const sessionStartHook = hooks["SessionStart"]![0].hooks[0];
      const result = await sessionStartHook({ hook_event_name: "SessionStart", source: "startup" } as never, undefined, { signal: new AbortController().signal });

      expect(mockQuery).toHaveBeenCalledWith("role-1", "play relaxing music", ["semantic", "episodic"], { topK: 5 });
      expect(result).toHaveProperty("hookSpecificOutput");
      const output = (result as { hookSpecificOutput: { hookEventName: string; additionalContext: string } }).hookSpecificOutput;
      expect(output.hookEventName).toBe("SessionStart");
      expect(output.additionalContext).toContain("Memory Context");
    });

    it("SessionStart hook fires on resume source", async () => {
      const { queryMemoryByTier } = await import("../../agent/memory-service.js");
      vi.mocked(queryMemoryByTier).mockResolvedValueOnce([
        { id: "m1", roleId: "role-1", type: "event", content: "resumed", tier: "episodic", keywords: [], importance: 3, sourceType: "task_complete", createdAt: 0, lastAccessed: 0, retrievedCount: 0, score: 0.5 },
      ]);

      const hooks = buildSessionHooks({ currentTaskId: "task-1", roleId: "role-1" });
      const sessionStartHook = hooks["SessionStart"]![0].hooks[0];
      const result = await sessionStartHook({ hook_event_name: "SessionStart", source: "resume" } as never, undefined, { signal: new AbortController().signal });

      expect(result).toHaveProperty("hookSpecificOutput");
    });

    it("SessionStart hook skips on compact source", async () => {
      const hooks = buildSessionHooks({ currentTaskId: "task-1", roleId: "role-1" });
      const sessionStartHook = hooks["SessionStart"]![0].hooks[0];
      const result = await sessionStartHook({ hook_event_name: "SessionStart", source: "compact" } as never, undefined, { signal: new AbortController().signal });

      expect(result).toEqual({});
    });

    it("SessionStart hook skips on clear source", async () => {
      const hooks = buildSessionHooks({ currentTaskId: "task-1", roleId: "role-1" });
      const sessionStartHook = hooks["SessionStart"]![0].hooks[0];
      const result = await sessionStartHook({ hook_event_name: "SessionStart", source: "clear" } as never, undefined, { signal: new AbortController().signal });

      expect(result).toEqual({});
    });

    it("SessionStart hook skips when no roleId", async () => {
      const hooks = buildSessionHooks({ currentTaskId: "task-1" });
      const sessionStartHook = hooks["SessionStart"]![0].hooks[0];
      const result = await sessionStartHook({ hook_event_name: "SessionStart", source: "startup" } as never, undefined, { signal: new AbortController().signal });

      expect(result).toEqual({});
    });

    it("SessionStart hook uses fallback query when no taskPrompt", async () => {
      const { queryMemoryByTier } = await import("../../agent/memory-service.js");
      const mockQuery = vi.mocked(queryMemoryByTier);
      mockQuery.mockResolvedValueOnce([
        { id: "m1", roleId: "role-1", type: "event", content: "fallback", tier: "episodic", keywords: [], importance: 3, sourceType: "task_complete", createdAt: 0, lastAccessed: 0, retrievedCount: 0, score: 0.5 },
      ]);

      const hooks = buildSessionHooks({ currentTaskId: "task-1", roleId: "role-1" });
      const sessionStartHook = hooks["SessionStart"]![0].hooks[0];
      await sessionStartHook({ hook_event_name: "SessionStart", source: "startup" } as never, undefined, { signal: new AbortController().signal });

      expect(mockQuery).toHaveBeenCalledWith("role-1", "role context and recent interactions", ["semantic", "episodic"], { topK: 5 });
    });

    it("SubagentStart hook calls selectInjectionBeliefs with roleId", async () => {
      const { selectInjectionBeliefs } = await import("../../agent/belief-injection.js");
      const mockInject = vi.mocked(selectInjectionBeliefs);
      mockInject.mockResolvedValueOnce([]);

      const hooks = buildSessionHooks({ currentTaskId: "task-1", roleId: "role-1", taskPrompt: "search for AppleScript" });
      const subagentStartHook = hooks["SubagentStart"]![0].hooks[0];
      await subagentStartHook({ hook_event_name: "SubagentStart", agent_id: "role-1" } as never, undefined, { signal: new AbortController().signal });

      expect(mockInject).toHaveBeenCalledWith("role-1", undefined, expect.anything());
    });
  });
});
