import { getDb } from "./db.js";
import { v4 as uuidv4 } from "uuid";
import type { EvolutionAudit } from "../shared/types.js";
import { getCurrentTraceId } from "../lib/trace-context.js";

export type EvolutionAuditRecord = EvolutionAudit;

export function createEvolutionAudit(record: Omit<EvolutionAuditRecord, "id">): void {
  const db = getDb();

  db.prepare(`
    INSERT INTO evolution_audit (id, timestamp, old_rules, new_rules, diff, trigger_task_id, role_id, source, trace_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    uuidv4(),
    record.timestamp,
    record.oldRules,
    record.newRules,
    record.diff,
    record.triggerTaskId ?? null,
    record.roleId ?? null,
    record.source ?? "reflection",
    record.traceId ?? getCurrentTraceId() ?? null,
  );
}

export function listEvolutionAudit(limit = 100, offset = 0): EvolutionAuditRecord[] {
  const db = getDb();

  const rows = db.prepare(`
    SELECT id, timestamp, old_rules as oldRules, new_rules as newRules, diff,
           trigger_task_id as triggerTaskId, role_id as roleId, source,
           trace_id as traceId
    FROM evolution_audit
    ORDER BY timestamp DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset) as EvolutionAuditRecord[];

  return rows;
}

export function listEvolutionAuditByRole(
  roleId: string,
  limit = 100,
  offset = 0,
): EvolutionAuditRecord[] {
  const db = getDb();

  const rows = db.prepare(`
    SELECT id, timestamp, old_rules as oldRules, new_rules as newRules, diff,
           trigger_task_id as triggerTaskId, role_id as roleId, source,
           trace_id as traceId
    FROM evolution_audit
    WHERE role_id = ?
    ORDER BY timestamp DESC
    LIMIT ? OFFSET ?
  `).all(roleId, limit, offset) as EvolutionAuditRecord[];

  return rows;
}

export function getLatestRoleEvolution(roleId: string): EvolutionAuditRecord | undefined {
  const db = getDb();

  return db.prepare(`
    SELECT id, timestamp, old_rules as oldRules, new_rules as newRules, diff,
           trigger_task_id as triggerTaskId, role_id as roleId, source,
           trace_id as traceId
    FROM evolution_audit
    WHERE role_id = ?
    ORDER BY timestamp DESC
    LIMIT 1
  `).get(roleId) as EvolutionAuditRecord | undefined;
}

export function generateDiff(oldRules: string, newRules: string): string {
  const oldLines = oldRules.split("\n").filter(Boolean);
  const newLines = newRules.split("\n").filter(Boolean);

  const added = newLines.filter((l) => !oldLines.includes(l));
  const removed = oldLines.filter((l) => !newLines.includes(l));

  const parts: string[] = [];
  if (added.length > 0) {
    parts.push(`+ ${added.join("\n+ ")}`);
  }
  if (removed.length > 0) {
    parts.push(`- ${removed.join("\n- ")}`);
  }

  return parts.join("\n") || "(no changes)";
}
