import { getDb } from "./db.js";
import type { Role, RoleStatus, AdditionalDirectory, SdkPermissionMode, LearnedRules, PinnedParameter, TaskStatus, EffortTier, SkillsConfig } from "../shared/types.js";
import { EMPTY_LEARNED_RULES, RoleHasActiveTasksError } from "../shared/types.js";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_DENIED_READ_PATHS } from "../shared/constants.js";
import { resolveTilde } from "../lib/path-permissions.js";
import { getConfigValue } from "./config.js";
import { normalizeRoleOsCapabilities } from "../shared/os-capabilities.js";
import { listTasks } from "./tasks.js";

/**
 * Normalise any legacy or malformed learnedRules input into a canonical LearnedRules object.
 * Handles: null/undefined (→ empty), legacy string[] (→ stylePreferences), already-structured object.
 */
function coerceLearnedRules(raw: unknown): LearnedRules {
  if (raw === null || raw === undefined) return { ...EMPTY_LEARNED_RULES };
  if (Array.isArray(raw)) {
    return {
      stylePreferences: raw.filter((s): s is string => typeof s === "string"),
      avoidedActions: [],
      pinnedParameters: [],
    };
  }
  if (typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    return {
      stylePreferences: Array.isArray(r.stylePreferences)
        ? r.stylePreferences.filter((s): s is string => typeof s === "string")
        : [],
      avoidedActions: Array.isArray(r.avoidedActions)
        ? r.avoidedActions.filter((s): s is string => typeof s === "string")
        : [],
      pinnedParameters: Array.isArray(r.pinnedParameters)
        ? r.pinnedParameters.filter(
            (p): p is PinnedParameter =>
              p !== null && typeof p === "object" && typeof (p as PinnedParameter).tool === "string",
          )
        : [],
    };
  }
  return { ...EMPTY_LEARNED_RULES };
}

/**
 * Validate additionalDirectories for a role update/create.
 * Throws if any path is invalid or insecure.
 * Accepts both bare strings (legacy backward-compat) and AdditionalDirectory objects.
 */
export function validateAdditionalDirectories(
  dirs: Array<string | { path: string }>,
  deniedReadPaths?: string[],
): void {
  for (const item of dirs) {
    const p = typeof item === "string" ? item : item.path;
    // Must be absolute (not relative like "./foo" or "bar/baz")
    if (!p.startsWith("/") && !p.startsWith("~/") && p !== "~") {
      throw new Error(`additionalDirectories must be absolute paths: '${p}' is not absolute`);
    }
    const resolved = resolve(resolveTilde(p));
    if (!resolved.startsWith("/")) {
      throw new Error(`additionalDirectories must be absolute paths: '${p}' is not absolute`);
    }
    // Must not overlap with hardcoded denied paths
    for (const denied of DEFAULT_DENIED_READ_PATHS) {
      const deniedResolved = resolve(resolveTilde(denied));
      if (resolved.startsWith(deniedResolved)) {
        throw new Error(`additionalDirectories cannot include hardcoded denied path: '${p}' matches '${denied}'`);
      }
    }
    // Must not overlap with runtime-configurable deniedReadPaths
    if (deniedReadPaths?.length) {
      for (const denied of deniedReadPaths) {
        const deniedResolved = resolve(resolveTilde(denied));
        if (resolved.startsWith(deniedResolved) || deniedResolved.startsWith(resolved)) {
          throw new Error(`additionalDirectories cannot overlap with deniedReadPaths: '${p}' conflicts with '${denied}'`);
        }
      }
    }
    // Must exist on disk
    if (!existsSync(resolved)) {
      throw new Error(`additionalDirectories path does not exist: '${p}'`);
    }
  }
}

interface RoleRow {
  id: string;
  name: string;
  cag_prompt: string;
  learned_rules: string | null;
  memory_stream_id: string;
  status: string;
  performance_score: number | null;
  preferences: string | null;
  created_at: number;
  updated_at: number | null;
  importance_trigger_curr: number | null;
  // Role-level tool permissions and execution config:
  allowed_tools: string | null;
  disallowed_tools: string | null;
  evaluation_criteria: string | null;
  execution_mode: string | null;
  model: string | null;
  max_budget_usd: number | null;
  approval_required: string | null;
  source: string | null;
  additional_directories: string | null;
  allowed_channels: string | null;
  mcp_servers: string | null;
  inherit_user_settings: number | null;
  permission_mode: string | null;
  allowed_bash_patterns: string | null;
  denied_bash_patterns: string | null;
  env_vars: string | null;
  os_capabilities: string | null;
  preset_id: string | null;
  effort_tier: string | null;
  skills: string | null;
  memory_budget_tokens: number | null;
}

function rowToRole(row: RoleRow): Role {
  return {
    id: row.id,
    name: row.name,
    cagPrompt: row.cag_prompt,
    learnedRules: coerceLearnedRules(row.learned_rules ? JSON.parse(row.learned_rules) : null),
    memoryStreamId: row.memory_stream_id,
    status: row.status as RoleStatus,
    performanceScore: row.performance_score ?? undefined,
    preferences: row.preferences ? JSON.parse(row.preferences) : {},
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? undefined,
    // Absorbed fields:
    allowedTools: row.allowed_tools ? JSON.parse(row.allowed_tools) : undefined,
    disallowedTools: row.disallowed_tools ? JSON.parse(row.disallowed_tools) : undefined,
    evaluationCriteria: row.evaluation_criteria ? JSON.parse(row.evaluation_criteria) : undefined,
    executionMode: (row.execution_mode as Role["executionMode"]) ?? undefined,
    model: row.model ?? undefined,
    maxBudgetUsd: row.max_budget_usd ?? undefined,
    approvalRequired: row.approval_required ? JSON.parse(row.approval_required) : undefined,
    source: (row.source as Role["source"]) ?? undefined,
    additionalDirectories: (() => {
      if (row.additional_directories === null) return undefined;
      try {
        const parsed: unknown = JSON.parse(row.additional_directories);
        if (Array.isArray(parsed)) {
          // Backward-compat: bare strings → { path: string }
          return parsed.map((item) => typeof item === "string" ? { path: item } : item);
        }
        return undefined;
      } catch { return undefined; }
    })(),
    allowedChannels: row.allowed_channels ? JSON.parse(row.allowed_channels) : undefined,
    mcpServers: row.mcp_servers ? JSON.parse(row.mcp_servers) : undefined,
    inheritUserSettings: row.inherit_user_settings === 1 ? true : undefined,
    permissionMode: (row.permission_mode as SdkPermissionMode | undefined) ?? undefined,
    allowedBashPatterns: row.allowed_bash_patterns ? JSON.parse(row.allowed_bash_patterns) : undefined,
    deniedBashPatterns: row.denied_bash_patterns ? JSON.parse(row.denied_bash_patterns) : undefined,
    envVars: row.env_vars ? JSON.parse(row.env_vars) : undefined,
    osCapabilities: row.os_capabilities ? normalizeRoleOsCapabilities(JSON.parse(row.os_capabilities)) : undefined,
    presetId: row.preset_id ?? undefined,
    effortTier: (row.effort_tier as EffortTier | null) ?? undefined,
    skills: row.skills ? JSON.parse(row.skills) as SkillsConfig : undefined,
    memoryBudgetTokens: row.memory_budget_tokens ?? undefined,
  };
}

export function createRole(role: Role): void {
  const rawDenied = (getConfigValue("defaults.deniedReadPaths") as string[] | undefined) ?? [...DEFAULT_DENIED_READ_PATHS];
  if (role.additionalDirectories) validateAdditionalDirectories(role.additionalDirectories, rawDenied);
  const db = getDb();
  db.prepare(`
    INSERT INTO roles (id, name, cag_prompt, learned_rules, memory_stream_id, status,
      performance_score, preferences, created_at, updated_at,
      allowed_tools, disallowed_tools, evaluation_criteria, execution_mode, model,
      max_budget_usd, approval_required, source, additional_directories, allowed_channels, mcp_servers, inherit_user_settings,
      permission_mode, allowed_bash_patterns, denied_bash_patterns, env_vars, os_capabilities, preset_id,
      effort_tier, skills, memory_budget_tokens)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    role.id,
    role.name,
    role.cagPrompt,
    JSON.stringify(role.learnedRules),
    role.memoryStreamId,
    role.status,
    role.performanceScore ?? null,
    role.preferences ? JSON.stringify(role.preferences) : null,
    role.createdAt,
    role.updatedAt ?? null,
    role.allowedTools ? JSON.stringify(role.allowedTools) : null,
    role.disallowedTools ? JSON.stringify(role.disallowedTools) : null,
    role.evaluationCriteria ? JSON.stringify(role.evaluationCriteria) : null,
    role.executionMode ?? null,
    role.model ?? null,
    role.maxBudgetUsd ?? null,
    role.approvalRequired ? JSON.stringify(role.approvalRequired) : null,
    role.source ?? null,
    role.additionalDirectories ? JSON.stringify(role.additionalDirectories) : null,
    role.allowedChannels ? JSON.stringify(role.allowedChannels) : null,
    role.mcpServers ? JSON.stringify(role.mcpServers) : null,
    role.inheritUserSettings ? 1 : 0,
    role.permissionMode ?? null,
    role.allowedBashPatterns ? JSON.stringify(role.allowedBashPatterns) : null,
    role.deniedBashPatterns ? JSON.stringify(role.deniedBashPatterns) : null,
    role.envVars ? JSON.stringify(role.envVars) : null,
    role.osCapabilities ? JSON.stringify(normalizeRoleOsCapabilities(role.osCapabilities)) : null,
    role.presetId ?? null,
    role.effortTier ?? null,
    role.skills ? JSON.stringify(role.skills) : null,
    role.memoryBudgetTokens ?? null,
  );
}

export function getRole(id: string): Role | undefined {
  const db = getDb();
  const row = db.prepare("SELECT * FROM roles WHERE id = ?").get(id) as RoleRow | undefined;
  return row ? rowToRole(row) : undefined;
}

export function getRoleByName(name: string): Role | undefined {
  const db = getDb();
  const row = db.prepare("SELECT * FROM roles WHERE name = ?").get(name) as RoleRow | undefined;
  return row ? rowToRole(row) : undefined;
}

export function updateRole(id: string, updates: Partial<Role>): void {
  const db = getDb();
  const setClauses: string[] = [];
  const values: unknown[] = [];

  if ("name" in updates) { setClauses.push("name = ?"); values.push(updates.name); }
  if ("cagPrompt" in updates) { setClauses.push("cag_prompt = ?"); values.push(updates.cagPrompt); }
  if ("learnedRules" in updates) { setClauses.push("learned_rules = ?"); values.push(JSON.stringify(coerceLearnedRules(updates.learnedRules))); }
  if ("memoryStreamId" in updates) { setClauses.push("memory_stream_id = ?"); values.push(updates.memoryStreamId); }
  if ("status" in updates) { setClauses.push("status = ?"); values.push(updates.status); }
  if ("performanceScore" in updates) { setClauses.push("performance_score = ?"); values.push(updates.performanceScore ?? null); }
  if ("preferences" in updates) { setClauses.push("preferences = ?"); values.push(updates.preferences ? JSON.stringify(updates.preferences) : null); }
  if ("updatedAt" in updates) { setClauses.push("updated_at = ?"); values.push(updates.updatedAt ?? null); }
  if ("allowedTools" in updates) { setClauses.push("allowed_tools = ?"); values.push(updates.allowedTools ? JSON.stringify(updates.allowedTools) : null); }
  if ("disallowedTools" in updates) { setClauses.push("disallowed_tools = ?"); values.push(updates.disallowedTools ? JSON.stringify(updates.disallowedTools) : null); }
  if ("evaluationCriteria" in updates) { setClauses.push("evaluation_criteria = ?"); values.push(updates.evaluationCriteria ? JSON.stringify(updates.evaluationCriteria) : null); }
  if ("executionMode" in updates) { setClauses.push("execution_mode = ?"); values.push(updates.executionMode ?? null); }
  if ("model" in updates) { setClauses.push("model = ?"); values.push(updates.model ?? null); }
  if ("maxBudgetUsd" in updates) { setClauses.push("max_budget_usd = ?"); values.push(updates.maxBudgetUsd ?? null); }
  if ("approvalRequired" in updates) { setClauses.push("approval_required = ?"); values.push(updates.approvalRequired ? JSON.stringify(updates.approvalRequired) : null); }
  if ("source" in updates) { setClauses.push("source = ?"); values.push(updates.source ?? null); }
  if ("additionalDirectories" in updates) {
    const rawDenied = (getConfigValue("defaults.deniedReadPaths") as string[] | undefined) ?? [...DEFAULT_DENIED_READ_PATHS];
    if (updates.additionalDirectories) validateAdditionalDirectories(updates.additionalDirectories, rawDenied);
    setClauses.push("additional_directories = ?");
    values.push(updates.additionalDirectories ? JSON.stringify(updates.additionalDirectories) : null);
  }
  if ("allowedChannels" in updates) {
    setClauses.push("allowed_channels = ?");
    values.push(updates.allowedChannels ? JSON.stringify(updates.allowedChannels) : null);
  }
  if ("mcpServers" in updates) {
    setClauses.push("mcp_servers = ?");
    values.push(updates.mcpServers ? JSON.stringify(updates.mcpServers) : null);
  }
  if ("inheritUserSettings" in updates) {
    setClauses.push("inherit_user_settings = ?");
    values.push(updates.inheritUserSettings ? 1 : 0);
  }
  if ("permissionMode" in updates) {
    setClauses.push("permission_mode = ?");
    values.push(updates.permissionMode ?? null);
  }
  if ("allowedBashPatterns" in updates) {
    setClauses.push("allowed_bash_patterns = ?");
    values.push(updates.allowedBashPatterns ? JSON.stringify(updates.allowedBashPatterns) : null);
  }
  if ("deniedBashPatterns" in updates) {
    setClauses.push("denied_bash_patterns = ?");
    values.push(updates.deniedBashPatterns ? JSON.stringify(updates.deniedBashPatterns) : null);
  }
  if ("envVars" in updates) {
    setClauses.push("env_vars = ?");
    values.push(updates.envVars ? JSON.stringify(updates.envVars) : null);
  }
  if ("osCapabilities" in updates) {
    setClauses.push("os_capabilities = ?");
    values.push(updates.osCapabilities ? JSON.stringify(normalizeRoleOsCapabilities(updates.osCapabilities)) : null);
  }
  if ("presetId" in updates) {
    setClauses.push("preset_id = ?");
    values.push(updates.presetId ?? null);
  }
  if ("effortTier" in updates) {
    setClauses.push("effort_tier = ?");
    values.push(updates.effortTier ?? null);
  }
  if ("skills" in updates) {
    setClauses.push("skills = ?");
    values.push(updates.skills ? JSON.stringify(updates.skills) : null);
  }

  if (setClauses.length === 0) return;

  values.push(id);
  db.prepare(`UPDATE roles SET ${setClauses.join(", ")} WHERE id = ?`).run(...values);
}

export function listRoles(status?: RoleStatus, limit?: number, offset = 0): Role[] {
  const db = getDb();
  let query = "SELECT * FROM roles";
  const params: unknown[] = [];

  if (status) {
    query += " WHERE status = ?";
    params.push(status);
  }

  query += " ORDER BY COALESCE(updated_at, created_at) DESC";
  if (typeof limit === "number") {
    query += " LIMIT ? OFFSET ?";
    params.push(limit, offset);
  }

  const rows = db.prepare(query).all(...params) as RoleRow[];
  return rows.map(rowToRole);
}

export function hasActiveTasks(roleId: string): { hasActive: boolean; count: number; statuses: string[] } {
  const activeStatuses: TaskStatus[] = ["pending", "queued", "running"];
  const tasks = listTasks(undefined, 1000, 0, roleId);
  const activeTasks = tasks.filter(t => activeStatuses.includes(t.status));
  const statuses = [...new Set(activeTasks.map(t => t.status))];
  return { hasActive: activeTasks.length > 0, count: activeTasks.length, statuses };
}

export function deleteRole(id: string, force = false): void {
  if (!force) {
    const { hasActive, count, statuses } = hasActiveTasks(id);
    if (hasActive) {
      const role = getRole(id);
      throw new RoleHasActiveTasksError(id, role?.name ?? id, count, statuses);
    }
  }
  const db = getDb();
  db.prepare("DELETE FROM roles WHERE id = ?").run(id);
}

/** Increment the monotonic task counter for a role. Called once per completed task (Task 2-impl). */
export function incrementRoleTaskSeq(roleId: string): void {
  getDb().prepare("UPDATE roles SET task_seq = task_seq + 1 WHERE id = ?").run(roleId);
}

/** Read the current task_seq for a role. Returns 0 if role not found. */
export function getRoleTaskSeq(roleId: string): number {
  const row = getDb().prepare("SELECT task_seq FROM roles WHERE id = ?").get(roleId) as { task_seq: number } | undefined;
  return row?.task_seq ?? 0;
}
