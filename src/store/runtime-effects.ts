import { v4 as uuidv4 } from "uuid";
import { getDb } from "./db.js";
import type { RuntimeEffect } from "../shared/types.js";
import { getCurrentTraceId } from "../lib/trace-context.js";

interface RuntimeEffectRow {
  id: string;
  trace_id: string | null;
  effect_type: string;
  effect_category: string;
  entity_type: string;
  entity_id: string | null;
  field_path: string | null;
  before_json: string | null;
  after_json: string | null;
  created_at: number;
  actor_role_id: string | null;
  tool_name: string | null;
}

export interface RecordRuntimeEffectInput {
  traceId?: string;
  effectType: string;
  effectCategory: string;
  entityType: string;
  entityId?: string;
  fieldPath?: string;
  before?: unknown;
  after?: unknown;
  createdAt?: number;
  actorRoleId?: string;
  toolName?: string;
}

export function recordRuntimeEffect(input: RecordRuntimeEffectInput): RuntimeEffect {
  const effect: RuntimeEffect = {
    id: uuidv4(),
    traceId: input.traceId ?? getCurrentTraceId() ?? undefined,
    effectType: input.effectType,
    effectCategory: input.effectCategory,
    entityType: input.entityType,
    entityId: input.entityId,
    fieldPath: input.fieldPath,
    before: input.before,
    after: input.after,
    createdAt: input.createdAt ?? Date.now(),
    actorRoleId: input.actorRoleId,
    toolName: input.toolName,
  };

  getDb().prepare(`
    INSERT INTO runtime_effects (
      id, trace_id, effect_type, effect_category, entity_type, entity_id,
      field_path, before_json, after_json, created_at, actor_role_id, tool_name
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    effect.id,
    effect.traceId ?? null,
    effect.effectType,
    effect.effectCategory,
    effect.entityType,
    effect.entityId ?? null,
    effect.fieldPath ?? null,
    effect.before !== undefined ? JSON.stringify(effect.before) : null,
    effect.after !== undefined ? JSON.stringify(effect.after) : null,
    effect.createdAt,
    effect.actorRoleId ?? null,
    effect.toolName ?? null,
  );

  return effect;
}

export function listRuntimeEffectsByTrace(traceId: string): RuntimeEffect[] {
  const rows = getDb().prepare(`
    SELECT * FROM runtime_effects
    WHERE trace_id = ?
    ORDER BY created_at ASC
  `).all(traceId) as RuntimeEffectRow[];
  return rows.map(rowToEffect);
}

function rowToEffect(row: RuntimeEffectRow): RuntimeEffect {
  return {
    id: row.id,
    traceId: row.trace_id ?? undefined,
    effectType: row.effect_type,
    effectCategory: row.effect_category,
    entityType: row.entity_type,
    entityId: row.entity_id ?? undefined,
    fieldPath: row.field_path ?? undefined,
    before: parseJson(row.before_json),
    after: parseJson(row.after_json),
    createdAt: row.created_at,
    actorRoleId: row.actor_role_id ?? undefined,
    toolName: row.tool_name ?? undefined,
  };
}

function parseJson(value: string | null): unknown {
  if (value === null) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
