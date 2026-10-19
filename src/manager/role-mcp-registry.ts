/**
 * Role MCP registry.
 *
 * Provides MCP servers that should be injected into ExecutionManager based on
 * the Role's presetId. This is the isolation mechanism that ensures only the
 * feature-miner preset Role receives mining-tools.
 *
 * Architecture:
 * - chat-manager preset: adam-tools (injected by ChatManager, not here)
 * - feature-miner preset: mining-tools
 * - All other Roles: no additional MCP servers from this registry
 */

import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { createMiningTools } from "./mining-tools.js";
import { createAuditTools } from "./audit-tools.js";

/**
 * System-MCP namespace prefixes that Adam injects.
 *
 * - `mcp__execution-tools__`: injected on EVERY task (unconditional, in execution-manager.ts)
 * - `mcp__mining-tools__`: injected ONLY for presetId === "feature-miner" (see getSdkMcpServersForRole)
 * - `mcp__audit-tools__`: injected ONLY for presetId === "mistake-digester"
 *
 * The carve-out is a cross-role union: any tool matching these prefixes is allowed
 * regardless of role.allowedTools at both layers (canUseTool gate, SDK options.allowedTools).
 * For roles WITHOUT the matching presetId, the SDK never routes the tool call (the server
 * isn't registered), so the over-grant is unreachable in practice. A future change to
 * `getSdkMcpServersForRole` that registers mining-tools/audit-tools on additional roles
 * inherits the carve-out — review the role's intended capability surface before adding.
 *
 * Architectural note (deferred): the cleanest design would be role-aware — pass the
 * actually-injected mcpServers keys into buildCanUseTool/options.allowedTools and derive
 * the carve-out from that. Today's cross-role union is simpler and unreachable-in-practice,
 * accepted as a tactical fix; revisit if more system MCPs are added or the over-grant
 * becomes a real risk.
 *
 * Field-overload note: augmenting options.allowedTools with system globs (in execution-manager)
 * conflates the role's user-grantable surface with Adam's required surface. The SDK does not
 * expose a separate "system-always-allow" option, so this is forced. Read-only consumers of
 * role.allowedTools (Web UI, audit logs, syncRoleSettings) read the DB-persisted value
 * (without the runtime augmentation), so the SDK-only mutation is contained.
 */
export const SYSTEM_MCP_PREFIXES: ReadonlySet<string> = new Set([
  "mcp__execution-tools__",
  "mcp__mining-tools__",
  "mcp__audit-tools__",
]);

export function isSystemMcpTool(toolName: string): boolean {
  if (!toolName) return false;
  for (const prefix of SYSTEM_MCP_PREFIXES) {
    if (toolName.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * External OAuth MCP namespace prefixes (issue #114). Tools like
 * mcp__claude_ai_Gmail__* / mcp__claude_ai_Notion__* are injected into the SDK
 * session by the Claude Code runtime from the parent process's Claude.ai OAuth
 * context — NOT by Adam's mcpServers config. settingSources / inheritUserSettings
 * cannot suppress their availability. They expose the user's personal
 * Gmail/Notion/Drive and must be default-denied to every Role unless the Role
 * explicitly opts in via its tool allowlist.
 */
export const EXTERNAL_OAUTH_MCP_PREFIXES: ReadonlySet<string> = new Set([
  "mcp__claude_ai_",
]);

export function isExternalOAuthMcpTool(toolName: string): boolean {
  if (!toolName) return false;
  for (const prefix of EXTERNAL_OAUTH_MCP_PREFIXES) {
    if (toolName.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * SDK options.disallowedTools augmentation (issue #114). Returns deny-glob
 * patterns for external OAuth MCP namespaces UNLESS the role has opted into any
 * OAuth tool via its allowlist. Used by ExecutionManager so dontAsk/bypassPermissions
 * roles (which skip canUseTool) still default-deny OAuth MCP at the SDK layer.
 * When the role opted in, returns [] so no allowed+disallowed conflict is created.
 */
export function externalOAuthDenyGlobs(allowedTools: string[] | undefined): string[] {
  const optedIn = (allowedTools ?? []).some((t) => isExternalOAuthMcpTool(t));
  return optedIn ? [] : Array.from(EXTERNAL_OAUTH_MCP_PREFIXES).map((p) => `${p}*`);
}

/**
 * Returns MCP server configs to inject for a given Role.
 * Returns an empty object unless the Role matches a known preset that requires
 * a specific MCP (currently only feature-miner).
 *
 * The returned servers are merged into ExecutionManager's mcpServers config
 * alongside roleMcpServers, taskMcpServers, and execution-tools.
 */
export function getSdkMcpServersForRole(
  role: { id: string; presetId?: string },
): Record<string, McpServerConfig> {
  if (role.presetId === "feature-miner") {
    return { "mining-tools": createMiningTools(role.id) };
  }
  if (role.presetId === "mistake-digester") {
    return { "audit-tools": createAuditTools() };
  }
  return {};
}
