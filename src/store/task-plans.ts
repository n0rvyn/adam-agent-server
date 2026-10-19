import { getDb } from "./db.js";
import type {
  TaskPlan,
  ExecutionPlan,
  DeviationReport,
  PlanStatus,
  ApprovalType,
} from "../shared/types.js";

interface TaskPlanRow {
  id: string;
  task_id: string;
  plan_json: string;
  status: string;
  approval_type: string | null;
  deviation_report_json: string | null;
  learned_rules_json: string | null;
  created_at: number;
  approved_at: number | null;
  reviewed_at: number | null;
}

function rowToTaskPlan(row: TaskPlanRow): TaskPlan {
  return {
    id: row.id,
    taskId: row.task_id,
    roleId: undefined,
    plan: JSON.parse(row.plan_json) as ExecutionPlan,
    status: row.status as PlanStatus,
    approvalType: (row.approval_type as ApprovalType) ?? undefined,
    deviationReport: row.deviation_report_json
      ? (JSON.parse(row.deviation_report_json) as DeviationReport)
      : undefined,
    learnedRules: row.learned_rules_json
      ? (JSON.parse(row.learned_rules_json) as string[])
      : undefined,
    createdAt: row.created_at,
    approvedAt: row.approved_at ?? undefined,
    reviewedAt: row.reviewed_at ?? undefined,
  };
}

export function createTaskPlan(plan: TaskPlan): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO task_plans (id, task_id, plan_json, status, approval_type,
      deviation_report_json, learned_rules_json, created_at, approved_at, reviewed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    plan.id,
    plan.taskId,
    JSON.stringify(plan.plan),
    plan.status,
    plan.approvalType ?? null,
    plan.deviationReport ? JSON.stringify(plan.deviationReport) : null,
    plan.learnedRules ? JSON.stringify(plan.learnedRules) : null,
    plan.createdAt,
    plan.approvedAt ?? null,
    plan.reviewedAt ?? null,
  );
}

export function getTaskPlan(id: string): TaskPlan | undefined {
  const db = getDb();
  const row = db.prepare("SELECT * FROM task_plans WHERE id = ?").get(id) as TaskPlanRow | undefined;
  return row ? rowToTaskPlan(row) : undefined;
}

export function listTaskPlans(taskId: string): TaskPlan[] {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM task_plans WHERE task_id = ? ORDER BY created_at DESC").all(taskId) as TaskPlanRow[];
  return rows.map(rowToTaskPlan);
}

export function getTaskPlanByTaskId(taskId: string): TaskPlan | undefined {
  const db = getDb();
  const row = db.prepare("SELECT * FROM task_plans WHERE task_id = ? ORDER BY created_at DESC LIMIT 1").get(taskId) as TaskPlanRow | undefined;
  return row ? rowToTaskPlan(row) : undefined;
}

export function updateTaskPlanStatus(
  id: string,
  status: PlanStatus,
  approvalType?: ApprovalType,
): void {
  const db = getDb();
  const now = Date.now();
  if (status === "approved") {
    db.prepare("UPDATE task_plans SET status = ?, approval_type = ?, approved_at = ? WHERE id = ?")
      .run(status, approvalType ?? null, now, id);
  } else {
    db.prepare("UPDATE task_plans SET status = ? WHERE id = ?").run(status, id);
  }
}

export function saveDeviationReport(id: string, report: DeviationReport): void {
  const db = getDb();
  db.prepare("UPDATE task_plans SET deviation_report_json = ?, reviewed_at = ? WHERE id = ?")
    .run(JSON.stringify(report), Date.now(), id);
}

export function saveLearnedRules(id: string, rules: string[]): void {
  const db = getDb();
  db.prepare("UPDATE task_plans SET learned_rules_json = ? WHERE id = ?")
    .run(JSON.stringify(rules), id);
}
