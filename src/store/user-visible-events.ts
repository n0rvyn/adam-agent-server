import { v4 as uuidv4 } from "uuid";
import { getDb } from "./db.js";
import type {
  UserVisibleAttachment,
  UserVisibleEvent,
  UserVisibleSourceType,
  UserVisibleTarget,
  ViewerKey,
} from "../shared/types.js";
import { getCurrentTraceId } from "../lib/trace-context.js";

interface UserVisibleEventRow {
  id: string;
  event_key: string;
  source_type: string;
  source_id: string;
  task_id: string | null;
  template_id: string | null;
  template_name: string | null;
  message_type: string;
  viewer_key: string;
  title: string | null;
  content_preview: string;
  attachments_json: string;
  targets_json: string;
  first_delivered_at: number;
  last_delivered_at: number;
  created_at: number;
  trace_id: string | null;
}

export interface RecordUserVisibleDeliveryEventInput {
  eventKey: string;
  sourceType: UserVisibleSourceType;
  sourceId: string;
  taskId?: string;
  templateId?: string;
  templateName?: string;
  messageType: string;
  viewerKey: ViewerKey;
  title?: string;
  contentPreview: string;
  attachments?: UserVisibleAttachment[];
  targets?: UserVisibleTarget[];
  deliveredAt?: number;
  traceId?: string;
}

export interface ListUserVisibleEventsForContextArgs {
  viewerKey: ViewerKey;
  since: number;
  until: number;
  excludeSourceIds?: string[];
  limit?: number;
}

function rowToEvent(row: UserVisibleEventRow): UserVisibleEvent {
  return {
    id: row.id,
    eventKey: row.event_key,
    sourceType: row.source_type as UserVisibleSourceType,
    sourceId: row.source_id,
    taskId: row.task_id ?? undefined,
    templateId: row.template_id ?? undefined,
    templateName: row.template_name ?? undefined,
    messageType: row.message_type,
    viewerKey: row.viewer_key,
    title: row.title ?? undefined,
    contentPreview: row.content_preview,
    attachments: parseJsonArray<UserVisibleAttachment>(row.attachments_json),
    targets: parseJsonArray<UserVisibleTarget>(row.targets_json),
    firstDeliveredAt: row.first_delivered_at,
    lastDeliveredAt: row.last_delivered_at,
    createdAt: row.created_at,
    traceId: row.trace_id ?? undefined,
  };
}

function parseJsonArray<T>(value: string): T[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

export function recordUserVisibleDeliveryEvent(input: RecordUserVisibleDeliveryEventInput): UserVisibleEvent {
  if (!input.viewerKey || input.viewerKey.trim().length === 0) {
    throw new Error("recordUserVisibleDeliveryEvent requires viewerKey");
  }
  if (!input.eventKey || input.eventKey.trim().length === 0) {
    throw new Error("recordUserVisibleDeliveryEvent requires eventKey");
  }
  if (!input.sourceId || input.sourceId.trim().length === 0) {
    throw new Error("recordUserVisibleDeliveryEvent requires sourceId");
  }

  const db = getDb();
  const now = Date.now();
  const deliveredAt = input.deliveredAt ?? now;
  const existing = db.prepare("SELECT * FROM user_visible_events WHERE event_key = ?")
    .get(input.eventKey) as UserVisibleEventRow | undefined;

  if (!existing) {
    const id = uuidv4();
    db.prepare(`
      INSERT INTO user_visible_events (
        id, event_key, source_type, source_id, task_id, template_id, template_name,
        message_type, viewer_key, title, content_preview, attachments_json,
        targets_json, first_delivered_at, last_delivered_at, created_at, trace_id
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.eventKey,
      input.sourceType,
      input.sourceId,
      input.taskId ?? null,
      input.templateId ?? null,
      input.templateName ?? null,
      input.messageType,
      input.viewerKey,
      input.title ?? null,
      input.contentPreview,
      JSON.stringify(input.attachments ?? []),
      JSON.stringify(input.targets ?? []),
      deliveredAt,
      deliveredAt,
      now,
      input.traceId ?? getCurrentTraceId() ?? null,
    );
    return getUserVisibleEventByEventKey(input.eventKey)!;
  }

  const mergedTargets = mergeTargets(parseJsonArray<UserVisibleTarget>(existing.targets_json), input.targets ?? []);
  const mergedAttachments = mergeAttachments(parseJsonArray<UserVisibleAttachment>(existing.attachments_json), input.attachments ?? []);
  db.prepare(`
    UPDATE user_visible_events
    SET task_id = COALESCE(task_id, ?),
        template_id = COALESCE(template_id, ?),
        template_name = COALESCE(template_name, ?),
        title = COALESCE(title, ?),
        content_preview = CASE WHEN content_preview = '' THEN ? ELSE content_preview END,
        attachments_json = ?,
        targets_json = ?,
        last_delivered_at = MAX(last_delivered_at, ?),
        trace_id = COALESCE(trace_id, ?)
    WHERE event_key = ?
  `).run(
    input.taskId ?? null,
    input.templateId ?? null,
    input.templateName ?? null,
    input.title ?? null,
    input.contentPreview,
    JSON.stringify(mergedAttachments),
    JSON.stringify(mergedTargets),
    deliveredAt,
    input.traceId ?? getCurrentTraceId() ?? null,
    input.eventKey,
  );
  return getUserVisibleEventByEventKey(input.eventKey)!;
}

export function getUserVisibleEventByEventKey(eventKey: string): UserVisibleEvent | undefined {
  const row = getDb().prepare("SELECT * FROM user_visible_events WHERE event_key = ?")
    .get(eventKey) as UserVisibleEventRow | undefined;
  return row ? rowToEvent(row) : undefined;
}

export function listUserVisibleEventsForContext(args: ListUserVisibleEventsForContextArgs): UserVisibleEvent[] {
  const db = getDb();
  const exclude = args.excludeSourceIds ?? [];
  const params: unknown[] = [args.viewerKey, args.since, args.until];
  let sql = `
    SELECT * FROM user_visible_events
    WHERE viewer_key = ?
      AND last_delivered_at >= ?
      AND last_delivered_at <= ?
  `;
  if (exclude.length > 0) {
    sql += ` AND source_id NOT IN (${exclude.map(() => "?").join(",")})`;
    params.push(...exclude);
  }
  sql += " ORDER BY last_delivered_at ASC";
  if (args.limit !== undefined) {
    sql += " LIMIT ?";
    params.push(args.limit);
  }
  const rows = db.prepare(sql).all(...params) as UserVisibleEventRow[];
  return rows.map(rowToEvent);
}

function mergeTargets(existing: UserVisibleTarget[], incoming: UserVisibleTarget[]): UserVisibleTarget[] {
  const result = [...existing];
  for (const target of incoming) {
    const key = targetIdentityKey(target);
    if (!result.some((item) => targetIdentityKey(item) === key)) {
      result.push(target);
    }
  }
  return result;
}

function targetIdentityKey(target: UserVisibleTarget): string {
  return [
    target.type,
    target.channelId ?? "",
    target.webhookUrl ?? "",
    target.chatId ?? "",
    target.sessionId ?? "",
  ].join("|");
}

function mergeAttachments(existing: UserVisibleAttachment[], incoming: UserVisibleAttachment[]): UserVisibleAttachment[] {
  const result = [...existing];
  for (const attachment of incoming) {
    const key = attachmentIdentityKey(attachment);
    const existingIndex = result.findIndex((item) => attachmentIdentityKey(item) === key);
    if (existingIndex >= 0) {
      result[existingIndex] = { ...result[existingIndex], ...attachment };
    } else {
      result.push(attachment);
    }
  }
  return result;
}

function attachmentIdentityKey(attachment: UserVisibleAttachment): string {
  if (attachment.artifactId) return `artifact:${attachment.artifactId}`;
  return [
    "file",
    attachment.filename ?? "",
    attachment.sizeBytes ?? "",
    attachment.mimeType ?? "",
  ].join("|");
}
