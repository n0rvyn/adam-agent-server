/**
 * SDK session hooks: canUseTool, SessionStart, SubagentStart, SubagentStop,
 * PostToolUse, PreCompact, PostCompact.
 *
 * D-015: Three-tier grading (simplified — Tier 2 path restriction removed)
 * D-016: Deny-and-continue (not interrupt; actionable message)
 * D-024, D-026: Role-based memory ownership
 *
 * Tool-prohibition gate (precedes all auto-allows; fixes #202):
 *   - disallowedTools is absolute — denied tools are denied at every tier, including
 *     read-only (Tier 1) and write (Tier 2) tools that are otherwise auto-allowed.
 *   - allowedTools is a hard allowlist when non-empty — any tool outside the list is
 *     denied, regardless of tier. Empty/undefined allowedTools = no allowlist.
 *   - Path approval (blockedPath) cannot override tool prohibition.
 *
 * Tier 1: Auto-allow read-only tools (zero cost, no risk)
 * Tier 2: Auto-allow write tools (sandbox enforces path restrictions)
 * Tier 3: Full evaluation — Bash patterns + approvalRequired check
 */

import type { CanUseTool, HookCallbackMatcher } from "@anthropic-ai/claude-agent-sdk";
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
export type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { isAbsolute, relative, resolve } from "node:path";
import { getRelevantMemoryContext } from "../agent/memory-service.js";
import { selectInjectionBeliefs, formatInjectionContext } from "../agent/belief-injection.js";
import { generateEmbedding as generateEmbeddingForHooks } from "../lib/embedding.js";
import { appendUsedMemoryIds, updateContextMeta } from "../store/tasks.js";
import { getRuntimeConfig } from "../config/runtime.js";
import { createStepLog } from "../store/logs.js";
import { resolveTilde } from "../lib/path-permissions.js";
import type { MidTaskInjectionConfig, RolePermissions, PinnedParameter } from "../shared/types.js";
import { isSystemMcpTool, isExternalOAuthMcpTool } from "./role-mcp-registry.js";

// ===== Tier Definitions =====

/** Tier 1: Auto-allow read-only tools (zero cost, no risk) */
const TIER_1 = new Set(["Read", "Glob", "Grep", "LSP"]);

/**
 * Tier 2: Write tools — sandbox enforces path restrictions.
 * These tools no longer need application-level path checking.
 */
const TIER_2 = new Set(["Edit", "Write", "NotebookEdit"]);

/** Tier 3: Everything else — Bash, WebFetch, Playwright, Agent, etc. */
const TIER_3 = new Set(["Bash", "WebFetch", "Agent", "WebSearch"]);

/** Tools that the mid-task injection hook MUST NOT count or trigger from. */
const MID_TASK_SKIP_TOOLS = new Set([
  "search_memories",
  "save_memory",
  "delete_memory",
  "Read",
  "Glob",
  "Grep",
  "LSP",
]);

/** Tools that signal the LLM voluntarily checked memory; reset counter + start cooldown. */
const MID_TASK_MEMORY_TOOLS = new Set(["search_memories"]);

interface MidTaskState {
  toolCallCount: number;
  lastInjectedAt: number;
  lastSearchMemoriesAt: number;
}

/**
 * Convert SDK Permission Rule glob pattern to RegExp.
 * Syntax: `*` matches any characters. All other regex metacharacters are escaped.
 * Result is anchored at start but not end (prefix matching) to support
 * commands like "rm -rf *" matching "rm -rf /tmp".
 * Example: "rm -rf *" → /^rm -rf .*$/  (matches "rm -rf /tmp")
 * Example: "https://*api*" → /^https:\/\/.*api.*$/  (matches "https://api.example.com")
 */
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

export interface CanUseToolOptions {
  /** Global absolute read blacklist — paths denied at both SDK and OS layers. */
  deniedReadPaths?: string[];
  /** Role's scope (cwd + additionalDirs) for blockedPath re-checks. */
  roleScope?: string[];
  /** Pinned default parameters for Role tool calls (Phase 3). */
  pinnedParameters?: PinnedParameter[];
}

function normalizeScopePath(p: string): string {
  return resolve(resolveTilde(p));
}

function isPathWithinRoots(targetPath: string, roots: string[]): boolean {
  return roots.some((root) => {
    const normalizedRoot = normalizeScopePath(root);
    const rel = relative(normalizedRoot, targetPath);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
}

/**
 * Build the canUseTool callback for the Manager's persistent SDK session.
 *
 * Priority:
 * 1. blockedPath — SDK permission flow includes a related path; Adam re-checks
 *    deniedReadPaths first, then confirms whether the path is still inside roleScope.
 * 2. Pinned param injection — merge pinned defaults into tool input (DP-002: LLM values win).
 *    Injected command/params then pass through Bash security pattern checks (Tier 3).
 * 3. Tier 1/2/3 — existing tool-based logic.
 */

// Import logger here to avoid circular dependency
import { getLogger } from "../lib/logger.js";
const log = getLogger("manager");

/**
 * Pattern matching: wildcard → anchored glob; no wildcard → substring.
 * Used by both pinned-param injection (matchPin) and permission pattern checks (globToRegExp).
 */
function matchPattern(pattern: string, target: string): boolean {
  if (pattern.includes("*")) {
    try {
      return globToRegExp(pattern).test(target);
    } catch (err) {
      log.warn({ pattern, error: String(err) }, "Pinned parameter glob failed to compile; pin ignored");
      return false;
    }
  }
  return target.includes(pattern);
}

/**
 * Two-tier pinned-parameter matcher (DP-001):
 * - Bash family: pattern starts with "Bash:" → strip prefix and match against command string.
 * - Other tools: match against toolName directly.
 * Within each tier: wildcard → glob; no wildcard → substring.
 */
function matchPin(pattern: string, toolName: string, input: Record<string, unknown>): boolean {
  if (pattern.startsWith("Bash:")) {
    if (toolName !== "Bash") return false;
    const sub = pattern.slice("Bash:".length);
    const command = (input as { command?: string }).command ?? "";
    return matchPattern(sub, command);
  }
  // Non-Bash: match against toolName directly
  return matchPattern(pattern, toolName);
}

interface InjectResult {
  input: Record<string, unknown>;
  injected: PinnedParameter[];
  overrides: Array<{ tool: string; key: string; pinnedValue: unknown; llmValue: unknown }>;
}

/**
 * Merge pinned default params into tool input.
 * DP-002: LLM-explicit values always win — existing keys are never overwritten.
 * For Bash: missing CLI flags are appended to the command string.
 * For other tools: missing keys are merged into the input object.
 * Shell-quoting for Bash values: single-quote wrapping with '\'' escape for embedded quotes.
 */
function injectPinnedParams(
  toolName: string,
  input: Record<string, unknown>,
  pins: PinnedParameter[] | undefined,
): InjectResult {
  if (!pins?.length) return { input, injected: [], overrides: [] };
  const overrides: InjectResult["overrides"] = [];
  const injected: PinnedParameter[] = [];
  let next = input;
  for (const pin of pins) {
    if (!matchPin(pin.tool, toolName, next)) continue;
    if (toolName === "Bash") {
      let command = (next as { command?: string }).command ?? "";
      const additions: string[] = [];
      for (const [flag, value] of Object.entries(pin.params)) {
        // Detect existing flag in any form: -v=, -v , --voice=
        const flagPattern = new RegExp(`(^|\\s)${flag.replace(/[.+?^${}()|[\]\\]/g, "\\$&")}([= ]|$)`);
        if (flagPattern.test(command)) {
          overrides.push({ tool: pin.tool, key: flag, pinnedValue: value, llmValue: "(flag already present)" });
        } else {
          // Shell-safe quoting: wrap value in single quotes, escape embedded single quotes via '\''
          const valStr = String(value);
          const quoted = valStr.includes("'") || /[\s$`"\\;&|<>(){}[\]*?#~!]/.test(valStr)
            ? "'" + valStr.replace(/'/g, "'\\''") + "'"
            : valStr;
          additions.push(`${flag} ${quoted}`);
        }
      }
      if (additions.length > 0) {
        command = command.trimEnd() + " " + additions.join(" ");
        next = { ...next, command };
        injected.push(pin);
      }
    } else {
      const additions: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(pin.params)) {
        if (k in (next as Record<string, unknown>)) {
          overrides.push({ tool: pin.tool, key: k, pinnedValue: v, llmValue: (next as Record<string, unknown>)[k] });
        } else {
          additions[k] = v;
        }
      }
      if (Object.keys(additions).length > 0) {
        next = { ...next, ...additions };
        injected.push(pin);
      }
    }
  }
  return { input: next, injected, overrides };
}

export function buildCanUseTool(
  getRolePermissions: (roleId: string) => RolePermissions | undefined,
  requestApproval?: (
    toolName: string,
    input: Record<string, unknown>,
    matchedPattern: string,
    agentID?: string,
  ) => Promise<PermissionResult>,
  options?: CanUseToolOptions,
): CanUseTool {
  return async (toolName, input, { agentID, blockedPath }) => {
    // Phase 3: pinned-param injection — merge pinned defaults BEFORE any security checks.
    // DP-002: LLM-explicit values always win (injectPinnedParams skips existing keys).
    // Injected command/params then pass through Bash security pattern checks below (Tier 3).
    const { input: effectiveInput, injected, overrides } = injectPinnedParams(
      toolName, input, options?.pinnedParameters,
    );
    if (injected.length > 0 || overrides.length > 0) {
      log.info({ toolName, injected: injected.length, overrides: overrides.length, overrideDetails: overrides },
        "Pinned parameter injection applied");
    }

    // Tool-prohibition gate (#202): runs BEFORE blockedPath approval and Tier 1/2 auto-allow.
    // - disallowedTools is absolute (every tier respects it, including Read/Glob/Grep/Edit/Write).
    // - allowedTools, when non-empty, is a hard allowlist — any tool outside is denied.
    // - System MCP tools (mcp__execution-tools__*) are auto-allowed AFTER disallowedTools and
    //   BEFORE allowedTools to keep the platform contract self-consistent. Adam injects the
    //   execution-tools MCP on every task (execution-manager.ts: mcpServers[EXECUTION_TOOLS_MCP_NAME]).
    //   These tools (publish_artifact_file, write_artifact) are required by template-executor for
    //   every step that declares outputAs. Adam grants them — disallowedTools is absolute and
    //   keeps precedence so an admin can still explicitly block them.
    // - External OAuth MCP tools (mcp__claude_ai_*) are default-denied between disallowedTools
    //   and the system-MCP carve-out: they are injected by the SDK runtime from the parent
    //   Claude.ai OAuth context (Gmail/Notion/Drive) and must be explicitly opted into via the
    //   role's allowedTools (glob-aware). The check is fail-closed (applies when perms is undefined).
    // Without this gate, blockedPath's approval flow can grant tools the role explicitly forbids,
    // and Tier 1/2 auto-allow can bypass disallowedTools entirely.
    const perms = getRolePermissions(agentID ?? "");

    // disallowedTools is absolute (admin block wins at every tier).
    if (perms?.disallowedTools?.includes(toolName)) {
      return { behavior: "deny", message: `Tool ${toolName} is not allowed for this role.` };
    }

    // #114: external OAuth MCP default-deny. These tools are injected by the SDK
    // runtime from the parent Claude.ai OAuth context and expose the user's personal
    // Gmail/Notion/Drive. Deny for every Role unless the Role explicitly opts in via
    // allowedTools (glob-aware). Fail-closed: applies even when perms is undefined
    // (unknown agent = no grants). Short-circuits the exact-match allowlist check below
    // so a glob opt-in (e.g. "mcp__claude_ai_Gmail__*") is honored.
    if (isExternalOAuthMcpTool(toolName)) {
      const optedIn = (perms?.allowedTools ?? []).some(
        (entry) => entry === toolName || (entry.includes("*") && globToRegExp(entry).test(toolName)),
      );
      return optedIn
        ? { behavior: "allow", updatedInput: effectiveInput }
        : {
            behavior: "deny",
            message: `Tool ${toolName} is an external OAuth integration not enabled for this role. Add it (or a matching pattern) to the role's allowedTools to grant access.`,
          };
    }

    if (perms) {
      // System MCP carve-out: per role-mcp-registry SYSTEM_MCP_PREFIXES set, Adam
      // injects three system MCPs (execution-tools, mining-tools, audit-tools). Their
      // tools are platform contract — auto-allow regardless of role allowedTools.
      // disallowedTools still wins above (admin block stays absolute).
      if (isSystemMcpTool(toolName)) {
        return { behavior: "allow", updatedInput: effectiveInput };
      }
      if (perms.allowedTools?.length && !perms.allowedTools.includes(toolName)) {
        return {
          behavior: "deny",
          message: `Tool ${toolName} is not in this role's allowedTools allowlist.`,
        };
      }
    }

    // Priority 1: blockedPath — SDK supplied the path involved in its permission flow.
    // Adam must still check whether that path is explicitly denied or actually
    // inside the role's own cwd/additionalDirectories.
    if (blockedPath) {
      const resolved = normalizeScopePath(blockedPath);
      // Check against global deniedReadPaths — absolute deny, no appeal
      if (options?.deniedReadPaths?.length) {
        for (const dp of options.deniedReadPaths) {
          const deniedResolved = normalizeScopePath(dp);
          if (isPathWithinRoots(resolved, [deniedResolved])) {
            log.warn({ toolName, blockedPath, agentID, deniedPath: dp }, "Denied: path in deniedReadPaths (absolute blacklist)");
            return {
              behavior: "deny",
              message: `Access denied: ${blockedPath} is in the global denied read paths list. This restriction is configured in Settings > Advanced and cannot be overridden by privilege escalation.`,
            };
          }
        }
      }

      // blockedPath alone does not prove scope violation; allow paths that are still
      // inside this role's cwd/additionalDirectories.
      if (options?.roleScope?.length && isPathWithinRoots(resolved, options.roleScope)) {
        return { behavior: "allow", updatedInput: effectiveInput };
      }

      // Path is outside role scope and not in absolute blacklist → trigger approval
      if (requestApproval) {
        return await requestApproval(toolName, effectiveInput, `blockedPath:${blockedPath}`, agentID);
      }
      return {
        behavior: "deny",
        message: `Access denied: ${blockedPath} is outside this role's allowed scope (cwd + additionalDirectories). Configure additionalDirectories to expand access.`,
      };
    }

    // Tier 1: auto-allow read-only tools
    if (TIER_1.has(toolName)) {
      return { behavior: "allow", updatedInput: effectiveInput };
    }

    // Tier 2: auto-allow write tools — OS sandbox enforces path restrictions
    if (TIER_2.has(toolName)) {
      return { behavior: "allow", updatedInput: effectiveInput };
    }

    // Tier 3: full evaluation (perms already fetched at the tool-prohibition gate above)

    // Bash three-tier control (D-002) — SDK Permission Rule glob syntax.
    // CRITICAL: uses effectiveInput.command so that pinned flags are first-class
    // citizens of the security model (passes through allowedBashPatterns / deniedBashPatterns).
    if (toolName === "Bash" && perms) {
      const command = (effectiveInput as { command?: string }).command ?? "";

      // Tier A: allowedBashPatterns — auto-execute
      if (perms.allowedBashPatterns?.length) {
        for (const pattern of perms.allowedBashPatterns) {
          try {
            if (globToRegExp(pattern).test(command)) {
              return { behavior: "allow", updatedInput: effectiveInput };
            }
          } catch { /* invalid glob — skip */ }
        }
      }

      // Tier B: deniedBashPatterns — auto-reject
      if (perms.deniedBashPatterns?.length) {
        for (const pattern of perms.deniedBashPatterns) {
          try {
            if (globToRegExp(pattern).test(command)) {
              return { behavior: "deny", message: `Bash command denied by pattern: ${pattern}` };
            }
          } catch { /* invalid glob — skip */ }
        }
      }
      // Tier C: falls through to approvalRequired logic
    }

    // (disallowedTools already enforced at the tool-prohibition gate above)

    // Privilege escalation (D-001): approvalRequired patterns identify operations that are
    // technically allowed but require explicit user confirmation before proceeding.
    // Like Unix sudo — the permission exists, but the operation needs a conscious human decision.
    if (requestApproval && perms?.approvalRequired?.length) {
      // For Bash: match against the command string. For others: match against JSON input.
      const matchTarget = toolName === "Bash"
        ? (effectiveInput as { command?: string }).command ?? ""
        : `${toolName} ${JSON.stringify(effectiveInput)}`;

      for (const pattern of perms.approvalRequired) {
        try {
          if (globToRegExp(pattern).test(matchTarget)) {
            return await requestApproval(toolName, effectiveInput, pattern, agentID);
          }
        } catch { /* invalid glob — skip */ }
      }
    }

    // No match — allow normally
    return { behavior: "allow", updatedInput: effectiveInput };
  };
}

// ===== Session Hooks =====

export interface SessionHooksContext {
  currentTaskId?: string;
  /** Role ID for scoped memory operations (D-024, D-026) */
  roleId?: string;
  /** Task prompt for memory search query (used by SessionStart and SubagentStart hooks) */
  taskPrompt?: string;
  /**
   * Returns the current chat session id when running a ChatManager turn; undefined for ExecutionManager tasks.
   * Getter pattern (mirrors `getActiveChatOrigin` in chat-manager.ts:90) lets the boot-time cached
   * hooks read the live per-turn value without rebuilding.
   */
  getChatSessionId?: () => string | undefined;
  /**
   * Returns the traceId of the currently in-flight turn for a ChatManager session.
   * Written by LiveSession.dispatchTurn via the shared turnTraceHolder; cleared on turn finish.
   * Used by the PostToolUse ChatManager branch to attribute chat_tool_calls to the correct turn
   * instead of the frozen construction-time ALS context.
   */
  getCurrentTurnTraceId?: () => string | undefined;
  /**
   * Step functional category from TaskStep.kind — used as belief scope label.
   * Undefined for ChatManager tasks and tasks without a step kind.
   */
  stepKind?: string;
}

/**
 * Build the session hooks for the Manager's persistent SDK session.
 *
 * D-017: Hook events
 * D-024, D-026: Role-based memory ownership
 * - SessionStart: inject relevant memories at session startup/resume (proactive injection)
 * - SubagentStart: inject relevant memories for the starting role (scoped to roleId)
 * - PreToolUse: mid-task memory injection (GAP-05) for ExecutionManager tasks
 *   when counter + cooldown gates pass. Skip-list + master switch enforce O(1)
 *   short-circuit on the hot path. State is closure-scoped per hooks instance.
 * - SubagentStop: extract learnings from subagent transcript (scoped to roleId)
 * - PostToolUse: audit logging (step logs)
 * - PreCompact: lifecycle hook before compaction (summary not yet available in SDK 0.2.112)
 * - PostCompact: persist compacted session summary to memory (scoped to roleId)
 */
export function buildSessionHooks(
  ctx: SessionHooksContext,
): Partial<Record<string, HookCallbackMatcher[]>> {
  // Per-task state for mid-task memory injection (GAP-05).
  // ExecutionManager builds a fresh hooks instance per task; ChatManager keeps
  // one persistent instance and relies on SubagentStop cleanup below.
  const midTaskState = new Map<string, MidTaskState>();

  return {
    SessionStart: [{
      hooks: [async (input) => {
        // Proactive memory injection at session startup/resume (D-026, GAP-11)
        // For ChatManager (roleId === "role-chat-manager"): always inject
        // For other roles: only on startup/resume
        if (!ctx.roleId) return {};
        const source = (input as Record<string, unknown>)["source"] as string | undefined;
        const isChatManager = ctx.roleId === "role-chat-manager";
        if (!isChatManager && source !== "startup" && source !== "resume") return {};

        try {
          const { queryMemoryByTier } = await import("../agent/memory-service.js");
          const query = ctx.taskPrompt || "role context and recent interactions";
          // ChatManager: semantic + working; other roles: semantic + episodic (RAG via search_memories)
          const tiers = isChatManager ? ["semantic", "working"] : ["semantic", "episodic"];
          const memories = await queryMemoryByTier(ctx.roleId, query, tiers, { topK: 5 });
          if (memories.length > 0) {
            const lines = memories.map((m) => `- [${m.tier ?? "episodic"}] ${m.content}`);
            const context = `[Memory Context]\n${lines.join("\n")}\n\n`;
            return {
              hookSpecificOutput: {
                hookEventName: "SessionStart",
                additionalContext: context,
              },
            };
          }
        } catch {
          // Memory injection failure is non-fatal
        }
        return {};
      }],
    }],
    SubagentStart: [{
      hooks: [async (input) => {
        // ctx.roleId is the authoritative source: ExecutionManager (execution-manager.ts:192) and
        // ChatManager (chat-manager.ts:151) both set it. The input.agent_id fallback is preserved
        // for symmetry with SubagentStop and for any future call site that omits ctx.roleId, but
        // SDK's agent_id is the SDK-internal subagent invocation ID (sdk.d.ts:4577), NOT a Role ID
        // — getRole() against it will silently return undefined in that case.
        const roleId = ctx.roleId ?? (input as Record<string, unknown>)["agent_id"] as string | undefined;
        if (!roleId) return {};

        // Build additional context: CAG (if present) + memory (DP-1.3: CAG-first order)
        const parts: string[] = [];

        try {
          const { getRole } = await import("../store/roles.js");
          const role = getRole(roleId);
          if (role?.cagPrompt && role.cagPrompt.trim().length > 0) {
            parts.push(`[Role CAG]\n${role.cagPrompt}`);
          }
        } catch {
          // Role lookup failure is non-fatal — proceed with memory-only injection
        }

        try {
          const query = ctx.taskPrompt || "role context";
          let contextString: string;
          let usedIds: string[];
          if (ctx.stepKind !== undefined) {
            // Scoped injection: unified top-K=5 active beliefs for this niche
            const beliefs = await selectInjectionBeliefs(roleId, ctx.stepKind, undefined);
            contextString = formatInjectionContext(beliefs, "initial");
            usedIds = beliefs.map((b) => b.id);
          } else {
            // Global injection (ChatManager and tasks without stepKind): embed query first
            let queryEmbedding: Float32Array | undefined;
            try {
              queryEmbedding = await generateEmbeddingForHooks(query);
            } catch (err) {
              log.warn({ err, roleId }, "ChatManager initial inject: embedding failed, falling back to recency order");
            }
            const beliefs = await selectInjectionBeliefs(roleId, undefined, queryEmbedding);
            contextString = formatInjectionContext(beliefs, "initial");
            usedIds = beliefs.map((b) => b.id);
          }
          if (contextString) {
            parts.push(contextString);
          }
          if (ctx.currentTaskId && usedIds.length > 0) {
            appendUsedMemoryIds(ctx.currentTaskId, usedIds);
          }
        } catch (err) {
          log.warn({ err, roleId, stepKind: ctx.stepKind }, "belief injection failed — skipping");
        }

        if (parts.length === 0) return {};
        return {
          hookSpecificOutput: {
            hookEventName: "SubagentStart",
            additionalContext: parts.join("\n\n"),
          },
        };
      }],
    }],
    PreToolUse: [{
      hooks: [async (input) => {
        const taskId = ctx.currentTaskId;
        if (!taskId) return {};

        const toolName = (input as Record<string, unknown>)["tool_name"] as string | undefined;
        if (!toolName) return {};

        let mtCfg: MidTaskInjectionConfig | undefined;
        try {
          mtCfg = getRuntimeConfig().memory?.midTaskInjection;
        } catch {
          return {};
        }
        if (!mtCfg || mtCfg.enabled !== true) return {};

        const state = midTaskState.get(taskId) ?? {
          toolCallCount: 0,
          lastInjectedAt: 0,
          lastSearchMemoriesAt: 0,
        };

        if (MID_TASK_MEMORY_TOOLS.has(toolName)) {
          state.toolCallCount = 0;
          state.lastSearchMemoriesAt = Date.now();
          midTaskState.set(taskId, state);
          return {};
        }

        if (MID_TASK_SKIP_TOOLS.has(toolName)) {
          return {};
        }

        state.toolCallCount += 1;

        const now = Date.now();
        if (state.toolCallCount < mtCfg.toolCallThreshold) {
          midTaskState.set(taskId, state);
          return {};
        }

        const sinceLastInject = now - state.lastInjectedAt;
        const sinceLastSearch = now - state.lastSearchMemoriesAt;
        if (
          sinceLastInject < mtCfg.cooldownMs ||
          (state.lastSearchMemoriesAt > 0 && sinceLastSearch < mtCfg.cooldownMs)
        ) {
          midTaskState.set(taskId, state);
          return {};
        }

        state.toolCallCount = 0;
        state.lastInjectedAt = now;
        midTaskState.set(taskId, state);

        try {
          const query = ctx.taskPrompt || "task context";
          let contextString: string;
          let usedIds: string[];
          if (ctx.stepKind !== undefined && ctx.roleId) {
            // Scoped refresh injection: unified top-K=5 active beliefs, refresh header
            let refreshEmbedding: Float32Array | undefined;
            try {
              refreshEmbedding = await generateEmbeddingForHooks(query);
            } catch (err) {
              log.warn({ err, roleId: ctx.roleId }, "scoped refresh inject: embedding failed");
            }
            const beliefs = await selectInjectionBeliefs(ctx.roleId, ctx.stepKind, refreshEmbedding);
            contextString = formatInjectionContext(beliefs, "refresh");
            usedIds = beliefs.map((b) => b.id);
          } else {
            // Global refresh injection (ChatManager)
            let refreshEmbedding: Float32Array | undefined;
            try {
              refreshEmbedding = await generateEmbeddingForHooks(query);
            } catch (err) {
              log.warn({ err, roleId: ctx.roleId }, "ChatManager refresh inject: embedding failed");
            }
            const beliefs = await selectInjectionBeliefs(ctx.roleId!, undefined, refreshEmbedding);
            contextString = formatInjectionContext(beliefs, "refresh");
            usedIds = beliefs.map((b) => b.id);
          }

          if (!contextString) return {};

          if (usedIds.length > 0) {
            appendUsedMemoryIds(taskId, usedIds);
          }

          // Strip [User Request] suffix (both scoped and legacy contextStrings carry it)
          const refreshContext = contextString.replace(/\n\n\[User Request\]\n$/, "\n");

          return {
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              additionalContext: refreshContext,
            },
          };
        } catch (err) {
          log.warn({ err, roleId: ctx.roleId, stepKind: ctx.stepKind }, "PreToolUse belief refresh failed — skipping");
          return {};
        }
      }],
    }],
    SubagentStop: [{
      hooks: [async (input) => {
        if (ctx.currentTaskId) midTaskState.delete(ctx.currentTaskId);

        // SubagentStop is the sole writer of type="thought" memories per task.
        // processTaskCompletion handles type="event" memories from tool results.
        // No cross-type dedup needed — type spaces do not overlap (GAP-08 fix).
        const agentId = (input as Record<string, unknown>)["agent_id"] as string | undefined;
        if (!agentId || !ctx.currentTaskId) return {};

        try {
          const { createMemory } = await import("../store/memories.js");
          const transcript = (input as Record<string, unknown>)["transcript"] as string | undefined;
          if (!transcript || transcript.length <= 100) return {};

          // Extract decision-oriented content (reasoning that processTaskCompletion won't capture)
          const content = `[Task ${ctx.currentTaskId} reasoning] ${transcript.slice(0, 3000)}`;
          createMemory({
            id: `session-${Date.now()}`,
            roleId: ctx.roleId ?? agentId,
            type: "thought", // "thought" distinguishes from processTaskCompletion's "event"
            content,
            keywords: [],
            importance: 3,
            sourceType: "task_complete",
            sourceTaskId: ctx.currentTaskId,
            createdAt: Date.now(),
            lastAccessed: Date.now(),
            retrievedCount: 0,
            tier: "episodic",
          });
        } catch {
          // Memory extraction failure is non-fatal
        }
        return {};
      }],
    }],
    PostToolUse: [{
      hooks: [async (input) => {
        // Extract shared values outside branches
        const toolName = (input as Record<string, unknown>)["tool_name"] as string | undefined;
        const toolInput = (input as Record<string, unknown>)["tool_input"] as Record<string, unknown> | undefined;
        const toolResponse = (input as Record<string, unknown>)["tool_response"];
        const rawOutput = typeof toolResponse === "string"
          ? toolResponse
          : JSON.stringify(toolResponse ?? "");

        // Branch 1: ExecutionManager — write step_log
        if (ctx.currentTaskId) {
          try {
            createStepLog({
              id: `step-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              taskId: ctx.currentTaskId,
              index: 0,
              type: "tool_call",
              content: `${toolName}: ${JSON.stringify(toolInput ?? {})} → ${rawOutput.slice(0, 200)}`,
              toolName,
              toolInput,
              toolOutput: rawOutput,
              timestamp: Date.now(),
            });
          } catch {
            // Step logging failure is non-fatal
          }
          return {};
        }

        // Branch 2: ChatManager — record in chat_tool_calls
        if (toolName && ctx.getChatSessionId) {
          const chatSessionId = ctx.getChatSessionId();
          if (chatSessionId) {
            try {
              const { getCurrentTraceId } = await import("../lib/trace-context.js");
              const { recordChatToolCall } = await import("../store/chat-tool-calls.js");
              // Prefer the per-turn trace (from LiveSession.dispatchTurn via turnTraceHolder)
              // over the frozen ALS context captured at LiveSession construction time.
              const traceId = ctx.getCurrentTurnTraceId?.() ?? getCurrentTraceId() ?? "";
              if (traceId) {
                recordChatToolCall({
                  traceId,
                  sessionId: chatSessionId,
                  toolName,
                  toolInput,
                  toolOutputSummary: rawOutput.slice(0, 500),
                });
              }
            } catch {
              // chat_tool_calls write failure is non-fatal (fail-open per Phase C threat model)
              try {
                const { recordAuditDiagnostic } = await import("../store/audit-diagnostics.js");
                await recordAuditDiagnostic({
                  source: "chat_tool_calls_logger",
                  severity: "warning",
                  sourceId: chatSessionId,
                  message: `chat_tool_calls write failed: ${String(toolName)}`,
                });
              } catch {
                // diagnostics failure is also non-fatal
              }
            }
          }
        }

        return {};
      }],
    }],
    PreCompact: [{
      hooks: [async (input) => {
        // SDK PreCompact exposes only trigger/custom instructions in 0.2.112.
        // The compaction summary arrives on PostCompact, which is where we persist it.
        return {};
      }],
    }],
    PostCompact: [{
      hooks: [async (input) => {
        // Persist compact summaries after context compaction (D-024, D-026)
        // DP-001: 5000 char limit (Issue #112: make configurable later)
        const summary = (input as Record<string, unknown>)["compact_summary"] as string | undefined;
        if (!summary || summary.trim().length === 0) return {};

        try {
          const { createMemory } = await import("../store/memories.js");
          createMemory({
            id: `compact-${Date.now()}`,
            roleId: ctx.roleId ?? "role-chat-manager",
            type: "thought",
            content: summary.slice(0, 5000),
            keywords: ["compaction", "context", "decisions"],
            importance: 4,
            sourceType: "post_compact",
            createdAt: Date.now(),
            lastAccessed: Date.now(),
            retrievedCount: 0,
            tier: "working",
          });
        } catch {
          // Post-compact memory save failure is non-fatal
        }
        return {};
      }],
    }],
  };
}
