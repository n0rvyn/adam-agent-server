/**
 * Reusable zod schemas for MCP tool input fields.
 *
 * Use these instead of bare `z.string()` for ID, path, and URL-like fields so the
 * LLM gets a clear regex-driven error when it passes a wrong-format value (e.g.,
 * a Role NAME instead of a Role ID UUID). Format families reflect actual IDs
 * observed in production data:
 *   - UUID v4 — tasks, goals, channels, sessions, event_defs, delivery_rules, strategies
 *   - `role-<name>` — preset system roles (role-chat-manager, role-adam-automator)
 *   - `tmpl-<hex>` — task templates (e.g., tmpl-a1b2c3d4)
 *   - `workflow-<uuid>` — legacy workflow templates (e.g., workflow-227c93e4-...)
 *   - `<name>@<scope>` — plugins (e.g., github@anthropic)
 *
 * Every leaf-level z primitive should chain `.describe(...)` with a one-line
 * explanation + example. The snapshot test in
 * src/__tests__/manager/adam-tools-schema.test.ts enforces this.
 */

import { z } from "zod";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Slightly looser: any UUID-shape (some legacy IDs may not be strict v4)
const UUID_ANY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SYSTEM_ROLE_ID = /^role-[a-z0-9][a-z0-9-]*$/;
const TEMPLATE_ID = /^tmpl-[a-f0-9]+$/;
const WORKFLOW_TEMPLATE_ID = /^workflow-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Friendly IDs: prefix-name format (e.g., pkos-scan-and-sync).
// TODO(#205): narrow to a curated allowlist after auditing existing friendly IDs.
const FRIENDLY_ID = /^[a-z][a-z0-9]+-[a-z][a-z0-9-]+$/;
const PLUGIN_ID = /^[a-zA-Z][\w-]*@[a-zA-Z][\w-]*$/;
const ABS_OR_TILDE_PATH = /^(?:\/|~\/)/;
export const STEP_ID_REGEX = /^[\p{L}0-9._-]+$/u;

export const taskIdSchema = z
  .string()
  .regex(UUID_ANY, "taskId must be a UUID (e.g., 'a1b2c3d4-...'). Use list_tasks to find existing IDs.")
  .describe("Task ID (UUID). Use list_tasks or read_task_status to find existing IDs.");

export const roleIdSchema = z
  .string()
  .refine((s) => UUID_ANY.test(s) || SYSTEM_ROLE_ID.test(s), {
    message: "roleId must be a UUID or a system role ID like 'role-chat-manager'. Use list_roles to find IDs (do NOT pass the Role's display name).",
  })
  .describe("Role ID (UUID or 'role-<name>' for presets). Use list_roles to find IDs — NOT the human-readable name.");

export const goalIdSchema = z
  .string()
  .regex(UUID_ANY, "goalId must be a UUID. Use list_goals to find existing IDs.")
  .describe("Goal ID (UUID). Use list_goals to find existing IDs.");

export const channelIdSchema = z
  .string()
  .regex(UUID_ANY, "channelId must be a UUID. Use list_channels to find IDs (do NOT pass the channel's display name).")
  .describe("Channel ID (UUID). Use list_channels to find IDs — NOT the channel's display name.");

export const sessionIdSchema = z
  .string()
  .regex(UUID_ANY, "sessionId must be a UUID.")
  .describe("Chat session ID (UUID).");

export const templateIdSchema = z
  .string()
  .refine((s) => UUID_ANY.test(s) || TEMPLATE_ID.test(s) || WORKFLOW_TEMPLATE_ID.test(s) || FRIENDLY_ID.test(s), {
    message: "templateId must be a UUID, 'tmpl-<hex>', 'workflow-<uuid>', or a friendly ID (e.g., 'pkos-scan-and-sync'). Use list_templates to find IDs.",
  })
  .describe("Task template ID. Use list_templates to find IDs.");

export const pluginIdSchema = z
  .string()
  .regex(PLUGIN_ID, "pluginId must be '<name>@<scope>' (e.g., 'github@anthropic'). Use list_available_plugins to discover.")
  .describe("Plugin ID in '<name>@<scope>' format (e.g., 'github@anthropic'). Use list_available_plugins to discover.");

export const eventDefIdSchema = z
  .string()
  .regex(UUID_ANY, "eventDefId must be a UUID. Use list_event_defs to find IDs.")
  .describe("Event definition ID (UUID). Use list_event_defs to find IDs.");

export const ruleIdSchema = z
  .string()
  .regex(UUID_ANY, "ruleId must be a UUID. Use list_delivery_rules to find IDs.")
  .describe("Delivery rule ID (UUID). Use list_delivery_rules to find IDs.");

export const strategyIdSchema = z
  .string()
  .regex(UUID_ANY, "strategyId must be a UUID. Use list_strategies to find IDs.")
  .describe("Strategy ID (UUID). Use list_strategies to find IDs.");

export const localFilePathSchema = z
  .string()
  .regex(ABS_OR_TILDE_PATH, "Path must be absolute ('/Users/.../file' or '~/...'). Do NOT use relative paths or remote URLs.")
  .describe("Absolute local file path (e.g., '/Users/me/file.txt' or '~/Documents/file.txt'). Remote URLs are NOT accepted — download files locally first.");

// TemplateExecution identifier — accepts UUIDs (production) or alphanumeric/dash/underscore short IDs (legacy / synthetic).
export const executionIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, "executionId must be 1-64 chars: letters, digits, dashes, underscores. Use list_template_executions or query_execution_status to find existing IDs.")
  .describe("TemplateExecution ID. Use list_template_executions or query_execution_status to find existing IDs.");

// Template step identifier (letters incl. CJK, digits, dots, underscores, dashes).
export const stepIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(STEP_ID_REGEX, "stepId must be 1-128 chars: letters (any script), digits, dots, underscores, or dashes.")
  .describe("Template step ID — a human-readable identifier for a template step.");

// Re-export UUID regex for ad-hoc use elsewhere (e.g., tests).
export const ID_REGEXES = { UUID_V4, UUID_ANY, SYSTEM_ROLE_ID, TEMPLATE_ID, PLUGIN_ID, ABS_OR_TILDE_PATH };
