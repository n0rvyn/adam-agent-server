/**
 * RBAC permission computation.
 *
 * Rules (D-006):
 * - allowedTools: agent.allowedTools must be subset of defaults.allowedTools
 * - disallowedTools: union of defaults.disallowedTools + agent.disallowedTools
 * - approvalRequired: union of defaults + agent
 * - maxBudgetUsd: min of defaults and agent (most restrictive)
 * - plugins: union of defaults.plugins + agent.plugins
 *
 * Note: allowedPaths/deniedPaths are no longer used — OS sandbox enforces filesystem
 * boundaries (write whitelist via visiblePaths, read blacklist via deniedReadPaths).
 * SDK canUseTool blockedPath handles read path restriction at the application layer.
 *
 * Field semantics for RolePermissions:
 * - undefined = inherit from defaults (no override)
 * - [] = restrict to none (empty set)
 * - string[] = explicit list (intersected/unioned with defaults)
 *
 * If agent has no permissions object at all, returns defaults as-is.
 */

import type { RolePermissions, EffectivePermissions, DefaultsConfig } from "../shared/types.js";

export function computeEffectivePermissions(
  defaults: DefaultsConfig,
  agentPerms?: RolePermissions,
): EffectivePermissions {
  if (!agentPerms) {
    return {
      allowedTools: defaults.allowedTools,
      disallowedTools: defaults.disallowedTools,
      approvalRequired: defaults.approvalRequired,
      maxBudgetUsd: defaults.maxBudgetUsd,
      plugins: defaults.plugins ?? [],
    };
  }

  return {
    allowedTools: intersectArrays(agentPerms.allowedTools, defaults.allowedTools),
    disallowedTools: unionArrays(defaults.disallowedTools, agentPerms.disallowedTools),
    approvalRequired: unionArrays(defaults.approvalRequired, agentPerms.approvalRequired),
    // 0 or undefined = inherit from defaults (no override); positive value = cap at min(agent, defaults)
    maxBudgetUsd: agentPerms.maxBudgetUsd !== undefined && agentPerms.maxBudgetUsd > 0
      ? Math.min(agentPerms.maxBudgetUsd, defaults.maxBudgetUsd)
      : defaults.maxBudgetUsd,
    plugins: unionArrays(defaults.plugins ?? [], agentPerms.plugins),
  };
}

/**
 * Intersection: agent items must be subset of defaults.
 * undefined = inherit defaults; [] = restrict to none.
 */
export function intersectArrays(agentArr: string[] | undefined, defaultsArr: string[]): string[] {
  if (agentArr === undefined) return defaultsArr;
  if (agentArr.length === 0) return [];
  if (defaultsArr.length === 0) return agentArr; // defaults empty = no restriction
  const defaultsSet = new Set(defaultsArr);
  return agentArr.filter(item => defaultsSet.has(item));
}

/**
 * Union: combine defaults + agent lists, deduplicated.
 * undefined = just use defaults.
 */
export function unionArrays(defaultsArr: string[], agentArr: string[] | undefined): string[] {
  if (agentArr === undefined) return defaultsArr;
  return [...new Set([...defaultsArr, ...agentArr])];
}
