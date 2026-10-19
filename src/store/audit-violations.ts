import { getDb } from "./db.js";
import type { AuditViolation } from "../shared/types.js";

export { type AuditViolation };

export function recordAuditViolation(v: AuditViolation): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO audit_violations
      (id, step_task_id, execution_id, role_id, contract_field, layer, severity, message, metadata_json, created_at)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    v.id,
    v.stepTaskId,
    v.executionId ?? null,
    v.roleId,
    v.contractField,
    v.layer,
    v.severity,
    v.message,
    v.metadata ? JSON.stringify(v.metadata) : null,
    v.createdAt,
  );
}

interface AuditViolationRow {
  id: string;
  step_task_id: string;
  execution_id: string | null;
  role_id: string;
  contract_field: string;
  layer: string;
  severity: string;
  message: string;
  metadata_json: string | null;
  created_at: number;
}

function rowToViolation(row: AuditViolationRow): AuditViolation {
  return {
    id: row.id,
    stepTaskId: row.step_task_id,
    executionId: row.execution_id ?? undefined,
    roleId: row.role_id,
    contractField: row.contract_field as AuditViolation["contractField"],
    layer: row.layer as AuditViolation["layer"],
    severity: row.severity as AuditViolation["severity"],
    message: row.message,
    metadata: row.metadata_json ? JSON.parse(row.metadata_json) : undefined,
    createdAt: row.created_at,
  };
}

export function getViolationsByRole(roleId: string, limit = 50): AuditViolation[] {
  const db = getDb();
  const rows = db.prepare(
    "SELECT * FROM audit_violations WHERE role_id = ? ORDER BY created_at DESC LIMIT ?",
  ).all(roleId, limit) as AuditViolationRow[];
  return rows.map(rowToViolation);
}

export function getViolationsByTask(stepTaskId: string): AuditViolation[] {
  const db = getDb();
  const rows = db.prepare(
    "SELECT * FROM audit_violations WHERE step_task_id = ? ORDER BY created_at DESC",
  ).all(stepTaskId) as AuditViolationRow[];
  return rows.map(rowToViolation);
}

export function getViolationsByExecution(executionId: string): AuditViolation[] {
  const db = getDb();
  const rows = db.prepare(
    "SELECT * FROM audit_violations WHERE execution_id = ? ORDER BY created_at DESC",
  ).all(executionId) as AuditViolationRow[];
  return rows.map(rowToViolation);
}
