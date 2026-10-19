import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { createGoal, getGoal, updateGoal, listGoals, deleteGoal } from "../store/goals.js";
import { createTask, updateTask, getTask, listTasks } from "../store/tasks.js";
import { createRole, getRole, updateRole, listRoles, deleteRole, getRoleByName } from "../store/roles.js";
import { ensureRoleWorkspace, getRoleWorkspacePath, writeRoleCLAUDEmd } from "../store/role-workspace.js";
import { listChannels, getChannel, updateChannel } from "../store/channels.js";
import { recipientCapInputSchema } from "../lib/recipient-cap-input.js";
import { RECIPIENT_DOMAIN_REGEX } from "../lib/recipient-cap-bounds.js";
import { getDb } from "../store/db.js";
import { listSessions } from "../chat/session-manager.js";
import { buildMetricTree } from "../goal-manager/goal-manager.js";
import { calculateReward } from "../strategy/evaluator/reward.js";
import { StrategyEngine } from "../strategy/engine.js";
import { StrategyGenerator } from "../strategy/generator.js";
import { getDefaults } from "../config/index.js";
import { getRuntimeConfig, updateMutableConfig } from "../config/runtime.js";
import { recordRuntimeEffect } from "../store/runtime-effects.js";
import { writeMutationReceipt } from "../audit/mutation-receipt-writer.js";
import { writeClaims } from "../store/assistant-claims.js";
import { resolveViewerKeyForDeliveryTarget, resolveViewerKeyForSource } from "../chat/viewer-identity.js";
import { getTemplateExecution } from "../store/template-executions.js";
import { ContractRuleItemSchema } from "../store/contract-rules.js";
import { listArtifactsByExecution } from "../store/artifacts.js";
import { assembleSummaryFromDb } from "../scheduler/template-summary-assembler.js";
import { composeDeliveryFromManifest } from "../delivery/compose-delivery.js";
import { createSharedMemoryTools } from "./shared-tools.js";
import type { ChatSource, ClaimSpec, Goal, GoalStatus, TaskStatus, NotifyTarget, Role, TaskRequirements, TaskStep, TaskTemplate, PinnedParameter, LearnedRules } from "../shared/types.js";
import { v4 as uuidv4 } from "uuid";
import { getLogger, setLogLevel } from "../lib/logger.js";
import {
  taskIdSchema,
  roleIdSchema,
  goalIdSchema,
  channelIdSchema,
  sessionIdSchema,
  templateIdSchema,
  pluginIdSchema,
  eventDefIdSchema,
  ruleIdSchema,
  strategyIdSchema,
  localFilePathSchema,
  stepIdSchema,
  executionIdSchema,
} from "../lib/tool-schemas.js";
import { listInstalledPlugins, getGlobalEnabledState, getInstalledPlugin, getPluginManifest, listMarketplaceSources, scanDirectoryConfig } from "../store/plugin-registry.js";
import * as pluginCli from "../lib/plugin-cli.js";
import type { AdditionalDirectory } from "../shared/types.js";
import { generateCapabilitySummary, resolveRolePluginCapabilities } from "../lib/role-capabilities.js";
import { listMemoriesByRole } from "../store/memories.js";
import { getStepLogs } from "../store/logs.js";
import { isPresetRole } from "../store/role-presets.js";
import { createDeliveryRule, listDeliveryRules, deleteDeliveryRule } from "../store/delivery-rules.js";
import { listStrategiesByRole } from "../store/strategies.js";
import { queryEvents } from "../store/events.js";
import { createEventDef, getEventDef, listEventDefs, updateEventDef, deleteEventDef } from "../store/event-defs.js";
import { startEventDefSource, stopEventDefSource, fireManualEvent, fireTestEvent } from "../events/sources/index.js";
import { getSourceTypeKeys, validateSourceConfig } from "../events/sources/schemas.js";
import { formatEventForLLM } from "../security/signal-sanitizer.js";
import { getTaskTemplate, updateTaskTemplate, deleteTaskTemplate, createTaskTemplate, disableTaskTemplate, getTaskTemplateDependents } from "../store/task-templates.js";
import { listTemplateVersions, getTemplateVersion, diffTemplateVersions, restoreTemplateVersion } from "../store/template-versions.js";
import { listTaskPlans } from "../store/task-plans.js";
import { TaskController } from "../server/routes/task-controller.js";
import { existsSync, readFileSync } from "node:fs";
import { assertDocPathInExportDir, parseConfigDoc, parsePortableConfig } from "../store/config-doc/parser.js";
import { checkImportDependencies, loadInstalledSnapshot } from "../store/config-doc/import-deps.js";
import { verifyImportedConfig } from "../store/config-doc/import-verify.js";
import { createTaskWithAdmission } from "../lib/task-dispatch.js";
import { SkillRegistry } from "./skill-registry.js";
import { getRoleTaskTypePerformance } from "../store/role-scores.js";
import type { ErrorCategory } from "../lib/error-classifier.js";
import {
  hasNonEmptyRequirements,
  validateTaskInstructionContract,
  REQUIREMENTS_EMPTY,
  TASK_INSTRUCTION_CONTAINS_ROLE_IDENTITY,
} from "./dispatch-contract.js";
import {
  getResolvedOsCapabilityRegistry,
  validateRoleOsCapabilitiesForStorage,
} from "../shared/os-capabilities.js";
import { getSandboxProvider, isSandboxAvailable } from "../sandbox/provider.js";
import {
  TaskRequirementsSchema,
  admitTask,
  rankRoles,
  resolveRoleScopes,
  pathCovered,
  detectApprovalWarnings,
} from "../lib/task-admission.js";
import { getCurrentTraceId, withTrace } from "../lib/trace-context.js";
import type { CapturedDispatch } from "../shared/types.js";
import { registerChatSentArtifact } from "./chat-artifact-publisher.js";
import { CHAT_MANAGER_ROLE_ID } from "../store/role-presets.js";
import { DEFAULT_EMAIL_CAP_BYTES } from "../lib/recipient-cap-bounds.js";
import { recordUserFeedback } from "../store/user-feedback.js";
import { deriveStepKind } from "../agent/derive-step-kind.js";
import { getCostSummary } from "../store/llm-costs.js";
import { getConfigValue } from "../store/config.js";

const log = getLogger("manager");

// ===== Helper =====

/**
 * Resolve an anchor-ref to the verbatim bytes from a config-doc.
 * Validates the path is inside the export dir, reads the file, parses it,
 * and returns the anchor bytes as a UTF-8 string.
 *
 * Throws on:
 *  - out-of-export-dir path
 *  - unreadable file
 *  - parser error (hash/length/marker mismatch)
 *  - missing anchor id
 *
 * Used by the `*Ref` params on `create_role` and `create_template`. The
 * caller is expected to convert the thrown error into a structured
 * `{ error }` tool response.
 */
function resolveAnchorBytes(
  ref: { docPath: string; anchorId: string },
  fieldLabel: string,
): string {
  const safePath = assertDocPathInExportDir(ref.docPath);
  let text: string;
  try {
    text = readFileSync(safePath, "utf8");
  } catch (err) {
    throw new Error(
      `create anchor-ref: cannot read file "${safePath}" for ${fieldLabel}: ${(err as Error).message}`,
    );
  }
  let parsed: ReturnType<typeof parseConfigDoc>;
  try {
    parsed = parseConfigDoc(text);
  } catch (err) {
    throw new Error(
      `create anchor-ref: failed to parse config-doc for ${fieldLabel}: ${(err as Error).message}`,
    );
  }
  let bytes: Buffer;
  try {
    bytes = parsed.getAnchorBytes(ref.anchorId);
  } catch (err) {
    throw new Error(
      `create anchor-ref: ${fieldLabel} anchor "${ref.anchorId}": ${(err as Error).message}`,
    );
  }
  return bytes.toString("utf8");
}

function toCallToolResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

function formatSkillMd(args: {
  skillName: string;
  description: string;
  instructions: string;
  parameters?: Record<string, { type: string; description: string }>;
}): string {
  const paramsMd = args.parameters
    ? Object.entries(args.parameters)
        .map(([name, p]) => `- ${name}: ${p.description}`)
        .join("\n")
    : "";
  const inputsSection = paramsMd ? `\n## Inputs\n${paramsMd}\n` : "";

  return `---
description: ${args.description}
---
# ${args.skillName}
${inputsSection}
## Instructions
${args.instructions}
`;
}

// ---------------------------------------------------------------------------
// Admission failure guidance (Task 7)
// ---------------------------------------------------------------------------

/** Human-readable guidance for each admission failure code. */
const ADMISSION_GUIDANCE: Record<string, string> = {
  ROLE_TOOL_MISMATCH: "One or more required tools are not available on the selected Role. Try dispatch_by_requirements for automatic Role selection, or check if a plugin providing those tools is installed.",
  ROLE_NOT_FOUND: "The specified Role is not found or is not active. Check if the Role has been renamed, retired, or deleted.",
  ROLE_SELECTION_AMBIGUOUS: "No single Role clearly satisfies all requirements. Consider installing a plugin that provides the missing tools or capabilities.",
  REQUIREMENTS_NOT_SATISFIED: "The Role's requirements profile does not match the task. Try relaxing some requirements or using dispatch_by_requirements for automatic selection.",
};

/**
 * Find a Role that has the missing tools and is not the excluded roleId.
 * Returns the role name, or undefined.
 */
function findAlternativeRoleWithTools(
  missingTools: string[],
  excludeRoleId?: string,
): string | undefined {
  const all = listRoles("active", 100, 0).filter((r) => r.id !== excludeRoleId && r.source !== "system");
  for (const role of all) {
    const allowed = new Set(role.allowedTools ?? []);
    if (missingTools.every((t) => allowed.has(t))) {
      return role.name;
    }
  }
  return undefined;
}

/**
 * Add skill context and task-type performance to list_roles ranked results.
 */
function buildSkillContextForRole(roleId: string, roleName: string): {
  matchingSkills: Array<{ name: string; description: string; successRate: number }>;
  taskTypePerformance?: ReturnType<typeof getRoleTaskTypePerformance>;
} {
  const skills = SkillRegistry.query({ roleId });
  const matchingSkills = skills.map((s) => ({
    name: s.name,
    description: s.description,
    successRate: s.health?.successRate ?? -1,
  }));
  // Pick the first matching skill as the task-type performance context
  const primarySkill = matchingSkills[0];
  const taskTypePerformance = primarySkill
    ? getRoleTaskTypePerformance(roleId, primarySkill.name)
    : undefined;
  return { matchingSkills, taskTypePerformance };
}

/**
 * Build a human-readable recommendedAction string for dispatch success.
 */
function buildRecommendedAction(roleId: string): string {
  if (!roleId) return "Generic dispatch (no matching skill found)";
  const skills = SkillRegistry.query({ roleId });
  if (skills.length === 0) return "Generic dispatch to selected Role (no matching skill)";
  const primary = skills[0];
  const rate = primary.health?.successRate ?? -1;
  const rateStr = rate >= 0 ? `${(rate * 100).toFixed(0)}%` : "N/A";
  return `Skill '${primary.name}' via Role '${primary.sourceName}' (success rate: ${rateStr})`;
}

// Shared: resolve LLM-facing delivery targets (channelName) → backend NotifyTarget (channelId + chatId)
export async function resolveDeliveryTargets(
  inputs: Array<{ type: string; sessionId?: string; channelName?: string; channelId?: string; chatId?: string }>,
): Promise<import("../shared/types.js").NotifyTarget[]> {
  const { listChannels: listAllChannels } = await import("../store/channels.js");
  const allChannels = listAllChannels();
  const { listSessions } = await import("../chat/session-manager.js");
  const allSessions = [...listSessions("active"), ...listSessions("archived")];
  const { getDefaultChatIdForChannel } = await import("../channels/target-resolution.js");

  const resolved: import("../shared/types.js").NotifyTarget[] = [];
  for (const target of inputs) {
    if (target.type === "session" && target.sessionId) {
      resolved.push({ type: "session", sessionId: target.sessionId });
    } else if (target.type === "channel") {
      let channelId = target.channelId;
      let chatId = target.chatId;

      // Resolve by name if channelId not provided
      if (!channelId && target.channelName) {
        const ch = allChannels.find((c) => c.name.toLowerCase().includes(target.channelName!.toLowerCase()));
        if (ch) channelId = ch.id;
      }

      // Resolve chatId from session history or channel config
      if (channelId && !chatId) {
        const ch = allChannels.find((c) => c.id === channelId);
        chatId = ch ? getDefaultChatIdForChannel(ch, allSessions) : undefined;
      }

      if (channelId && chatId) {
        resolved.push({ type: "channel", channelId, chatId });
      } else {
        log.warn({ channelName: target.channelName, channelId, chatId }, "Could not resolve channel notify target");
      }
    }
  }
  return resolved;
}

// Shared roleId resolution: finds a Role by name matching the role hint.
async function resolveRoleIdByRoleHint(roleHint: string): Promise<string | undefined> {
  const { listRoles } = await import("../store/roles.js");
  const allRoles = listRoles(undefined, 100, 0);
  for (const r of allRoles) {
    if (r.name.toLowerCase().includes(roleHint.toLowerCase())) {
      return r.id;
    }
  }
  return undefined;
}

// ===== Tool Input Schemas (raw shapes for SDK tool() helper) =====

const readGoalStateShape = {
  goalId: goalIdSchema,
};

const updateGoalStateShape = {
  goalId: goalIdSchema,
  status: z.string().optional().describe("Filter by status (e.g., 'pending', 'running', 'completed', 'failed')."),
  currentValue: z.number().optional().describe("New current value for the goal's metric."),
  budgetUsd: z.number().optional().describe("Updated budget cap in USD."),
  notes: z.string().optional().describe("Free-form notes about the goal update."),
};

const decomposeGoalShape = {
  goalId: goalIdSchema,
  goalDescription: z.string().describe("Natural-language goal description used for LLM decomposition into subtasks."),
  maxSubtasks: z.number().optional().describe("Maximum number of subtasks to generate (default 5)."),
};

// LLM-facing notify target: uses channelName (human-readable) which the backend resolves
const notifyTargetInputShape = z.union([
  z.object({ type: z.literal("session"), sessionId: sessionIdSchema }),
  z.object({ type: z.literal("channel"), channelName: z.string().describe("Channel display name (e.g., 'WeChat on iPad' or 'Client Mail'). Use list_channels to find the exact name.") }),
  z.object({ type: z.literal("channel"), channelId: channelIdSchema, chatId: z.string().describe("Chat / conversation ID inside the channel (channel-specific format).").optional() }),
]);

const dispatchTaskShape = {
  prompt: z.string().describe("Task prompt — the natural-language instruction for the executor."),
  roleId: roleIdSchema.optional().describe("Role ID. Call list_roles(requirements) first to find the best role for the task."),
  requirements: TaskRequirementsSchema.optional().describe("Task requirements: tools, paths, OS capabilities, network access, plugins."),
  autoSelectRole: z.boolean().optional().describe("Auto-select the best role based on requirements (requires requirements field)."),
  deliverTo: z.array(notifyTargetInputShape).optional().describe("Where to deliver the task output (result full text). E.g., send result to a specific channel. e.g., [{type:\"channel\", channelName:\"iPad WeChat\"}] when user says \"发到 iPad 微信\"."),
  reportTo: z.array(notifyTargetInputShape).optional().describe("Where to send status reports (completion summary). Defaults to the originating channel/session."),
  toolOverrides: z.object({
    allowedTools: z.array(z.string()).optional().describe("Override: explicitly allow these tools (replaces inherited list)."),
    disallowedTools: z.array(z.string()).optional().describe("Override: explicitly deny these tools (adds to inherited denylist)."),
  }).optional().describe("Tool permission overrides for this dispatch only (does not persist)."),
  effortTier: z.enum(["low", "medium", "high"]).optional()
    .describe("Override the Role's effortTier for this dispatch only. low=Haiku, medium=Sonnet, high=Opus. Resolved at task start to config.anthropic.default{Haiku|Sonnet|Opus}Model. Omit to use the Role's configured tier."),
};

const taskInstructionSchema = z.string().describe(
  "Work instruction for the executor. Do not include Role identity/persona such as '你是 X' or 'You are X'; selected Role CAG prompt supplies identity.",
);

const dispatchToRoleShape = {
  taskInstruction: taskInstructionSchema,
  roleId: roleIdSchema.describe("Exact Role ID from list_roles(requirements). Do not pass a role name."),
  requirements: TaskRequirementsSchema.describe("Non-empty task requirements used to validate the selected Role."),
  deliverTo: z.array(notifyTargetInputShape).optional().describe("Where to deliver the task output."),
  reportTo: z.array(notifyTargetInputShape).optional().describe("Where to send status reports."),
  toolOverrides: dispatchTaskShape.toolOverrides,
  effortTier: dispatchTaskShape.effortTier,
};

const dispatchByRequirementsShape = {
  taskInstruction: taskInstructionSchema,
  requirements: TaskRequirementsSchema.describe("Non-empty task requirements used for automatic Role selection."),
  deliverTo: z.array(notifyTargetInputShape).optional().describe("Where to deliver the task output."),
  reportTo: z.array(notifyTargetInputShape).optional().describe("Where to send status reports."),
  toolOverrides: dispatchTaskShape.toolOverrides,
  effortTier: dispatchTaskShape.effortTier,
};

const evaluateResultShape = {
  taskId: taskIdSchema,
  goalId: goalIdSchema.optional(),
  strategyId: strategyIdSchema.optional(),
};

const createStrategyShape = {
  roleId: roleIdSchema,
  taskType: z.string().describe("Task category label (e.g., 'web_search', 'code_review'). Used to bucket strategies."),
  name: z.string().optional().describe("Display name for the strategy (auto-generated if omitted)."),
};

const listPendingGoalsShape = {
  status: z.string().optional().describe("Filter by status (e.g., 'pending', 'running', 'completed', 'failed')."),
  limit: z.number().optional().describe("Max results to return (default 10)."),
};

const assignRoleShape = {
  taskId: taskIdSchema,
  roleId: roleIdSchema,
};


const readTaskStatusShape = {
  taskId: taskIdSchema.optional(),
  status: z.string().optional().describe("Filter by status (e.g., 'pending', 'running', 'completed', 'failed')."),
  limit: z.number().optional().describe("Max results to return (default 10)."),
};

const modifyRolePermissionsShape = {
  roleId: roleIdSchema,
  allowedTools: z.array(z.string()).optional().describe("Explicitly allow these tools (additive to defaults)."),
  disallowedTools: z.array(z.string()).optional().describe("Explicitly deny these tools."),
  osCapabilities: z.array(z.object({
    id: z.string().min(1),
    targets: z.array(z.string().min(1)).optional(),
  })).optional().describe("Role-level OS capability grants. Use get_capabilities to inspect the runtime registry and valid target-scoped entries."),
  additionalDirectories: z.array(z.object({
    path: localFilePathSchema,
    mode: z.enum(["ro", "rw"]).optional().describe("Read-only or read-write access. Default: rw. Enforced by OS sandbox."),
    inheritPlugins: z.boolean().optional().describe("Inherit global plugins when accessing this directory."),
    inheritMcp: z.boolean().optional().describe("Inherit MCP servers when accessing this directory."),
    inheritPermissions: z.boolean().optional().describe("Inherit permission overrides when accessing this directory."),
  })).optional().describe("Extra directories the Role can access (beyond its workspace). Each entry grants sandboxed read/write access."),
  allowedChannels: z.array(z.string()).optional().describe("Channel names this Role is permitted to deliver to."),
  inheritUserSettings: z.boolean().optional().describe("Enable/disable inheriting user-level settings (global plugins, MCP servers). Default: false (isolated)."),
};

const updateRoleShape = {
  roleId: roleIdSchema.describe("Role ID to update."),
  name: z.string().min(1).optional().describe("Display name shown in lists and references."),
  cagPrompt: z.string().optional().describe("CAG prompt — Role's identity/personality directive."),
  learnedRules: z.union([
    z.array(z.string()),
    z.object({
      stylePreferences: z.array(z.string()).optional(),
      avoidedActions: z.array(z.string()).optional(),
      pinnedParameters: z.array(z.object({
        tool: z.string(),
        params: z.record(z.string(), z.unknown()),
        condition: z.string().optional(),
        pinnedAt: z.number(),
      })).optional(),
    }),
  ]).optional().describe("Learned rules — either legacy string[] (auto-migrated to stylePreferences) or structured LearnedRules object."),
  status: z.enum(["active", "inactive", "retired"]).optional().describe("Role lifecycle status."),
  executionMode: z.enum(["isolated", "inline"]).optional().describe("Execution mode: 'isolated' (separate process, sandboxed) or 'inline' (same process, unsandboxed)."),
  effortTier: z.enum(["low", "medium", "high"]).nullable().optional().describe("The Role's model tier — the canonical way to set a Role's model. low → config.anthropic.defaultHaikuModel, medium → defaultSonnetModel, high → defaultOpusModel; resolved fresh at execution/chat start, so the actual model is configured once in Settings (not hardcoded per-Role). Pass null to clear (Role inherits the global ANTHROPIC_MODEL)."),
  maxBudgetUsd: z.number().optional().describe("Max USD budget per task for this Role."),
  approvalRequired: z.array(z.string()).optional().describe("Glob patterns for operations requiring user approval before execution."),
  preferences: z.object({
    maxTurns: z.number().optional(),
  }).optional().describe("Execution preferences for this Role."),
  permissionMode: z.enum(["default", "acceptEdits", "dontAsk", "bypassPermissions", "plan", "auto"]).optional().describe("CLI permission behavior for this Role."),
  allowedBashPatterns: z.array(z.string()).optional().describe("Bash patterns that auto-execute without approval (e.g., 'git *', 'pnpm *')."),
  deniedBashPatterns: z.array(z.string()).optional().describe("Bash patterns that auto-reject without approval."),
  evaluationCriteria: z.record(z.string(), z.number()).optional().describe("Named quality thresholds the monitor uses to score this Role's outputs."),
  envVars: z.record(z.string(), z.string()).optional().describe("Environment variables injected into the Role's execution environment."),
};

const viewAuditLogShape = {
  roleId: roleIdSchema.optional(),
  limit: z.number().optional().describe("Max results to return (default 10)."),
};

/**
 * Anchor-ref shape. A `*Ref` param reads a verbatim field's bytes from a
 * config-doc by anchor id (no LLM re-emission, no token bloat). When the
 * caller passes both an inline value and a `*Ref` for the same field,
 * the tool returns an error (ambiguous). When `docPath` is outside the
 * configured export dir, the tool returns an error before any read.
 *
 * Declared early because it is referenced by `createRoleShape` (below)
 * and by `templateStepInputShape` (further down).
 */
const anchorRefShape = z.object({
  docPath: localFilePathSchema.describe("Absolute path to a config-doc YAML. Must resolve inside the configured export dir (~/.adam/config-exports/ by default)."),
  anchorId: z.string().min(1).describe("Anchor id declared in the config-doc, e.g. 'role.<roleId>.cagPrompt' or 'template.<tplId>.step.<stepId>.prompt'."),
});

const createRoleShape = {
  name: z.string().describe("Display name shown in lists and references."),
  cagPrompt: z.string().describe("CAG prompt — Role's identity/personality directive."),
  cagPromptRef: anchorRefShape.optional().describe("Anchor reference for the CAG prompt. When provided, the CAG prompt is read byte-exact from the config-doc via parseConfigDoc(...).getAnchorBytes(anchorId) and used INSTEAD OF the inline `cagPrompt` field. Use this for long CAG prompts imported from a doc. If both `cagPrompt` and `cagPromptRef` are given, the tool returns an error (ambiguous)."),
  traits: z.array(z.string()).optional().describe("Behavioral trait tags for this Role (e.g., '代码质量优先', '测试驱动')."),
  allowedTools: z.array(z.string()).optional().describe("Tools this Role is permitted to use."),
  disallowedTools: z.array(z.string()).optional().describe("Tools this Role is explicitly denied from using."),
  osCapabilities: z.array(z.object({
    id: z.string().min(1),
    targets: z.array(z.string().min(1)).optional(),
  })).optional().describe("Initial Role-level OS capability grants. Use get_capabilities to discover editable capability ids and target rules."),
  additionalDirectories: z.array(z.object({
    path: localFilePathSchema,
    mode: z.enum(["ro", "rw"]).optional().describe("Read-only or read-write access. Default: rw. Enforced by OS sandbox."),
    inheritPlugins: z.boolean().optional().describe("Inherit global plugins when accessing this directory."),
    inheritMcp: z.boolean().optional().describe("Inherit MCP servers when accessing this directory."),
    inheritPermissions: z.boolean().optional().describe("Inherit permission overrides when accessing this directory."),
  })).optional().describe("Extra directories the Role can access (beyond its workspace). Each entry grants sandboxed read/write access."),
  // Portable role field set (F1 in the Phase 2 plan). Drives faithful
  // reconstruction when importing a config-doc. All fields optional —
  // omitting them preserves today's back-compat behavior. `mcpServers` is
  // deliberately NOT in this set (D-011: runtime role MCP comes from
  // `role_extensions`, the `mcp_servers` column is dead; see Phase 2 plan
  // "Out of scope / follow-ups" for the portability follow-up).
  learnedRules: z.union([
    z.array(z.string()),
    z.object({
      stylePreferences: z.array(z.string()).optional(),
      avoidedActions: z.array(z.string()).optional(),
      pinnedParameters: z.array(z.object({
        tool: z.string(),
        params: z.record(z.string(), z.unknown()),
        condition: z.string().optional(),
        pinnedAt: z.number(),
      })).optional(),
    }),
  ]).optional().describe("Learned rules for this Role — used by the import path to faithfully reconstruct a Role. Omit to keep today's default of an empty learnedRules object."),
  status: z.enum(["active", "inactive", "retired"]).optional().describe("Role lifecycle status. Defaults to 'active'."),
  executionMode: z.enum(["isolated", "inline"]).optional().describe("Execution mode: 'isolated' (separate process, sandboxed) or 'inline' (same process, unsandboxed)."),
  effortTier: z.enum(["low", "medium", "high"]).nullable().optional().describe("Model tier for this Role. low → config.anthropic.defaultHaikuModel, medium → defaultSonnetModel, high → defaultOpusModel; resolved fresh at execution/chat start. Pass null to clear."),
  model: z.string().optional().describe("Model id override for this Role. Mirrored from updateRoleShape. Stored verbatim; effortTier is the canonical path."),
  maxBudgetUsd: z.number().optional().describe("Max USD budget per task for this Role."),
  approvalRequired: z.array(z.string()).optional().describe("Glob patterns for operations requiring user approval before execution."),
  preferences: z.object({
    maxTurns: z.number().optional(),
  }).optional().describe("Execution preferences for this Role. Defaults to {}."),
  permissionMode: z.enum(["default", "acceptEdits", "dontAsk", "bypassPermissions", "plan", "auto"]).optional().describe("CLI permission behavior for this Role."),
  allowedBashPatterns: z.array(z.string()).optional().describe("Bash patterns that auto-execute without approval (e.g., 'git *', 'pnpm *')."),
  deniedBashPatterns: z.array(z.string()).optional().describe("Bash patterns that auto-reject without approval."),
  evaluationCriteria: z.record(z.string(), z.number()).optional().describe("Named quality thresholds the monitor uses to score this Role's outputs."),
  envVars: z.record(z.string(), z.string()).optional().describe("Environment variables injected into the Role's execution environment."),
  source: z.enum(["system", "user"]).optional().describe("Origin of this Role — 'system' for built-in presets, 'user' for user-created. Defaults to undefined."),
  allowedChannels: z.array(z.string()).optional().describe("Channel names this Role is permitted to deliver to. (D-004: null=unrestricted, []=block all, ['name']=whitelist)"),
  inheritUserSettings: z.boolean().optional().describe("Enable/disable inheriting user-level settings (global plugins, MCP servers). Default: false (isolated)."),
  presetId: z.string().optional().describe("Preset identifier, set when this Role was seeded from a canonical preset."),
  skills: z.union([z.array(z.string()), z.literal("all")]).optional().describe("SDK skills option: array of skill names or 'all'. Replaces deprecated allowedTools: ['Skill']."),
  memoryBudgetTokens: z.number().int().positive().optional().describe("Per-role token budget for memory context injection. Null/undefined → use global default from config.memory.globalBudgetTokens."),
  performanceScore: z.number().optional().describe("Aggregate quality score for this Role (0..1)."),
  // Same-name signal — only honored during import. 'create' (default) and
  // omitted behave identically. 'skip' short-circuits on an ACTIVE same-name
  // role (a retired same-name does not trigger skip). 'error' rejects.
  ifExists: z.enum(["create", "skip", "error"]).optional().describe("Same-name signal used during config-doc import. 'create' (default): always create. 'skip': return {skipped:true, existingRoleId} when an ACTIVE same-name role exists; a retired same-name does not trigger skip. 'error': return {error} when an ACTIVE same-name role exists."),
};

const retireRoleShape = {
  roleId: roleIdSchema,
  reason: z.string().optional().describe("Reason for the action (audit trail)."),
};

const createGoalShape = {
  name: z.string().describe("Display name shown in lists and references."),
  description: z.string().optional().describe("Free-form description."),
  roleId: roleIdSchema.optional(),
  metric: z.string().optional().describe("Metric type label (e.g., 'count', 'duration_ms', 'cost_usd')."),
  targetValue: z.number().optional().describe("Target metric value to reach (e.g., 100 for a count goal). Default 1."),
  deadline: z.number().optional().describe("Unix timestamp (ms) deadline. Default: 7 days from now."),
  budgetUsd: z.number().optional().describe("Max USD budget for this goal."),
  deliverTo: z.array(notifyTargetInputShape).optional().describe("Where to deliver goal completion notifications."),
};

const templateStepPersonaShape = z.object({
  speakAs: z.string().min(1).describe("Persona/display name the step should speak as."),
  voiceConstraints: z.string().optional().describe("Additional voice/style constraints for this step."),
});

export const templateStepOutputContractShape = z.object({
  mustReferenceArtifacts: z.boolean().optional(),
  customAssertions: z.array(z.string().min(1)).min(1).max(8).optional().describe("Up to 8 assertion strings; each evaluated by a Haiku judge after the step succeeds Layer A/B."),
  customAssertionRefs: z.array(z.object({
    docPath: localFilePathSchema,
    anchorId: z.string().min(1).describe("Anchor id declared in the config-doc, e.g. 'template.<tplId>.step.<stepId>.outputContract.customAssertions[<i>]'."),
  })).optional().describe("Up to 8 anchor references. Each entry's bytes are read from the config-doc via parseConfigDoc(...).getAnchorBytes(anchorId) and substituted positionally for the corresponding customAssertion. Use this INSTEAD OF customAssertions when the assertion strings are long or come from an imported doc. If both customAssertions and customAssertionRefs are given, they are concatenated in order."),
  contractRules: z.array(ContractRuleItemSchema).optional().describe(
    "The single contract vocabulary. Each item is a discriminated union keyed by `kind`: " +
    "{kind:'lengthTarget',min,max,unit} (unit = characters|words|bytes), " +
    "{kind:'format',value} (value = markdown|json|text), " +
    "{kind:'requireHeading',value:boolean}, {kind:'mime',declared}, " +
    "{kind:'fileSizeBytes',min?,max?}, {kind:'audioZeroCrossingRatePerS',max}, {kind:'audioDurationMs',min?,max?}. " +
    "Track A rules (lengthTarget/format/requireHeading/mime) are content-checked at the write_artifact boundary; " +
    "Track B rules (file size / audio) are checked on disk after publish_artifact_file.",
  ),
});

const templateStepInputShape = z.object({
  id: stepIdSchema.describe("Unique Template step ID."),
  prompt: z.string().describe("Task prompt for this step."),
  promptRef: anchorRefShape.optional().describe("Anchor reference for the step prompt. When provided, the prompt is read byte-exact from the config-doc via parseConfigDoc(...).getAnchorBytes(anchorId) and used INSTEAD OF the inline `prompt` field. Use this for long prompts imported from a doc. If both `prompt` and `promptRef` are given, the tool returns an error (ambiguous)."),
  roleId: roleIdSchema.optional().describe("Fixed role for this step. Use autoSelectRole instead for dynamic role selection."),
  requirements: TaskRequirementsSchema.optional().describe("Task requirements for this step: tools, paths, OS capabilities, network access, plugins."),
  autoSelectRole: z.boolean().optional().describe("Auto-select the best role for this step at dispatch time based on requirements."),
  dependsOn: z.array(stepIdSchema).optional().describe("Template step IDs this step depends on."),
  minDependencies: z.number().int().min(1).optional().describe("Partial-success tolerance for this step's dependencies. When the user says things like \"至少 N 篇/个 成功就跑\", \"3 个里 2 个成功就继续\", \"any 2 of 3 dependencies pass\", \"only need M of N upstreams\" — set this to N. The step will run as long as at least minDependencies of its dependsOn entries succeeded (skipped/failed/no_content/cancelled count as failed). Absent (default) = ALL deps must succeed (strict-AND). Must be ≥ 1 and ≤ dependsOn.length. Concrete example: a step with dependsOn=[润色A,润色B,润色C] and minDependencies=2 still runs when 润色B fails, as long as 润色A and 润色C succeeded."),
  config: z.object({
    timeout: z.number().optional().describe("Step-level timeout override in seconds."),
    maxTurns: z.number().optional().describe("Step-level maxTurns override."),
  }).optional().describe("Step-level execution config overrides."),
  outputAs: z.string().optional().describe("Optional output label for this step's result."),
  kind: z.string().optional().describe("Step functional category, used as the belief scope label {roleId}::{kind}. Steps without kind fall back to the {roleId}::default scope."),
  consumesFrom: z.array(z.string()).optional().describe("Required upstream step IDs whose artifacts this step consumes."),
  consumesFromOptional: z.array(z.string()).optional().describe("Optional upstream step IDs whose missing artifacts do not fail this step."),
  persona: z.object({
    speakAs: z.string().min(1).describe("Persona/display name the step should speak as."),
    speakAsRef: anchorRefShape.optional().describe("Anchor reference for persona.speakAs. When provided, the speakAs string is read byte-exact from the config-doc and used INSTEAD OF the inline `speakAs` field. If both `speakAs` and `speakAsRef` are given, the tool returns an error (ambiguous)."),
    voiceConstraints: z.string().optional().describe("Additional voice/style constraints for this step."),
  }).optional().describe("Persona constraints injected into this step."),
  outputContract: templateStepOutputContractShape.optional().describe("Output contract enforced for this step."),
  recordEditorScores: z.boolean().optional().describe("Podcast Phase 2: when true, the executor parses this step's result as the review-editor scoring JSON ({candidates:[{candidate_id,scores,selected,editor_notes}]}) and persists each candidate to editor_scores for the retrospective."),
  assertions: z.array(z.string()).optional().describe("Optional inline assertions checked at the write_artifact boundary for this step (e.g. ['len>0','contains:开场白'])."),
  candidateId: z.string().min(1).optional().describe("Podcast Phase 2 parallel-N: stable candidate id for this path (e.g. \"稿-A\"). The executor maps the review-editor's per-candidate scores back to this step's briefPerturbation via this id."),
  briefPerturbation: z.object({
    cross_domain_bucket: z.string().nullable().describe("Forced cross-domain bucket for this path; null on an unperturbed path."),
    contrarian_source: z.string().min(1).describe("Forced contrarian source name for this path."),
  }).optional().describe("Podcast Phase 2 parallel-N: the brief perturbation applied to this path. The executor uses it as the canonical editor_scores.brief_diff — never the LLM output."),
  settlementLedgerOwner: z.string().optional().describe("Belief Ledger opt-in (consume): the ledger owner key (a show/template-scope identity, e.g. 'podcast-show') whose due unsettled falsifiable predictions the platform reads and injects as a self-falsification settlement section at the top of this step's prompt, before the step runs. Omit on steps that should not open with a settlement section."),
  publishesClaimsTo: z.string().optional().describe("Belief Ledger opt-in (publish): the ledger owner key (same show/template-scope identity) the platform records this step's output to. This step's output MUST be a JSON array of falsifiable predictions [{claim, confidence, falsifyCondition, date}]; the platform parses it after the step completes and records each as an unsettled prediction. Set ONLY on a dedicated claims-producing step whose sole deliverable is that array — never on a script/prose step."),
  settlesPredictionsFor: z.string().optional().describe("Belief Ledger opt-in (settle): the ledger owner key (same show/template-scope identity) whose due predictions this step's output settles. This step's output MUST be a JSON array of settle-verdicts [{predictionId, status, outcome, newConfidence?, rewriteClaim?}] where status is confirmed|refuted|partial; the platform parses it after the step completes and settles each referenced prediction (validating the id belongs to the owner and is still unsettled). Set ONLY on a dedicated verdict-producing step (e.g. a 结算 step), typically the same step that also sets settlementLedgerOwner to receive the due predictions in its prompt."),
  openLedgerOwner: z.string().optional().describe("Belief Ledger opt-in (open-questions, Phase 2): the ledger owner key (same show/template-scope identity) whose recent (NOT-yet-due) unsettled predictions the platform injects as a 开放问题/承接·展开 section at the top of this step's prompt. DISJOINT from settlementLedgerOwner by age (open = age < lookbackDays, settlement = age >= dueDays), so the same prediction never appears in both blocks. Set when you want the opening step to carry forward / expand on recent open bets instead of (or in addition to) settling due ones — typically the same step also sets settlementLedgerOwner."),
  openLedgerLookbackDays: z.number().int().min(1).optional().describe("Belief Ledger opt-in (open-questions, Phase 2): optional window in days for the open-questions block (default 2). Clamped to [1, dueDays-1] inside findRecentOpenPredictions; callers cannot widen it past the settlement boundary. Ignored when openLedgerOwner is not set."),
});

const createTemplateShape = {
  name: z.string().describe("Display name shown in lists and references."),
  description: z.string().optional().describe("Free-form description."),
  triggerType: z.enum(["manual", "cron", "template_complete", "event"]).optional().describe("How this template is triggered: 'manual' (default), 'cron' (scheduled), 'template_complete' (after another TemplateExecution finishes), or 'event' (on a canonical event)."),
  triggerCron: z.string().optional().describe("Cron expression for recurring trigger (e.g., '0 9 * * *' for 9am daily)."),
  triggerEvent: z.string().optional().describe(
    "For triggerType=template_complete: 'template_complete:<templateId>'. For manual/cron/event: unused.",
  ),
  eventDefId: eventDefIdSchema.optional().describe(
    "Required when triggerType='event'. Event def to bind this template to. Use list_event_defs to find or create_event_def to create one.",
  ),
  prompt: z.string().optional().describe("Shorthand single-step task prompt. Use steps[] for multi-step Templates."),
  roleId: roleIdSchema.optional().describe("Shorthand single-step fixed role. Use autoSelectRole instead for dynamic role selection."),
  requirements: TaskRequirementsSchema.optional().describe("Task requirements: tools, paths, OS capabilities, network access, plugins. Required when autoSelectRole is true."),
  autoSelectRole: z.boolean().optional().describe("Auto-select best role at dispatch time based on requirements."),
  config: z.record(z.string(), z.unknown()).optional().describe("Template-level config. Use continueOnError for multi-step execution behavior."),
  steps: z.array(templateStepInputShape).optional().describe("Canonical Template steps. Use this for multi-role or multi-step work."),
  enabled: z.boolean().optional().describe("Enable this template immediately (default true)."),
  goalIds: z.array(z.string()).optional().describe("Goal IDs that add pre-run decomposition and post-run review to this Template. A Goal-backed Template still requires prompt or steps[]."),
  deliverTo: z.array(notifyTargetInputShape).optional().describe("Where to deliver the task output (result full text)."),
  reportTo: z.array(notifyTargetInputShape).optional().describe("Where to send status reports (completion summary)."),
  retryPolicy: z.object({ maxAttempts: z.number().int().positive() }).optional().describe("Retry policy for validator-driven retries. Set maxAttempts > 1 to enable one retry after a validator failure."),
  // F1 (Phase 2 plan): portable template fields accepted for faithful
  // reconstruction from a config-doc. All optional — omitting them
  // preserves back-compat. `tags` and `isPreset` are stored on the row
  // today; `presetId` is the canonical "this was seeded from a preset"
  // marker. `rolePreference` is the template-level role hint consumed by
  // `validateTemplateDefinition` (KB D-013).
  tags: z.array(z.string()).optional().describe("Tags for filtering / display. Used by faithful reconstruction from a config-doc."),
  isPreset: z.boolean().optional().describe("True when this template was seeded from a canonical preset."),
  presetId: z.string().optional().describe("Preset identifier — set when this template was seeded from a canonical preset."),
  rolePreference: z.string().optional().describe("Template-level role preference (the canonical role id) used as a fallback when a step omits roleId/autoSelectRole."),
};

const listRolesShape = {
  status: z.enum(["active", "retired", "probation"]).optional().describe("Filter by role status."),
  limit: z.number().optional().describe("Max results to return (default 10)."),
  requirements: TaskRequirementsSchema.optional().describe("Task requirements to score and rank roles against."),
};

const listChannelsShape = {
  enabled: z.boolean().optional().describe("Filter by enabled status."),
};

const getSystemStatusShape = {};

const getCapabilitiesShape = {};

const scheduleTaskShape = {
  prompt: z.string().describe("The task prompt to execute after the delay"),
  delayMinutes: z.number().optional().describe("Minutes from now to execute (e.g., 30 for 'half an hour later')"),
  runAt: z.string().optional().describe("ISO 8601 timestamp to execute at (e.g., '2026-04-01T15:00:00+08:00')"),
  roleId: roleIdSchema.describe("Role ID to assign the task to. Call list_roles first."),
  deliverTo: z.array(notifyTargetInputShape).optional().describe("Where to deliver the task output (result full text)."),
  reportTo: z.array(notifyTargetInputShape).optional().describe("Where to send status reports (completion summary)."),
};

const listAvailablePluginsShape = {
  roleId: roleIdSchema.optional().describe("If provided, shows which plugins are installed in that role's workspace."),
};

const installPluginForRoleShape = {
  roleId: roleIdSchema.describe("Role ID to install the plugin under (project-scope)."),
  pluginId: pluginIdSchema.describe("Plugin ID (e.g. 'github@anthropic'). Use list_available_plugins to discover available plugins."),
};

const uninstallPluginFromRoleShape = {
  roleId: roleIdSchema.describe("Role ID to uninstall the plugin from."),
  pluginId: pluginIdSchema.describe("Plugin ID to uninstall."),
};

const bindMcpToRoleShape = {
  roleId: roleIdSchema.describe("Role ID to bind the MCP server to."),
  mcpName: z.string().describe("Name for this MCP server (e.g., 'github', 'filesystem')."),
  mcpConfig: z.record(z.string(), z.unknown()).describe("MCP server configuration object."),
};

const unbindMcpFromRoleShape = {
  roleId: roleIdSchema.describe("Role ID to unbind the MCP server from."),
  mcpName: z.string().describe("Name of the MCP server to remove."),
};

const enablePluginShape = { pluginId: pluginIdSchema.describe("Plugin ID (e.g., 'github@anthropic').") };
const disablePluginShape = { pluginId: pluginIdSchema.describe("Plugin ID (e.g., 'github@anthropic').") };
const browseMarketplaceShape = {};
const listMarketplaceSourcesShape = {};
const getPluginDetailShape = { pluginId: pluginIdSchema.describe("Plugin ID (e.g., 'github@anthropic').") };
const scanDirectoryShape = {
  roleId: roleIdSchema.describe("Role ID to associate scanned plugins with."),
  path: localFilePathSchema.describe("Directory path to scan for .claude/settings.json."),
};
const cancelTaskShape = { taskId: taskIdSchema.describe("Task ID to cancel.") };
const viewTaskLogsShape = {
  taskId: taskIdSchema.describe("Task ID to get logs for."),
  limit: z.number().optional().describe("Max log entries (default 20)."),
};
const deleteRoleShape = { roleId: roleIdSchema.describe("Role ID to delete.") };
const viewConfigShape = {};
const readConfigDocShape = {
  docPath: localFilePathSchema.describe("Absolute path to a config-doc YAML file. Must resolve inside the configured export dir (~/.adam/config-exports/ by default). Used to read a Template+Role set exported from another instance."),
};
const updateConfigShape = {
  updates: z.record(z.string(), z.unknown()).describe("Config key-value pairs to update. Example: { 'defaults.maxTurns': 50, 'logging.level': 'debug' }"),
};
const listMemoriesShape = {
  roleId: roleIdSchema.describe("Role ID to list memories for."),
  limit: z.number().optional().describe("Max results (default 20)."),
};
const updateTemplateShape = {
  templateId: templateIdSchema.describe("Template ID to update."),
  name: z.string().optional().describe("Display name shown in lists and references."),
  enabled: z.boolean().optional().describe("Filter by enabled status."),
  prompt: z.string().optional().describe("Task prompt for a single-step Template, or for the step named by stepId."),
  triggerType: z.enum(["manual", "cron", "template_complete", "event"]).optional().describe("Explicit trigger type. Required when updating trigger settings."),
  triggerCron: z.string().optional().describe("Cron expression for recurring trigger (e.g., '0 9 * * *' for 9am daily)."),
  triggerEvent: z.string().optional().describe(
    "For template_complete: 'template_complete:<templateId>'. Unused for manual/cron/event.",
  ),
  eventDefId: eventDefIdSchema.optional().describe("Required when triggerType='event'. The event def UUID to bind this template to."),
  stepId: stepIdSchema.optional().describe("Step ID to patch when updating a specific step in a multi-step Template."),
  steps: z.array(templateStepInputShape).optional().describe("Full replacement Template steps array. CRITICAL: when modifying an existing template, you MUST preserve the original step order from get_template_detail — do NOT reorder steps based on which ones you are changing. Reordering steps that the user did not explicitly ask to reorder is a silent unauthorized modification. If you only need to change one step's field (e.g., minDependencies, prompt, dependsOn), prefer the targeted-patch path (pass `stepId` + the specific field) instead of full-replacement, which avoids this risk entirely."),
  roleId: roleIdSchema.optional().describe("Step-level fixed role for the single step or the step named by stepId."),
  autoSelectRole: z.boolean().optional().describe("Step-level: if true, Adam picks the best-fit role at dispatch time."),
  requirements: TaskRequirementsSchema.optional().describe("Step-level: required when autoSelectRole=true. Fields: tools, paths, osCapabilities, network, plugins."),
  outputAs: z.string().optional().describe("Step-level output label for the single step or the step named by stepId."),
  minDependencies: z.number().int().min(1).optional().describe("Partial-success tolerance for the step named by stepId. When the user says things like \"把 X 步骤改成至少 N 篇/个成功就跑\", \"set step X to require only M of N upstreams\", \"X 这步要求 K 个依赖成功就行\" — pass stepId=X plus minDependencies=N. The named step will run as long as at least N of its dependsOn entries succeeded (skipped/failed/no_content/cancelled count as failed). Use this WITH stepId for targeted patches; do NOT need to pass the full steps array. Must be ≥ 1 and ≤ that step's dependsOn.length. Concrete example: stepId=\"评分\", minDependencies=2 makes the 评分 step run when at least 2 of [润色A,润色B,润色C] succeeded."),
  consumesFrom: z.array(z.string()).optional().describe("Step-level required upstream step IDs for the single step or stepId target."),
  consumesFromOptional: z.array(z.string()).optional().describe("Step-level optional upstream step IDs for the single step or stepId target."),
  persona: templateStepPersonaShape.optional().describe("Step-level persona constraints for the single step or stepId target."),
  outputContract: templateStepOutputContractShape.optional().describe("Step-level output contract for the single step or stepId target."),
  settlementLedgerOwner: z.string().optional().describe("Belief Ledger opt-in (consume) for the stepId target: ledger owner key (show/template-scope identity, e.g. 'podcast-show') whose due unsettled predictions are injected as a self-falsification settlement section at the top of this step's prompt. Pass with stepId for a targeted patch."),
  publishesClaimsTo: z.string().optional().describe("Belief Ledger opt-in (publish) for the stepId target: ledger owner key the platform records this step's output to. The step's output MUST be a JSON array [{claim, confidence, falsifyCondition, date}]. Set ONLY on a dedicated claims-producing step. Pass with stepId for a targeted patch."),
  settlesPredictionsFor: z.string().optional().describe("Belief Ledger opt-in (settle) for the stepId target: ledger owner key whose due predictions this step's output settles. The step's output MUST be a JSON array of settle-verdicts [{predictionId, status, outcome, newConfidence?, rewriteClaim?}] (status confirmed|refuted|partial). Set ONLY on a dedicated verdict-producing step. Pass with stepId for a targeted patch."),
  openLedgerOwner: z.string().optional().describe("Belief Ledger opt-in (open-questions, Phase 2) for the stepId target: ledger owner key whose recent unsettled predictions are injected as a 开放问题/承接·展开 section at the top of this step's prompt. Disjoint from settlementLedgerOwner by age. Pass with stepId for a targeted patch."),
  openLedgerLookbackDays: z.number().int().min(1).optional().describe("Belief Ledger opt-in (open-questions, Phase 2) for the stepId target: window in days for the open-questions block (default 2, clamped to [1, dueDays-1]). Pass with stepId for a targeted patch."),
  config: z.record(z.string(), z.unknown()).optional().describe("Template-level config, or step-level config when stepId/prompt/roleId/requirements/outputAs is also provided."),
  retryPolicy: z.object({ maxAttempts: z.number().int().positive() }).optional().describe("Retry policy for validator-driven retries."),
  deliverTo: z.array(notifyTargetInputShape).optional().describe("Replace where the template's result (full text + file artifacts) is delivered. Pass the full target list — it overwrites, not appends."),
  reportTo: z.array(notifyTargetInputShape).optional().describe("Replace where the template's status report is sent. Pass the full target list — it overwrites, not appends."),
};
const deleteTemplateShape = {
  templateId: templateIdSchema.describe("Template ID to delete. Obtain from list_templates."),
  mode: z.enum(["template_only", "with_tasks"]).describe(
    "REQUIRED. Deletion mode chosen by the user after you presented the dependent counts. 'template_only' removes the template + template_executions but keeps tasks as orphaned history records under the Tasks tab. 'with_tasks' additionally deletes every task created by this template and their role_scores + manager_decisions (chat_messages.task_id nulled). NEVER guess this value — the user must explicitly confirm which mode.",
  ),
};
const getTemplateDependentsShape = {
  templateId: templateIdSchema.describe("Template ID to inspect."),
};
const getTemplateDetailShape = {
  templateId: templateIdSchema.describe("Template ID to inspect."),
};
const runTemplateShape = { templateId: templateIdSchema.describe("Template ID to run immediately.") };
const listDeliveryRulesShape = { enabled: z.boolean().optional().describe("Filter by enabled status.") };
const queryDeliveryHistoryShape = {
  executionId: executionIdSchema.optional().describe("Filter by TemplateExecution id; use when the user asks about a specific scheduled task / podcast run / batch."),
  taskId: taskIdSchema.optional().describe("Filter by Task id."),
  channelId: channelIdSchema.optional().describe("Filter by channel id."),
  timeRangeStart: z.number().int().min(0).optional().describe("Start of time range (ms epoch); use when the user asks about a time window like 'today' or 'last week'."),
  timeRangeEnd: z.number().int().min(0).optional().describe("End of time range (ms epoch); defaults to now."),
  limit: z.number().int().min(1).max(200).optional().describe("Max rows to return; default 50, max 200."),
};
const queryExecutionStatusShape = {
  executionId: executionIdSchema.describe("TemplateExecution id to query."),
};
const cancelExecutionShape = {
  executionId: executionIdSchema.describe("TemplateExecution id to cancel (cancels its running step tasks)."),
};
const deliveryMatchCriteriaSchema = z.object({
  templateId: z.string().optional(),
  roleId: z.string().optional(),
  promptPattern: z.string().max(500).optional(),
  excludePromptPatterns: z.array(z.string().max(200)).max(20).optional(),
  taskStatus: z.string().optional(),
}).optional().describe(
  "Match criteria: rule fires when ALL set fields match. " +
  "excludePromptPatterns: regex array; any match prevents firing (use for E2E test prompts).",
);

const createDeliveryRuleShape = {
  eventType: z.string().describe("Event type that triggers this rule (e.g., 'task_complete')."),
  channelId: channelIdSchema.describe("Channel ID to deliver to."),
  format: z.string().optional().describe("Format template (e.g., 'summary', 'full'). Default: 'summary'."),
  matchCriteria: deliveryMatchCriteriaSchema,
  enabled: z.boolean().optional().describe("Enable this rule immediately (default true)."),
};
const deleteDeliveryRuleShape = { ruleId: ruleIdSchema.describe("Delivery rule ID to delete.") };
const listStrategiesShape = { roleId: roleIdSchema.optional().describe("Role ID to filter strategies by.") };

function summarizeTemplateSteps(steps: TaskStep[]) {
  return steps.map((step) => ({
    id: step.id,
    roleId: step.roleId,
    autoSelectRole: step.autoSelectRole,
    dependsOn: step.dependsOn ?? [],
    outputAs: step.outputAs,
    consumesFrom: step.consumesFrom,
    consumesFromOptional: step.consumesFromOptional,
    persona: step.persona,
    outputContract: step.outputContract,
    ...(step.recordEditorScores !== undefined ? { recordEditorScores: step.recordEditorScores } : {}),
    ...(step.candidateId !== undefined ? { candidateId: step.candidateId } : {}),
    ...(step.briefPerturbation !== undefined ? { briefPerturbation: step.briefPerturbation } : {}),
    ...(step.settlementLedgerOwner !== undefined ? { settlementLedgerOwner: step.settlementLedgerOwner } : {}),
    ...(step.publishesClaimsTo !== undefined ? { publishesClaimsTo: step.publishesClaimsTo } : {}),
    ...(step.settlesPredictionsFor !== undefined ? { settlesPredictionsFor: step.settlesPredictionsFor } : {}),
    ...(step.openLedgerOwner !== undefined ? { openLedgerOwner: step.openLedgerOwner } : {}),
    ...(step.openLedgerLookbackDays !== undefined ? { openLedgerLookbackDays: step.openLedgerLookbackDays } : {}),
    promptPreview: step.prompt.length > 120 ? `${step.prompt.slice(0, 117)}...` : step.prompt,
  }));
}

export function mapTemplateStepInput(step: z.infer<typeof templateStepInputShape>): TaskStep {
  return {
    id: step.id,
    prompt: step.prompt,
    ...(step.roleId !== undefined ? { roleId: step.roleId } : {}),
    ...(step.requirements !== undefined ? { requirements: step.requirements } : {}),
    ...(step.autoSelectRole !== undefined ? { autoSelectRole: step.autoSelectRole } : {}),
    ...(step.dependsOn !== undefined ? { dependsOn: step.dependsOn } : {}),
    ...(step.minDependencies !== undefined ? { minDependencies: step.minDependencies } : {}),
    ...(step.config !== undefined ? { config: step.config } : {}),
    ...(step.outputAs !== undefined ? { outputAs: step.outputAs } : {}),
    kind: step.kind ?? deriveStepKind(step.id),
    ...(step.consumesFrom !== undefined ? { consumesFrom: step.consumesFrom } : {}),
    ...(step.consumesFromOptional !== undefined ? { consumesFromOptional: step.consumesFromOptional } : {}),
    ...(step.persona !== undefined ? { persona: step.persona } : {}),
    ...(step.outputContract !== undefined ? { outputContract: step.outputContract } : {}),
    ...(step.recordEditorScores !== undefined ? { recordEditorScores: step.recordEditorScores } : {}),
    ...(step.candidateId !== undefined ? { candidateId: step.candidateId } : {}),
    ...(step.briefPerturbation !== undefined ? { briefPerturbation: step.briefPerturbation } : {}),
    ...(step.settlementLedgerOwner !== undefined ? { settlementLedgerOwner: step.settlementLedgerOwner } : {}),
    ...(step.publishesClaimsTo !== undefined ? { publishesClaimsTo: step.publishesClaimsTo } : {}),
    ...(step.settlesPredictionsFor !== undefined ? { settlesPredictionsFor: step.settlesPredictionsFor } : {}),
    ...(step.openLedgerOwner !== undefined ? { openLedgerOwner: step.openLedgerOwner } : {}),
    ...(step.openLedgerLookbackDays !== undefined ? { openLedgerLookbackDays: step.openLedgerLookbackDays } : {}),
    ...(step.assertions !== undefined ? { assertions: step.assertions } : {}),
  };
}

function fullTemplateDetail(template: NonNullable<ReturnType<typeof getTaskTemplate>>) {
  return {
    id: template.id,
    name: template.name,
    description: template.description,
    enabled: template.enabled,
    trigger: template.trigger,
    deliverTo: template.deliverTo,
    reportTo: template.reportTo,
    config: template.config,
    steps: template.steps.map((step) => ({
      id: step.id,
      prompt: step.prompt,
      roleId: step.roleId,
      requirements: step.requirements,
      autoSelectRole: step.autoSelectRole,
      dependsOn: step.dependsOn,
      outputAs: step.outputAs,
      config: step.config,
      consumesFrom: step.consumesFrom,
      consumesFromOptional: step.consumesFromOptional,
      persona: step.persona,
      outputContract: step.outputContract,
      settlementLedgerOwner: step.settlementLedgerOwner,
      publishesClaimsTo: step.publishesClaimsTo,
      settlesPredictionsFor: step.settlesPredictionsFor,
      openLedgerOwner: step.openLedgerOwner,
      openLedgerLookbackDays: step.openLedgerLookbackDays,
    })),
  };
}

function recordAdamToolRuntimeEffect(args: {
  toolName: string;
  effectType: string;
  effectCategory: string;
  entityType: string;
  entityId?: string;
  fieldPath?: string;
  before?: unknown;
  after?: unknown;
}): void {
  try {
    recordRuntimeEffect({
      toolName: args.toolName,
      effectType: args.effectType,
      effectCategory: args.effectCategory,
      entityType: args.entityType,
      entityId: args.entityId,
      fieldPath: args.fieldPath,
      before: args.before,
      after: args.after,
    });
  } catch (err) {
    log.warn({ err, toolName: args.toolName, effectCategory: args.effectCategory }, "failed to record Adam tool runtime effect");
  }
}

function collectTemplateUpdateFieldPaths(args: Record<string, unknown>, before: TaskTemplate): string[] {
  const paths: string[] = [];
  for (const key of ["name", "enabled"]) {
    if (args[key] !== undefined) paths.push(key);
  }
  if (args.steps !== undefined) paths.push("steps");
  if (args.triggerCron !== undefined || args.triggerEvent !== undefined || args.triggerType !== undefined || args.eventDefId !== undefined) {
    paths.push("trigger");
  }

  const stepId = typeof args.stepId === "string"
    ? args.stepId
    : before.steps.length === 1 ? before.steps[0].id : undefined;
  const stepFields = [
    "prompt",
    "roleId",
    "autoSelectRole",
    "requirements",
    "outputAs",
    "consumesFrom",
    "consumesFromOptional",
    "persona",
    "outputContract",
    "settlementLedgerOwner",
    "publishesClaimsTo",
    "settlesPredictionsFor",
    "openLedgerOwner",
    "openLedgerLookbackDays",
  ];
  for (const key of stepFields) {
    if (args[key] !== undefined && stepId) paths.push(`steps.${stepId}.${key}`);
  }
  if (args.config !== undefined) {
    if ((stepId && stepFields.some((key) => args[key] !== undefined)) || args.stepId !== undefined) {
      const config = args.config as Record<string, unknown>;
      const keys = Object.keys(config);
      paths.push(...(keys.length > 0 ? keys.map((key) => `steps.${stepId}.config.${key}`) : [`steps.${stepId}.config`]));
    } else {
      const config = args.config as Record<string, unknown>;
      const keys = Object.keys(config);
      paths.push(...(keys.length > 0 ? keys.map((key) => `config.${key}`) : ["config"]));
    }
  }

  return [...new Set(paths.length > 0 ? paths : ["template"])];
}

/**
 * Walk a dot-separated path on an object and return the value.
 * Step-level paths like "steps.<id>.prompt" look up the step by id first.
 * Returns undefined if the path cannot be resolved.
 *
 * Re-exported from src/store/template-field-paths.ts (Phase 0.5 refactor)
 * for backward compatibility with any callers that imported from here.
 */
import { pickFieldByPath } from "../store/template-field-paths.js";

function buildTemplateTriggerFromArgs(args: {
  triggerType?: "manual" | "cron" | "template_complete" | "event";
  triggerCron?: string;
  triggerEvent?: string;
  eventDefId?: string;
}) {
  const type = args.triggerType
    ?? (args.eventDefId ? "event" : args.triggerEvent ? "template_complete" : args.triggerCron ? "cron" : "manual");

  if (type === "event" && !args.eventDefId) {
    return { error: "eventDefId required when triggerType='event'" };
  }
  if (type !== "event" && args.eventDefId) {
    return { error: "eventDefId only valid when triggerType='event'" };
  }
  if (type === "cron" && !args.triggerCron) {
    return { error: "triggerCron required when triggerType='cron'" };
  }
  if (type === "template_complete") {
    if (!args.triggerEvent) {
      return { error: "triggerEvent required when triggerType='template_complete'" };
    }
    if (!/^template_complete:[\w-]+$/.test(args.triggerEvent)) {
      return { error: "triggerEvent must use 'template_complete:<templateId>'" };
    }
  }
  if (type === "manual" && (args.triggerCron || args.triggerEvent || args.eventDefId)) {
    return { error: "manual templates cannot include triggerCron, triggerEvent, or eventDefId" };
  }

  return {
    trigger: {
      type,
      ...(type === "cron" ? { cron: args.triggerCron } : {}),
      ...(type === "template_complete" ? { event: args.triggerEvent } : {}),
      ...(type === "event" ? { eventDefId: args.eventDefId } : {}),
    } as import("../shared/types.js").TaskTemplate["trigger"],
  };
}

// ===== Tool Definitions =====

export interface AdamToolsRuntimeContext {
  getActiveChatOrigin?: () => { chatSessionId: string; source: ChatSource } | undefined;
  onTaskDispatched?: (dispatch: CapturedDispatch) => void;
  hideLegacyDispatchTask?: boolean;
  /**
   * Returns the traceId of the currently in-flight ChatManager turn (from LiveSession
   * via the shared turnTraceHolder). When present, every tool handler is wrapped in
   * `withTrace(turnTraceId)` so that `getCurrentTraceId()` inside handlers (e.g. inside
   * `writeMutationReceipt`) returns the per-turn trace rather than the frozen ALS context
   * captured at LiveSession construction time. Absent for ExecutionManager tool instances.
   */
  getTurnTraceId?: () => string | undefined;
}

// Module-level alias so the traced wrapper inside buildTools can reference the SDK tool
// without hitting a TDZ when it shadows the name with `const tool = tracedTool`.
const _sdkTool = tool;

export function buildTools(runtimeContext: AdamToolsRuntimeContext = {}) {
  // Per-session traced tool wrapper (Task 1-impl):
  // When getTurnTraceId is provided (ChatManager sessions), every tool handler runs inside
  // withTrace(turnTraceId) so that writeMutationReceipt / captureDispatch / getCurrentTraceId()
  // see the in-flight turn's trace, not the frozen ALS context from LiveSession construction.
  // When getTurnTraceId is absent (ExecutionManager), falls through to the raw SDK tool —
  // byte-identical to prior behavior (regression shield).
  // Build a traced wrapper that re-establishes the per-turn ALS context before each handler.
  // Cast to `typeof _sdkTool` so the Zod-inferred handler arg types are preserved for all callers.
  const tool = ((
    name: string,
    description: string,
    shape: Parameters<typeof _sdkTool>[2],
    handler: Parameters<typeof _sdkTool>[3],
  ) => {
    const wrappedHandler: typeof handler = async (args, extra) => {
      const turnTraceId = runtimeContext.getTurnTraceId?.();
      if (turnTraceId) {
        return withTrace(turnTraceId, "chat", () => (handler as (a: typeof args, e: typeof extra) => ReturnType<typeof handler>)(args, extra));
      }
      return (handler as (a: typeof args, e: typeof extra) => ReturnType<typeof handler>)(args, extra);
    };
    return _sdkTool(name, description, shape, wrappedHandler);
  }) as typeof _sdkTool;
  // `tool` now shadows the module-level import within buildTools so all tool() calls below use the wrapper.
  const captureDispatch = (args: {
    taskId: string;
    toolName: CapturedDispatch["toolName"];
    reportTo?: NotifyTarget[];
    deliverTo?: NotifyTarget[];
  }) => {
    runtimeContext.onTaskDispatched?.({
      taskId: args.taskId,
      toolName: args.toolName,
      origin: runtimeContext.getActiveChatOrigin?.(),
      reportTo: args.reportTo,
      deliverTo: args.deliverTo,
      traceId: getCurrentTraceId(),
    });
  };

  const getOriginReportTo = (): NotifyTarget[] | undefined => {
    const origin = runtimeContext.getActiveChatOrigin?.();
    if (!origin) return undefined;
    if (origin.source.type === "channel" && origin.source.channelId && origin.source.chatId) {
      return [{ type: "channel", channelId: origin.source.channelId, chatId: origin.source.chatId }];
    }
    return [{ type: "session", sessionId: origin.chatSessionId }];
  };

  // Shared delivery target resolver used by dispatch tools
  const resolveDispatchTargets = async (args: { deliverTo?: unknown; reportTo?: unknown }) => {
    return {
      resolvedDeliverTo: args.deliverTo
        ? await resolveDeliveryTargets(args.deliverTo as Array<{ type: string; sessionId?: string; channelName?: string; channelId?: string; chatId?: string }>)
        : undefined,
      resolvedReportTo: args.reportTo
        ? await resolveDeliveryTargets(args.reportTo as Array<{ type: string; sessionId?: string; channelName?: string; channelId?: string; chatId?: string }>)
        : undefined,
    };
  };

  return [
  tool("read_goal_state", "Read a single goal's detailed state: progress percentage, time remaining, budget spent, and current value. Use this for deep-dive on one goal; use list_goals for an overview of all goals.", readGoalStateShape, async (args) => {
    const goal = getGoal(args.goalId);
    if (!goal) return toCallToolResult({ error: "Goal not found" });

    const now = Date.now();
    const progress = goal.targetValue > 0 ? goal.currentValue / goal.targetValue : 0;

    return toCallToolResult({
      id: goal.id,
      name: goal.name,
      description: goal.description,
      roleId: goal.roleId,
      metricType: goal.metricType,
      targetValue: goal.targetValue,
      currentValue: goal.currentValue,
      deadline: goal.deadline,
      budgetUsd: goal.budgetUsd,
      status: goal.status,
      progress,
      timeRemainingMs: Math.max(0, goal.deadline - now),
      budgetRemainingUsd: goal.budgetUsd,
    });
  }),

  tool("update_goal_state", "Update a goal's status, current value, or budget.", updateGoalStateShape, async (args) => {
    const beforeGoal = getGoal(args.goalId);
    const updates: Partial<Goal> = {};
    if (args.status) updates.status = args.status as GoalStatus;
    if (args.currentValue !== undefined) updates.currentValue = args.currentValue;
    if (args.budgetUsd !== undefined) updates.budgetUsd = args.budgetUsd;

    if (Object.keys(updates).length > 0) {
      updates.updatedAt = Date.now();
      updateGoal(args.goalId, updates);
      const updatedGoal = getGoal(args.goalId);
      if (updatedGoal) {
        for (const fieldPath of Object.keys(updates).filter((key) => key !== "updatedAt")) {
          recordAdamToolRuntimeEffect({
            toolName: "update_goal_state",
            effectType: "update",
            effectCategory: "goal_update",
            entityType: "goal",
            entityId: args.goalId,
            fieldPath,
            after: (updatedGoal as unknown as Record<string, unknown>)[fieldPath],
          });
        }
        // Phase 4: write entity_mutation receipt
        const fieldChanges = Object.keys(updates).filter((k) => k !== "updatedAt").map((k) => ({
          path: k,
          op: "set" as const,
          before: (beforeGoal as unknown as Record<string, unknown>)?.[k],
          after: (updates as Record<string, unknown>)?.[k],
        })).filter((fc) => fc.before !== undefined || fc.after !== undefined);
        writeMutationReceipt({
          toolName: "update_goal_state",
          entityType: "goal",
          verb: "update",
          entityId: args.goalId,
          fieldChanges,
        });
      }
    }
    return toCallToolResult({ success: true });
  }),

  tool("decompose_goal", "Decompose a goal into actionable subtasks using LLM reasoning.", decomposeGoalShape, async (args) => {
    const config = getRuntimeConfig();
    const maxSubtasks = Math.min(args.maxSubtasks ?? 5, 10);

    try {
      const { query } = await import("@anthropic-ai/claude-agent-sdk");
      // D-012: LLM generates requirements for each subtask
      const prompt = `Decompose this goal into ${maxSubtasks} actionable subtasks.

Goal: ${args.goalDescription}

Respond ONLY with a JSON array. Each item:
{
  "description": "...",
  "prompt": "detailed task instruction",
  "complexity": "low|medium|high",
  "role": "engineer|analyst|content_creator|reviewer",
  "requirements": {
    "tools": ["Read", "Write"],
    "paths": [{"path": "/abs/path", "access": "ro"}],
    "osCapabilities": [{"id": "automation", "targets": ["bundle.id"]}],
    "network": false
  }
}

Rules:
- Each subtask must be independently executable
- Order from foundational to dependent
- Be specific about what each subtask should accomplish
- For each subtask, specify the best role from: 'engineer', 'analyst', 'content_creator', 'reviewer'. Match role to the nature of the work.
- Include tools and paths required for the subtask where known. If unknown, omit the field.`;

      const q = query({
        prompt,
        options: {
          cwd: process.cwd(),
          maxTurns: 1,
          maxBudgetUsd: 0.02,
          persistSession: false,
        },
      });

      let resultText = "";
      for await (const event of q) {
        const ev = event as Record<string, unknown>;
        if (ev["type"] === "result" && typeof ev["result"] === "string") {
          resultText = ev["result"] as string;
        }
      }

      const jsonMatch = resultText.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as Array<{
          description: string;
          prompt: string;
          complexity: string;
          role?: string;
          requirements?: { tools?: string[]; paths?: Array<{ path: string; access: string }>; osCapabilities?: Array<{ id: string; targets?: string[] }>; network?: boolean };
        }>;
        const tasks: Array<{ id: string; description: string; prompt: string; dependencies: string[]; estimatedComplexity: string; role?: string; admissionError?: string }> = [];

        for (let i = 0; i < Math.min(parsed.length, maxSubtasks); i++) {
          const item = parsed[i];
          const subtaskRole = item.role;
          const roleId = subtaskRole ? await resolveRoleIdByRoleHint(subtaskRole) : undefined;

          // D-012: Route subtask through admission
          const dispatchResult = await createTaskWithAdmission({
            prompt: item.prompt,
            roleId,
            requirements: item.requirements as TaskRequirements | undefined,
            config: config.defaults,
            dispatchSource: "decompose_goal_subtask",
          });

          if (!dispatchResult.ok) {
            // D-004: Record admission failure in the subtask result
            tasks.push({
              id: `admission-failed-${i}`,
              description: item.description,
              prompt: item.prompt,
              dependencies: i > 0 && tasks.length > 0 ? [tasks[i - 1].id] : [],
              estimatedComplexity: item.complexity ?? "medium",
              role: subtaskRole,
              admissionError: `${dispatchResult.code}: ${dispatchResult.reason}`,
            });
            continue;
          }

          tasks.push({
            id: dispatchResult.taskId,
            description: item.description,
            prompt: item.prompt,
            dependencies: i > 0 ? [tasks[i - 1].id] : [],
            estimatedComplexity: item.complexity ?? "medium",
            role: subtaskRole,
          });
        }

        if (tasks.length > 0) return toCallToolResult({ subtasks: tasks });
      }
    } catch (err) {
      log.error({ error: err }, "LLM decomposition failed, using fallback");
    }

    // Fallback: mechanical decomposition — D-002/D-012: route through admitTask.
    // This calls admitTask({ roleId: undefined, autoSelectRole: false }) which
    // returns REQUIREMENTS_MISSING, so no task is created silently.
    const fallbackAdmission = await admitTask({
      taskId: uuidv4(),
      roleId: undefined,
      autoSelectRole: false,
    });

    const tasks: Array<{ id: string; description: string; prompt: string; dependencies: string[]; estimatedComplexity: string; admissionError?: string }> = [];
    if (!fallbackAdmission.ok) {
      // Record admission failure in the subtask result so caller sees why nothing was created
      tasks.push({
        id: "admission-blocked",
        description: `Decomposition fallback blocked: ${fallbackAdmission.reason}`,
        prompt: args.goalDescription,
        dependencies: [],
        estimatedComplexity: "medium",
        admissionError: `${fallbackAdmission.code}: ${fallbackAdmission.reason}`,
      });
    }
    return toCallToolResult({ subtasks: tasks });
  }),

  tool("dispatch_to_role", "Dispatch a task to a specific Role. Use when you have selected a candidate from list_roles(requirements). taskInstruction describes the work only — do NOT include Role identity/persona such as '你是 X' or 'You are X'; the selected Role's CAG prompt supplies identity.", dispatchToRoleShape, async (args) => {
    const instructionCheck = validateTaskInstructionContract(args.taskInstruction);
    if (!instructionCheck.ok) {
      return toCallToolResult({ error: instructionCheck.error, code: instructionCheck.code });
    }
    if (!hasNonEmptyRequirements(args.requirements)) {
      return toCallToolResult({ error: "requirements must not be empty. Include at least one of: tools, paths, osCapabilities, plugins, or network.", code: REQUIREMENTS_EMPTY });
    }

    const { resolvedDeliverTo, resolvedReportTo } = await resolveDispatchTargets(args);

    const taskConfig: { toolOverrides?: { allowedTools?: string[]; disallowedTools?: string[] }; effortTier?: "low" | "medium" | "high" } = {};
    if (args.toolOverrides) taskConfig.toolOverrides = args.toolOverrides;
    if (args.effortTier !== undefined) taskConfig.effortTier = args.effortTier;

    const result = await createTaskWithAdmission({
      prompt: args.taskInstruction,
      roleId: args.roleId,
      requirements: args.requirements,
      autoSelectRole: false,
      deliverTo: resolvedDeliverTo,
      reportTo: resolvedReportTo,
      config: taskConfig,
      sourceSessionId: runtimeContext.getActiveChatOrigin?.()?.chatSessionId,
      dispatchSource: "dispatch_to_role",
    });

    if (!result.ok) {
      const candidateList = (result.candidates ?? []).map((c: { roleId: string; name: string; fitScore: number; missing?: { tools?: string[]; paths?: Array<{ path: string; access: string }>; osCapabilities?: Array<{ id: string }>; plugins?: string[] } }) => ({
        id: c.roleId,
        name: c.name,
        fitScore: c.fitScore,
        missing: c.missing,
      }));
      const available = candidateList.length > 0
        ? candidateList
        : listRoles("active", 20, 0)
            .filter(r => r.source !== "system")
            .map(r => ({ id: r.id, name: r.name, allowedTools: r.allowedTools ?? [], capabilitySummary: generateCapabilitySummary(r) }));
      // Task 7: actionable guidance
      const guidance = ADMISSION_GUIDANCE[result.code ?? ""] ?? null;
      let alternativeRole: string | undefined;
      if (result.code === "ROLE_TOOL_MISMATCH" && result.missing?.tools) {
        alternativeRole = findAlternativeRoleWithTools(result.missing.tools, args.roleId);
      }
      return toCallToolResult({
        error: result.reason,
        code: result.code,
        missing: result.missing,
        availableRoles: available,
        guidance,
        alternativeRole,
      });
    }

    if (getTask(result.taskId)) {
      captureDispatch({
        taskId: result.taskId,
        toolName: "dispatch_to_role",
        reportTo: resolvedReportTo,
        deliverTo: resolvedDeliverTo,
      });
      recordAdamToolRuntimeEffect({
        toolName: "dispatch_to_role",
        effectType: "create",
        effectCategory: "task_scheduled",
        entityType: "task",
        entityId: result.taskId,
      });
    }

    return toCallToolResult({
      taskId: result.taskId,
      roleId: result.roleId,
      fitScore: result.fitScore,
      strategyId: result.strategyId,
      warnings: result.warnings,
    });
  }),

  tool("dispatch_by_requirements", "Dispatch a task with automatic Role selection. Use when requirements are clear and you don't need a specific Role. taskInstruction describes the work only — do NOT include Role identity/persona.", dispatchByRequirementsShape, async (args) => {
    const instructionCheck = validateTaskInstructionContract(args.taskInstruction);
    if (!instructionCheck.ok) {
      return toCallToolResult({ error: instructionCheck.error, code: instructionCheck.code });
    }
    if (!hasNonEmptyRequirements(args.requirements)) {
      return toCallToolResult({ error: "requirements must not be empty. Include at least one of: tools, paths, osCapabilities, plugins, or network.", code: REQUIREMENTS_EMPTY });
    }

    const { resolvedDeliverTo, resolvedReportTo } = await resolveDispatchTargets(args);

    const taskConfig: { toolOverrides?: { allowedTools?: string[]; disallowedTools?: string[] }; effortTier?: "low" | "medium" | "high" } = {};
    if (args.toolOverrides) taskConfig.toolOverrides = args.toolOverrides;
    if (args.effortTier !== undefined) taskConfig.effortTier = args.effortTier;

    const result = await createTaskWithAdmission({
      prompt: args.taskInstruction,
      requirements: args.requirements,
      autoSelectRole: true,
      deliverTo: resolvedDeliverTo,
      reportTo: resolvedReportTo,
      config: taskConfig,
      sourceSessionId: runtimeContext.getActiveChatOrigin?.()?.chatSessionId,
      dispatchSource: "dispatch_by_requirements",
    });

    if (!result.ok) {
      const candidateList = (result.candidates ?? []).map((c: { roleId: string; name: string; fitScore: number; missing?: { tools?: string[]; paths?: Array<{ path: string; access: string }>; osCapabilities?: Array<{ id: string }>; plugins?: string[] } }) => ({
        id: c.roleId,
        name: c.name,
        fitScore: c.fitScore,
        missing: c.missing,
      }));
      const available = candidateList.length > 0
        ? candidateList
        : listRoles("active", 20, 0)
            .filter(r => r.source !== "system")
            .map(r => ({ id: r.id, name: r.name, allowedTools: r.allowedTools ?? [], capabilitySummary: generateCapabilitySummary(r) }));
      // Task 7: actionable guidance (dispatch_by_requirements — no roleId arg)
      const guidance = ADMISSION_GUIDANCE[result.code ?? ""] ?? null;
      return toCallToolResult({
        error: result.reason,
        code: result.code,
        missing: result.missing,
        availableRoles: available,
        guidance,
      });
    }

    if (getTask(result.taskId)) {
      captureDispatch({
        taskId: result.taskId,
        toolName: "dispatch_by_requirements",
        reportTo: resolvedReportTo,
        deliverTo: resolvedDeliverTo,
      });
      recordAdamToolRuntimeEffect({
        toolName: "dispatch_by_requirements",
        effectType: "create",
        effectCategory: "task_scheduled",
        entityType: "task",
        entityId: result.taskId,
      });
    }

    return toCallToolResult({
      taskId: result.taskId,
      roleId: result.roleId,
      fitScore: result.fitScore,
      strategyId: result.strategyId,
      warnings: result.warnings,
      // Task 7: recommended action
      recommendedAction: buildRecommendedAction(result.roleId ?? ""),
    });
  }),

  tool("dispatch_task", "LEGACY compatibility tool. ChatManager conversational dispatch must use dispatch_to_role or dispatch_by_requirements; keep this for older callers that still send {prompt, roleId}.", dispatchTaskShape, async (args) => {
    // Short-circuit REQUIREMENTS_MISSING with available roles list
    if (!args.roleId && !args.autoSelectRole) {
      const available = listRoles("active", 20, 0)
        .filter(r => r.source !== "system")
        .map(r => ({ id: r.id, name: r.name, allowedTools: r.allowedTools ?? [], capabilitySummary: generateCapabilitySummary(r) }));
      return toCallToolResult({
        error: "Must provide roleId or autoSelectRole=true with requirements.",
        availableRoles: available,
      });
    }

    // Resolve deliverTo and reportTo: convert channelName → channelId + chatId
    const resolvedDeliverTo = args.deliverTo
      ? await resolveDeliveryTargets(args.deliverTo as Array<{ type: string; sessionId?: string; channelName?: string; channelId?: string; chatId?: string }>)
      : undefined;
    const resolvedReportTo = args.reportTo
      ? await resolveDeliveryTargets(args.reportTo as Array<{ type: string; sessionId?: string; channelName?: string; channelId?: string; chatId?: string }>)
      : undefined;

    const result = await createTaskWithAdmission({
      prompt: args.prompt,
      roleId: args.roleId,
      requirements: args.requirements,
      autoSelectRole: args.autoSelectRole,
      deliverTo: resolvedDeliverTo,
      reportTo: resolvedReportTo,
      config: { toolOverrides: args.toolOverrides, ...(args.effortTier !== undefined ? { effortTier: args.effortTier } : {}) },
      sourceSessionId: runtimeContext.getActiveChatOrigin?.()?.chatSessionId,
      dispatchSource: "dispatch_task",
    });

    if (!result.ok) {
      const candidateList = (result.candidates ?? []).map((c: { roleId: string; name: string; fitScore: number; missing?: { tools?: string[]; paths?: Array<{ path: string; access: string }>; osCapabilities?: Array<{ id: string }>; plugins?: string[] } }) => ({
        id: c.roleId,
        name: c.name,
        fitScore: c.fitScore,
        missing: c.missing,
      }));
      // If admission didn't attach candidates (e.g., ROLE_NOT_FOUND with no requirements,
      // or REQUIREMENTS_MISSING), show the active non-system roles so the caller can pick.
      const available = candidateList.length > 0
        ? candidateList
        : listRoles("active", 20, 0)
            .filter(r => r.source !== "system")
            .map(r => ({ id: r.id, name: r.name, allowedTools: r.allowedTools ?? [], capabilitySummary: generateCapabilitySummary(r) }));
      return toCallToolResult({
        error: result.reason,
        code: result.code,
        missing: result.missing,
        availableRoles: available,
      });
    }

    if (getTask(result.taskId)) {
      captureDispatch({
        taskId: result.taskId,
        toolName: "dispatch_task",
        reportTo: resolvedReportTo,
        deliverTo: resolvedDeliverTo,
      });
      recordAdamToolRuntimeEffect({
        toolName: "dispatch_task",
        effectType: "create",
        effectCategory: "task_scheduled",
        entityType: "task",
        entityId: result.taskId,
      });
    }

    return toCallToolResult({
      taskId: result.taskId,
      roleId: result.roleId,
      fitScore: result.fitScore,
      strategyId: result.strategyId,
      warnings: result.warnings,
    });
  }),

  tool("evaluate_result", "Evaluate a completed task's result and record a trial for Thompson Sampling.", evaluateResultShape, async (args) => {
    const { goalId, taskId, strategyId } = args;

    const result = calculateReward(goalId ?? "", taskId);

    // Record trial for Thompson Sampling update
    if (strategyId && goalId) {
      StrategyEngine.recordTrial(
        strategyId,
        goalId,
        taskId,
        result.reward,
        result.breakdown.L2 || undefined,
        result.breakdown.L3 || undefined,
        `Evaluated via adam-tools`,
      );
      // Phase 4: write entity_mutation receipt for the trial record
      writeMutationReceipt({
        toolName: "evaluate_result",
        entityType: "trial",
        verb: "create",
        fieldChanges: [{ path: "_entity", op: "set", before: null, after: { strategyId, goalId, taskId, reward: result.reward } }],
      });
    }

    return toCallToolResult({
      reward: result.reward,
      metricL2Score: result.breakdown.L2 || undefined,
      metricL3Score: result.breakdown.L3 || undefined,
      source: result.source,
      reasoning: `Evaluated via ${result.source} with confidence ${result.confidence.toFixed(2)}`,
    });
  }),

  tool("create_strategy", "Create a new strategy variant for a role/taskType using LLM evolution.", createStrategyShape, async (args) => {
    const { roleId, taskType } = args;

    // Generate new variants via LLM-driven evolution
    await StrategyGenerator.generateVariants(roleId, taskType, 3, 1);

    // Get the strategies for this role/taskType
    const strategies = StrategyEngine.getStrategies(roleId, taskType);
    const newest = strategies[strategies.length - 1];

    if (!newest) {
      return toCallToolResult({ error: `Failed to create strategy for ${roleId}/${taskType}` });
    }

    // Phase 4: write entity_mutation receipt
    writeMutationReceipt({
      toolName: "create_strategy",
      entityType: "strategy",
      verb: "create",
      entityId: newest.id,
      fieldChanges: [{ path: "_entity", op: "set", before: null, after: { id: newest.id, name: newest.name, roleId, taskType } }],
    });

    return toCallToolResult({
      id: newest.id,
      name: newest.name,
      promptTemplate: newest.promptTemplate,
    });
  }),

  tool("list_goals", "List all goals with progress percentage, budget, deadline, and time remaining. Goal statuses: active (in progress), paused, completed, failed. Use this to check current goal status before making decisions.", listPendingGoalsShape, async (args) => {
    const status = args.status as GoalStatus | undefined;
    return toCallToolResult(listGoals(status, args.limit ?? 10, 0));
  }),

  tool("delete_goal", "Delete a goal by ID.", { goalId: goalIdSchema }, async (args) => {
    const goal = getGoal(args.goalId);
    if (!goal) return toCallToolResult({ error: "Goal not found" });
    deleteGoal(args.goalId);
    if (!getGoal(args.goalId)) {
      recordAdamToolRuntimeEffect({
        toolName: "delete_goal",
        effectType: "delete",
        effectCategory: "goal_update",
        entityType: "goal",
        entityId: args.goalId,
        before: goal,
      });
      // Phase 4: write entity_mutation receipt
      writeMutationReceipt({
        toolName: "delete_goal",
        entityType: "goal",
        verb: "delete",
        entityId: args.goalId,
        fieldChanges: [{ path: "_entity", op: "set", before: goal, after: null }],
      });
    }
    return toCallToolResult({ success: true, goalId: args.goalId });
  }),

  tool("pause_goal", "Pause an active goal.", { goalId: goalIdSchema }, async (args) => {
    const goal = getGoal(args.goalId);
    if (!goal) return toCallToolResult({ error: "Goal not found" });
    updateGoal(args.goalId, { status: "paused", updatedAt: Date.now() });
    // Phase 4: write entity_mutation receipt
    writeMutationReceipt({
      toolName: "pause_goal",
      entityType: "goal",
      verb: "pause",
      entityId: args.goalId,
      fieldChanges: [{ path: "status", op: "set", before: goal.status, after: "paused" }],
    });
    return toCallToolResult({ success: true, goalId: args.goalId, status: "paused" });
  }),

  tool("assign_role", "Assign a role to a pending task.", assignRoleShape, async (args) => {
    const { taskId, roleId } = args;
    const task = getTask(taskId);
    if (!task) return toCallToolResult({ error: `Task not found: ${taskId}` });
    const role = getRole(roleId);
    if (!role) return toCallToolResult({ error: `Role not found: ${roleId}` });
    const beforeTask = getTask(taskId);
    updateTask(taskId, { roleId });
    log.debug({ taskId, roleId, roleName: role.name }, "Role assigned to task");
    // Phase 4: write entity_mutation receipt
    writeMutationReceipt({
      toolName: "assign_role",
      entityType: "task",
      verb: "update",
      entityId: taskId,
      fieldChanges: [{ path: "roleId", op: "set", before: beforeTask?.roleId, after: roleId }],
      taskId,
      roleId,
    });
    return toCallToolResult({ success: true, taskId, roleId });
  }),

  // Shared memory tools (search, save, delete) — no scope for ChatManager (cross-role access).
  // Pass the per-session traced `tool` wrapper so memory mutations (save/delete write
  // writeMutationReceipt) attribute to the in-flight turn trace, not the frozen ctor trace.
  ...createSharedMemoryTools(undefined, tool),

  tool("read_task_status", "Read a single task's details (prompt, status, result, roleId) by ID, or list all tasks filtered by status (pending, running, completed, failed). Use this to check task progress and results.", readTaskStatusShape, async (args) => {
    if (args.taskId) {
      const task = getTask(args.taskId);
      return toCallToolResult(task ?? { error: "Task not found" });
    }
    const status = args.status as TaskStatus | undefined;
    return toCallToolResult(listTasks(status, args.limit ?? 100, 0));
  }),

  tool("modify_role_permissions", "Update a role's RBAC permissions (paths, tools, OS capabilities).", modifyRolePermissionsShape, async (args) => {
    const role = getRole(args.roleId);
    if (!role) return toCallToolResult({ error: `Role not found: ${args.roleId}` });

    // Capture before state for receipt
    const beforeRole = { allowedTools: role.allowedTools, disallowedTools: role.disallowedTools, osCapabilities: role.osCapabilities, additionalDirectories: role.additionalDirectories, allowedChannels: role.allowedChannels, inheritUserSettings: role.inheritUserSettings };

    // Tools: write to dedicated DB columns (read by ExecutionManager + workspace sync)
    const roleUpdates: Partial<import("../shared/types.js").Role> = {};
    if (args.allowedTools) roleUpdates.allowedTools = args.allowedTools;
    if (args.disallowedTools) roleUpdates.disallowedTools = args.disallowedTools;
    if (args.osCapabilities !== undefined) {
      try {
        roleUpdates.osCapabilities = validateRoleOsCapabilitiesForStorage(args.osCapabilities);
      } catch (error) {
        return toCallToolResult({ error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (args.additionalDirectories !== undefined) roleUpdates.additionalDirectories = args.additionalDirectories;
    if (args.allowedChannels !== undefined) roleUpdates.allowedChannels = args.allowedChannels;
    if ("inheritUserSettings" in args) roleUpdates.inheritUserSettings = args.inheritUserSettings;

    updateRole(args.roleId, roleUpdates);
    // Phase 4: write entity_mutation receipt
    writeMutationReceipt({
      toolName: "modify_role_permissions",
      entityType: "role",
      verb: "update",
      entityId: args.roleId,
      fieldChanges: [
        ...(args.allowedTools ? [{ path: "allowedTools", op: "set" as const, before: beforeRole.allowedTools, after: args.allowedTools }] : []),
        ...(args.disallowedTools ? [{ path: "disallowedTools", op: "set" as const, before: beforeRole.disallowedTools, after: args.disallowedTools }] : []),
        ...(args.osCapabilities !== undefined ? [{ path: "osCapabilities", op: "set" as const, before: beforeRole.osCapabilities, after: roleUpdates.osCapabilities }] : []),
        ...(args.additionalDirectories !== undefined ? [{ path: "additionalDirectories", op: "set" as const, before: beforeRole.additionalDirectories, after: args.additionalDirectories }] : []),
        ...(args.allowedChannels !== undefined ? [{ path: "allowedChannels", op: "set" as const, before: beforeRole.allowedChannels, after: args.allowedChannels }] : []),
        ...("inheritUserSettings" in args ? [{ path: "inheritUserSettings", op: "set" as const, before: beforeRole.inheritUserSettings, after: args.inheritUserSettings }] : []),
      ].filter((fc) => fc.before !== fc.after),
      roleId: args.roleId,
    });
    return toCallToolResult({ success: true });
  }),

  tool(
    "update_role",
    "Update a role's identity and config fields (name, CAG prompt, learned rules, status, effortTier, execution mode, preferences, permission mode, bash patterns, evaluation criteria, env vars). A Role's model is chosen via effortTier (low/medium/high → the models configured in Settings), not a hardcoded per-Role model string. For permission fields (allowedTools, disallowedTools, osCapabilities, additionalDirectories, allowedChannels, inheritUserSettings) use modify_role_permissions instead.",
    updateRoleShape,
    async (args) => {
      const existing = getRole(args.roleId);
      if (!existing) {
        return toCallToolResult({ error: `Role not found: ${args.roleId}` });
      }

      const { roleId, learnedRules: rawLearnedRules, ...restFields } = args;
      // Coerce legacy string[] learnedRules to structured LearnedRules (auto-migrate)
      // Structured objects: fill missing slots from existing to avoid overwriting with defaults
      const coercedLearnedRules = rawLearnedRules !== undefined && Array.isArray(rawLearnedRules)
        ? {
            stylePreferences: rawLearnedRules.filter((s: unknown) => typeof s === "string"),
            avoidedActions: [],
            pinnedParameters: [],
          }
        : rawLearnedRules !== undefined && typeof rawLearnedRules === "object"
        ? {
            stylePreferences: (rawLearnedRules as Partial<LearnedRules>).stylePreferences ?? existing.learnedRules.stylePreferences,
            avoidedActions: (rawLearnedRules as Partial<LearnedRules>).avoidedActions ?? existing.learnedRules.avoidedActions,
            pinnedParameters: (rawLearnedRules as Partial<LearnedRules>).pinnedParameters ?? existing.learnedRules.pinnedParameters,
          }
        : undefined;
      // effortTier is nullable in the tool schema ("pass null to clear"), but Partial<Role>
      // types it as EffortTier | undefined. Pull it out of the spread and apply it only when
      // provided: null → undefined here, which updateRole persists as NULL (`?? null`) = clear.
      const { effortTier, ...otherFields } = restFields;
      const patch: Partial<Role> = { ...otherFields, updatedAt: Date.now() };
      if (effortTier !== undefined) patch.effortTier = effortTier ?? undefined;
      if (coercedLearnedRules !== undefined) patch.learnedRules = coercedLearnedRules;
      updateRole(roleId, patch);

      const updated = getRole(roleId);
      if (!updated) {
        return toCallToolResult({ error: "Role disappeared after update" });
      }

      // Mirror PATCH /roles/:id side effect: rewrite workspace CLAUDE.md when
      // cagPrompt or learnedRules change and the workspace already exists.
      // Note: if `name` also changed in this call, getRoleWorkspacePath(updated.name)
      // points at a not-yet-created path and existsSync() returns false — the
      // CLAUDE.md rewrite is silently skipped. This matches the REST route's
      // behavior at src/server/routes/roles.ts:378-382.
      if (args.cagPrompt !== undefined || args.learnedRules !== undefined) {
        const wsPath = getRoleWorkspacePath(updated.name);
        if (existsSync(wsPath)) {
          writeRoleCLAUDEmd(wsPath, updated);
        }
      }

      // Phase 4: write entity_mutation receipt
      const fieldChanges: Array<{ path: string; op: "set"; before: unknown; after: unknown }> = [];
      if (args.name !== undefined) fieldChanges.push({ path: "name", op: "set", before: existing.name, after: args.name });
      if (args.cagPrompt !== undefined) fieldChanges.push({ path: "cagPrompt", op: "set", before: existing.cagPrompt, after: args.cagPrompt });
      if (args.learnedRules !== undefined) fieldChanges.push({ path: "learnedRules", op: "set", before: existing.learnedRules, after: updated.learnedRules });
      if (args.status !== undefined) fieldChanges.push({ path: "status", op: "set", before: existing.status, after: args.status });
      if (args.effortTier !== undefined) fieldChanges.push({ path: "effortTier", op: "set", before: existing.effortTier, after: args.effortTier });
      if (args.executionMode !== undefined) fieldChanges.push({ path: "executionMode", op: "set", before: existing.executionMode, after: args.executionMode });
      if (args.preferences !== undefined) fieldChanges.push({ path: "preferences", op: "set", before: existing.preferences, after: args.preferences });
      if (args.permissionMode !== undefined) fieldChanges.push({ path: "permissionMode", op: "set", before: existing.permissionMode, after: args.permissionMode });
      if (args.allowedBashPatterns !== undefined) fieldChanges.push({ path: "allowedBashPatterns", op: "set", before: existing.allowedBashPatterns, after: args.allowedBashPatterns });
      if (args.deniedBashPatterns !== undefined) fieldChanges.push({ path: "deniedBashPatterns", op: "set", before: existing.deniedBashPatterns, after: args.deniedBashPatterns });
      if (args.evaluationCriteria !== undefined) fieldChanges.push({ path: "evaluationCriteria", op: "set", before: existing.evaluationCriteria, after: args.evaluationCriteria });
      if (args.envVars !== undefined) fieldChanges.push({ path: "envVars", op: "set", before: existing.envVars, after: args.envVars });
      if (args.maxBudgetUsd !== undefined) fieldChanges.push({ path: "maxBudgetUsd", op: "set", before: existing.maxBudgetUsd, after: args.maxBudgetUsd });
      if (args.approvalRequired !== undefined) fieldChanges.push({ path: "approvalRequired", op: "set", before: existing.approvalRequired, after: args.approvalRequired });
      if (fieldChanges.length > 0) {
        writeMutationReceipt({
          toolName: "update_role",
          entityType: "role",
          verb: "update",
          entityId: args.roleId,
          fieldChanges,
          roleId: args.roleId,
        });
      }

      return toCallToolResult({ success: true, role: updated });
    },
  ),

  tool("view_audit_log", "View the evolution audit log for role changes.", viewAuditLogShape, async (args) => {
    const { listEvolutionAudit } = await import("../store/evolution-audit.js");
    const entries = listEvolutionAudit(args.limit ?? 50);
    return toCallToolResult({ entries });
  }),

  // === Phase 3: Role Pinned Parameters ===

  tool(
    "pin_role_parameter",
    "Pin a default tool parameter for a Role. When the Role calls a matching tool without specifying a key, the pinned value is auto-injected. LLM-explicit values always win. Use this when the user asks the Role to remember a tool parameter (voice ID, model name, voice file, etc.).",
    {
      roleId: roleIdSchema.describe("Role to pin a parameter for."),
      tool: z.string().min(1).describe("Tool glob to match (e.g., 'Bash:generate_voice.sh', 'mcp__server__*'). Glob '*' matches any characters; reuses Adam's standard glob (allowedBashPatterns syntax)."),
      params: z.record(z.string(), z.unknown()).describe("Parameter key-value pairs to inject as defaults. For Bash tools, use CLI flags as keys (e.g., {'-v': 'male-qn-qing-xx'}). For MCP tools, use the tool's parameter names."),
      condition: z.string().optional().describe("Optional natural-language condition for when to apply this pin (informational; not enforced)."),
    },
    async (args) => {
      const existing = getRole(args.roleId);
      if (!existing) return toCallToolResult({ error: `Role not found: ${args.roleId}` });
      const newPin: PinnedParameter = {
        tool: args.tool,
        params: args.params,
        condition: args.condition,
        pinnedAt: Date.now(),
      };
      // Replace any existing pin with same tool+params-key set; otherwise append
      const sameKeyIdx = existing.learnedRules.pinnedParameters.findIndex(
        (p) => p.tool === args.tool && JSON.stringify(Object.keys(p.params).sort()) === JSON.stringify(Object.keys(args.params).sort()),
      );
      const next = [...existing.learnedRules.pinnedParameters];
      if (sameKeyIdx >= 0) {
        next[sameKeyIdx] = newPin;
      } else {
        next.push(newPin);
      }
      const patch: Partial<Role> = {
        learnedRules: { ...existing.learnedRules, pinnedParameters: next },
        updatedAt: Date.now(),
      };
      updateRole(args.roleId, patch);
      const updated = getRole(args.roleId)!;
      const wsPath = getRoleWorkspacePath(updated.name);
      if (existsSync(wsPath)) writeRoleCLAUDEmd(wsPath, updated);
      // Phase 4: write entity_mutation receipt
      const oldPin = existing.learnedRules.pinnedParameters.find(
        (p) => p.tool === args.tool && JSON.stringify(Object.keys(p.params).sort()) === JSON.stringify(Object.keys(args.params).sort()),
      );
      writeMutationReceipt({
        toolName: "pin_role_parameter",
        entityType: "role",
        verb: "update",
        entityId: args.roleId,
        fieldChanges: [{ path: `pinnedParameters.${args.tool}`, op: "set", before: oldPin ?? null, after: newPin }],
        roleId: args.roleId,
      });
      return toCallToolResult({ success: true, pin: newPin });
    },
  ),

  tool(
    "save_role_style",
    "Save free-text style guidance to a Role's stylePreferences or avoidedActions slot. Use stylePreferences for what to do; avoidedActions for what to avoid. For tool-parameter defaults (voice IDs, model names), use pin_role_parameter instead.",
    {
      roleId: roleIdSchema.describe("Role to add style guidance for."),
      slot: z.enum(["stylePreferences", "avoidedActions"]).describe("'stylePreferences' for things to do; 'avoidedActions' for things to avoid."),
      text: z.string().min(1).describe("The style guidance in free text (e.g., 'Always greet the user in 卞旸's voice', 'Avoid hardcoded paths in scripts')."),
    },
    async (args) => {
      const existing = getRole(args.roleId);
      if (!existing) return toCallToolResult({ error: `Role not found: ${args.roleId}` });
      const slot = args.slot;
      if ((existing.learnedRules[slot] as string[]).includes(args.text)) {
        return toCallToolResult({ success: true, alreadyPresent: true });
      }
      const nextSlot = [...(existing.learnedRules[slot] as string[]), args.text];
      const next: LearnedRules = { ...existing.learnedRules, [slot]: nextSlot };
      updateRole(args.roleId, { learnedRules: next, updatedAt: Date.now() });
      const updated = getRole(args.roleId)!;
      const wsPath = getRoleWorkspacePath(updated.name);
      if (existsSync(wsPath)) writeRoleCLAUDEmd(wsPath, updated);
      // Phase 4: write entity_mutation receipt
      writeMutationReceipt({
        toolName: "save_role_style",
        entityType: "role",
        verb: "update",
        entityId: args.roleId,
        fieldChanges: [{ path: `${slot}`, op: "set", before: existing.learnedRules[slot], after: nextSlot }],
        roleId: args.roleId,
      });
      return toCallToolResult({ success: true });
    },
  ),

  tool("list_roles", "List all roles with their capabilities including bound plugins (skills/agents). Use this to discover available roles before dispatching tasks. Pass requirements to get ranked results with fitScore showing which roles best match the task.", listRolesShape, async (args) => {
    // D-009: When requirements provided, return ranked results with fitScore
    if (args.requirements) {
      const reqs = args.requirements;
      const ranked = rankRoles(reqs);
      type RankedItem = ReturnType<typeof rankRoles>[number];
      const results = ranked.slice(0, args.limit ?? 50).map((item: RankedItem) => {
        const r = item.role;
        const pluginCaps = resolveRolePluginCapabilities(r);
        const resolvedRolePlugins = pluginCaps.plugins.map((p) => p.name);
        const roleCwd = getRoleWorkspacePath(r.name);
        const scopes = resolveRoleScopes(r, roleCwd);

        // DP-004: per-dimension matched arrays
        const matchedTools: string[] | undefined = reqs.tools
          ? (r.allowedTools ?? []).filter((t: string) => reqs.tools!.includes(t))
          : undefined;
        const matchedPaths: TaskRequirements["paths"] = reqs.paths
          ? reqs.paths.filter((p) => pathCovered(p, scopes))
          : undefined;
        const roleOsCapIds = new Set((r.osCapabilities ?? []).map((c) => c.id));
        const matchedOsCapabilities: string[] | undefined = reqs.osCapabilities
          ? reqs.osCapabilities.filter((c) => roleOsCapIds.has(c.id)).map((c) => c.id)
          : undefined;
        const rolePluginNameSet = new Set(resolvedRolePlugins);
        const matchedPlugins: string[] | undefined = reqs.plugins
          ? reqs.plugins.filter((p) => rolePluginNameSet.has(p))
          : undefined;
        const matchedNetwork: boolean | undefined = reqs.network === true
          ? (r.osCapabilities ?? []).some((c) => c.id === "local-network")
          : undefined;

        const missingOsCaps = item.missing?.osCapabilities;
        const warnings = detectApprovalWarnings(r, reqs);
        const skillCtx = buildSkillContextForRole(r.id, r.name);
        return {
          id: r.id,
          name: r.name,
          status: r.status,
          allowedTools: r.allowedTools ?? [],
          disallowedTools: r.disallowedTools ?? [],
          osCapabilities: r.osCapabilities ?? [],
          additionalDirectories: r.additionalDirectories ?? [],
          cagPrompt: r.cagPrompt.slice(0, 500) + (r.cagPrompt.length > 500 ? "..." : ""),
          capabilitySummary: generateCapabilitySummary(r, pluginCaps),
          plugins: pluginCaps.plugins.map((p) => ({
            name: p.name,
            skills: p.skills.map((s) => s.name),
            agents: p.agents.map((a) => a.name),
          })),
          // Task 7: skill context and task-type performance
          matchingSkills: skillCtx.matchingSkills,
          taskTypePerformance: skillCtx.taskTypePerformance,
          // D-009 / DP-004: Ranking fields with per-dimension matched/missing + warnings
          fitScore: item.fitScore,
          fits: item.evaluation.ok,
          matchedTools,
          matchedPaths,
          matchedOsCapabilities,
          matchedPlugins,
          matchedNetwork,
          missingCapabilities: item.missing ? {
            tools: item.missing.tools,
            paths: item.missing.paths,
            osCapabilities: missingOsCaps?.map((c) => c.id),
            plugins: item.missing.plugins,
            network: item.missing.network,
          } : undefined,
          warnings,
          why: item.evaluation.ok
            ? `Role '${r.name}' satisfies all requirements (fitScore: ${item.fitScore.toFixed(2)})`
            : `Role '${r.name}' does not satisfy requirements: ${!item.evaluation.ok ? item.evaluation.reason : 'unknown'}`,
        };
      });
      return toCallToolResult({ roles: results });
    }

    // Default: list all roles without ranking
    const roles = listRoles(args.status, args.limit ?? 50, 0);
    const summary = roles.map((r) => {
      const pluginCaps = resolveRolePluginCapabilities(r);
      return {
        id: r.id,
        name: r.name,
        status: r.status,
        allowedTools: r.allowedTools ?? [],
        disallowedTools: r.disallowedTools ?? [],
        osCapabilities: r.osCapabilities ?? [],
        additionalDirectories: r.additionalDirectories ?? [],
        cagPrompt: r.cagPrompt.slice(0, 500) + (r.cagPrompt.length > 500 ? "..." : ""),
        capabilitySummary: generateCapabilitySummary(r, pluginCaps),
        plugins: pluginCaps.plugins.map((p) => ({
          name: p.name,
          skills: p.skills.map((s) => s.name),
          agents: p.agents.map((a) => a.name),
        })),
      };
    });
    return toCallToolResult({ roles: summary });
  }),

  tool("create_role", "Create a new role with a name, CAG prompt, and optional tool permissions or OS capabilities. The CAG prompt can come from an inline string (cagPrompt) or from a config-doc anchor (cagPromptRef) — use cagPromptRef for long prompts imported from another instance; the docPath must resolve inside ~/.adam/config-exports/. The full portable role field set (model, effortTier, skills, envVars, learnedRules, preferences, maxBudgetUsd, approvalRequired, permissionMode, allowedBashPatterns, deniedBashPatterns, evaluationCriteria, executionMode, source, allowedChannels, inheritUserSettings, presetId, memoryBudgetTokens, status, performanceScore) is accepted for faithful reconstruction from a config-doc — all fields are optional, omitting them preserves back-compat. The `ifExists` signal (`create` | `skip` | `error`, default `create`) handles same-name roles during import: `skip` returns {skipped:true, existingRoleId} when an ACTIVE same-name role exists (a retired same-name does NOT trigger skip); `error` rejects. `mcpServers` is intentionally NOT in this set — runtime role MCP comes from the `role_extensions` binding table, not the `mcp_servers` column (D-011).", createRoleShape, async (args) => {
    let osCapabilities: Role["osCapabilities"];
    try {
      osCapabilities = validateRoleOsCapabilitiesForStorage(args.osCapabilities);
    } catch (error) {
      return toCallToolResult({ error: error instanceof Error ? error.message : String(error) });
    }

    // Anchor-ref resolution for cagPrompt. Reject the ambiguous case (both
    // inline and ref passed) and surface any path/anchor failure as a
    // structured error before building the store object.
    let resolvedCagPrompt: string;
    if (args.cagPromptRef !== undefined) {
      if (args.cagPrompt !== undefined && args.cagPrompt !== "") {
        return toCallToolResult({
          error: "create_role: pass EITHER cagPrompt (inline string) OR cagPromptRef (anchor reference), not both — ambiguous",
        });
      }
      try {
        resolvedCagPrompt = resolveAnchorBytes(args.cagPromptRef, "cagPrompt");
      } catch (error) {
        return toCallToolResult({ error: error instanceof Error ? error.message : String(error) });
      }
    } else {
      resolvedCagPrompt = args.cagPrompt;
    }

    // ifExists short-circuit — runs BEFORE the DB write so a same-name hit
    // never reaches the UNIQUE constraint. ACTIVE-only: a retired same-name
    // does not trigger skip / error (so re-importing after a fresh role is
    // possible without the user having to manually retire the old one).
    ifExistsCheck: if (args.ifExists === "skip" || args.ifExists === "error") {
      const existing = getRoleByName(args.name);
      if (existing && existing.status === "active") {
        if (args.ifExists === "skip") {
          return toCallToolResult({
            skipped: true,
            existingRoleId: existing.id,
            name: existing.name,
          });
        }
        return toCallToolResult({
          error: `create_role: an active role with name "${args.name}" already exists (id ${existing.id}) — set ifExists='skip' to reuse it or ifExists='create' to force a new one`,
        });
      }
      // Active-only: if the existing role is retired, fall through to create
      // (do NOT break — continue the build path).
      break ifExistsCheck;
    }

    const roleId = `role-${uuidv4().slice(0, 8)}`;
    // learnedRules default: today's behavior (empty structured object) when
    // omitted. Accepts both legacy `string[]` (auto-migrated by createRole
    // via coerceLearnedRules) and the structured object.
    const learnedRules = (args.learnedRules !== undefined
      ? args.learnedRules
      : { stylePreferences: [], avoidedActions: [], pinnedParameters: [] }) as Role["learnedRules"];
    const role = {
      id: roleId,
      name: args.name,
      cagPrompt: resolvedCagPrompt,
      learnedRules,
      memoryStreamId: `mem-${uuidv4().slice(0, 8)}`,
      status: (args.status ?? "active") as Role["status"],
      preferences: args.preferences ?? {},
      createdAt: Date.now(),
      allowedTools: args.allowedTools,
      disallowedTools: args.disallowedTools,
      osCapabilities,
      additionalDirectories: args.additionalDirectories,
      evaluationCriteria: args.evaluationCriteria,
      executionMode: args.executionMode,
      model: args.model,
      maxBudgetUsd: args.maxBudgetUsd,
      approvalRequired: args.approvalRequired,
      source: args.source,
      allowedChannels: args.allowedChannels,
      inheritUserSettings: args.inheritUserSettings,
      permissionMode: args.permissionMode,
      allowedBashPatterns: args.allowedBashPatterns,
      deniedBashPatterns: args.deniedBashPatterns,
      envVars: args.envVars,
      presetId: args.presetId,
      effortTier: args.effortTier === null ? undefined : args.effortTier,
      skills: args.skills,
      memoryBudgetTokens: args.memoryBudgetTokens,
      performanceScore: args.performanceScore,
    };
    try {
      createRole(role);
    } catch (err) {
      // UNIQUE constraint on roles.name is the only expected failure mode
      // post-ifExists (a same-name hit at status='retired' falls through
      // the active-only gate). Surface as a structured tool error so the
      // import orchestrator can decide whether to rename or skip.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("UNIQUE constraint failed: roles.name")) {
        return toCallToolResult({
          error: `create_role: a role with name "${args.name}" already exists (retired or otherwise). Set ifExists='skip' to reuse, or rename the new role.`,
        });
      }
      throw err;
    }
    ensureRoleWorkspace(role);
    const savedRole = getRole(roleId);
    if (savedRole) {
      recordAdamToolRuntimeEffect({
        toolName: "create_role",
        effectType: "create",
        effectCategory: "role_update",
        entityType: "role",
        entityId: roleId,
        after: savedRole,
      });
      // Phase 4: write entity_mutation receipt
      writeMutationReceipt({
        toolName: "create_role",
        entityType: "role",
        verb: "create",
        entityId: roleId,
        fieldChanges: [{ path: "_entity", op: "set", before: null, after: { id: roleId, name: args.name, status: "active", cagPrompt: args.cagPrompt } }],
      });
    }
    return toCallToolResult({
      roleId,
      name: args.name,
      allowedTools: args.allowedTools,
      osCapabilities: role.osCapabilities,
      additionalDirectories: role.additionalDirectories ?? [],
    });
  }),

  tool("retire_role", "Retire a role (marks as retired, stops receiving tasks).", retireRoleShape, async (args) => {
    const role = getRole(args.roleId);
    if (!role) return toCallToolResult({ error: `Role not found: ${args.roleId}` });
    updateRole(args.roleId, { status: "retired" });
    log.info({ roleId: args.roleId, reason: args.reason }, "Role retired");
    // Phase 4: write entity_mutation receipt
    writeMutationReceipt({
      toolName: "retire_role",
      entityType: "role",
      verb: "retire",
      entityId: args.roleId,
      fieldChanges: [{ path: "status", op: "set", before: role.status, after: "retired" }],
      roleId: args.roleId,
    });
    return toCallToolResult({ success: true });
  }),

  tool("create_goal", "Create a new goal with optional budget, deadline, and metric tracking.", createGoalShape, async (args) => {
    const goalId = uuidv4();
    const now = Date.now();
    const sevenDays = now + 7 * 24 * 60 * 60 * 1000;

    const goal: Goal = {
      id: goalId,
      name: args.name,
      description: args.description,
      roleId: args.roleId ?? "engineer",
      metricType: args.metric ?? "completion",
      targetValue: args.targetValue ?? 1,
      currentValue: 0,
      deadline: args.deadline ?? sevenDays,
      budgetUsd: args.budgetUsd ?? 5.0,
      status: "active",
      createdAt: now,
      deliverTo: args.deliverTo
        ? await resolveDeliveryTargets(args.deliverTo as Array<{ type: string; sessionId?: string; channelName?: string; channelId?: string; chatId?: string }>)
        : undefined,
    };

    createGoal(goal);
    buildMetricTree(goalId, goal.metricType);

    const saved = getGoal(goalId);
    if (saved) {
      recordAdamToolRuntimeEffect({
        toolName: "create_goal",
        effectType: "create",
        effectCategory: "goal_update",
        entityType: "goal",
        entityId: goalId,
        after: saved,
      });
      // Phase 4: write entity_mutation receipt
      writeMutationReceipt({
        toolName: "create_goal",
        entityType: "goal",
        verb: "create",
        entityId: goalId,
        fieldChanges: [{ path: "_entity", op: "set", before: null, after: { id: goalId, name: args.name, status: "active", roleId: args.roleId ?? "engineer" } }],
      });
    }
    return toCallToolResult({ goalId: saved!.id, name: saved!.name, status: saved!.status });
  }),

  tool("create_template", "Create a Template automation. Use steps[] for multiple roles or multiple steps, then run_template when immediate execution is requested. triggerType values: 'manual' (default), 'cron' (recurring via cron expression), 'template_complete' (fires when a TemplateExecution for another Template completes; set triggerEvent to 'template_complete:<templateId>'), or 'event' (fires when an Event def fires; set eventDefId to the event def UUID). For one-shot delayed tasks ('in 30 minutes', 'tomorrow at 3pm'), use schedule_task instead. Step-level long free-text fields (step.prompt, persona.speakAs, outputContract.customAssertions[i]) can come from inline strings OR from a config-doc anchor reference (promptRef, persona.speakAsRef, customAssertionRefs[]) — use the *Ref form for long fields imported from another instance; the docPath must resolve inside ~/.adam/config-exports/.", createTemplateShape, async (args) => {
    const { createTaskTemplate, listTaskTemplates } = await import("../store/task-templates.js");
    const templateId = uuidv4();

    const triggerResult = buildTemplateTriggerFromArgs(args);
    if ("error" in triggerResult) {
      return toCallToolResult({ error: triggerResult.error });
    }

    // Resolve anchor-refs on each step BEFORE mapTemplateStepInput runs.
    // Refs are additive — when absent, the inline value is used as-is.
    // When a ref is present, the inline value must be absent (ambiguity rejected).
    let resolvedInputSteps: Array<z.infer<typeof templateStepInputShape>> | undefined;
    if (args.steps?.length) {
      resolvedInputSteps = [];
      for (const step of args.steps) {
        const stepAny = step as Record<string, unknown>;
        const next: Record<string, unknown> = { ...stepAny };

        // promptRef
        if (stepAny.promptRef !== undefined) {
          if (typeof stepAny.prompt === "string" && stepAny.prompt !== "") {
            return toCallToolResult({
              error: `create_template: step "${step.id}" pass EITHER prompt (inline) OR promptRef (anchor reference), not both — ambiguous`,
            });
          }
          try {
            next.prompt = resolveAnchorBytes(stepAny.promptRef as { docPath: string; anchorId: string }, `step "${step.id}" prompt`);
          } catch (error) {
            return toCallToolResult({ error: error instanceof Error ? error.message : String(error) });
          }
          delete next.promptRef;
        }

        // persona.speakAsRef
        const persona = stepAny.persona as Record<string, unknown> | undefined;
        if (persona && persona.speakAsRef !== undefined) {
          if (typeof persona.speakAs === "string" && persona.speakAs !== "") {
            return toCallToolResult({
              error: `create_template: step "${step.id}" pass EITHER persona.speakAs (inline) OR persona.speakAsRef (anchor reference), not both — ambiguous`,
            });
          }
          let resolvedSpeakAs: string;
          try {
            resolvedSpeakAs = resolveAnchorBytes(persona.speakAsRef as { docPath: string; anchorId: string }, `step "${step.id}" persona.speakAs`);
          } catch (error) {
            return toCallToolResult({ error: error instanceof Error ? error.message : String(error) });
          }
          next.persona = { ...persona, speakAs: resolvedSpeakAs };
          delete (next.persona as Record<string, unknown>).speakAsRef;
        }

        // outputContract.customAssertionRefs
        const oc = stepAny.outputContract as Record<string, unknown> | undefined;
        if (oc && Array.isArray(oc.customAssertionRefs) && (oc.customAssertionRefs as unknown[]).length > 0) {
          const refs = oc.customAssertionRefs as Array<{ docPath: string; anchorId: string }>;
          const refBytes: string[] = [];
          for (const ref of refs) {
            try {
              refBytes.push(resolveAnchorBytes(ref, `step "${step.id}" outputContract.customAssertionRefs[anchorId=${ref.anchorId}]`));
            } catch (error) {
              return toCallToolResult({ error: error instanceof Error ? error.message : String(error) });
            }
          }
          const inlineAssertions = Array.isArray(oc.customAssertions) ? (oc.customAssertions as string[]) : [];
          next.outputContract = { ...oc, customAssertions: [...inlineAssertions, ...refBytes] };
          delete (next.outputContract as Record<string, unknown>).customAssertionRefs;
        }

        resolvedInputSteps.push(next as z.infer<typeof templateStepInputShape>);
      }
    }

    const steps: TaskStep[] = resolvedInputSteps
      ? resolvedInputSteps.map(mapTemplateStepInput)
      : args.prompt
        ? [{
            id: "step-1",
            prompt: args.prompt,
            ...(args.roleId !== undefined ? { roleId: args.roleId } : {}),
            ...(args.autoSelectRole !== undefined ? { autoSelectRole: args.autoSelectRole } : {}),
            ...(args.requirements !== undefined ? { requirements: args.requirements } : {}),
            ...(args.config !== undefined ? { config: args.config as TaskStep["config"] } : {}),
          }]
        : [];

    if (steps.length === 0) {
      return toCallToolResult({ error: "create_template requires either prompt shorthand or canonical steps[]" });
    }

    const resolvedDeliverTo = args.deliverTo
      ? await resolveDeliveryTargets(args.deliverTo as Array<{ type: string; sessionId?: string; channelName?: string; channelId?: string; chatId?: string }>)
      : undefined;
    const resolvedReportTo = args.reportTo
      ? await resolveDeliveryTargets(args.reportTo as Array<{ type: string; sessionId?: string; channelName?: string; channelId?: string; chatId?: string }>)
      : undefined;

    const template = {
      id: templateId,
      name: args.name,
      description: args.description,
      trigger: triggerResult.trigger,
      steps,
      config: args.steps?.length ? args.config as Record<string, unknown> | undefined : undefined,
      enabled: args.enabled ?? true,
      createdAt: Date.now(),
      goalIds: args.goalIds,
      deliverTo: resolvedDeliverTo,
      reportTo: resolvedReportTo,
      // F1 (Phase 2 plan): portable template fields forwarded to the
      // store. createTaskTemplate persists these to their dedicated
      // columns / JSON cells (tags, is_preset, preset_id, role_preference).
      tags: args.tags,
      isPreset: args.isPreset,
      presetId: args.presetId,
      rolePreference: args.rolePreference,
      retryPolicy: args.retryPolicy,
    };

    // Duplicate-name guard (DP-002): warn (do not block) if an enabled template with same name exists
    const existingEnabled = listTaskTemplates(true, 100, 0).filter((t) => t.name === args.name);
    const dupeWarning = existingEnabled.length > 0
      ? `An enabled template named "${args.name}" already exists (id ${existingEnabled[0].id})`
      : undefined;

    try {
      createTaskTemplate(template);
    } catch (err) {
      const { TemplateRoleConfigError, TemplateValidationError } = await import("../store/task-templates.js");
      if (err instanceof TemplateRoleConfigError) {
        return toCallToolResult({
          code: err.code,
          error: err.message,
          failingStepIds: err.failingStepIds,
          hint: "Set roleId (recommended) OR autoSelectRole=true with a requirements object (e.g., {tools:['Read']}) on each step. Use list_roles to find an appropriate role.",
        });
      }
      if (err instanceof TemplateValidationError) {
        return toCallToolResult({
          code: err.code,
          error: err.message,
          failingStepIds: err.failingStepIds,
        });
      }
      throw err;
    }
    const savedTemplate = getTaskTemplate(templateId);
    if (savedTemplate) {
      recordAdamToolRuntimeEffect({
        toolName: "create_template",
        effectType: "create",
        effectCategory: "template_update",
        entityType: "task_template",
        entityId: templateId,
        after: fullTemplateDetail(savedTemplate),
      });
      // Phase 4: write entity_mutation receipt
      writeMutationReceipt({
        toolName: "create_template",
        entityType: "task_template",
        verb: "create",
        entityId: templateId,
        fieldChanges: [{ path: "_entity", op: "set", before: null, after: fullTemplateDetail(savedTemplate) }],
      });
    }

    return toCallToolResult({
      templateId,
      name: template.name,
      trigger: template.trigger,
      stepCount: steps.length,
      steps: summarizeTemplateSteps(steps),
      ...(template.goalIds ? { goalIds: template.goalIds } : {}),
      ...(dupeWarning ? { warning: dupeWarning } : {}),
    });
  }),

  tool(
    "create_event_def",
    "Create an Event definition — a user-configured source that fires on schedule/webhook/directory/manual. Event defs are the trigger half of the Event Slot; pair with create_template(triggerType='event', eventDefId=<returned id>) to bind work to the trigger. sourceType is validated at runtime against the installed source registry (currently: webhook, cron, directory_watch, manual — additional types may be registered at runtime). sourceConfig is per-type: cron → {cron: '0 9 * * *'}; directory_watch → {path: '/abs/path', glob?: '*.md'}; webhook/manual → {}.",
    {
      name: z.string().min(1).max(100).describe("Human-readable name (unique within workspace)."),
      sourceType: z.string().describe("Source type — validated against installed registry at call time. Currently: 'webhook' | 'cron' | 'directory_watch' | 'manual'. If the value is rejected, the error message lists the currently-registered types."),
      sourceConfig: z.record(z.string(), z.unknown()).describe("Per-sourceType configuration. See tool description."),
      enabled: z.boolean().optional().describe("Default true."),
      description: z.string().max(500).optional().describe("Free-form description of what this event represents."),
    },
    async (args) => {
      // Registry validation (runtime — picks up late-registered types)
      if (!getSourceTypeKeys().includes(args.sourceType as never)) {
        return toCallToolResult({
          error: `Unknown sourceType: '${args.sourceType}'. Currently registered: ${getSourceTypeKeys().join(", ")}`,
        });
      }
      const configCheck = validateSourceConfig(args.sourceType, args.sourceConfig);
      if (!configCheck.ok) {
        return toCallToolResult({ error: `Invalid sourceConfig: ${configCheck.error}` });
      }

      const id = uuidv4();
      const def = createEventDef({
        id,
        name: args.name,
        sourceType: args.sourceType as "webhook" | "manual" | "cron" | "directory_watch",
        sourceConfig: args.sourceConfig,
        enabled: args.enabled ?? true,
        description: args.description,
      });

      // Start runtime source handler; on failure, roll back the DB row.
      try {
        startEventDefSource(def);
      } catch (err) {
        deleteEventDef(id);
        const message = err instanceof Error ? err.message : String(err);
        return toCallToolResult({ error: `Failed to start source: ${message}. Event def was not created.` });
      }

      // Phase 4: write entity_mutation receipt
      writeMutationReceipt({
        toolName: "create_event_def",
        entityType: "event_def",
        verb: "create",
        entityId: def.id,
        fieldChanges: [{ path: "_entity", op: "set", before: null, after: { id: def.id, name: def.name, sourceType: def.sourceType, enabled: def.enabled } }],
      });

      return toCallToolResult({ id: def.id, name: def.name, sourceType: def.sourceType, enabled: def.enabled });
    },
  ),

  tool(
    "list_event_defs",
    "List Event definitions. Use before create_template(triggerType='event') to find the eventDefId, or before fire_event_def / list_event_firings.",
    {
      sourceType: z.string().optional().describe("Filter by source type (e.g., 'cron', 'webhook')."),
      enabled: z.boolean().optional().describe("Filter by enabled flag."),
    },
    async (args) => {
      const defs = listEventDefs({
        sourceType: args.sourceType as "webhook" | "manual" | "cron" | "directory_watch" | undefined,
        enabled: args.enabled,
      });
      return toCallToolResult(defs.map((d) => ({
        id: d.id,
        name: d.name,
        sourceType: d.sourceType,
        sourceConfig: d.sourceConfig,
        enabled: d.enabled,
        description: d.description,
        createdAt: d.createdAt,
      })));
    },
  ),

  tool(
    "update_event_def",
    "Update an Event definition. Changing `enabled` or `sourceConfig` on an active def automatically restarts the runtime source handler. Use list_event_defs first to get the id.",
    {
      id: eventDefIdSchema.describe("Event def id."),
      name: z.string().min(1).max(100).optional().describe("Human-readable name for this event definition."),
      sourceType: z.string().optional().describe("Only set when migrating to a different source type."),
      sourceConfig: z.record(z.string(), z.unknown()).optional().describe("Per-sourceType configuration. See tool description."),
      enabled: z.boolean().optional().describe("Enable or disable this event definition."),
      description: z.string().max(500).optional().describe("Free-form description of what this event represents."),
    },
    async (args) => {
      const existing = getEventDef(args.id);
      if (!existing) return toCallToolResult({ error: `Event def '${args.id}' not found` });

      // Validate source-type / config if changing
      if (args.sourceType !== undefined || args.sourceConfig !== undefined) {
        const st = args.sourceType ?? existing.sourceType;
        if (!getSourceTypeKeys().includes(st as never)) {
          return toCallToolResult({ error: `Unknown sourceType: '${st}'` });
        }
        const configCheck = validateSourceConfig(st, args.sourceConfig ?? existing.sourceConfig);
        if (!configCheck.ok) return toCallToolResult({ error: `Invalid sourceConfig: ${configCheck.error}` });
      }

      // Stop-then-start semantics (mirror REST route at event-defs.ts:168-178):
      const wasEnabled = existing.enabled;
      const willBeEnabled = args.enabled ?? existing.enabled;
      const configChanged = args.sourceType !== undefined || args.sourceConfig !== undefined;

      // Stop if was-enabled and either flipping disable, or config changing (need restart)
      if (wasEnabled && (!willBeEnabled || configChanged)) {
        stopEventDefSource(existing.id, existing.sourceType);
      }

      const updated = updateEventDef(args.id, {
        name: args.name,
        sourceType: args.sourceType as "webhook" | "manual" | "cron" | "directory_watch" | undefined,
        sourceConfig: args.sourceConfig,
        enabled: args.enabled,
        description: args.description,
      });
      if (!updated) return toCallToolResult({ error: "Update failed" });

      // Start if will-be-enabled and either flipping enable, or config changed on an enabled def
      if (willBeEnabled && (!wasEnabled || configChanged)) {
        try {
          startEventDefSource(updated);
        } catch (err) {
          // Self-heal: flip enabled=false so DB state reflects runtime state
          updateEventDef(args.id, { enabled: false });
          const message = err instanceof Error ? err.message : String(err);
          return toCallToolResult({ error: `Failed to start source with new config: ${message}. Event def has been marked disabled to match runtime state.` });
        }
      }

      // Phase 4: write entity_mutation receipt
      const eventDefFieldChanges: Array<{ path: string; op: "set"; before: unknown; after: unknown }> = [];
      if (args.name !== undefined) eventDefFieldChanges.push({ path: "name", op: "set", before: existing.name, after: args.name });
      if (args.sourceType !== undefined) eventDefFieldChanges.push({ path: "sourceType", op: "set", before: existing.sourceType, after: args.sourceType });
      if (args.sourceConfig !== undefined) eventDefFieldChanges.push({ path: "sourceConfig", op: "set", before: existing.sourceConfig, after: args.sourceConfig });
      if (args.enabled !== undefined) eventDefFieldChanges.push({ path: "enabled", op: "set", before: existing.enabled, after: args.enabled });
      if (args.description !== undefined) eventDefFieldChanges.push({ path: "description", op: "set", before: existing.description, after: args.description });
      if (eventDefFieldChanges.length > 0) {
        writeMutationReceipt({
          toolName: "update_event_def",
          entityType: "event_def",
          verb: "update",
          entityId: args.id,
          fieldChanges: eventDefFieldChanges,
        });
      }

      return toCallToolResult({
        id: updated.id, name: updated.name, sourceType: updated.sourceType, enabled: updated.enabled,
      });
    },
  ),

  tool(
    "delete_event_def",
    "Delete an Event definition. Stops the runtime source handler (cron/fswatch) first, then deletes the DB row. Templates bound to this event def become orphaned and will not fire.",
    {
      id: eventDefIdSchema.describe("Event def id."),
    },
    async (args) => {
      const existing = getEventDef(args.id);
      if (!existing) return toCallToolResult({ error: `Event def '${args.id}' not found` });

      try {
        stopEventDefSource(existing.id, existing.sourceType);
      } catch (err) {
        log.warn({ defId: existing.id, err }, "stopEventDefSource failed during delete — proceeding with row deletion");
      }
      const ok = deleteEventDef(args.id);
      // Phase 4: write entity_mutation receipt
      writeMutationReceipt({
        toolName: "delete_event_def",
        entityType: "event_def",
        verb: "delete",
        entityId: args.id,
        fieldChanges: [{ path: "_entity", op: "set", before: { id: existing.id, name: existing.name, sourceType: existing.sourceType }, after: null }],
      });
      return toCallToolResult({ ok, id: args.id });
    },
  ),

  tool(
    "fire_event_def",
    "Fire an Event definition now. For manual defs: creates a real manual event (same as clicking 'Fire now' in the UI). For any source type: with test=true, creates a synthetic test event (source='manual-test-<defId>') that flows through the EventDispatcher — useful for debugging why a Template bound to the event didn't fire. Payload is optional.",
    {
      id: eventDefIdSchema.describe("Event def id."),
      test: z.boolean().optional().describe("Test mode. Required (=true) when source type != 'manual'. Default false. In test mode the event does NOT collide with real firings' dedup keys."),
      payload: z.record(z.string(), z.unknown()).optional().describe("Optional event payload. Must be < 64 KB when JSON-serialized."),
    },
    async (args) => {
      const def = getEventDef(args.id);
      if (!def) return toCallToolResult({ error: `Event def '${args.id}' not found` });

      const isTest = args.test === true;
      if (def.sourceType !== "manual" && !isTest) {
        return toCallToolResult({
          error: `Can only directly fire manual event defs; this def has source type '${def.sourceType}'. Pass test=true to dry-run.`,
        });
      }

      // 64 KB payload size cap
      if (args.payload) {
        const size = Buffer.byteLength(JSON.stringify(args.payload), "utf8");
        if (size > 65536) {
          return toCallToolResult({ error: `Payload exceeds 64 KB limit (got ${size} bytes)` });
        }
      }

      try {
        const result = isTest
          ? fireTestEvent(def, args.payload)
          : fireManualEvent(def, args.payload);
        // Phase 4: write entity_mutation receipt
        writeMutationReceipt({
          toolName: "fire_event_def",
          entityType: "event_firing",
          verb: "create",
          entityId: result.eventId,
          fieldChanges: [{ path: "_entity", op: "set", before: null, after: { eventId: result.eventId, eventDefId: def.id, payload: args.payload } }],
        });
        return toCallToolResult({ ok: true, eventId: result.eventId, test: isTest });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return toCallToolResult({ error: message });
      }
    },
  ),

  tool(
    "list_event_firings",
    "List recent firings of an Event definition — for debugging 'why didn't my automation fire' and inspecting event history. Returns id, occurredAt, type, source, dedupKey, confidence, and a truncated payload (500 char cap for display). For full payloads, use REST GET /event-defs/:id/firings.",
    {
      eventDefId: eventDefIdSchema.describe("Event def id. Use list_event_defs to find it."),
      since: z.string().optional().describe("ISO 8601 start timestamp (inclusive). Omit for unlimited range."),
      until: z.string().optional().describe("ISO 8601 end timestamp (inclusive)."),
      limit: z.number().int().positive().max(500).optional().describe("Max rows (default 50, max 500)."),
    },
    async (args) => {
      const def = getEventDef(args.eventDefId);
      if (!def) return toCallToolResult({ error: `Event def '${args.eventDefId}' not found` });

      const rows = queryEvents({
        eventDefId: args.eventDefId,
        since: args.since,
        until: args.until,
        limit: args.limit ?? 50,
      });

      const PAYLOAD_DISPLAY_CAP = 500;
      return toCallToolResult({
        eventDefName: def.name,
        sourceType: def.sourceType,
        count: rows.length,
        firings: rows.map((e) => {
          const formatted = formatEventForLLM({
            payload: e.payload,
            trustLevel: e.trustLevel,
            source: e.source,
            maxBodyChars: PAYLOAD_DISPLAY_CAP,
          });
          return {
            id: e.id,
            occurredAt: e.occurredAt,
            type: e.type,
            source: e.source,
            dedupKey: e.dedupKey,
            confidence: e.confidence,
            trustLevel: e.trustLevel,
            payloadPreview: formatted,
            payloadTruncated: formatted.length > PAYLOAD_DISPLAY_CAP,
          };
        }),
      });
    },
  ),

  tool(
    "create_skill",
    "Author a Claude Code Skill file under a target Role's workspace. The Skill becomes available next time the Role runs. Preset Roles (Engineer, Reviewer, Researcher, Writer, Chat Manager, adam-automator) require overwrite=true to replace an existing skill — first-time creation is unrestricted. Returns the written file path.",
    {
      roleId: roleIdSchema.describe("Role to target. Use list_roles to find it."),
      skillName: z
        .string()
        .regex(/^[a-z0-9_][a-z0-9_-]{0,39}$/, "skillName must be 1-40 chars: lowercase letters, digits, underscores, optional hyphen in middle. No leading dot or dash.")
        .describe("Skill directory name (used as the directory under .claude/skills/)."),
      description: z.string().max(500).describe("One-line description shown to the Role's LLM when choosing a Skill."),
      instructions: z.string().describe("The skill body: what it does and how to do it."),
      parameters: z.record(z.string(), z.object({
        type: z.string().describe("Parameter type name"),
        description: z.string().describe("Parameter description"),
      })).optional().describe("Named input parameters and their types."),
      overwrite: z.boolean().optional().describe(
        "Required (=true) to overwrite an existing SKILL.md under a preset Role (Engineer, Reviewer, Researcher, Writer, Chat Manager, adam-automator). First-time skill creation and non-preset Roles do not require this flag.",
      ),
    },
    async (args) => {
      const { getRole } = await import("../store/roles.js");
      const { ensureRoleWorkspace } = await import("../store/role-workspace.js");
      const { mkdir, writeFile } = await import("fs/promises");
      const { resolve } = await import("path");

      const role = getRole(args.roleId);
      if (!role) {
        return toCallToolResult({ error: `Role '${args.roleId}' not found` });
      }

      const workspace = ensureRoleWorkspace(role);
      const skillDir = resolve(workspace, ".claude", "skills", args.skillName);

      // Preset-role overwrite guard
      if (isPresetRole(role)) {
        const { existsSync } = await import("node:fs");
        const existingSkillPath = resolve(skillDir, "SKILL.md");
        if (existsSync(existingSkillPath) && args.overwrite !== true) {
          return toCallToolResult({
            error: `Role '${role.name}' is a preset. Skill '${args.skillName}' already exists at ${existingSkillPath}. Pass overwrite=true to replace, or choose a different skillName to add alongside.`,
            requiresOverwrite: true,
            existingPath: existingSkillPath,
          });
        }
      }

      // Defense-in-depth: ensure resolved path is still inside .claude/skills/
      const skillsRoot = resolve(workspace, ".claude", "skills");
      if (!skillDir.startsWith(skillsRoot + (process.platform === "win32" ? "\\" : "/"))) {
        return toCallToolResult({ error: "Path traversal rejected" });
      }

      await mkdir(skillDir, { recursive: true });
      const content = formatSkillMd(args);
      const skillFile = resolve(skillDir, "SKILL.md");
      await writeFile(skillFile, content, "utf8");

      // Phase 4: write entity_mutation receipt
      writeMutationReceipt({
        toolName: "create_skill",
        entityType: "skill_file",
        verb: "create",
        entityId: args.skillName,
        fieldChanges: [{ path: "_entity", op: "set", before: null, after: { skillName: args.skillName, path: skillFile } }],
      });

      return toCallToolResult({ ok: true, path: skillFile });
    },
  ),

  tool("list_templates", "List task templates (automations). Use this to check existing scheduled/recurring tasks before creating new ones.", {
    enabled: z.boolean().optional().describe("Filter by enabled status. Omit to list all."),
    limit: z.number().optional().describe("Max results (default 50)"),
  }, async (args) => {
    const { listTaskTemplates } = await import("../store/task-templates.js");
    const templates = listTaskTemplates(args.enabled, args.limit ?? 50, 0);
    return toCallToolResult(templates.map(t => ({
      id: t.id,
      name: t.name,
      description: t.description,
      trigger: t.trigger,
      enabled: t.enabled,
      rolePreference: t.rolePreference,
      stepCount: t.steps.length,
      steps: summarizeTemplateSteps(t.steps),
      config: {
        continueOnError: t.config?.continueOnError ?? false,
      },
      deliverTo: t.deliverTo,
      createdAt: t.createdAt,
    })));
  }),

  tool("get_template_detail", "Read full persisted Template details, including complete step config and output contracts. Use before and after changing configurable Template fields.", getTemplateDetailShape, async (args) => {
    const template = getTaskTemplate(args.templateId);
    if (!template) return toCallToolResult({ error: `Template not found: ${args.templateId}` });
    return toCallToolResult(fullTemplateDetail(template));
  }),

  tool("send_to_channel", "Send a message (text, image, voice, video, file) to a connected channel by name. Use this to deliver task results, media, or notifications to a specific channel (e.g., WeChat on iPad). For media: provide mediaUrl as an absolute local file path and mediaType. Do NOT use remote URLs — download files locally first.", {
    channelName: z.string().describe("The channel name, e.g., 'WeChat on iPad' or 'Client Mail'"),
    message: z.string().describe("The message content to send (text caption when sending media)"),
    mediaUrl: localFilePathSchema.optional().describe("Absolute local file path to the media file (e.g. /Users/.../file.png). Must exist on disk. Do NOT use remote URLs — download files locally first."),
    mediaType: z.enum(["image", "audio", "video", "file"]).optional().describe("Type of the media file. Required when mediaUrl is provided"),
  }, async (args) => {
    // Validate mediaUrl: local path only, must exist
    if (args.mediaUrl) {
      if (args.mediaUrl.includes("://") && !args.mediaUrl.startsWith("file://")) {
        return toCallToolResult({ error: `mediaUrl must be a local file path, not a remote URL. Got: ${args.mediaUrl.slice(0, 80)}. Download the file to a local path first, then pass the local path.` });
      }
      const resolvedPath = args.mediaUrl.startsWith("file://")
        ? new URL(args.mediaUrl).pathname
        : args.mediaUrl;
      if (!existsSync(resolvedPath)) {
        return toCallToolResult({ error: `Media file not found: ${resolvedPath}. Verify the file exists before sending.` });
      }
      if (!args.mediaType) {
        return toCallToolResult({ error: "mediaType is required when mediaUrl is provided. Specify one of: image, audio, video, file." });
      }
    }
    const resolved = await resolveDeliveryTargets([{ type: "channel", channelName: args.channelName }]);
    if (resolved.length === 0) {
      return toCallToolResult({ error: `Channel "${args.channelName}" not found or no chatId available` });
    }
    const target = resolved[0];
    if (target.type !== "channel") {
      return toCallToolResult({ error: "Resolved target is not a channel" });
    }
    const { getOutboundGateway } = await import("../delivery/outbound-gateway.js");
    const gateway = getOutboundGateway();
    const result = await gateway.send({
      channelId: target.channelId,
      chatId: target.chatId!,
      content: args.message,
      messageType: "deliver",
      mediaUrl: args.mediaUrl,
      mediaType: args.mediaType,
    });

    // Phase 2 post-hook: register chat_sent artifact (async, fire-and-forget)
    if (result.success && args.mediaUrl) {
      const origin = runtimeContext.getActiveChatOrigin?.();
      const resolvedMediaPath = args.mediaUrl.startsWith("file://")
        ? new URL(args.mediaUrl).pathname
        : args.mediaUrl;
      setImmediate(() => {
        void registerChatSentArtifact({
          mediaUrl: resolvedMediaPath,
          chatSessionId: origin?.chatSessionId,
          roleId: CHAT_MANAGER_ROLE_ID,
          mime: undefined, // mediaType is "image"|"audio"|"video"|"file" (not MIME); leave mime null in DB
        });
      });
    }

    return toCallToolResult({ success: result.success, channelName: args.channelName, ...(result.error ? { error: result.error } : {}) });
  }),

  tool("list_channels", "List all connected channels with their platform, status, and chatId for message delivery. Use this to discover available channels before sending messages or setting up notifications.", listChannelsShape, async (args) => {
    const allChannels = listChannels(args.enabled);
    const allSessions = [...listSessions("active"), ...listSessions("archived")];
    const { getDefaultChatIdForChannel } = await import("../channels/target-resolution.js");

    const result = allChannels.map((ch) => {
      const chatId = getDefaultChatIdForChannel(ch, allSessions);
      const base = {
        id: ch.id,
        name: ch.name,
        platform: ch.platform,
        status: ch.status,
        chatId,
      };
      if (ch.platform === "email") {
        return {
          ...base,
          defaultRecipientCapBytes: ch.defaultRecipientCapBytes ?? DEFAULT_EMAIL_CAP_BYTES,
          recipientCapMap: ch.recipientCapMap ?? {},
        };
      }
      return base;
    });

    return toCallToolResult({ channels: result });
  }),

  tool(
    "get_channel_recipient_caps",
    "Read the per-recipient attachment size caps for email channels. Returns the default cap (in bytes) and any per-domain overrides. Omit channelId to list caps for all email channels.",
    {
      channelId: z.string().uuid().optional().describe("Channel ID (UUID). Omit to return caps for all email channels."),
    },
    async (args) => {
      const allChannels = listChannels();
      const emailChannels = allChannels.filter((ch) => ch.platform === "email");
      const filtered = args.channelId
        ? emailChannels.filter((ch) => ch.id === args.channelId)
        : emailChannels;
      if (args.channelId && filtered.length === 0) {
        return toCallToolResult({ error: `Email channel not found: ${args.channelId}` });
      }
      const channels = filtered.map((ch) => {
        const defaultBytes = ch.defaultRecipientCapBytes ?? DEFAULT_EMAIL_CAP_BYTES;
        return {
          id: ch.id,
          name: ch.name,
          defaultRecipientCapBytes: defaultBytes,
          defaultRecipientCapMB: Math.round(defaultBytes / (1024 * 1024) * 10) / 10,
          recipientCapMap: ch.recipientCapMap ?? {},
        };
      });
      return toCallToolResult({ channels });
    },
  ),

  tool(
    "update_channel_recipient_caps",
    "Update the per-recipient attachment size cap for an email channel. Accepts integer bytes (e.g., 36700160) or human-readable strings (e.g., '35MB', '35M', '1.5GB'). Pass recipientCapMap to set per-domain overrides; an empty object clears all overrides. Both bounds are 1 MB ≤ cap ≤ 200 MB.",
    {
      channelId: z.string().uuid().describe("Channel ID (UUID). Use get_channel_recipient_caps to discover IDs."),
      defaultBytes: recipientCapInputSchema.optional().describe("Channel-wide default cap. Integer bytes or human-readable string like '35MB'."),
      recipientCapMap: z.record(
        z.string().regex(RECIPIENT_DOMAIN_REGEX, "domain must be lowercase letters/digits/dot/hyphen only"),
        recipientCapInputSchema,
      ).optional().describe("Per-domain overrides (lowercase domains). Empty object clears all overrides."),
    },
    async (args) => {
      const channel = getChannel(args.channelId as string);
      if (!channel) {
        return toCallToolResult({ error: `Channel not found: ${args.channelId}` });
      }
      if (channel.platform !== "email") {
        return toCallToolResult({ error: `Channel ${args.channelId} is not an email channel (platform=${channel.platform})` });
      }
      if (args.defaultBytes === undefined && args.recipientCapMap === undefined) {
        return toCallToolResult({ error: "Provide at least one of defaultBytes or recipientCapMap" });
      }
      // Validate defaultBytes (may be raw string/number when called from tests bypassing SDK schema)
      let parsedDefaultBytes: number | undefined;
      if (args.defaultBytes !== undefined) {
        const result = recipientCapInputSchema.safeParse(args.defaultBytes);
        if (!result.success) {
          return toCallToolResult({ error: result.error.issues[0]?.message ?? "Invalid defaultBytes" });
        }
        parsedDefaultBytes = result.data;
      }
      // Validate recipientCapMap
      let parsedCapMap: Record<string, number> | undefined;
      if (args.recipientCapMap !== undefined) {
        const mapSchema = z.record(
          z.string().regex(RECIPIENT_DOMAIN_REGEX, "domain must be lowercase letters/digits/dot/hyphen only"),
          recipientCapInputSchema,
        );
        const mapResult = mapSchema.safeParse(args.recipientCapMap);
        if (!mapResult.success) {
          return toCallToolResult({ error: mapResult.error.issues[0]?.message ?? "Invalid recipientCapMap" });
        }
        parsedCapMap = mapResult.data;
      }
      const updates: Parameters<typeof updateChannel>[1] = {};
      if (parsedDefaultBytes !== undefined) updates.defaultRecipientCapBytes = parsedDefaultBytes;
      if (parsedCapMap !== undefined) updates.recipientCapMap = parsedCapMap;
      updateChannel(args.channelId as string, updates);
      const fieldChanges = [];
      if (parsedDefaultBytes !== undefined) {
        fieldChanges.push({
          path: "defaultRecipientCapBytes",
          op: "set" as const,
          before: channel.defaultRecipientCapBytes,
          after: parsedDefaultBytes,
        });
      }
      if (parsedCapMap !== undefined) {
        fieldChanges.push({
          path: "recipientCapMap",
          op: "set" as const,
          before: channel.recipientCapMap,
          after: parsedCapMap,
        });
      }
      writeMutationReceipt({
        toolName: "update_channel_recipient_caps",
        entityType: "channel",
        verb: "update",
        entityId: args.channelId as string,
        fieldChanges,
      });
      return toCallToolResult({
        success: true,
        channelId: args.channelId,
        ...(parsedDefaultBytes !== undefined && { defaultRecipientCapBytes: parsedDefaultBytes }),
        ...(parsedCapMap !== undefined && { recipientCapMap: parsedCapMap }),
      });
    },
  ),

  tool("get_system_status", "Get current system status: execution pool capacity (active/max/queued slots), running task count, and system health. Use this to check if the system has capacity before dispatching tasks.", getSystemStatusShape, async () => {
    const config = getRuntimeConfig();
    const running = listTasks("running");
    const pending = listTasks("pending");
    return toCallToolResult({
      executionPool: {
        active: running.length,
        max: config.execution?.maxConcurrent ?? 5,
        queued: pending.length,
      },
      timestamp: new Date().toISOString(),
    });
  }),

  tool("schedule_task", "Schedule a one-shot delayed task. roleId is required — call list_roles first. Use this when the user wants something done later (e.g., '半小时后', 'in 30 minutes', 'tomorrow at 3pm'). For recurring schedules ('every day', 'weekly'), use create_template instead.", scheduleTaskShape, async (args) => {
    // Validate role exists and is active
    const role = getRole(args.roleId);
    if (!role || role.status !== "active") {
      const available = listRoles("active", 20, 0)
        .filter(r => r.source !== "system")
        .map(r => ({ id: r.id, name: r.name, allowedTools: r.allowedTools ?? [], capabilitySummary: generateCapabilitySummary(r) }));
      return toCallToolResult({
        error: `Role not found or not active: ${args.roleId}. Pick a roleId from the list below.`,
        availableRoles: available,
      });
    }

    const now = Date.now();

    // Compute runAtMs
    let runAtMs: number;
    if (args.delayMinutes !== undefined && args.runAt !== undefined) {
      return toCallToolResult({ error: "Provide exactly one of delayMinutes or runAt, not both" });
    }
    if (args.delayMinutes !== undefined) {
      runAtMs = now + args.delayMinutes * 60 * 1000;
    } else if (args.runAt !== undefined) {
      runAtMs = new Date(args.runAt).getTime();
      if (isNaN(runAtMs)) {
        return toCallToolResult({ error: "Invalid ISO 8601 timestamp in runAt" });
      }
    } else {
      return toCallToolResult({ error: "Provide either delayMinutes or runAt" });
    }

    if (runAtMs <= now) {
      return toCallToolResult({ error: "Scheduled time must be in the future" });
    }
    const maxDelayMs = 7 * 24 * 60 * 60 * 1000;
    if (runAtMs - now > maxDelayMs) {
      return toCallToolResult({ error: "Schedule exceeds maximum of 7 days" });
    }

    const templateId = uuidv4();
    const runAtIso = new Date(runAtMs).toISOString();

    // Resolve delivery targets
    const resolvedDeliverTo = args.deliverTo
      ? await resolveDeliveryTargets(args.deliverTo as Array<{ type: string; sessionId?: string; channelName?: string; channelId?: string; chatId?: string }>)
      : undefined;
    const resolvedReportTo = args.reportTo
      ? await resolveDeliveryTargets(args.reportTo as Array<{ type: string; sessionId?: string; channelName?: string; channelId?: string; chatId?: string }>)
      : undefined;

    createTaskTemplate({
      id: templateId,
      name: args.prompt.slice(0, 80),
      description: `One-shot scheduled task: ${args.prompt.slice(0, 200)}`,
      trigger: { type: "once", runAt: runAtIso },
      steps: [{ id: "main", prompt: args.prompt }],
      rolePreference: args.roleId,
      config: { ...getDefaults() },
      tags: ["scheduled", "once"],
      enabled: true,
      createdAt: now,
      deliverTo: resolvedDeliverTo,
      reportTo: resolvedReportTo,
    });

    // Tell BreeEngine to schedule the timer
    const { getBreeEngine } = await import("../scheduler/bree-engine.js");
    const bree = getBreeEngine();
    if (bree) bree.scheduleOnceJob(templateId);
    const scheduled = getTaskTemplate(templateId);
    if (scheduled?.trigger.type === "once" && scheduled.enabled) {
      recordAdamToolRuntimeEffect({
        toolName: "schedule_task",
        effectType: "create",
        effectCategory: "task_scheduled",
        entityType: "task_template",
        entityId: templateId,
        fieldPath: "trigger",
        after: scheduled.trigger,
      });
      // Phase 4: write entity_mutation receipt
      writeMutationReceipt({
        toolName: "schedule_task",
        entityType: "task_template",
        verb: "create",
        entityId: templateId,
        fieldChanges: [{
          path: "_entity",
          op: "set",
          before: null,
          after: {
            templateId,
            trigger: { type: "once", at: runAtIso },
            roleId: args.roleId,
            taskInstruction: args.prompt.length > 200 ? `${args.prompt.slice(0, 200)}…` : args.prompt,
          },
        }],
      });
    }

    return toCallToolResult({
      templateId,
      executeAt: runAtIso,
      prompt: args.prompt,
    });
  }),

  tool("cancel_scheduled_task", "Cancel a previously scheduled one-shot task by its template ID. The task will not execute.", {
    templateId: templateIdSchema.describe("The template ID returned by schedule_task"),
  }, async (args) => {
    const template = getTaskTemplate(args.templateId);
    if (!template) {
      return toCallToolResult({ error: `Template not found: ${args.templateId}` });
    }
    if (template.trigger.type !== "once") {
      return toCallToolResult({ error: "This is not a one-shot scheduled task. Use disable_template for recurring automations." });
    }

    // Disable the template (prevents execution)
    disableTaskTemplate(args.templateId);

    // Remove timer from BreeEngine
    const { getBreeEngine } = await import("../scheduler/bree-engine.js");
    const bree = getBreeEngine();
    if (bree) await bree.unscheduleJob(args.templateId);
    const cancelled = getTaskTemplate(args.templateId);
    if (cancelled && cancelled.enabled === false) {
      recordAdamToolRuntimeEffect({
        toolName: "cancel_scheduled_task",
        effectType: "update",
        effectCategory: "task_cancelled",
        entityType: "task_template",
        entityId: args.templateId,
        fieldPath: "enabled",
        before: true,
        after: false,
      });
      // Phase 4: write entity_mutation receipt
      writeMutationReceipt({
        toolName: "cancel_scheduled_task",
        entityType: "task_template",
        verb: "cancel",
        entityId: args.templateId,
        fieldChanges: [{ path: "enabled", op: "set", before: true, after: false }],
      });
    }

    return toCallToolResult({ cancelled: true, templateId: args.templateId });
  }),

  tool("list_available_plugins", "List all installed plugins with their scope and global enabled state. If roleId is provided, shows which plugins are installed in that role's workspace.", listAvailablePluginsShape, async (args) => {
    const globalEnabled = getGlobalEnabledState();
    const allPlugins = listInstalledPlugins();
    const boundPluginIds = args.roleId
      ? (() => {
          const role = getRole(args.roleId!);
          if (!role) return [];
          const wsPath = getRoleWorkspacePath(role.name);
          return listInstalledPlugins({ scope: "project", projectPath: wsPath }).map((p: { id: string }) => p.id);
        })()
      : [];

    return toCallToolResult({
      plugins: allPlugins.map((p) => ({
        id: p.id,
        name: p.name,
        scope: p.scope,
        projectPath: p.projectPath,
        enabled: p.enabled,
        globalEnabled: globalEnabled[p.id] ?? p.enabled,
        isInstalledInRole: boundPluginIds.includes(p.id),
        description: p.version ? `v${p.version}` : undefined,
      })),
    });
  }),

  tool("install_plugin_for_role", "Install a plugin into a role's workspace (project-scope). The plugin will be available when that role executes tasks.", installPluginForRoleShape, async (args) => {
    const role = getRole(args.roleId);
    if (!role) return toCallToolResult({ error: `Role not found: ${args.roleId}` });

    const wsPath = getRoleWorkspacePath(role.name);
    try {
      pluginCli.installPlugin(args.pluginId, "project", wsPath);
      // Phase 4: write entity_mutation receipt
      writeMutationReceipt({
        toolName: "install_plugin_for_role",
        entityType: "plugin",
        verb: "install",
        entityId: args.pluginId,
        fieldChanges: [
          { path: "scope", op: "set", before: null, after: "role" },
          { path: "roleId", op: "set", before: null, after: args.roleId },
        ],
        roleId: args.roleId,
      });
      return toCallToolResult({ success: true, roleId: args.roleId, pluginId: args.pluginId, scope: "project", cwd: wsPath });
    } catch (err) {
      return toCallToolResult({ error: `Failed to install plugin: ${err}` });
    }
  }),

  tool("uninstall_plugin_from_role", "Uninstall a plugin from a role's workspace.", uninstallPluginFromRoleShape, async (args) => {
    const role = getRole(args.roleId);
    if (!role) return toCallToolResult({ error: `Role not found: ${args.roleId}` });

    const wsPath = getRoleWorkspacePath(role.name);
    try {
      pluginCli.uninstallPlugin(args.pluginId, "project", wsPath);
      // Phase 4: write entity_mutation receipt
      writeMutationReceipt({
        toolName: "uninstall_plugin_from_role",
        entityType: "plugin",
        verb: "uninstall",
        entityId: args.pluginId,
        fieldChanges: [{ path: "scope", op: "set", before: "role", after: null }],
        roleId: args.roleId,
      });
      return toCallToolResult({ success: true, roleId: args.roleId, pluginId: args.pluginId });
    } catch (err) {
      return toCallToolResult({ error: `Failed to uninstall plugin: ${err}` });
    }
  }),

  tool("bind_mcp_to_role", "Bind an MCP server configuration to a role. The MCP server will be available to the role during task execution.", bindMcpToRoleShape, async (args) => {
    const role = getRole(args.roleId);
    if (!role) return toCallToolResult({ error: `Role not found: ${args.roleId}` });

    const currentMcpServers = (role.mcpServers ?? {}) as Record<string, unknown>;
    const updatedMcpServers = { ...currentMcpServers, [args.mcpName]: args.mcpConfig };

    try {
      updateRole(args.roleId, { mcpServers: updatedMcpServers });
      ensureRoleWorkspace(role);
      // Phase 4: write entity_mutation receipt
      writeMutationReceipt({
        toolName: "bind_mcp_to_role",
        entityType: "mcp_binding",
        verb: "bind",
        entityId: `${args.roleId}:${args.mcpName}`,
        fieldChanges: [{ path: `mcpServers.${args.mcpName}`, op: "set", before: null, after: args.mcpConfig }],
        roleId: args.roleId,
      });
      return toCallToolResult({ success: true, roleId: args.roleId, mcpName: args.mcpName, mcpServers: updatedMcpServers });
    } catch (err) {
      return toCallToolResult({ error: `Failed to bind MCP server: ${err}` });
    }
  }),

  tool("unbind_mcp_from_role", "Remove an MCP server binding from a role.", unbindMcpFromRoleShape, async (args) => {
    const role = getRole(args.roleId);
    if (!role) return toCallToolResult({ error: `Role not found: ${args.roleId}` });

    const currentMcpServers = { ...(role.mcpServers ?? {}) } as Record<string, unknown>;
    if (!(args.mcpName in currentMcpServers)) {
      return toCallToolResult({ error: `MCP server "${args.mcpName}" not bound to this role` });
    }

    const oldConfig = currentMcpServers[args.mcpName];
    delete currentMcpServers[args.mcpName];

    try {
      updateRole(args.roleId, { mcpServers: currentMcpServers });
      ensureRoleWorkspace(role);
      // Phase 4: write entity_mutation receipt
      writeMutationReceipt({
        toolName: "unbind_mcp_from_role",
        entityType: "mcp_binding",
        verb: "unbind",
        entityId: `${args.roleId}:${args.mcpName}`,
        fieldChanges: [{ path: `mcpServers.${args.mcpName}`, op: "set", before: oldConfig, after: null }],
        roleId: args.roleId,
      });
      return toCallToolResult({ success: true, roleId: args.roleId, mcpName: args.mcpName });
    } catch (err) {
      return toCallToolResult({ error: `Failed to unbind MCP server: ${err}` });
    }
  }),

  tool("get_capabilities", "Get a comprehensive overview of Adam's current capabilities: available roles and their tools, OS capability registry, connected channels, installed plugins, active automations, and execution capacity. Call this when the user asks what you can do, or asks for help.", getCapabilitiesShape, async () => {
    const { listTaskTemplates } = await import("../store/task-templates.js");
    const config = getRuntimeConfig();
    const roles = listRoles(undefined, 100, 0);
    const channels = listChannels();
    const templates = listTaskTemplates(true, 100, 0);
    const running = listTasks("running");
    const pending = listTasks("pending");
    const sandbox = getSandboxProvider();
    const sandboxAvailable = await isSandboxAvailable();

    return toCallToolResult({
      roles: {
        description: "Specialized worker identities — each has its own tools, MCP servers, plugins (skills/agents), and learned rules",
        active: roles.filter(r => r.status === "active" && r.source !== "system").map(r => {
          const pluginCaps = resolveRolePluginCapabilities(r);
          return {
            name: r.name,
            tools: r.allowedTools ?? [],
            osCapabilities: r.osCapabilities ?? [],
            mcpServers: Object.keys(r.mcpServers ?? {}),
            channels: r.allowedChannels ?? [],
            capabilitySummary: generateCapabilitySummary(r, pluginCaps),
            plugins: pluginCaps.plugins.map((p) => ({
              name: p.name,
              skills: p.skills.map((s) => s.name),
              agents: p.agents.map((a) => a.name),
            })),
          };
        }),
        retired: roles.filter(r => r.status === "retired").length,
        probation: roles.filter(r => r.status === "probation").length,
      },
      osCapabilities: {
        description: "Role-level OS capability registry. Only editable entries can be assigned to roles on this runtime.",
        sandbox: {
          platform: sandbox.platform,
          available: sandboxAvailable,
        },
        registry: getResolvedOsCapabilityRegistry(sandbox.platform, sandboxAvailable),
      },
      channels: {
        description: "Send/receive messages via connected platforms",
        connected: channels.filter(c => c.enabled).map(c => ({
          name: c.name, platform: c.platform, status: c.status,
        })),
      },
      plugins: {
        description: "Extensions that add capabilities to roles",
        installed: listInstalledPlugins().filter(p => p.enabled).map(p => ({
          name: p.name, scope: p.scope, description: p.version ? `v${p.version}` : undefined,
        })),
      },
      automations: {
        description: "Recurring cron tasks and event-triggered templates",
        active: templates.map(t => ({ name: t.name, trigger: t.trigger })),
      },
      execution: {
        description: "Parallel task execution pool",
        maxConcurrent: config.execution?.maxConcurrent ?? 5,
        running: running.length,
        queued: pending.length,
      },
      coreFeatures: [
        "Goal management — SMART goals with budget/deadline/metric, auto-decomposition into subtasks",
        "Memory — per-Role vector + keyword searchable memory across tasks",
        "Strategy evolution — Thompson Sampling optimizes task approaches over time",
        "Monitor — automatic quality scoring, role retirement/reinstatement",
        "Delivery engine — event-driven result routing to channels/webhooks",
        "Schedule — cron recurring templates + one-shot delayed tasks",
      ],
    });
  }),

  // ===== Plugin management tools =====

  tool("enable_plugin", "Enable a globally installed plugin (makes it available to all roles).", enablePluginShape, async (args) => {
    try {
      pluginCli.enablePlugin(args.pluginId);
      // Phase 4: write entity_mutation receipt
      writeMutationReceipt({
        toolName: "enable_plugin",
        entityType: "plugin",
        verb: "enable",
        entityId: args.pluginId,
        fieldChanges: [{ path: "enabled", op: "set", before: false, after: true }],
      });
      return toCallToolResult({ success: true, pluginId: args.pluginId });
    } catch (err) {
      return toCallToolResult({ error: `Failed to enable plugin: ${err}` });
    }
  }),

  tool("disable_plugin", "Disable a globally installed plugin (removes it from all roles).", disablePluginShape, async (args) => {
    try {
      pluginCli.disablePlugin(args.pluginId);
      // Phase 4: write entity_mutation receipt
      writeMutationReceipt({
        toolName: "disable_plugin",
        entityType: "plugin",
        verb: "disable",
        entityId: args.pluginId,
        fieldChanges: [{ path: "enabled", op: "set", before: true, after: false }],
      });
      return toCallToolResult({ success: true, pluginId: args.pluginId });
    } catch (err) {
      return toCallToolResult({ error: `Failed to disable plugin: ${err}` });
    }
  }),

  tool("browse_marketplace", "Browse all available plugins from configured marketplaces (shows installed and available).", browseMarketplaceShape, async () => {
    try {
      const available = pluginCli.listAvailablePlugins();
      const installed = listInstalledPlugins();
      return toCallToolResult({ available, installed });
    } catch (err) {
      return toCallToolResult({ error: `Failed to browse marketplace: ${err}` });
    }
  }),

  tool("list_marketplace_sources", "List configured plugin marketplace sources.", listMarketplaceSourcesShape, async () => {
    const sources = listMarketplaceSources();
    return toCallToolResult({ sources });
  }),

  tool("get_plugin_detail", "Get detailed manifest for an installed plugin (skills, agents, MCP servers, hooks).", getPluginDetailShape, async (args) => {
    const entry = getInstalledPlugin(args.pluginId);
    if (!entry) return toCallToolResult({ error: `Plugin not found: ${args.pluginId}` });

    const manifest = getPluginManifest(entry.installPath);
    return toCallToolResult({
      id: entry.id,
      name: entry.name,
      version: entry.version,
      scope: entry.scope,
      projectPath: entry.projectPath,
      enabled: entry.enabled,
      manifest,
    });
  }),

  tool("scan_directory", "Scan a directory for .claude/settings.json and return its plugin/MCP configuration.", scanDirectoryShape, async (args) => {
    const { getRole } = await import("../store/roles.js");
    const role = getRole(args.roleId);
    if (!role) return toCallToolResult({ error: `Role not found: ${args.roleId}` });

    try {
      const config = scanDirectoryConfig(args.path);
      return toCallToolResult({ roleId: args.roleId, path: args.path, config });
    } catch (err) {
      return toCallToolResult({ error: `Failed to scan directory: ${err}` });
    }
  }),

  // ===== Task lifecycle tools =====

  tool("cancel_task", "Cancel a running or pending task by setting its status to 'cancelled'. Emits a task_status_change event.", cancelTaskShape, async (args) => {
    const task = getTask(args.taskId);
    if (!task) return toCallToolResult({ error: `Task not found: ${args.taskId}` });

    const oldStatus = task.status;
    updateTask(args.taskId, { status: "cancelled", completedAt: Date.now() });

    const { serverBus } = await import("../server/events/server-bus.js");
    serverBus.emit({ type: "task_status_change", taskId: args.taskId, oldStatus, newStatus: "cancelled" });
    if (oldStatus === "pending" || oldStatus === "queued" || oldStatus === "running" || oldStatus === "paused") {
      serverBus.emit({ type: "task_abort_requested", taskId: args.taskId, reason: "cancelled" });
    }

    // Phase 4: write entity_mutation receipt
    writeMutationReceipt({
      toolName: "cancel_task",
      entityType: "task",
      verb: "cancel",
      entityId: args.taskId,
      fieldChanges: [
        { path: "status", op: "set", before: oldStatus, after: "cancelled" },
        { path: "completedAt", op: "set", before: undefined, after: Date.now() },
      ],
      taskId: args.taskId,
      roleId: task.roleId,
    });

    return toCallToolResult({ success: true, taskId: args.taskId, status: "cancelled" });
  }),

  tool("view_task_logs", "Retrieve step-by-step execution logs for a task.", viewTaskLogsShape, async (args) => {
    const logs = getStepLogs(args.taskId, args.limit ?? 20);
    return toCallToolResult({ taskId: args.taskId, count: logs.length, logs });
  }),

  // ===== Role + config tools =====

  tool("delete_role", "Delete a role by ID. This removes the role and its workspace.", deleteRoleShape, async (args) => {
    const role = getRole(args.roleId);
    if (!role) return toCallToolResult({ error: `Role not found: ${args.roleId}` });

    deleteRole(args.roleId);
    if (!getRole(args.roleId)) {
      recordAdamToolRuntimeEffect({
        toolName: "delete_role",
        effectType: "delete",
        effectCategory: "role_update",
        entityType: "role",
        entityId: args.roleId,
        before: role,
      });
      // Phase 4: write entity_mutation receipt
      writeMutationReceipt({
        toolName: "delete_role",
        entityType: "role",
        verb: "delete",
        entityId: args.roleId,
        fieldChanges: [{ path: "_entity", op: "set", before: { id: role.id, name: role.name, status: role.status }, after: null }],
      });
    }
    return toCallToolResult({ success: true, roleId: args.roleId });
  }),

  tool("view_config", "Get the current runtime configuration (mutable fields and restart-required fields).", viewConfigShape, async () => {
    const { MUTABLE_PATHS, RESTART_REQUIRED_PATHS } = await import("../config/runtime.js");
    const config = getRuntimeConfig();

    // Fetch via HTTP to reuse REST API logic
    let restConfig: Record<string, unknown> = {};
    try {
      const port = getRuntimeConfig().server?.port ?? 7100;
      const res = await fetch(`http://127.0.0.1:${port}/config`);
      if (res.ok) restConfig = await res.json() as Record<string, unknown>;
    } catch { /* fallback to runtime config */ }

    const mutable = [...MUTABLE_PATHS, ...RESTART_REQUIRED_PATHS] as readonly string[];
    const restartRequired = [...RESTART_REQUIRED_PATHS] as readonly string[];

    // Build path → { value, mutable }
    const result: Record<string, { value: unknown; mutable: boolean }> = {};
    for (const path of mutable) {
      const keys = path.split(".");
      let val: unknown = config;
      for (const k of keys) {
        if (val && typeof val === "object") val = (val as Record<string, unknown>)[k];
        else { val = undefined; break; }
      }
      result[path] = { value: val, mutable: !RESTART_REQUIRED_PATHS.includes(path as typeof RESTART_REQUIRED_PATHS[number]) };
    }

    return toCallToolResult({ config: result, mutable: [...MUTABLE_PATHS], restartRequired: [...RESTART_REQUIRED_PATHS] });
  }),

  tool(
    "read_config_doc",
    "Read a config-doc YAML file produced by a previous export and return its header structure (schemaVersion, template/role inventories, dependency manifest, placeholder manifest, ledger owners, and the inventory of anchor ids) PLUS the structured portable config (templates + roles) in a `config` field. The structured config carries verbatim fields as `{__anchor}` refs (not verbatim bytes) and env fields as `${TOKEN}` strings — sufficient to reconstruct via create_role / create_template without pulling long free-text into context. This tool NEVER returns verbatim anchor content (cagPrompt / step.prompt / persona.speakAs / customAssertions). To bring a verbatim field into a create_role or create_template call, use the *Ref params (cagPromptRef / promptRef / personaSpeakAsRef / customAssertionRefs[]) on those tools — those read bytes directly via the parser, never via this surface. The docPath must resolve inside the configured export dir (~/.adam/config-exports/ by default); traversal and out-of-dir paths are rejected.",
    readConfigDocShape,
    async (args) => {
      // Validate path inside export dir BEFORE reading — defeats `..` and symlink escape.
      let safePath: string;
      try {
        safePath = assertDocPathInExportDir(args.docPath);
      } catch (err) {
        return toCallToolResult({ error: (err as Error).message });
      }
      // Read file. Use readFileSync (sync) — these docs are small and this tool is not on a hot path.
      let text: string;
      try {
        text = readFileSync(safePath, "utf8");
      } catch (err) {
        return toCallToolResult({ error: `read_config_doc: cannot read file "${safePath}": ${(err as Error).message}` });
      }
      // Parse; surface any integrity violations as a structured error.
      let parsed: ReturnType<typeof parseConfigDoc>;
      try {
        parsed = parseConfigDoc(text);
      } catch (err) {
        return toCallToolResult({ error: (err as Error).message });
      }
      // Return the header summary PLUS the structured config (if present).
      // Phase 1 docs do not have a machine block; the header-only contract
      // is preserved by returning the summary without a `config` field. A
      // malformed machine block is a hard error (fail-closed — the importer
      // is told the doc is unreadable for reconstruction rather than getting
      // a half-populated result).
      let config: ReturnType<typeof parsePortableConfig> | undefined;
      try {
        config = parsePortableConfig(text);
      } catch (err) {
        const msg = (err as Error).message;
        // Missing machine block is a Phase 1 doc — return header-only.
        if (/machine block missing/.test(msg)) {
          // Fall through to header-only return below.
        } else {
          // Malformed machine block, prototype-pollution key, dangling
          // anchor, or step roleId not in roles — all fail-closed.
          return toCallToolResult({ error: msg });
        }
      }
      // Explicitly omit any anchor bytes — they are pulled via `*Ref` params
      // on create_role / create_template, not exposed through this read
      // surface (per threat model: read returns structure, not verbatim
      // content, so an LLM-influenced read cannot exfiltrate long free-text
      // fields through a single tool call).
      return toCallToolResult({
        schemaVersion: parsed.header.schemaVersion,
        exportedAt: parsed.header.exportedAt,
        templates: parsed.header.templates,
        roles: parsed.header.roles,
        dependencies: parsed.header.dependencies,
        placeholders: parsed.header.placeholders,
        ledgerOwners: parsed.header.ledgerOwners,
        anchorIds: parsed.anchorIds,
        ...(config !== undefined ? { config } : {}),
      });
    },
  ),

  tool(
    "check_config_doc_dependencies",
    "Check a config-doc's declared plugin/skill dependencies against the live installed set. Refuses to proceed when a required plugin or skill is absent (returns `ok: false` with the missing names). mcpServer deps are surfaced as warnings (their config is placeholder-bound, not auto-installed). The docPath must resolve inside the configured export dir. This is the gate that runs BEFORE building anything — pass it before invoking create_role / create_template to reconstruct a doc.",
    readConfigDocShape,
    async (args) => {
      // Validate path inside export dir BEFORE reading.
      let safePath: string;
      try {
        safePath = assertDocPathInExportDir(args.docPath);
      } catch (err) {
        return toCallToolResult({ error: (err as Error).message });
      }
      // Read + parse header (no need for the machine block — the dependency
      // manifest lives in the header).
      let text: string;
      try {
        text = readFileSync(safePath, "utf8");
      } catch (err) {
        return toCallToolResult({ error: `check_config_doc_dependencies: cannot read file "${safePath}": ${(err as Error).message}` });
      }
      let parsed: ReturnType<typeof parseConfigDoc>;
      try {
        parsed = parseConfigDoc(text);
      } catch (err) {
        return toCallToolResult({ error: (err as Error).message });
      }
      // Load the installed snapshot from the live registry. If the registry
      // read fails, the gate treats every dep as missing (fail-closed).
      let snapshot;
      try {
        snapshot = loadInstalledSnapshot();
      } catch (err) {
        return toCallToolResult({
          error: `check_config_doc_dependencies: installed plugin registry unreadable: ${(err as Error).message}`,
        });
      }
      const result = checkImportDependencies(parsed.header.dependencies, snapshot);
      return toCallToolResult(result);
    },
  ),

  tool(
    "verify_imported_config",
    "Verify a freshly imported Template + Role set against a config-doc's structural contract. Returns {ok, mismatches[]}. The check is READ-ONLY — it never mutates the built entities. `builtTemplateId` is the id returned by create_template; `builtRoleIds` is the array of ids returned by create_role (in the order they were created). `roleIdMap` maps each doc source roleId to the newly created built roleId (ChatManager tracks this when it mints new ids for import). The docPath must resolve inside the configured export dir. The mismatches[] entries name the exact failing step / edge / key / role-field (path field) so the import orchestrator can pinpoint the rebuild failure. Runs after rebuild but BEFORE reporting success to the user.",
    {
      builtTemplateId: templateIdSchema.describe("Id of the built template (returned by create_template)."),
      builtRoleIds: z.array(roleIdSchema).describe("Ids of the built roles (each returned by create_role)."),
      docPath: localFilePathSchema.describe("Absolute path to the config-doc YAML. Must resolve inside the configured export dir."),
      roleIdMap: z.record(z.string(), z.string()).describe("Source roleId (key, from the doc) -> built roleId (value, returned by create_role). ChatManager builds this map as it creates roles during import."),
    },
    async (args) => {
      // Validate path inside export dir BEFORE reading.
      let safePath: string;
      try {
        safePath = assertDocPathInExportDir(args.docPath);
      } catch (err) {
        return toCallToolResult({ error: (err as Error).message });
      }
      // Read + parse the doc.
      let text: string;
      try {
        text = readFileSync(safePath, "utf8");
      } catch (err) {
        return toCallToolResult({ error: `verify_imported_config: cannot read file "${safePath}": ${(err as Error).message}` });
      }
      // Parse header (anchor validation); parse machine block (structural contract).
      let portable: ReturnType<typeof parsePortableConfig>;
      try {
        portable = parsePortableConfig(text);
      } catch (err) {
        return toCallToolResult({ error: `verify_imported_config: ${(err as Error).message}` });
      }
      const result = verifyImportedConfig({
        builtTemplateId: args.builtTemplateId,
        builtRoleIds: args.builtRoleIds,
        expected: portable,
        roleIdMap: args.roleIdMap,
      });
      return toCallToolResult(result);
    },
  ),

  tool("update_config", "Update mutable runtime configuration fields. Returns partial-success: some fields may update while others return errors.", updateConfigShape, async (args) => {
    const { isRestartRequiredPath } = await import("../config/runtime.js");
    const { setConfigValue } = await import("../store/config.js");
    const result = updateMutableConfig(args.updates, setConfigValue);
    for (const path of result.updated) {
      recordAdamToolRuntimeEffect({
        toolName: "update_config",
        effectType: "update",
        effectCategory: "config_update",
        entityType: "config",
        entityId: path,
        fieldPath: path,
        after: args.updates[path],
      });
      // Phase 4: write entity_mutation receipt per updated field
      writeMutationReceipt({
        toolName: "update_config",
        entityType: "config_field",
        verb: "update",
        entityId: path,
        fieldChanges: [{ path: "value", op: "set", before: undefined, after: args.updates[path] }],
      });
    }

    // Sync logging level change immediately
    if (args.updates["logging.level"]) {
      setLogLevel(args.updates["logging.level"] as Parameters<typeof setLogLevel>[0]);
    }

    // Emit config_changed event
    if (result.updated.length > 0) {
      const { serverBus } = await import("../server/events/server-bus.js");
      serverBus.emit({
        type: "config_changed",
        changes: result.updated.map(path => ({ path, value: args.updates[path] })),
      });
    }

    return toCallToolResult(result);
  }),

  // ===== Memory + template + delivery + strategy tools =====

  tool("list_memories", "List memories stored under a specific role.", listMemoriesShape, async (args) => {
    const memories = listMemoriesByRole(args.roleId, args.limit ?? 20);
    return toCallToolResult({ roleId: args.roleId, count: memories.length, memories });
  }),

  tool("update_template", "Update a task template's fields (name, prompt, cron, enabled, Belief Ledger step fields, etc.). Belief Ledger step fields: settlementLedgerOwner (open with self-falsification settlement block for due predictions), publishesClaimsTo (record this step's claims-artifact to a ledger owner), settlesPredictionsFor (settle due predictions from this step's verdict-artifact), openLedgerOwner / openLedgerLookbackDays (open with a 开放问题/承接·展开 block for recent unsettled predictions; disjoint from settlement by age).", updateTemplateShape, async (args) => {
    const template = getTaskTemplate(args.templateId);
    if (!template) return toCallToolResult({ error: `Template not found: ${args.templateId}` });

    const updates: Partial<import("../shared/types.js").TaskTemplate> = {};
    if (args.name !== undefined) updates.name = args.name;
    if (args.enabled !== undefined) updates.enabled = args.enabled;

    if (args.steps !== undefined) {
      updates.steps = args.steps.map(mapTemplateStepInput);
    }

    // Step-level field changes either target stepId or the only step in a single-step Template.
    const stepFieldsChanging =
      args.prompt !== undefined ||
      args.roleId !== undefined ||
      args.autoSelectRole !== undefined ||
      args.requirements !== undefined ||
      args.outputAs !== undefined ||
      args.consumesFrom !== undefined ||
      args.consumesFromOptional !== undefined ||
      args.persona !== undefined ||
      args.outputContract !== undefined ||
      args.minDependencies !== undefined ||
      args.settlementLedgerOwner !== undefined ||
      args.publishesClaimsTo !== undefined ||
      args.settlesPredictionsFor !== undefined ||
      args.openLedgerOwner !== undefined ||
      args.openLedgerLookbackDays !== undefined ||
      (args.stepId !== undefined && args.config !== undefined);
    if (stepFieldsChanging && args.steps !== undefined) {
      return toCallToolResult({ error: "Use either full steps[] replacement or stepId-targeted fields, not both" });
    }
    if (stepFieldsChanging) {
      const steps = template.steps?.length ? template.steps.map((step) => ({ ...step })) : [];
      const targetIndex = args.stepId !== undefined
        ? steps.findIndex((step) => step.id === args.stepId)
        : (steps.length === 1 ? 0 : -1);
      if (targetIndex < 0) {
        return toCallToolResult({
          error: args.stepId
            ? `Step not found: ${args.stepId}`
            : "stepId is required when updating steps on a multi-step Template",
        });
      }
      const current = steps[targetIndex];
      steps[targetIndex] = {
        ...current,
        ...(args.prompt !== undefined ? { prompt: args.prompt } : {}),
        ...(args.roleId !== undefined ? { roleId: args.roleId } : {}),
        ...(args.autoSelectRole !== undefined ? { autoSelectRole: args.autoSelectRole } : {}),
        ...(args.requirements !== undefined ? { requirements: args.requirements } : {}),
        ...(args.outputAs !== undefined ? { outputAs: args.outputAs } : {}),
        ...(args.consumesFrom !== undefined ? { consumesFrom: args.consumesFrom } : {}),
        ...(args.consumesFromOptional !== undefined ? { consumesFromOptional: args.consumesFromOptional } : {}),
        ...(args.persona !== undefined ? { persona: args.persona } : {}),
        ...(args.outputContract !== undefined ? { outputContract: args.outputContract } : {}),
        ...(args.minDependencies !== undefined ? { minDependencies: args.minDependencies } : {}),
        ...(args.settlementLedgerOwner !== undefined ? { settlementLedgerOwner: args.settlementLedgerOwner } : {}),
        ...(args.publishesClaimsTo !== undefined ? { publishesClaimsTo: args.publishesClaimsTo } : {}),
        ...(args.settlesPredictionsFor !== undefined ? { settlesPredictionsFor: args.settlesPredictionsFor } : {}),
        ...(args.openLedgerOwner !== undefined ? { openLedgerOwner: args.openLedgerOwner } : {}),
        ...(args.openLedgerLookbackDays !== undefined ? { openLedgerLookbackDays: args.openLedgerLookbackDays } : {}),
        ...(args.config !== undefined ? { config: args.config as TaskStep["config"] } : {}),
      };
      // Role-tagging (outputContract.expectedArtifacts) was removed in the single-vocabulary
      // pure design — contract granularity is the artifact key (outputAs), enforced by the
      // Layer A presence gate. No expectedArtifacts→outputAs cross-check remains.
      updates.steps = steps;
    }

    if (args.triggerCron !== undefined || args.triggerEvent !== undefined ||
        args.triggerType !== undefined || args.eventDefId !== undefined) {
      const triggerResult = buildTemplateTriggerFromArgs({
        triggerType: args.triggerType,
        triggerCron: args.triggerCron,
        triggerEvent: args.triggerEvent,
        eventDefId: args.eventDefId,
      });
      if ("error" in triggerResult) {
        return toCallToolResult({ error: triggerResult.error });
      }
      updates.trigger = triggerResult.trigger;
    }
    if (args.config !== undefined && !stepFieldsChanging) {
      updates.config = args.config as Record<string, unknown>;
    }
    if (args.deliverTo !== undefined) {
      updates.deliverTo = await resolveDeliveryTargets(
        args.deliverTo as Array<{ type: string; sessionId?: string; channelName?: string; channelId?: string; chatId?: string }>,
      );
    }
    if (args.reportTo !== undefined) {
      updates.reportTo = await resolveDeliveryTargets(
        args.reportTo as Array<{ type: string; sessionId?: string; channelName?: string; channelId?: string; chatId?: string }>,
      );
    }

    try {
      updateTaskTemplate(args.templateId, updates);
    } catch (err) {
      const { TemplateRoleConfigError, TemplateValidationError } = await import("../store/task-templates.js");
      if (err instanceof TemplateRoleConfigError) {
        return toCallToolResult({
          code: err.code,
          error: err.message,
          failingStepIds: err.failingStepIds,
          hint: "Set roleId (recommended) OR autoSelectRole=true with a requirements object.",
        });
      }
      if (err instanceof TemplateValidationError) {
        return toCallToolResult({
          code: err.code,
          error: err.message,
          failingStepIds: err.failingStepIds,
        });
      }
      throw err;
    }

    // Reschedule the running bree engine when the trigger or enabled state changed.
    // Without this, enabling a cron template / changing its cron via this tool only
    // writes the DB row — the live scheduler keeps the stale schedule until restart
    // (the REST PATCH route reschedules; this tool must match it to stay hot-reload-safe).
    if (updates.trigger !== undefined || updates.enabled !== undefined) {
      const { getBreeEngine } = await import("../scheduler/bree-engine.js");
      const bree = getBreeEngine();
      if (bree) {
        await bree.unscheduleJob(args.templateId);
        const fresh = getTaskTemplate(args.templateId);
        if (fresh?.enabled && fresh.trigger.type === "cron" && fresh.trigger.cron) {
          await bree.scheduleJob(args.templateId);
        } else if (fresh?.enabled && fresh.trigger.type === "once" && fresh.trigger.runAt) {
          bree.scheduleOnceJob(args.templateId);
        }
      }
    }

    const updatedTemplate = getTaskTemplate(args.templateId);
    if (updatedTemplate) {
      for (const fieldPath of collectTemplateUpdateFieldPaths(args as Record<string, unknown>, template)) {
        recordAdamToolRuntimeEffect({
          toolName: "update_template",
          effectType: "update",
          effectCategory: "template_update",
          entityType: "task_template",
          entityId: args.templateId,
          fieldPath,
          before: fullTemplateDetail(template),
          after: fullTemplateDetail(updatedTemplate),
        });
      }
      // Phase 4: write entity_mutation receipt
      const fieldPaths = collectTemplateUpdateFieldPaths(args as Record<string, unknown>, template);
      const beforeDetail = fullTemplateDetail(template) as Record<string, unknown>;
      const afterDetail = fullTemplateDetail(updatedTemplate) as Record<string, unknown>;
      const fieldChanges = fieldPaths
        .map((path) => ({
          path,
          op: "set" as const,
          before: pickFieldByPath(beforeDetail, path),
          after: pickFieldByPath(afterDetail, path),
        }))
        .filter((fc) => fc.before !== undefined || fc.after !== undefined);
      if (fieldChanges.length > 0) {
        writeMutationReceipt({
          toolName: "update_template",
          entityType: "task_template",
          verb: "update",
          entityId: args.templateId,
          fieldChanges,
        });
      }
    }
    return toCallToolResult({
      success: true,
      templateId: args.templateId,
      updated: Object.keys(updates),
      template: updatedTemplate ? fullTemplateDetail(updatedTemplate) : undefined,
    });
  }),

  tool(
    "get_template_dependents",
    "Count template_executions and tasks that depend on a template. Use this BEFORE delete_template to show the user what will be affected. Returns { executionCount, taskCount, templateExecutions, hasDependents }. If hasDependents is false, delete_template is safe with mode='template_only'. If true, you MUST ask the user whether to delete the template only (keeps tasks as history) or delete with its tasks (removes tasks and their score history). Never pick the mode yourself.",
    getTemplateDependentsShape,
    async (args) => {
      const template = getTaskTemplate(args.templateId);
      if (!template) return toCallToolResult({ error: `Template not found: ${args.templateId}` });
      const dependents = getTaskTemplateDependents(args.templateId);
      return toCallToolResult({
        templateId: args.templateId,
        templateName: template.name,
        executionCount: dependents.executionCount,
        templateExecutions: dependents.executionCount,
        taskCount: dependents.taskCount,
        hasDependents: dependents.executionCount > 0 || dependents.taskCount > 0,
      });
    },
  ),

  tool(
    "delete_template",
    "Delete a task template by ID. PRECONDITION: you must have called get_template_dependents first. If executionCount > 0 or taskCount > 0, you must have shown the user those counts and received explicit confirmation of which mode to use. Call this tool only after the user picks 'template_only' or 'with_tasks'. Passing a mode without user confirmation violates the skill's safety contract.",
    deleteTemplateShape,
    async (args) => {
      const template = getTaskTemplate(args.templateId);
      if (!template) return toCallToolResult({ error: `Template not found: ${args.templateId}` });

      const dependents = getTaskTemplateDependents(args.templateId);
      deleteTaskTemplate(args.templateId, args.mode);
      if (!getTaskTemplate(args.templateId)) {
        recordAdamToolRuntimeEffect({
          toolName: "delete_template",
          effectType: "delete",
          effectCategory: "template_update",
          entityType: "task_template",
          entityId: args.templateId,
          before: fullTemplateDetail(template),
        });
        // Phase 4: write entity_mutation receipt
        writeMutationReceipt({
          toolName: "delete_template",
          entityType: "task_template",
          verb: "delete",
          entityId: args.templateId,
          fieldChanges: [{ path: "_entity", op: "set", before: fullTemplateDetail(template), after: null }],
        });
      }

      return toCallToolResult({
        success: true,
        templateId: args.templateId,
        templateName: template.name,
        mode: args.mode,
        deleted: {
          template: 1,
          templateExecutions: dependents.executionCount,
          tasks: args.mode === "with_tasks" ? dependents.taskCount : 0,
        },
      });
    },
  ),

  tool(
    "migrate_template_outputAs",
    "Apply outputAs values to template steps that don't have them. Read each step's prompt and propose a sensible outputAs name based on the step's stated purpose. Use this when upgrading a legacy template to the schema-enforced output contract. Only fills missing outputAs — does not overwrite existing values.",
    {
      templateId: templateIdSchema.describe("Template ID to migrate. Use list_templates to find IDs."),
      mapping: z.record(z.string(), z.string()).describe("Map of stepId → proposed outputAs. Only steps in this mapping are updated; steps already having outputAs are skipped. Example: {\"达芬奇采集\": \"素材摘要\", \"达芬奇写稿\": \"播客草稿\"}"),
      dryRun: z.boolean().optional().default(false).describe("If true, return what would change without applying."),
    },
    async (args) => {
      const { KEY_REGEX } = await import("./execution-tools.js");

      const template = getTaskTemplate(args.templateId);
      if (!template) return toCallToolResult({ error: `Template not found: ${args.templateId}` });

      const steps = (template.steps ?? []) as import("../shared/types.js").TaskStep[];
      const changes: Array<{ stepId: string; before: string | null; after: string }> = [];
      const errors: Array<{ stepId: string; reason: string }> = [];

      for (const [stepId, proposedOutputAs] of Object.entries(args.mapping)) {
        // Validate proposed value against KEY_REGEX BEFORE looking up step (per Threat Model:
        // outputAs flows to artifact key → blob path; validation at migration boundary)
        if (!KEY_REGEX.test(proposedOutputAs)) {
          errors.push({
            stepId,
            reason: `invalid outputAs "${proposedOutputAs}" — must match ${KEY_REGEX.toString()} (alphanumeric, dot, underscore, dash; 1-256 chars)`,
          });
          continue;
        }
        const step = steps.find((s) => s.id === stepId);
        if (!step) {
          errors.push({ stepId, reason: "step not found in template" });
          continue;
        }
        if (step.outputAs && step.outputAs.length > 0) {
          // Don't overwrite — surface as info, not error
          changes.push({ stepId, before: step.outputAs, after: step.outputAs });
          continue;
        }
        changes.push({ stepId, before: null, after: proposedOutputAs });
        if (!args.dryRun) {
          step.outputAs = proposedOutputAs;
        }
      }

      if (!args.dryRun) {
        updateTaskTemplate(args.templateId, { steps });
        const updated = getTaskTemplate(args.templateId);
        if (updated) {
          for (const change of changes.filter((c) => c.before === null)) {
            recordAdamToolRuntimeEffect({
              toolName: "migrate_template_outputAs",
              effectType: "update",
              effectCategory: "template_update",
              entityType: "task_template",
              entityId: args.templateId,
              fieldPath: `steps.${change.stepId}.outputAs`,
              after: change.after,
            });
          }
          // Phase 4: write entity_mutation receipt
          const stepUpdates = changes.filter((c) => c.before === null);
          if (stepUpdates.length > 0) {
            writeMutationReceipt({
              toolName: "migrate_template_outputAs",
              entityType: "task_template",
              verb: "update",
              entityId: args.templateId,
              fieldChanges: stepUpdates.map(({ stepId, before, after }) => ({
                path: `steps.${stepId}.outputAs`, op: "set" as const, before, after,
              })),
            });
          }
        }
      }

      return toCallToolResult({
        applied: !args.dryRun,
        changes,
        errors,
        summary: `${changes.filter((c) => c.before === null).length} added, ${changes.filter((c) => c.before !== null).length} skipped (already set), ${errors.length} errors`,
      });
    },
  ),

  tool("run_template", "Trigger a template immediately using the Template execution path.", runTemplateShape, async (args) => {
    const template = getTaskTemplate(args.templateId);
    if (!template) return toCallToolResult({ error: `Template not found: ${args.templateId}` });

    try {
      const { getBreeEngine } = await import("../scheduler/bree-engine.js");
      const engine = getBreeEngine();
      const originReportTo = getOriginReportTo();
      const dispatchContext = { originReportTo, triggerContext: { source: "adam-tools" } };
      const executionId = engine
        ? await engine.runNow(args.templateId, dispatchContext)
        : uuidv4();
      if (!engine) {
        const { dispatchTemplate } = await import("../scheduler/template-dispatch.js");
        void dispatchTemplate(template, { executionId, ...dispatchContext }).catch((err) => {
          log.error({ templateId: args.templateId, executionId, error: err }, "run_template execution failed");
        });
      }
      recordAdamToolRuntimeEffect({
        toolName: "run_template",
        effectType: "create",
        effectCategory: "template_execution_started",
        entityType: "template_execution",
        entityId: executionId,
        after: { templateId: args.templateId, executionId },
      });
      // Phase 4: write entity_mutation receipt
      writeMutationReceipt({
        toolName: "run_template",
        entityType: "template_execution",
        verb: "create",
        entityId: executionId,
        fieldChanges: [{ path: "_entity", op: "set", before: null, after: { executionId, templateId: args.templateId, triggeredBy: "manual" } }],
      });
      return toCallToolResult({ success: true, templateId: args.templateId, templateName: template.name, executionId, status: "started" });
    } catch (err) {
      return toCallToolResult({ error: `Failed to trigger template: ${err}` });
    }
  }),

  // === Template Version History (Phase 0.5) ===

  tool("list_template_versions", "List all saved versions of a task template, newest first. Each version contains the pre-change snapshot, the reason it was captured (update/delete/restore), the author, and the trace ID. Use this before diffing or restoring — the versionNo is the integer you need.", { templateId: templateIdSchema.describe("Template ID whose version history to list.") }, async (args) => {
    const template = getTaskTemplate(args.templateId);
    if (!template) return toCallToolResult({ error: `Template not found: ${args.templateId}` });
    const versions = listTemplateVersions(args.templateId);
    return toCallToolResult({
      templateId: args.templateId,
      templateName: template.name,
      count: versions.length,
      versions: versions.map((v) => ({
        versionNo: v.versionNo,
        reason: v.reason,
        author: v.author,
        traceId: v.traceId,
        createdAt: v.createdAt,
        snapshotName: v.snapshot.name,
      })),
    });
  }),

  tool("diff_template_versions", "Show field-level differences between two versions of a template. Walks steps by step id, config keys (excluding last_run_at), and top-level fields. Returns an array of {path, before, after} entries. Use this to understand what changed before restoring.", {
    templateId: templateIdSchema.describe("Template ID whose versions to diff."),
    a: z.number().int().positive().describe("Earlier version number."),
    b: z.number().int().positive().describe("Later version number."),
  }, async (args) => {
    const va = getTemplateVersion(args.templateId, args.a);
    if (!va) return toCallToolResult({ error: `Version not found: ${args.templateId}#${args.a}` });
    const vb = getTemplateVersion(args.templateId, args.b);
    if (!vb) return toCallToolResult({ error: `Version not found: ${args.templateId}#${args.b}` });
    const diffs = diffTemplateVersions(va.snapshot, vb.snapshot);
    return toCallToolResult({
      templateId: args.templateId,
      a: args.a,
      b: args.b,
      changeCount: diffs.length,
      changes: diffs,
    });
  }),

  tool("restore_template_version", "Restore a template's content to a previous version. Non-destructive: the current content is first captured as a new 'restore' version, then the old content is written back. The version history is preserved. Restore does NOT change the enabled flag — operators re-enable separately if needed.", {
    templateId: templateIdSchema.describe("Template ID to restore."),
    versionNo: z.number().int().positive().describe("Version number to restore to (from list_template_versions)."),
  }, async (args) => {
    const version = getTemplateVersion(args.templateId, args.versionNo);
    if (!version) return toCallToolResult({ error: `Version not found: ${args.templateId}#${args.versionNo}` });
    try {
      const result = restoreTemplateVersion(args.templateId, args.versionNo);
      const after = getTaskTemplate(args.templateId);
      recordAdamToolRuntimeEffect({
        toolName: "restore_template_version",
        effectType: "update",
        effectCategory: "template_restore",
        entityType: "task_template",
        entityId: args.templateId,
        after: { restoredFromVersion: args.versionNo, preRestoreVersionNo: result.preRestoreVersionNo, currentName: after?.name },
      });
      writeMutationReceipt({
        toolName: "restore_template_version",
        entityType: "task_template",
        verb: "update",
        entityId: args.templateId,
        fieldChanges: [
          { path: "restored_from_version", op: "set", before: null, after: args.versionNo },
          { path: "pre_restore_version", op: "set", before: null, after: result.preRestoreVersionNo },
        ],
      });
      return toCallToolResult({
        success: true,
        templateId: args.templateId,
        restoredFromVersion: result.restoredFromVersion,
        preRestoreVersionNo: result.preRestoreVersionNo,
        currentName: after?.name,
      });
    } catch (err) {
      return toCallToolResult({ error: `Failed to restore template version: ${err instanceof Error ? err.message : String(err)}` });
    }
  }),

  tool("list_delivery_rules", "List delivery rules, optionally filtered by enabled status.", listDeliveryRulesShape, async (args) => {
    const rules = listDeliveryRules(args.enabled);
    return toCallToolResult({ count: rules.length, rules });
  }),

  tool("query_delivery_history",
    "USE THIS for ANY question about delivery status, channel sends, what-was-sent, who-received, send result, success/failure of outbound. Returns structured rows: channelId, status (delivered|pending|failed|expired), messageType, deliveredAt timestamp, error message (if failed), traceId, executionId. Includes group-by counts (by channelId and by status). DO NOT answer delivery questions from session memory — always call this tool first.",
    queryDeliveryHistoryShape,
    async (args) => {
      try {
        const db = getDb();
        const params: unknown[] = [];
        const conditions: string[] = [];

        if (args.executionId) {
          conditions.push("dl.execution_id = ?");
          params.push(args.executionId);
        }
        if (args.taskId) {
          conditions.push("dl.task_id = ?");
          params.push(args.taskId);
        }
        if (args.channelId) {
          conditions.push("json_extract(dl.target, '$.channelId') = ?");
          params.push(args.channelId);
        }
        if (args.timeRangeStart !== undefined) {
          conditions.push("dl.created_at >= ?");
          params.push(args.timeRangeStart);
        }
        if (args.timeRangeEnd !== undefined) {
          conditions.push("dl.created_at <= ?");
          params.push(args.timeRangeEnd);
        }

        const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
        const limit = args.limit ?? 50;
        params.push(limit);

        const rows = db.prepare(
          `SELECT dl.*, dl.target as target_json FROM delivery_log dl ${where} ORDER BY dl.created_at DESC LIMIT ?`
        ).all(...params) as Array<{
          id: string; rule_id: string; task_id: string | null; execution_id: string | null;
          status: string; target: string; content: string; attempts: number; error: string | null;
          created_at: number; delivered_at: number | null; expires_at: number;
          source: string | null; message_type: string | null; trace_id: string | null;
        }>;

        const items = rows.map((row) => {
          let parsedTarget: Record<string, unknown> = {};
          try { parsedTarget = JSON.parse(row.target); } catch { /* use empty */ }
          return {
            id: row.id,
            taskId: row.task_id,
            executionId: row.execution_id,
            ruleId: row.rule_id,
            status: row.status,
            channelId: parsedTarget.channelId as string | undefined,
            chatId: parsedTarget.chatId as string | undefined,
            sessionId: parsedTarget.sessionId as string | undefined,
            webhookUrl: parsedTarget.webhookUrl as string | undefined,
            content: row.content,
            attempts: row.attempts,
            error: row.error ?? undefined,
            messageType: row.message_type ?? undefined,
            createdAt: row.created_at,
            deliveredAt: row.delivered_at ?? undefined,
            traceId: row.trace_id ?? undefined,
          };
        });

        // Compute counts in a single pass
        const total = items.length;
        const byChannel: Record<string, number> = {};
        const byStatus: Record<string, number> = {};
        for (const item of items) {
          if (item.channelId) byChannel[item.channelId] = (byChannel[item.channelId] ?? 0) + 1;
          byStatus[item.status] = (byStatus[item.status] ?? 0) + 1;
        }

        return toCallToolResult({
          items,
          counts: { total, byChannel, byStatus },
          hasMore: items.length === limit,
        });
      } catch (err) {
        return toCallToolResult({ error: err instanceof Error ? err.message : String(err) });
      }
    }
  ),

  tool("query_execution_status",
    "Query the authoritative status of a TemplateExecution (one row from template_executions + per-step status + receipt counts grouped by verb). USE THIS when the user asks 'did the scheduled task run', 'how did the podcast go', or 'what step is X at'. Returns: { id, templateId, status, stepStatuses, startedAt, completedAt, error, deliveryCounts }. DO NOT answer execution-status questions from session memory.",
    queryExecutionStatusShape,
    async (args) => {
      try {
        const execution = getTemplateExecution(args.executionId);
        if (!execution) {
          return toCallToolResult({ error: `Execution not found: ${args.executionId}` });
        }

        // Canonical delivery receipt rollup for this execution is delivery_log by status
        // (each delivery_log row with a corresponding effect_receipt is written together by OutboundGateway)
        const db = getDb();
        const deliveryCountsRows = db.prepare(
          "SELECT status, COUNT(*) AS n FROM delivery_log WHERE execution_id = ? GROUP BY status"
        ).all(args.executionId) as Array<{ status: string; n: number }>;

        const deliveryCounts: Record<string, number> = {};
        for (const row of deliveryCountsRows) {
          deliveryCounts[row.status] = row.n;
        }

        return toCallToolResult({
          id: execution.id,
          templateId: execution.templateId,
          status: execution.status,
          stepStatuses: execution.stepStatuses,
          startedAt: execution.startedAt,
          completedAt: execution.completedAt,
          error: execution.error,
          deliveryCounts,
        });
      } catch (err) {
        return toCallToolResult({ error: err instanceof Error ? err.message : String(err) });
      }
    }
  ),

  tool(
    "cancel_execution",
    "Cancel a running TemplateExecution by its execution id. Cancels every step task whose status is running, pending, queued, or paused. Does NOT cancel steps that are already completed, failed, cancelled, or skipped. Returns { success, executionId, cancelledTaskIds }. Use this when the user asks to stop a running pipeline — they only need to know the execution id, not individual step task ids.",
    cancelExecutionShape,
    async (args) => {
      try {
        const execution = getTemplateExecution(args.executionId);
        if (!execution) {
          return toCallToolResult({ error: `Execution not found: ${args.executionId}` });
        }

        const { serverBus } = await import("../server/events/server-bus.js");
        const cancelledTaskIds: string[] = [];

        const CANCELLABLE_STATUSES = new Set(["pending", "queued", "running", "paused"]);

        for (const [, stepStatus] of Object.entries(execution.stepStatuses)) {
          const { taskId, status } = stepStatus;
          if (!taskId || !CANCELLABLE_STATUSES.has(status)) continue;

          const task = getTask(taskId);
          if (!task) continue;
          // Guard on the LIVE task status, not the (possibly stale) step snapshot: a step can
          // read "running" while the task has already reached a terminal state. Never overwrite
          // a terminal task's status/completedAt. Mirrors cancel_task's non-terminal guard.
          if (!CANCELLABLE_STATUSES.has(task.status)) continue;

          const oldStatus = task.status;
          updateTask(taskId, { status: "cancelled", completedAt: Date.now() });
          serverBus.emit({ type: "task_status_change", taskId, oldStatus, newStatus: "cancelled" });
          serverBus.emit({ type: "task_abort_requested", taskId, reason: "cancelled" });
          cancelledTaskIds.push(taskId);
        }

        writeMutationReceipt({
          toolName: "cancel_execution",
          entityType: "template_execution",
          verb: "cancel",
          entityId: args.executionId,
          fieldChanges: [
            { path: "cancelledTasks", op: "set", before: null, after: cancelledTaskIds },
          ],
        });

        return toCallToolResult({ success: true, executionId: args.executionId, cancelledTaskIds });
      } catch (err) {
        return toCallToolResult({ error: err instanceof Error ? err.message : String(err) });
      }
    }
  ),

  tool("create_delivery_rule", "Create a new delivery rule for event-driven result routing.", createDeliveryRuleShape, async (args) => {
    const ruleId = uuidv4();
    const rule: import("../shared/types.js").DeliveryRule = {
      id: ruleId,
      eventType: args.eventType as import("../shared/types.js").DeliveryEventType,
      matchCriteria: args.matchCriteria ?? {},
      target: { type: "channel", channelId: args.channelId },
      formatTemplate: args.format,
      maxPerMinute: 10,
      skipOriginChannel: false,
      enabled: args.enabled ?? true,
      createdAt: Date.now(),
    };
    createDeliveryRule(rule);
    const saved = listDeliveryRules().find((item) => item.id === ruleId);
    if (saved) {
      recordAdamToolRuntimeEffect({
        toolName: "create_delivery_rule",
        effectType: "create",
        effectCategory: "delivery_rule_update",
        entityType: "delivery_rule",
        entityId: ruleId,
        after: saved,
      });
      // Phase 4: write entity_mutation receipt
      writeMutationReceipt({
        toolName: "create_delivery_rule",
        entityType: "delivery_rule",
        verb: "create",
        entityId: ruleId,
        fieldChanges: [{ path: "_entity", op: "set", before: null, after: { id: ruleId, eventType: args.eventType, target: { type: "channel", channelId: args.channelId } } }],
      });
    }
    return toCallToolResult({ success: true, ruleId, rule });
  }),

  tool("delete_delivery_rule", "Delete a delivery rule by ID.", deleteDeliveryRuleShape, async (args) => {
    const rules = listDeliveryRules();
    const existing = rules.find(r => r.id === args.ruleId);
    if (!existing) return toCallToolResult({ error: `Delivery rule not found: ${args.ruleId}` });

    deleteDeliveryRule(args.ruleId);
    if (!listDeliveryRules().some((rule) => rule.id === args.ruleId)) {
      recordAdamToolRuntimeEffect({
        toolName: "delete_delivery_rule",
        effectType: "delete",
        effectCategory: "delivery_rule_update",
        entityType: "delivery_rule",
        entityId: args.ruleId,
        before: existing,
      });
      // Phase 4: write entity_mutation receipt
      writeMutationReceipt({
        toolName: "delete_delivery_rule",
        entityType: "delivery_rule",
        verb: "delete",
        entityId: args.ruleId,
        fieldChanges: [{ path: "_entity", op: "set", before: { id: existing.id, eventType: existing.eventType }, after: null }],
      });
    }
    return toCallToolResult({ success: true, ruleId: args.ruleId });
  }),

  tool("list_strategies", "List Thompson Sampling strategy populations for a role, or all strategies if roleId omitted.", listStrategiesShape, async (args) => {
    let strategies: import("../shared/types.js").Strategy[];
    if (args.roleId) {
      strategies = listStrategiesByRole(args.roleId);
    } else {
      // No roleId — fetch all from DB directly
      const { getDb } = await import("../store/db.js");
      const rows = getDb().prepare("SELECT * FROM strategies ORDER BY created_at").all() as Array<{
        id: string; role_id: string; name: string; task_type: string; created_at: number;
        updated_at: number | null; prompt_template: string | null; alpha: number; beta: number;
        trials: number; total_reward: number; metadata: string | null; enabled: number;
      }>;
      strategies = rows.map(row => ({
        id: row.id,
        roleId: row.role_id,
        name: row.name,
        taskType: row.task_type,
        createdAt: row.created_at,
        updatedAt: row.updated_at ?? undefined,
        promptTemplate: row.prompt_template ?? "",
        alpha: row.alpha,
        beta: row.beta,
        totalTrials: row.trials,
        avgReward: row.total_reward && row.trials > 0 ? row.total_reward / row.trials : undefined,
        enabled: row.enabled === 1,
      }));
    }
    return toCallToolResult({ roleId: args.roleId ?? null, count: strategies.length, strategies });
  }),

  // Naming: "operationId" corresponds to task_plans.id in the database.
  // The DB table is named "task_plans" and the events use "planId" — these are historical
  // names from the original PAERL Plan-first design. The actual semantic is privilege
  // escalation for a specific tool operation. See privilege-escalation-timezone-crystal D-005.
  tool("authorize_task_operation",
    "Authorize a pending privilege escalation for a task. The paused operation will proceed.",
    {
      taskId: taskIdSchema,
      operationId: z.string().optional().describe("ID of the specific operation. If omitted, authorizes the most recent pending operation."),
      scope: z.enum(["once", "permanent"]).default("once").describe("'once' = this operation only. 'permanent' = auto-authorize matching patterns in the future."),
    },
    async (args) => {
      // operationId maps to task_plans.id (historical naming: "planId")
      const plans = listTaskPlans(args.taskId);
      const target = args.operationId
        ? plans.find(p => p.id === args.operationId)
        : plans.find(p => p.status === "pending");
      if (!target) return toCallToolResult({ error: "No pending operation found for this task" });

      const taskController = new TaskController();
      taskController.resolvePlanApproval(target.id, "allow", args.scope);
      // Phase 4: write entity_mutation receipt
      writeMutationReceipt({
        toolName: "authorize_task_operation",
        entityType: "task_authorization",
        verb: "update",
        entityId: args.taskId,
        fieldChanges: [{ path: "approvalStatus", op: "set", before: "pending", after: "authorized" }],
        taskId: args.taskId,
      });
      return toCallToolResult({
        success: true,
        operationId: target.id,
        decision: "allow",
        scope: args.scope,
      });
    }
  ),

  tool("deny_task_operation",
    "Deny a pending privilege escalation for a task. The paused operation will be rejected.",
    {
      taskId: taskIdSchema,
      operationId: z.string().optional().describe("ID of the specific operation. If omitted, denies the most recent pending operation."),
      reason: z.string().optional().describe("Reason for denial, provided to the executor as feedback."),
    },
    async (args) => {
      const plans = listTaskPlans(args.taskId);
      const target = args.operationId
        ? plans.find(p => p.id === args.operationId)
        : plans.find(p => p.status === "pending");
      if (!target) return toCallToolResult({ error: "No pending operation found for this task" });

      const taskController = new TaskController();
      taskController.resolvePlanApproval(target.id, "deny", "once", args.reason);
      // Phase 4: write entity_mutation receipt
      writeMutationReceipt({
        toolName: "deny_task_operation",
        entityType: "task_authorization",
        verb: "update",
        entityId: args.taskId,
        fieldChanges: [{ path: "approvalStatus", op: "set", before: "pending", after: "denied" }],
        taskId: args.taskId,
      });
      return toCallToolResult({
        success: true,
        operationId: target.id,
        decision: "deny",
      });
    }
  ),

  tool("get_skills",
    "Query available skills across all Roles. Use BEFORE dispatching to find the right skill for a task.",
    {
      query: z.string().optional().describe("Free-text search query across skill names and descriptions"),
      roleId: z.string().optional().describe("Filter to skills available to a specific role"),
    },
    async (args) => {
      const { SkillRegistry } = await import("./skill-registry.js");
      const results = SkillRegistry.query({ query: args.query, roleId: args.roleId });
      return toCallToolResult({
        skills: results.map((s) => ({
          name: s.name,
          description: s.description,
          source: `${s.source}:${s.sourceName}`,
          availableRoles: s.boundRoles.map((r) => r.roleName),
          triggers: s.triggers.slice(0, 5),
          errorPatterns: s.errorPatterns?.map((e) => e.category) ?? [],
          health: s.health ? {
            totalTasks: s.health.totalTasks,
            successRate: s.health.successRate,
            lastSuccessAt: s.health.lastSuccessAt,
            commonErrors: s.health.commonErrors.map((e) => ({ category: e.category, count: e.count })),
          } : undefined,
        })),
      });
    }
  ),

  tool("get_skill_health",
    "Check the health status of a skill before dispatching. Returns usage stats, success rate, and common failure modes. If failure rate > 50%, a warning is included.",
    {
      skillName: z.string().describe("Name of the skill to check health for"),
    },
    async (args) => {
      const skills = SkillRegistry.match(args.skillName, 5);
      const matched = skills.find((s) => s.name.toLowerCase() === args.skillName.toLowerCase())
        ?? skills[0];

      if (!matched) {
        return toCallToolResult({
          skillName: args.skillName,
          found: false,
          health: null,
          warning: null,
        });
      }

      const health = matched.health;
      const totalTasks = health?.totalTasks ?? 0;
      const successRate = health?.successRate ?? -1;
      const failureRate = successRate >= 0 ? 1 - successRate : -1;

      let warning: string | null = null;
      if (failureRate > 0.5) {
        warning = `This skill has a high failure rate (${(failureRate * 100).toFixed(0)}%). Consider verifying the skill configuration or using an alternative Role.`;
      }

      return toCallToolResult({
        skillName: matched.name,
        found: true,
        source: `${matched.source}:${matched.sourceName}`,
        availableRoles: matched.boundRoles.map((r) => r.roleName),
        health: health ? {
          totalTasks,
          successCount: health.successCount,
          failureCount: health.failureCount,
          successRate,
          lastSuccessAt: health.lastSuccessAt,
          lastFailureAt: health.lastFailureAt,
          commonErrors: health.commonErrors.map((e) => ({ category: e.category, count: e.count })),
        } : null,
        errorPatterns: matched.errorPatterns?.map((e) => ({
          pattern: e.pattern,
          category: e.category,
          userAction: e.userAction,
        })) ?? [],
        warning,
      });
    }
  ),

  tool(
    "commit_claim",
    "Declare structured claims about what this chat turn just did so the audit engine can verify against effect receipts. Call this in the SAME turn before reporting completion text. Mirror of the worker tool — ChatManager declares claims for actions taken via adam-tools (channel sends, template/role/goal mutations, batch operations, etc.).",
    {
      claims: z.array(z.object({
        verb: z.string().min(1).describe("What was done: 'send', 'update', 'create', 'delete', 'cancel', 'enable', 'disable', 'bind', 'unbind', etc."),
        entityType: z.string().min(1).describe("What kind of thing was affected: 'channel_message', 'task_template', 'task', 'goal', 'role', 'delivery_rule', 'plugin', 'mcp_binding', 'config_field', etc."),
        expected: z.discriminatedUnion("kind", [
          z.object({
            kind: z.literal("outbound").describe("Used when verb='send' — declares a channel message was sent."),
            target: z.object({
              channelId: z.string().min(1).describe("Channel that received the message."),
              chatId: z.string().min(1).optional().describe("Specific chat within the channel; omit for any chat."),
            }).describe("Where the message went."),
            attachmentCount: z.number().int().min(0).optional().describe("How many attachments were sent. Verifier requires receipt.attachmentCount >= this."),
            textPresent: z.boolean().optional().describe("Whether the message body had non-empty text. Verifier requires receipt.textChars > 0 when true."),
          }),
          z.object({
            kind: z.literal("field_change").describe("Used for single-entity updates — declares a specific field on a specific entity changed."),
            entityId: z.string().min(1).describe("Identifier of the entity that was changed."),
            fieldPath: z.string().min(1).describe("Dotted path to the field that changed, e.g. 'deliverTo', 'cron', 'config.timeout'."),
            op: z.enum(["set", "list_add", "list_remove"]).describe("How the field changed: scalar set, list append, or list removal."),
            added: z.array(z.unknown()).min(1).optional().describe("Items appended when op='list_add'. Verifier accepts a superset (receipt may have appended more items)."),
            removed: z.array(z.unknown()).min(1).optional().describe("Items removed when op='list_remove'. Verifier accepts a superset."),
            after: z.unknown().optional().describe("New value when op='set'. Verifier requires deep-equal match."),
          }),
          z.object({
            kind: z.literal("batch").describe("Used for batch operations like cancel-many or delete-many."),
            entityType: z.string().min(1).describe("Restrict matching to this entity type."),
            entityIds: z.array(z.string()).min(1).optional().describe("Specific entity IDs affected. Verifier checks receipt.entityIds is a superset."),
            scope: z.object({
              filter: z.string().min(1).describe("Free-text description of the filter applied (e.g., 'status=running AND role_id=role-x'). Verifier ignores this; human-readable only."),
              expectedCount: z.number().int().min(0).describe("Minimum number of entities expected to have been affected. Verifier requires receipt.scope.matchedCount >= this."),
            }).optional().describe("Filter+count for scope-based batches when individual IDs aren't enumerated."),
          }),
        ]).describe("Structured expectation matched against effect_receipts. Pick the kind that fits the action."),
        note: z.string().optional().describe("Free-text human note kept in the audit log only. Verifier ignores this."),
      })).min(1).max(20).describe("One or more claims declaring exactly what just happened. Each claim is verified independently against receipts."),
    },
    async (args) => {
      // Chat-side trace context: getCurrentTraceId() returns the active trace from the
      // ChatManager turn binding. Chat-originated claims carry sessionId (from the
      // active chat origin) but no taskId (the claim is about the chat turn itself,
      // not a worker task).
      const traceId = getCurrentTraceId();
      if (!traceId) {
        return toCallToolResult({ error: "commit_claim requires an active trace context" });
      }
      const sessionId = runtimeContext.getActiveChatOrigin?.()?.chatSessionId;
      try {
        const row = writeClaims({
          traceId,
          sessionId,
          claims: args.claims as ClaimSpec[],
        });
        return toCallToolResult({
          claimRowId: row.id,
          claimsCount: row.claims.length,
          declaredAt: row.declaredAt,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return toCallToolResult({ error: msg });
      }
    },
  ),

  tool(
    "dispatch_outbound_batch",
    "Redeliver a completed TemplateExecution's result + artifacts to one or more channel targets. Use this to fan out the full result bundle (text summary + all file artifacts) to additional channels after the original execution completed. Accepts either a task ID (resolves to its associated execution) or an execution ID directly. Per-target validation: missing channels, disconnected channels, and viewerKey mismatches are skipped with structured error info — the call still succeeds for any valid targets.",
    {
      source: z.object({
        type: z.enum(["execution", "task"]).describe("Whether the id refers to a TemplateExecution or a Task whose execution should be redelivered."),
        id: z.string().min(1).describe("Execution ID or task ID."),
      }).describe("What to redeliver."),
      targets: z.array(z.object({
        channelId: z.string().min(1).describe("Target channel ID."),
        chatId: z.string().min(1).describe("Target chat within the channel."),
      })).min(1).describe("One or more channel targets to deliver to."),
      includeArtifacts: z.boolean().optional().describe("Whether to include file artifacts as attachments. Defaults to true."),
      messageType: z.string().optional().describe("Message type label for delivery ledger. Defaults to 'result_delivery'."),
    },
    async (args) => {
      const includeArtifacts = args.includeArtifacts ?? true;
      const messageType = args.messageType ?? "result_delivery";

      // 1. Resolve executionId from source
      let executionId: string;
      if (args.source.type === "task") {
        const task = getTask(args.source.id);
        if (!task) {
          return toCallToolResult({ error: `Task not found: ${args.source.id}` });
        }
        // Convention: tasks created by template execution have their execution id = task id.
        // Verify there's an associated execution before proceeding.
        const associatedExecution = getTemplateExecution(args.source.id);
        if (!associatedExecution) {
          return toCallToolResult({ error: `Task has no associated TemplateExecution: ${args.source.id}` });
        }
        executionId = associatedExecution.id;
      } else {
        const execution = getTemplateExecution(args.source.id);
        if (!execution) {
          return toCallToolResult({ error: `Execution not found: ${args.source.id}` });
        }
        executionId = execution.id;
      }

      // 2. Reconstruct execution summary + artifacts from DB
      const assembled = assembleSummaryFromDb(executionId);
      if (!assembled) {
        return toCallToolResult({
          executionId,
          error: "Cannot reconstruct execution summary (no persisted step results)",
        });
      }

      // 3. Resolve the source viewer key (from the active chat origin)
      const origin = runtimeContext.getActiveChatOrigin?.();
      const sourceViewerKey = origin ? resolveViewerKeyForSource(origin.source) : undefined;
      const sessionId = origin?.chatSessionId;

      // 4. Validate each target: channel existence, status, viewerKey alignment
      const validTargets: Array<{ channelId: string; chatId: string }> = [];
      const skippedTargets: Array<{ channelId: string; chatId?: string; error: string }> = [];
      for (const target of args.targets) {
        const channel = getChannel(target.channelId);
        if (!channel) {
          skippedTargets.push({
            channelId: target.channelId,
            chatId: target.chatId,
            error: "Channel not found",
          });
          continue;
        }
        if (channel.status === "disconnected") {
          skippedTargets.push({
            channelId: target.channelId,
            chatId: target.chatId,
            error: `Channel is disconnected: ${target.channelId}`,
          });
          continue;
        }
        const targetViewerKey = resolveViewerKeyForDeliveryTarget({
          type: "channel",
          channelId: target.channelId,
          chatId: target.chatId,
        });
        // viewerKey alignment: channels with "owner" match any owner-source;
        // otherwise the keys must match exactly.
        if (targetViewerKey && targetViewerKey !== "owner") {
          if (sourceViewerKey !== targetViewerKey) {
            skippedTargets.push({
              channelId: target.channelId,
              chatId: target.chatId,
              error: `viewerKey mismatch: source=${sourceViewerKey ?? "unknown"} target=${targetViewerKey}`,
            });
            continue;
          }
        }
        validTargets.push({ channelId: target.channelId, chatId: target.chatId });
      }

      if (validTargets.length === 0) {
        return toCallToolResult({
          executionId,
          error: "No deliverable targets",
          targetErrors: skippedTargets,
        });
      }

      // 5. Compose the payload. If the template declares a delivery manifest, the composer
      //    produces the body + named/typed attachments (same path as live completion). Otherwise
      //    fall back to the reconstructed summary + all file artifacts (legacy behavior).
      const composed = includeArtifacts ? composeDeliveryFromManifest(executionId) : null;
      const fileArtifacts = !includeArtifacts ? [] : (composed ? composed.artifacts : assembled.fileArtifacts);
      const composedAttachments = composed ? composed.attachments : undefined;
      const content = composed ? composed.content : assembled.summary;
      const attachmentCount = composedAttachments ? composedAttachments.length : fileArtifacts.length;

      // 6. Hand off to OutboundGateway.redeliverExecutionTo for actual delivery + receipts
      const { getOutboundGateway } = await import("../delivery/outbound-gateway.js");
      const gateway = getOutboundGateway();
      const { deliveries } = await gateway.redeliverExecutionTo({
        executionId,
        targets: validTargets,
        content,
        messageType,
        fileArtifacts,
        attachments: composedAttachments,
        includeArtifacts,
        actorToolName: "dispatch_outbound_batch",
        sessionId,
      });

      const result: {
        executionId: string;
        attachmentCount: number;
        deliveries: typeof deliveries;
        skippedTargets?: typeof skippedTargets;
      } = {
        executionId,
        attachmentCount,
        deliveries,
      };
      if (skippedTargets.length > 0) {
        result.skippedTargets = skippedTargets;
      }
      return toCallToolResult(result);
    },
  ),
  tool(
    "record_user_feedback",
    "Record a good/bad user rating for a TemplateExecution (or a specific step within it). Use this when the user expresses satisfaction or dissatisfaction with a past execution — for example 'that podcast episode was great' or 'last night's brief was off'. The rating is stored and attributed with high weight to the active challenger belief associated with that execution.",
    {
      executionId: executionIdSchema,
      stepId: stepIdSchema.optional(),
      rating: z.enum(["good", "bad"]).describe("'good' if the user expressed satisfaction, 'bad' if dissatisfied"),
    },
    async (args) => {
      const { executionId, stepId, rating } = args;
      recordUserFeedback({ executionId, stepId, rating });
      writeMutationReceipt({
        toolName: "record_user_feedback",
        entityType: "user_feedback",
        verb: "create",
        entityId: executionId,
        fieldChanges: [{ path: "_entity", op: "set", before: null, after: { executionId, stepId, rating } }],
      });
      return toCallToolResult({ ok: true, executionId, stepId, rating });
    },
  ),

  // === Cost Query ===

  tool(
    "read_cost_summary",
    "Read the platform's recent LLM spend and whether it exceeds the user's configured daily spend limit. Defaults to today. Returns total cost (USD), the configured limit, an over/under flag, call count, top model, and how many calls were unpriced (cost unknown). Read-only — use this when the user asks how much has been spent or whether they are over their limit.",
    {
      from: z.number().int().positive().optional().describe("Window start, epoch ms. Default: local midnight today."),
      to: z.number().int().positive().optional().describe("Window end, epoch ms. Default: now."),
    },
    async (args) => {
      const now = Date.now();
      // "today" uses the server process's local timezone.
      // For this single-user Personal OS the server runs in the user's tz, matching the Cost page's
      // browser-tz "Today". If a server/browser tz split appears later, switch to `server.timezone` config.
      const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
      const from = (args.from !== undefined && Number.isFinite(args.from) && args.from > 0) ? args.from : midnight.getTime();
      const to = (args.to !== undefined && Number.isFinite(args.to) && args.to > 0) ? args.to : now;
      const tzOffsetMinutes = -new Date().getTimezoneOffset(); // server-local day boundary
      const threshold = Number(getConfigValue("cost.dailyThresholdUsd") ?? getRuntimeConfig().cost?.dailyThresholdUsd ?? 0) || 0;
      const summary = await getCostSummary({ from, to, groupBy: "source", granularity: "day", tzOffsetMinutes });
      const overThreshold = threshold > 0 && summary.totalCostUsd > threshold;
      return toCallToolResult({
        window: { from, to },
        totalCostUsd: summary.totalCostUsd,
        thresholdUsd: threshold,
        overThreshold,
        callCount: summary.callCount,
        topModel: summary.topModel,
        unpricedCallCount: summary.unpricedCallCount,
      });
    },
  ),
];
}

// ===== MCP Server =====

// getToolsFingerprint removed (issue #221 cleanup): originally used to invalidate
// SDK sessions when the MCP tool set changed across server restarts. Since
// ChatManager no longer persists SDK sessions, this guard has no consumer.

export function createAdamTools(runtimeContext: AdamToolsRuntimeContext = {}) {
  const tools = buildTools(runtimeContext);
  const filtered = runtimeContext.hideLegacyDispatchTask
    ? tools.filter((item) => item.name !== "dispatch_task")
    : tools;
  return createSdkMcpServer({
    name: "adam-tools",
    version: "1.0.0",
    tools: filtered,
  });
}
