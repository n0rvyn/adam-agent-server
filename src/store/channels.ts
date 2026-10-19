import { getDb } from "./db.js";
import { getLogger } from "../lib/logger.js";
import type { Channel, ChannelPlatform, ChannelStatus } from "../shared/types.js";
import {
  MIN_REASONABLE_CAP_BYTES,
  MAX_REASONABLE_CAP_BYTES,
  DEFAULT_EMAIL_CAP_BYTES,
  RECIPIENT_DOMAIN_REGEX,
} from "../lib/recipient-cap-bounds.js";

const log = getLogger("store");

interface ChannelRow {
  id: string;
  name: string;
  platform: string;
  enabled: number;
  status: string;
  config: string;
  linked_role_id: string | null;
  allowed_chat_ids: string | null;
  viewer_key: string | null;
  created_at: number;
  updated_at: number | null;
  last_message_at: number | null;
  message_count: number;
  recipient_cap_map_json: string | null;
  default_recipient_cap_bytes: number | null;
}

function rowToChannel(row: ChannelRow): Channel {
  let recipientCapMap: Record<string, number> | undefined;
  if (row.recipient_cap_map_json) {
    try {
      recipientCapMap = JSON.parse(row.recipient_cap_map_json) as Record<string, number>;
    } catch (err) {
      log.warn({ channelId: row.id, err }, "Malformed recipient_cap_map_json; using empty map");
      recipientCapMap = undefined;
    }
  }
  return {
    id: row.id,
    name: row.name,
    platform: row.platform as ChannelPlatform,
    enabled: row.enabled === 1,
    status: row.status as ChannelStatus,
    config: JSON.parse(row.config),
    linkedRoleId: row.linked_role_id ?? undefined,
    allowedChatIds: row.allowed_chat_ids ? JSON.parse(row.allowed_chat_ids) : undefined,
    viewerKey: row.viewer_key ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? undefined,
    lastMessageAt: row.last_message_at ?? undefined,
    messageCount: row.message_count,
    recipientCapMap,
    defaultRecipientCapBytes: row.default_recipient_cap_bytes ?? undefined,
  };
}

export function createChannel(channel: Channel): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO channels (id, name, platform, enabled, status, config, linked_role_id,
      allowed_chat_ids, viewer_key, created_at, updated_at, last_message_at, message_count,
      recipient_cap_map_json, default_recipient_cap_bytes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    channel.id,
    channel.name,
    channel.platform,
    channel.enabled ? 1 : 0,
    channel.status,
    JSON.stringify(channel.config),
    channel.linkedRoleId ?? null,
    channel.allowedChatIds ? JSON.stringify(channel.allowedChatIds) : null,
    channel.viewerKey ?? null,
    channel.createdAt,
    channel.updatedAt ?? null,
    channel.lastMessageAt ?? null,
    channel.messageCount,
    channel.recipientCapMap ? JSON.stringify(channel.recipientCapMap) : null,
    channel.defaultRecipientCapBytes ?? null,
  );
}

export function getChannel(id: string): Channel | undefined {
  const db = getDb();
  const row = db.prepare("SELECT * FROM channels WHERE id = ?").get(id) as ChannelRow | undefined;
  return row ? rowToChannel(row) : undefined;
}

export function updateChannel(id: string, updates: Partial<Pick<Channel, "name" | "enabled" | "status" | "config" | "linkedRoleId" | "allowedChatIds" | "viewerKey" | "lastMessageAt" | "messageCount" | "recipientCapMap" | "defaultRecipientCapBytes">>): void {
  const db = getDb();
  const setClauses: string[] = [];
  const values: unknown[] = [];

  if (updates.name !== undefined) { setClauses.push("name = ?"); values.push(updates.name); }
  if (updates.enabled !== undefined) { setClauses.push("enabled = ?"); values.push(updates.enabled ? 1 : 0); }
  if (updates.status !== undefined) { setClauses.push("status = ?"); values.push(updates.status); }
  if (updates.config !== undefined) { setClauses.push("config = ?"); values.push(JSON.stringify(updates.config)); }
  if (updates.linkedRoleId !== undefined) { setClauses.push("linked_role_id = ?"); values.push(updates.linkedRoleId); }
  if (updates.allowedChatIds !== undefined) { setClauses.push("allowed_chat_ids = ?"); values.push(JSON.stringify(updates.allowedChatIds)); }
  if (updates.viewerKey !== undefined) { setClauses.push("viewer_key = ?"); values.push(updates.viewerKey); }
  if (updates.lastMessageAt !== undefined) { setClauses.push("last_message_at = ?"); values.push(updates.lastMessageAt); }
  if (updates.messageCount !== undefined) { setClauses.push("message_count = ?"); values.push(updates.messageCount); }
  if (updates.recipientCapMap !== undefined) { setClauses.push("recipient_cap_map_json = ?"); values.push(JSON.stringify(updates.recipientCapMap)); }
  if (updates.defaultRecipientCapBytes !== undefined) { setClauses.push("default_recipient_cap_bytes = ?"); values.push(updates.defaultRecipientCapBytes); }

  if (setClauses.length === 0) return;

  setClauses.push("updated_at = ?");
  values.push(Date.now());
  values.push(id);
  db.prepare(`UPDATE channels SET ${setClauses.join(", ")} WHERE id = ?`).run(...values);
}

export function listChannels(enabled?: boolean): Channel[] {
  const db = getDb();
  if (enabled !== undefined) {
    const rows = db.prepare("SELECT * FROM channels WHERE enabled = ? ORDER BY created_at DESC").all(enabled ? 1 : 0) as ChannelRow[];
    return rows.map(rowToChannel);
  }
  const rows = db.prepare("SELECT * FROM channels ORDER BY created_at DESC").all() as ChannelRow[];
  return rows.map(rowToChannel);
}

export function deleteChannel(id: string): void {
  const db = getDb();
  db.prepare("DELETE FROM channels WHERE id = ?").run(id);
}

export function updateChannelStatus(id: string, status: ChannelStatus): void {
  const db = getDb();
  db.prepare("UPDATE channels SET status = ?, updated_at = ? WHERE id = ?").run(status, Date.now(), id);
}

export function getRecipientCap(channelId: string, recipientDomain: string): number {
  const db = getDb();
  const row = db.prepare("SELECT recipient_cap_map_json, default_recipient_cap_bytes FROM channels WHERE id = ?").get(channelId) as { recipient_cap_map_json: string | null; default_recipient_cap_bytes: number | null } | undefined;
  if (!row) return DEFAULT_EMAIL_CAP_BYTES;
  let map: Record<string, number> = {};
  if (row.recipient_cap_map_json) {
    try {
      map = JSON.parse(row.recipient_cap_map_json) as Record<string, number>;
    } catch (err) {
      log.warn({ channelId, err }, "Malformed recipient_cap_map_json; using empty map");
    }
  }
  return map[recipientDomain] ?? row.default_recipient_cap_bytes ?? DEFAULT_EMAIL_CAP_BYTES;
}

export function setRecipientCap(channelId: string, recipientDomain: string, capBytes: number): void {
  if (!RECIPIENT_DOMAIN_REGEX.test(recipientDomain)) throw new RangeError(`invalid recipient domain: ${recipientDomain}`);
  if (capBytes < MIN_REASONABLE_CAP_BYTES || capBytes > MAX_REASONABLE_CAP_BYTES) {
    throw new RangeError(`cap ${capBytes} outside [${MIN_REASONABLE_CAP_BYTES}, ${MAX_REASONABLE_CAP_BYTES}]`);
  }
  const db = getDb();
  // Use $."domain" notation to treat the domain as a literal key (dots are path separators in SQLite JSON).
  // The full path string is bound as a single parameter — not interpolated into SQL.
  db.prepare("UPDATE channels SET recipient_cap_map_json = json_set(coalesce(recipient_cap_map_json, '{}'), ?, ?), updated_at = ? WHERE id = ?")
    .run(`$."${recipientDomain}"`, capBytes, Date.now(), channelId);
}
