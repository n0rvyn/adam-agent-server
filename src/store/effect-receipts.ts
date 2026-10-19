import { v4 as uuidv4 } from "uuid";
import { getDb } from "./db.js";
import { validateReceipt } from "./effect-receipt-validators.js";
import type {
  EffectReceipt,
  EffectReceiptInput,
  EffectReceiptActor,
  EffectReceiptTarget,
  EffectReceiptPayload,
  EffectReceiptFieldChange,
  EffectReceiptScope,
  EffectCategory,
} from "../shared/types.js";

interface EffectReceiptRow {
  id: string;
  trace_id: string;
  task_id: string | null;
  session_id: string | null;
  effect_category: string;
  verb: string;
  entity_type: string;
  entity_id: string | null;
  entity_ids_json: string | null;
  target_json: string | null;
  payload_json: string | null;
  field_changes_json: string | null;
  scope_json: string | null;
  actor_json: string;
  outcome: string;
  created_at: number;
}

export class InvalidReceiptError extends Error {
  constructor(public readonly errors: string[]) {
    super(`Invalid effect receipt: ${errors.join("; ")}`);
    this.name = "InvalidReceiptError";
  }
}

/**
 * Persists one effect receipt. Validates input first; throws InvalidReceiptError
 * with structured error list on validation failure.
 */
export function writeEffectReceipt(input: EffectReceiptInput): EffectReceipt {
  const validation = validateReceipt(input);
  if (!validation.valid) {
    throw new InvalidReceiptError(validation.errors);
  }

  const receipt: EffectReceipt = {
    id: input.id ?? uuidv4(),
    traceId: input.traceId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    effectCategory: input.effectCategory,
    verb: input.verb,
    entityType: input.entityType,
    entityId: input.entityId,
    entityIds: input.entityIds,
    target: input.target,
    payload: input.payload,
    fieldChanges: input.fieldChanges,
    scope: input.scope,
    actor: input.actor,
    outcome: input.outcome ?? "success",
    createdAt: input.createdAt ?? Date.now(),
  };

  getDb().prepare(`
    INSERT INTO effect_receipts (
      id, trace_id, task_id, session_id,
      effect_category, verb, entity_type,
      entity_id, entity_ids_json,
      target_json, payload_json, field_changes_json, scope_json,
      actor_json, outcome, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    receipt.id,
    receipt.traceId,
    receipt.taskId ?? null,
    receipt.sessionId ?? null,
    receipt.effectCategory,
    receipt.verb,
    receipt.entityType,
    receipt.entityId ?? null,
    receipt.entityIds ? JSON.stringify(receipt.entityIds) : null,
    receipt.target ? JSON.stringify(receipt.target) : null,
    receipt.payload ? JSON.stringify(receipt.payload) : null,
    receipt.fieldChanges ? JSON.stringify(receipt.fieldChanges) : null,
    receipt.scope ? JSON.stringify(receipt.scope) : null,
    JSON.stringify(receipt.actor),
    receipt.outcome,
    receipt.createdAt,
  );

  return receipt;
}

export function listReceiptsByTrace(traceId: string): EffectReceipt[] {
  const rows = getDb().prepare(`
    SELECT * FROM effect_receipts
    WHERE trace_id = ?
    ORDER BY created_at ASC
  `).all(traceId) as EffectReceiptRow[];
  return rows.map(rowToReceipt);
}

export function listReceiptsByTask(taskId: string): EffectReceipt[] {
  const rows = getDb().prepare(`
    SELECT * FROM effect_receipts
    WHERE task_id = ?
    ORDER BY created_at ASC
  `).all(taskId) as EffectReceiptRow[];
  return rows.map(rowToReceipt);
}

export function listReceiptsByEntity(args: { entityType: string; entityId: string }): EffectReceipt[] {
  const rows = getDb().prepare(`
    SELECT * FROM effect_receipts
    WHERE entity_type = ? AND entity_id = ?
    ORDER BY created_at ASC
  `).all(args.entityType, args.entityId) as EffectReceiptRow[];
  return rows.map(rowToReceipt);
}

function rowToReceipt(row: EffectReceiptRow): EffectReceipt {
  return {
    id: row.id,
    traceId: row.trace_id,
    taskId: row.task_id ?? undefined,
    sessionId: row.session_id ?? undefined,
    effectCategory: row.effect_category as EffectCategory,
    verb: row.verb,
    entityType: row.entity_type,
    entityId: row.entity_id ?? undefined,
    entityIds: parseJson<string[]>(row.entity_ids_json) ?? undefined,
    target: parseJson<EffectReceiptTarget>(row.target_json) ?? undefined,
    payload: parseJson<EffectReceiptPayload>(row.payload_json) ?? undefined,
    fieldChanges: parseJson<EffectReceiptFieldChange[]>(row.field_changes_json) ?? undefined,
    scope: parseJson<EffectReceiptScope>(row.scope_json) ?? undefined,
    actor: JSON.parse(row.actor_json) as EffectReceiptActor,
    outcome: (row.outcome as "success" | "failure") ?? "success",
    createdAt: row.created_at,
  };
}

function parseJson<T>(value: string | null): T | undefined {
  if (value === null) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}
