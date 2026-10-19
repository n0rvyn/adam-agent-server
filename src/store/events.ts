import { getDb } from "./db.js";
import { v4 as uuidv4 } from "uuid";

export interface Event {
  id: string;
  eventDefId?: string;
  occurredAt: string;
  ingestedAt: string;
  userDay?: string;
  source: string;
  type: string;
  payload: Record<string, unknown>;
  confidence: number;
  dedupKey: string;
  relatedEntities?: string;
  trustLevel: string;
}

interface EventRow {
  id: string;
  event_def_id: string | null;
  occurred_at: string;
  ingested_at: string;
  user_day: string | null;
  source: string;
  type: string;
  payload: string;
  confidence: number;
  dedup_key: string;
  related_entities: string | null;
  trust_level: string;
}

function rowToEvent(row: EventRow): Event {
  return {
    id: row.id,
    eventDefId: row.event_def_id ?? undefined,
    occurredAt: row.occurred_at,
    ingestedAt: row.ingested_at,
    userDay: row.user_day ?? undefined,
    source: row.source,
    type: row.type,
    payload: JSON.parse(row.payload),
    confidence: row.confidence,
    dedupKey: row.dedup_key,
    relatedEntities: row.related_entities ?? undefined,
    trustLevel: row.trust_level,
  };
}

export interface CreateEventInput {
  id?: string;
  eventDefId?: string;
  type: string;
  source: string;
  dedupKey: string;
  payload: Record<string, unknown>;
  occurredAt?: string;
  userDay?: string;
  confidence?: number;
  relatedEntities?: string;
  trustLevel?: string;
}

export interface CreateEventResult {
  inserted: boolean;
  id: string;
}

export function createEvent(input: CreateEventInput): CreateEventResult {
  const db = getDb();
  const id = input.id ?? uuidv4();
  const now = new Date().toISOString();

  // Use INSERT OR IGNORE — if dedup constraint fires, rowchanges = 0
  const info = db.prepare(`
    INSERT OR IGNORE INTO events
      (id, event_def_id, occurred_at, ingested_at, user_day, source, type, payload, confidence, dedup_key, related_entities, trust_level)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.eventDefId ?? null,
    input.occurredAt ?? now,
    now,
    input.userDay ?? null,
    input.source,
    input.type,
    JSON.stringify(input.payload),
    input.confidence ?? 1.0,
    input.dedupKey,
    input.relatedEntities ?? null,
    input.trustLevel ?? "trusted",
  );

  if (info.changes === 0) {
    // Dedup hit — fetch existing row
    const existing = db.prepare("SELECT id FROM events WHERE source = ? AND dedup_key = ?")
      .get(input.source, input.dedupKey) as { id: string } | undefined;
    return { inserted: false, id: existing?.id ?? id };
  }

  return { inserted: true, id };
}

export function getEvent(id: string): Event | undefined {
  const db = getDb();
  const row = db.prepare("SELECT * FROM events WHERE id = ?").get(id) as EventRow | undefined;
  return row ? rowToEvent(row) : undefined;
}

export interface QueryEventsFilter {
  eventDefId?: string;
  typePattern?: string;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}

export function queryEvents(filter: QueryEventsFilter = {}): Event[] {
  const db = getDb();
  let sql = "SELECT * FROM events WHERE 1=1";
  const params: unknown[] = [];

  if (filter.eventDefId !== undefined) {
    sql += " AND event_def_id = ?";
    params.push(filter.eventDefId);
  }
  if (filter.typePattern !== undefined) {
    sql += " AND type LIKE ?";
    params.push(filter.typePattern);
  }
  if (filter.since !== undefined) {
    sql += " AND occurred_at >= ?";
    params.push(filter.since);
  }
  if (filter.until !== undefined) {
    sql += " AND occurred_at <= ?";
    params.push(filter.until);
  }

  sql += " ORDER BY occurred_at DESC";

  const limit = Math.min(filter.limit ?? 50, 500);
  sql += ` LIMIT ${limit}`;
  if (filter.offset !== undefined) {
    sql += ` OFFSET ${filter.offset}`;
  }

  const rows = db.prepare(sql).all(...params) as EventRow[];
  return rows.map(rowToEvent);
}
