import { getDb } from "./db.js";
import type { EventDef } from "../shared/types.js";
import { v4 as uuidv4 } from "uuid";

interface EventDefRow {
  id: string;
  name: string;
  source_type: string;
  source_config: string;
  enabled: number;
  description: string | null;
  created_at: number;
  updated_at: number;
}

function rowToEventDef(row: EventDefRow): EventDef {
  return {
    id: row.id,
    name: row.name,
    sourceType: row.source_type as EventDef["sourceType"],
    sourceConfig: JSON.parse(row.source_config),
    enabled: row.enabled === 1,
    description: row.description ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createEventDef(def: Omit<EventDef, "createdAt" | "updatedAt">): EventDef {
  const db = getDb();
  const now = Date.now();
  db.prepare(`
    INSERT INTO event_defs (id, name, source_type, source_config, enabled, description, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    def.id,
    def.name,
    def.sourceType,
    JSON.stringify(def.sourceConfig),
    def.enabled ? 1 : 0,
    def.description ?? null,
    now,
    now,
  );
  return { ...def, createdAt: now, updatedAt: now };
}

export function getEventDef(id: string): EventDef | undefined {
  const db = getDb();
  const row = db.prepare("SELECT * FROM event_defs WHERE id = ?").get(id) as EventDefRow | undefined;
  return row ? rowToEventDef(row) : undefined;
}

export interface ListEventDefsFilter {
  sourceType?: EventDef["sourceType"];
  enabled?: boolean;
}

export function listEventDefs(filter: ListEventDefsFilter = {}): EventDef[] {
  const db = getDb();
  let sql = "SELECT * FROM event_defs WHERE 1=1";
  const params: unknown[] = [];
  if (filter.sourceType !== undefined) {
    sql += " AND source_type = ?";
    params.push(filter.sourceType);
  }
  if (filter.enabled !== undefined) {
    sql += " AND enabled = ?";
    params.push(filter.enabled ? 1 : 0);
  }
  sql += " ORDER BY created_at DESC";
  const rows = db.prepare(sql).all(...params) as EventDefRow[];
  return rows.map(rowToEventDef);
}

export function updateEventDef(id: string, patch: Partial<Pick<EventDef, "name" | "sourceType" | "sourceConfig" | "enabled" | "description">>): EventDef | undefined {
  const db = getDb();
  const existing = getEventDef(id);
  if (!existing) return undefined;
  const updated: EventDef = {
    ...existing,
    ...patch,
    updatedAt: Date.now(),
  };
  db.prepare(`
    UPDATE event_defs
    SET name = ?, source_type = ?, source_config = ?, enabled = ?, description = ?, updated_at = ?
    WHERE id = ?
  `).run(
    updated.name,
    updated.sourceType,
    JSON.stringify(updated.sourceConfig),
    updated.enabled ? 1 : 0,
    updated.description ?? null,
    updated.updatedAt,
    id,
  );
  return updated;
}

export function deleteEventDef(id: string): boolean {
  const db = getDb();
  const info = db.prepare("DELETE FROM event_defs WHERE id = ?").run(id);
  return info.changes > 0;
}
