/**
 * Admin Agent tools — executed in the main process via IPC.
 * Worker sends admin_tool_request, manager calls these functions, returns result.
 */

import { listApprovalRules, createApprovalRule, deleteApprovalRule } from "../store/approval-rules.js";
import { createDeliveryRule as storeCreateDeliveryRule, listDeliveryRules as storeListDeliveryRules, updateDeliveryRule as storeUpdateDeliveryRule, deleteDeliveryRule as storeDeleteDeliveryRule } from "../store/delivery-rules.js";
import type { DeliveryRule, DeliveryEventType, DeliveryMatchCriteria, DeliveryTarget } from "../shared/types.js";
import { listEvolutionAudit } from "../store/evolution-audit.js";
import { createEvolutionAudit, generateDiff } from "../store/evolution-audit.js";
import type { ApprovalRule, RiskLevel } from "../shared/types.js";
import { v4 as uuidv4 } from "uuid";
import { getLogger } from "../lib/logger.js";
import { getRole, updateRole, createRole } from "../store/roles.js";

const log = getLogger("admin");

export interface AdminToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

export function viewRolePermissions(targetRoleId: string): AdminToolResult {
  const role = getRole(targetRoleId);
  if (!role) return { success: false, error: `Role not found: ${targetRoleId}` };

  return {
    success: true,
    data: {
      roleId: role.id,
      name: role.name,
      allowedTools: role.allowedTools ?? [],
      disallowedTools: role.disallowedTools ?? [],
      maxBudgetUsd: role.maxBudgetUsd,
      approvalRequired: role.approvalRequired ?? [],
    },
  };
}

export function modifyRolePermissions(
  callerRoleId: string | undefined,
  targetRoleId: string,
  permissions: Record<string, unknown>,
): AdminToolResult {
  if (callerRoleId === targetRoleId) {
    const denied = { success: false, error: "Cannot modify your own permissions" };
    createEvolutionAudit({
      timestamp: Date.now(),
      roleId: targetRoleId,
      source: "admin",
      oldRules: "",
      newRules: "",
      diff: `BLOCKED: self-modification attempt by ${callerRoleId ?? "unknown"}`,
    });
    return denied;
  }

  const role = getRole(targetRoleId);
  if (!role) return { success: false, error: `Role not found: ${targetRoleId}` };

  const updates: Partial<import("../shared/types.js").Role> = {};
  if (permissions.allowedTools) updates.allowedTools = permissions.allowedTools as string[];
  if (permissions.disallowedTools) updates.disallowedTools = permissions.disallowedTools as string[];
  if (permissions.approvalRequired) updates.approvalRequired = permissions.approvalRequired as string[];
  if (permissions.maxBudgetUsd) updates.maxBudgetUsd = permissions.maxBudgetUsd as number;

  updateRole(targetRoleId, updates);
  createEvolutionAudit({
    timestamp: Date.now(),
    roleId: targetRoleId,
    source: "admin",
    oldRules: JSON.stringify({ allowedTools: role.allowedTools, disallowedTools: role.disallowedTools }),
    newRules: JSON.stringify(updates),
    diff: generateDiff(
      JSON.stringify({ allowedTools: role.allowedTools, disallowedTools: role.disallowedTools }),
      JSON.stringify({ allowedTools: updates.allowedTools ?? role.allowedTools, disallowedTools: updates.disallowedTools ?? role.disallowedTools }),
    ),
  });

  return { success: true, data: { roleId: targetRoleId, updated: true } };
}

export function modifyDefaults(changes: Record<string, unknown>): AdminToolResult {
  const defaults = (() => { try { return require("../config/index.js").getDefaults(); } catch { return null; } })();
  return {
    success: true,
    data: {
      currentDefaults: defaults,
      requestedChanges: changes,
      note: "Config file changes require server restart.",
    },
  };
}

export function adminCreateRole(
  name: string,
  _role: string,
  cagPrompt: string,
  permissions?: Record<string, unknown>,
): AdminToolResult {
  const roleId = `role-${uuidv4().slice(0, 8)}`;
  const roleAllowedTools = (permissions?.allowedTools as string[] | undefined) ?? [];

  createRole({
    id: roleId,
    name,
    cagPrompt,
    learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
    memoryStreamId: `mem-${uuidv4().slice(0, 8)}`,
    status: "active",
    preferences: {},
    allowedTools: roleAllowedTools,
    createdAt: Date.now(),
  });

  createEvolutionAudit({
    timestamp: Date.now(),
    roleId,
    source: "admin",
    oldRules: "",
    newRules: JSON.stringify({ name, cagPrompt: cagPrompt.slice(0, 80) }),
    diff: `Created role: ${name}`,
  });

  log.info({ roleId, name, createdBy: "admin" }, "Role created by admin");
  return { success: true, data: { roleId, name } };
}

export function adminRetireRole(
  callerRoleId: string | undefined,
  targetRoleId: string,
): AdminToolResult {
  const role = getRole(targetRoleId);
  if (!role) return { success: false, error: `Role not found: ${targetRoleId}` };

  updateRole(targetRoleId, { status: "retired" });
  createEvolutionAudit({
    timestamp: Date.now(),
    roleId: targetRoleId,
    source: "admin",
    oldRules: JSON.stringify({ status: role.status }),
    newRules: JSON.stringify({ status: "retired" }),
    diff: `Status changed: ${role.status} → retired`,
  });

  log.info({ roleId: targetRoleId, retiredBy: callerRoleId ?? "unknown" }, "Role retired by admin");
  return { success: true, data: { roleId: targetRoleId, status: "retired" } };
}

export function viewAuditLog(limit = 50): AdminToolResult {
  const records = listEvolutionAudit(limit);
  return { success: true, data: records };
}

export function viewApprovalRules(): AdminToolResult {
  const rules = listApprovalRules();
  return { success: true, data: rules };
}

export function adminCreateApprovalRule(
  roleId: string | undefined,
  taskPattern: string,
  maxRiskLevel: RiskLevel,
): AdminToolResult {
  const rule: ApprovalRule = {
    id: uuidv4(),
    roleId,
    taskPattern,
    maxRiskLevel,
    createdAt: Date.now(),
  };
  createApprovalRule(rule);
  log.info({ ruleId: rule.id, taskPattern, maxRiskLevel }, "Approval rule created by admin");
  return { success: true, data: rule };
}

export function adminDeleteApprovalRule(ruleId: string): AdminToolResult {
  deleteApprovalRule(ruleId);
  log.info({ ruleId }, "Approval rule deleted by admin");
  return { success: true, data: { ruleId, deleted: true } };
}

// ===== Delivery Rule Management (D-009) =====

export function adminCreateDeliveryRule(
  eventType: string,
  matchCriteria: DeliveryMatchCriteria,
  target: DeliveryTarget,
  maxPerMinute = 5,
): AdminToolResult {
  const rule: DeliveryRule = {
    id: uuidv4(),
    eventType: eventType as DeliveryEventType,
    matchCriteria,
    target,
    maxPerMinute,
    skipOriginChannel: true,
    enabled: true,
    createdAt: Date.now(),
    createdBy: "admin",
  };
  storeCreateDeliveryRule(rule);
  log.info({ ruleId: rule.id, eventType, target: target.type }, "Delivery rule created by admin");
  return { success: true, data: rule };
}

export function adminListDeliveryRules(): AdminToolResult {
  return { success: true, data: storeListDeliveryRules() };
}

export function adminUpdateDeliveryRule(ruleId: string, updates: Partial<DeliveryRule>): AdminToolResult {
  storeUpdateDeliveryRule(ruleId, updates);
  log.info({ ruleId }, "Delivery rule updated by admin");
  return { success: true, data: { ruleId, updated: true } };
}

export function adminDeleteDeliveryRule(ruleId: string): AdminToolResult {
  storeDeleteDeliveryRule(ruleId);
  log.info({ ruleId }, "Delivery rule deleted by admin");
  return { success: true, data: { ruleId, deleted: true } };
}

/**
 * Execute an admin tool by name. Called from manager.ts on admin_tool_request IPC.
 */
export function executeAdminTool(
  toolName: string,
  args: Record<string, unknown>,
  _callerRoleId?: string,
): AdminToolResult {
  switch (toolName) {
    case "viewRolePermissions":
      return viewRolePermissions(args.targetRoleId as string);
    case "modifyRolePermissions":
      return modifyRolePermissions(_callerRoleId, args.targetRoleId as string, args.permissions as Record<string, unknown>);
    case "modifyDefaults":
      return modifyDefaults(args.changes as Record<string, unknown>);
    case "createRole":
      return adminCreateRole(args.name as string, args.role as string, args.cagPrompt as string, args.permissions as Record<string, unknown> | undefined);
    case "retireRole":
      return adminRetireRole(_callerRoleId, args.targetRoleId as string);
    case "viewAuditLog":
      return viewAuditLog(args.limit as number | undefined);
    case "viewApprovalRules":
      return viewApprovalRules();
    case "createApprovalRule":
      return adminCreateApprovalRule(args.roleId as string | undefined, args.taskPattern as string, args.maxRiskLevel as RiskLevel);
    case "deleteApprovalRule":
      return adminDeleteApprovalRule(args.ruleId as string);
    case "createDeliveryRule":
      return adminCreateDeliveryRule(args.eventType as string, args.matchCriteria as DeliveryMatchCriteria, args.target as DeliveryTarget, args.maxPerMinute as number | undefined);
    case "listDeliveryRules":
      return adminListDeliveryRules();
    case "updateDeliveryRule":
      return adminUpdateDeliveryRule(args.ruleId as string, args.updates as Partial<DeliveryRule>);
    case "deleteDeliveryRule":
      return adminDeleteDeliveryRule(args.ruleId as string);
    default:
      return { success: false, error: `Unknown admin tool: ${toolName}` };
  }
}
