import { getRoleByName, updateRole } from "../store/roles.js";
import { ensureRoleWorkspace } from "../store/role-workspace.js";
import { createEvolutionAudit, generateDiff } from "../store/evolution-audit.js";
import { getLogger } from "../lib/logger.js";
import type { EvolutionAuditSource, LearnedRules } from "../shared/types.js";

const log = getLogger("agent");

export interface CleanupResult {
  roleId: string;
  roleName: string;
  removedCount: number;
  remainingCount: number;
  addedRule: string | null;
}

/**
 * Filter a Role's learnedRules array, removing entries that match ANY of the
 * provided regex patterns. Optionally append a single replacement rule.
 *
 * On change: updates DB, regenerates Role's CLAUDE.md via ensureRoleWorkspace
 * (which also mkdirs the workspace if missing — handles both fresh-install and
 * post-mutation paths), and records one evolution_audit row. Idempotent: a
 * re-run that finds nothing to remove (and no add-rule deltas) is a no-op
 * (no DB write, no audit row).
 */
export function cleanupRoleLearnedRules(
  roleName: string,
  removePatterns: RegExp[],
  options: { addRule?: string; source?: EvolutionAuditSource } = {},
): CleanupResult {
  const role = getRoleByName(roleName);
  if (!role) {
    throw new Error(`Role not found: ${roleName}`);
  }

  const original = role.learnedRules.stylePreferences ?? [];
  const kept = original.filter((rule) => !removePatterns.some((re) => re.test(rule)));
  const removedCount = original.length - kept.length;

  let addedRule: string | null = null;
  if (options.addRule && !kept.includes(options.addRule)) {
    kept.push(options.addRule);
    addedRule = options.addRule;
  }

  // Idempotency: nothing changed -> no-op
  if (removedCount === 0 && addedRule === null) {
    log.info({ roleId: role.id, roleName }, "cleanupRoleLearnedRules: no changes (idempotent)");
    return {
      roleId: role.id,
      roleName,
      removedCount: 0,
      remainingCount: original.length,
      addedRule: null,
    };
  }

  const oldRulesJoined = original.join("\n");
  const newRulesJoined = kept.join("\n");
  const diff = generateDiff(oldRulesJoined, newRulesJoined);

  const next: LearnedRules = {
    stylePreferences: kept,
    avoidedActions: role.learnedRules.avoidedActions,
    pinnedParameters: role.learnedRules.pinnedParameters,
  };
  updateRole(role.id, { learnedRules: next });
  // ensureRoleWorkspace handles mkdir + writeRoleCLAUDEmd + syncRoleSettings.
  // Safer than calling writeRoleCLAUDEmd(wsPath, ...) directly, because the
  // workspace dir may not exist (e.g. test env, or production case where the
  // dir was wiped between Role creation and now).
  ensureRoleWorkspace({ ...role, learnedRules: next });

  createEvolutionAudit({
    timestamp: Date.now(),
    oldRules: oldRulesJoined,
    newRules: newRulesJoined,
    diff,
    triggerTaskId: undefined,
    roleId: role.id,
    source: options.source ?? "rule-cleanup",
  });

  log.info({
    roleId: role.id,
    roleName,
    removedCount,
    remainingCount: next.stylePreferences.length,
    addedRule,
  }, "cleanupRoleLearnedRules: applied");

  return {
    roleId: role.id,
    roleName,
    removedCount,
    remainingCount: next.stylePreferences.length,
    addedRule: addedRule ?? null,
  };
}
