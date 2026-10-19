import { getDb } from "./db.js";
import { v4 as uuidv4 } from "uuid";
import type { TaskRequirements } from "../shared/types.js";

export interface ManagerDecision {
  id: string;
  taskId: string;
  roleId?: string;
  decisionType: "dispatch" | "boundary_expansion" | "boundary_denial" | "boundary_approval" | "admission";
  boundary?: Record<string, unknown>;
  reason?: string;
  requirements?: TaskRequirements;
  fitScore?: number;
  candidates?: Array<{ roleId: string; name: string; fitScore: number; fits?: boolean }>;
  tieBreakReason?: string;
  createdAt: number;
}

export function recordManagerDecision(
  taskId: string,
  roleId: string | undefined,
  decisionType: ManagerDecision["decisionType"],
  boundary?: Record<string, unknown>,
  reason?: string,
): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO manager_decisions (id, task_id, role_id, decision_type, boundary_json, reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    uuidv4(),
    taskId,
    roleId ?? null,
    decisionType,
    boundary ? JSON.stringify(boundary) : null,
    reason ?? null,
    Date.now(),
  );
}

export function getManagerDecisions(taskId: string): ManagerDecision[] {
  const db = getDb();
  const rows = db.prepare(
    "SELECT * FROM manager_decisions WHERE task_id = ? ORDER BY created_at ASC",
  ).all(taskId) as any[];
  return rows.map(r => ({
    id: r.id,
    taskId: r.task_id,
    roleId: r.role_id ?? undefined,
    decisionType: r.decision_type,
    boundary: r.boundary_json ? JSON.parse(r.boundary_json) : undefined,
    reason: r.reason ?? undefined,
    requirements: r.requirements_json ? JSON.parse(r.requirements_json) : undefined,
    fitScore: r.fit_score ?? undefined,
    candidates: r.candidates_json ? JSON.parse(r.candidates_json) : undefined,
    tieBreakReason: r.tie_break_reason ?? undefined,
    createdAt: r.created_at,
  }));
}

export function recordRoutingDecision(params: {
  taskId: string;
  chosenRoleId: string;
  requirements: TaskRequirements;
  fitScore: number;
  tieBreakReason?: string;
  candidates: Array<{ roleId: string; name: string; fitScore: number; fits: boolean }>;
}): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO manager_decisions
    (id, task_id, role_id, decision_type, requirements_json, fit_score, candidates_json, tie_break_reason, created_at)
    VALUES (?, ?, ?, 'admission', ?, ?, ?, ?, ?)
  `).run(
    uuidv4(),
    params.taskId,
    params.chosenRoleId,
    JSON.stringify(params.requirements),
    params.fitScore,
    JSON.stringify(params.candidates),
    params.tieBreakReason ?? null,
    Date.now(),
  );
}
