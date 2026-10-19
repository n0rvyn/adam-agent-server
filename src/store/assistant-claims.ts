import { v4 as uuidv4 } from "uuid";
import { getDb } from "./db.js";
import { validateClaim, InvalidClaimError } from "../audit/claim-spec.js";
import type { AssistantClaim, ClaimSpec } from "../shared/types.js";

interface AssistantClaimRow {
  id: string;
  trace_id: string;
  session_id: string | null;
  task_id: string | null;
  source_message_id: string | null;
  claims_json: string;
  declared_at: number;
}

export interface WriteClaimsInput {
  id?: string;
  traceId: string;
  sessionId?: string;
  taskId?: string;
  sourceMessageId?: string;
  claims: ClaimSpec[];
  declaredAt?: number;
}

/**
 * Persists one assistant_claims row containing one or more ClaimSpec entries.
 * Validates each ClaimSpec before insertion; throws InvalidClaimError on the
 * first failure (we reject the whole batch to keep the audit substrate clean).
 */
export function writeClaims(input: WriteClaimsInput): AssistantClaim {
  if (!input.traceId) throw new InvalidClaimError(["traceId is required"]);
  if (!Array.isArray(input.claims) || input.claims.length === 0) {
    throw new InvalidClaimError(["claims must be a non-empty array"]);
  }
  for (const [i, claim] of input.claims.entries()) {
    const v = validateClaim(claim);
    if (!v.valid) {
      throw new InvalidClaimError([`claims[${i}]: ${v.errors.join("; ")}`]);
    }
  }

  const row: AssistantClaim = {
    id: input.id ?? uuidv4(),
    traceId: input.traceId,
    sessionId: input.sessionId,
    taskId: input.taskId,
    sourceMessageId: input.sourceMessageId,
    claims: input.claims,
    declaredAt: input.declaredAt ?? Date.now(),
  };

  getDb().prepare(`
    INSERT INTO assistant_claims (
      id, trace_id, session_id, task_id, source_message_id, claims_json, declared_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id,
    row.traceId,
    row.sessionId ?? null,
    row.taskId ?? null,
    row.sourceMessageId ?? null,
    JSON.stringify(row.claims),
    row.declaredAt,
  );

  return row;
}

export function listClaimsByTrace(traceId: string): AssistantClaim[] {
  const rows = getDb().prepare(`
    SELECT * FROM assistant_claims WHERE trace_id = ? ORDER BY declared_at ASC
  `).all(traceId) as AssistantClaimRow[];
  return rows.map(rowToClaim);
}

export function listClaimsBySession(sessionId: string): AssistantClaim[] {
  const rows = getDb().prepare(`
    SELECT * FROM assistant_claims WHERE session_id = ? ORDER BY declared_at ASC
  `).all(sessionId) as AssistantClaimRow[];
  return rows.map(rowToClaim);
}

function rowToClaim(row: AssistantClaimRow): AssistantClaim {
  return {
    id: row.id,
    traceId: row.trace_id,
    sessionId: row.session_id ?? undefined,
    taskId: row.task_id ?? undefined,
    sourceMessageId: row.source_message_id ?? undefined,
    claims: JSON.parse(row.claims_json) as ClaimSpec[],
    declaredAt: row.declared_at,
  };
}
