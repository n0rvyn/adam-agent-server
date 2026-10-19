import { v4 as uuidv4 } from "uuid";
import { getDb } from "./db.js";
import type {
  AssistantDeliveryCommitment,
  DeliveryArtifactExpectation,
  DeliveryCommitmentEvidenceItem,
  DeliveryCommitmentStatus,
  NotifyTarget,
} from "../shared/types.js";

interface AssistantDeliveryCommitmentRow {
  id: string;
  trace_id: string | null;
  session_id: string;
  source_message_id: string | null;
  task_id: string | null;
  commitment_type: string;
  status: string;
  target_json: string;
  artifact_expectation_json: string | null;
  evidence_json: string | null;
  failure_reason: string | null;
  created_at: number;
  updated_at: number;
  fulfilled_at: number | null;
}

export interface CreateDeliveryCommitmentInput {
  traceId?: string;
  sessionId: string;
  sourceMessageId?: string;
  taskId?: string;
  target: NotifyTarget;
  artifactExpectation?: DeliveryArtifactExpectation;
}

export interface FindRecentDeliveryEvidenceArgs {
  traceId?: string;
  sessionId?: string;
  taskId?: string;
  status?: Exclude<DeliveryCommitmentStatus, "pending" | "blocked" | "cancelled">;
  since?: number;
  limit?: number;
}

function parseJson<T>(value: string | null | undefined): T | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

function rowToCommitment(row: AssistantDeliveryCommitmentRow): AssistantDeliveryCommitment {
  return {
    id: row.id,
    traceId: row.trace_id ?? undefined,
    sessionId: row.session_id,
    sourceMessageId: row.source_message_id ?? undefined,
    taskId: row.task_id ?? undefined,
    commitmentType: "future_delivery",
    status: row.status as AssistantDeliveryCommitment["status"],
    target: JSON.parse(row.target_json) as NotifyTarget,
    artifactExpectation: parseJson<DeliveryArtifactExpectation>(row.artifact_expectation_json),
    evidence: parseJson<DeliveryCommitmentEvidenceItem[]>(row.evidence_json),
    failureReason: row.failure_reason ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    fulfilledAt: row.fulfilled_at ?? undefined,
  };
}

export function createDeliveryCommitment(input: CreateDeliveryCommitmentInput): AssistantDeliveryCommitment {
  const now = Date.now();
  const id = uuidv4();
  getDb().prepare(`
    INSERT INTO assistant_delivery_commitments (
      id, trace_id, session_id, source_message_id, task_id, commitment_type,
      status, target_json, artifact_expectation_json, evidence_json,
      failure_reason, created_at, updated_at, fulfilled_at
    )
    VALUES (?, ?, ?, ?, ?, 'future_delivery', 'pending', ?, ?, NULL, NULL, ?, ?, NULL)
  `).run(
    id,
    input.traceId ?? null,
    input.sessionId,
    input.sourceMessageId ?? null,
    input.taskId ?? null,
    JSON.stringify(input.target),
    input.artifactExpectation ? JSON.stringify(input.artifactExpectation) : null,
    now,
    now,
  );
  return getDeliveryCommitment(id)!;
}

export function getDeliveryCommitment(id: string): AssistantDeliveryCommitment | undefined {
  const row = getDb().prepare("SELECT * FROM assistant_delivery_commitments WHERE id = ?")
    .get(id) as AssistantDeliveryCommitmentRow | undefined;
  return row ? rowToCommitment(row) : undefined;
}

export function findPendingDeliveryCommitmentsForTask(taskId: string): AssistantDeliveryCommitment[] {
  const rows = getDb().prepare(`
    SELECT * FROM assistant_delivery_commitments
    WHERE task_id = ? AND status = 'pending'
    ORDER BY created_at ASC
  `).all(taskId) as AssistantDeliveryCommitmentRow[];
  return rows.map(rowToCommitment);
}

export function markDeliveryCommitmentFulfilled(
  id: string,
  evidence: DeliveryCommitmentEvidenceItem[],
): void {
  const now = Date.now();
  getDb().prepare(`
    UPDATE assistant_delivery_commitments
    SET status = 'fulfilled',
        evidence_json = ?,
        failure_reason = NULL,
        updated_at = ?,
        fulfilled_at = ?
    WHERE id = ?
  `).run(JSON.stringify(evidence), now, now, id);
}

export function markDeliveryCommitmentFailed(
  id: string,
  reason: string,
  evidence: DeliveryCommitmentEvidenceItem[] = [],
): void {
  const now = Date.now();
  getDb().prepare(`
    UPDATE assistant_delivery_commitments
    SET status = 'failed',
        evidence_json = ?,
        failure_reason = ?,
        updated_at = ?
    WHERE id = ?
  `).run(JSON.stringify(evidence), reason, now, id);
}

export function markDeliveryCommitmentBlocked(id: string, reason: string): void {
  const now = Date.now();
  getDb().prepare(`
    UPDATE assistant_delivery_commitments
    SET status = 'blocked',
        failure_reason = ?,
        updated_at = ?
    WHERE id = ?
  `).run(reason, now, id);
}

export function findRecentDeliveryEvidence(args: FindRecentDeliveryEvidenceArgs): AssistantDeliveryCommitment[] {
  const clauses: string[] = ["status IN ('fulfilled','failed')"];
  const params: unknown[] = [];
  if (args.traceId) {
    clauses.push("trace_id = ?");
    params.push(args.traceId);
  }
  if (args.sessionId) {
    clauses.push("session_id = ?");
    params.push(args.sessionId);
  }
  if (args.taskId) {
    clauses.push("task_id = ?");
    params.push(args.taskId);
  }
  if (args.status) {
    clauses.push("status = ?");
    params.push(args.status);
  }
  if (args.since !== undefined) {
    clauses.push("updated_at >= ?");
    params.push(args.since);
  }
  params.push(args.limit ?? 20);
  const rows = getDb().prepare(`
    SELECT * FROM assistant_delivery_commitments
    WHERE ${clauses.join(" AND ")}
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(...params) as AssistantDeliveryCommitmentRow[];
  return rows.map(rowToCommitment);
}
