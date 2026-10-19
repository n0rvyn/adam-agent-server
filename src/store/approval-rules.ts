import { getDb } from "./db.js";
import type { ApprovalRule, RiskLevel } from "../shared/types.js";

interface ApprovalRuleRow {
  id: string;
  role_id: string | null;
  task_pattern: string;
  max_risk_level: string;
  created_at: number;
  created_by_task_id: string | null;
}

function rowToRule(row: ApprovalRuleRow): ApprovalRule {
  return {
    id: row.id,
    roleId: row.role_id ?? undefined,
    taskPattern: row.task_pattern,
    maxRiskLevel: row.max_risk_level as RiskLevel,
    createdAt: row.created_at,
    createdByTaskId: row.created_by_task_id ?? undefined,
  };
}

const RISK_ORDER: Record<RiskLevel, number> = { low: 1, medium: 2, high: 3 };

export function createApprovalRule(rule: ApprovalRule): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO approval_rules (id, role_id, task_pattern, max_risk_level, created_at, created_by_task_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    rule.id,
    rule.roleId ?? null,
    rule.taskPattern,
    rule.maxRiskLevel,
    rule.createdAt,
    rule.createdByTaskId ?? null,
  );
}

/**
 * Find a matching permanent approval rule for the given task.
 * Matches by: roleId (if set), task prompt regex, and risk level.
 */
export function findMatchingRule(
  roleId: string | undefined,
  prompt: string,
  riskLevel: RiskLevel,
): ApprovalRule | undefined {
  const db = getDb();
  const rows = db.prepare(
    "SELECT * FROM approval_rules ORDER BY created_at DESC",
  ).all() as ApprovalRuleRow[];

  for (const row of rows) {
    // Role match: rule.roleId is null (matches all) or matches the task's role
    if (row.role_id && row.role_id !== roleId) continue;

    // Risk level: rule must cover this level or higher
    if (RISK_ORDER[riskLevel] > RISK_ORDER[row.max_risk_level as RiskLevel]) continue;

    // Pattern match: regex on prompt
    try {
      const regex = new RegExp(row.task_pattern, "i");
      if (regex.test(prompt)) {
        return rowToRule(row);
      }
    } catch {
      // Invalid regex — skip this rule
    }
  }

  return undefined;
}

export function listApprovalRules(): ApprovalRule[] {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM approval_rules ORDER BY created_at DESC").all() as ApprovalRuleRow[];
  return rows.map(rowToRule);
}

export function deleteApprovalRule(id: string): void {
  const db = getDb();
  db.prepare("DELETE FROM approval_rules WHERE id = ?").run(id);
}
