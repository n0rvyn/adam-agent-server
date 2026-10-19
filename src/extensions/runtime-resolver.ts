/**
 * Runtime Resolver — Phase 3
 *
 * Resolves Role-extension bindings into an SDK mcpServers map at task dispatch time.
 * Called by ExecutionManager before query() is opened.
 *
 * Merge order per D-S01: extensionBindingMcp wins over nothing;
 * taskMcpServers and presetRoleMcpServers layer on top in ExecutionManager.
 *
 * mcpServerStatus() timing discovery (Task 1-impl probe, 2026-05-16):
 *   - q.mcpServerStatus is a function BEFORE and DURING iteration.
 *   - Calling it on the "result" event (mid-iteration) errors with API error (no MCP servers configured).
 *   - Calling it AFTER the while loop ends throws: "ProcessTransport is not ready for writing".
 *   - CONCLUSION: mcpServerStatus() must be called DURING iteration while the process transport is live.
 *   - Implementation: capture status on the "result" event inside the while loop (Task 2).
 */

import path from "node:path";
import type { McpStdioServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { getDb } from "../store/db.js";
import { getExtensionById, computeEffectiveConfig } from "../store/extensions.js";
import { listBindingsByRole } from "../store/role-extensions.js";
import { substitutePlaceholders, substitutePlaceholdersDeep } from "./placeholders.js";
import { RUNTIME_DIR } from "../shared/constants.js";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Minimal task shape required by the resolver — avoids full Task import cycle */
interface ResolverTask {
  id: string;
  roleId?: string;
}

// Re-export UnresolvedPlaceholderError so callers can import from one place
export { UnresolvedPlaceholderError } from "./placeholders.js";

// ── Resolver ──────────────────────────────────────────────────────────────────

/**
 * Resolves all enabled Role-extension bindings for a task into an SDK mcpServers map.
 *
 * For each enabled binding:
 *   1. Joins role_extensions → extensions to get the manifest
 *   2. Computes effective config (extension defaults merged with binding overrides)
 *   3. Runs placeholder substitution on mcp_config.env and mcp_config.args
 *   4. Outputs a StdioMcpServerConfig keyed by generatedServerName
 *
 * Returns an empty object if the task has no roleId or the role has no enabled bindings.
 * Throws UnresolvedPlaceholderError if a ${user_config.X} placeholder references a key
 * missing from the effective config.
 */
/**
 * SDK-shape map returned by the resolver.
 * All entries are stdio configs (the only config type extensions support).
 * Typed as McpStdioServerConfig so callers can access .command/.args/.env directly,
 * and assignable to Record<string, McpServerConfig> for SDK passthrough.
 */
export type ExtensionMcpMap = Record<string, McpStdioServerConfig>;

export async function resolveExtensionsForTask(
  task: ResolverTask,
  ctx: { HOME: string },
): Promise<ExtensionMcpMap> {
  if (!task.roleId) return {};

  const db = getDb();
  const bindings = listBindingsByRole(db, task.roleId).filter((b) => b.enabled);

  if (bindings.length === 0) return {};

  const extensionsRoot = path.join(
    process.env.ADAM_TEST_DIR ?? RUNTIME_DIR,
    "extensions",
  );

  const out: ExtensionMcpMap = {};

  for (const binding of bindings) {
    const extension = getExtensionById(db, binding.extensionId);
    if (!extension) continue;

    const effectiveConfig = computeEffectiveConfig(extension, binding);
    const manifest = JSON.parse(extension.manifestJson) as {
      server: {
        mcp_config: {
          command: string;
          args?: string[];
          env?: Record<string, string>;
        };
      };
    };

    const mcpConfig = manifest.server.mcp_config;

    const subCtx = {
      HOME: ctx.HOME,
      __dirname: path.join(extensionsRoot, extension.name),
      user_config: effectiveConfig as Record<string, string | number | boolean>,
    };

    // Substitute placeholders in command, args, and env
    const command = substitutePlaceholders(mcpConfig.command, subCtx);

    const args = mcpConfig.args?.map((a) => substitutePlaceholders(a, subCtx));

    const env = mcpConfig.env
      ? substitutePlaceholdersDeep(mcpConfig.env, subCtx)
      : undefined;

    out[binding.generatedServerName] = {
      type: "stdio",
      command,
      ...(args !== undefined ? { args } : {}),
      ...(env !== undefined ? { env } : {}),
    } as McpStdioServerConfig;
  }

  return out;
}
