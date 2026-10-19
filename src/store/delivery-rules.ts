import { getDb } from "./db.js";
import type { DeliveryRule, DeliveryEventType, DeliveryMatchCriteria, DeliveryTarget } from "../shared/types.js";

interface DeliveryRuleRow {
  id: string;
  event_type: string;
  match_criteria: string;
  target: string;
  format_template: string | null;
  max_per_minute: number;
  skip_origin_channel: number;
  enabled: number;
  created_at: number;
  created_by: string | null;
}

function rowToRule(row: DeliveryRuleRow): DeliveryRule {
  return {
    id: row.id,
    eventType: row.event_type as DeliveryEventType,
    matchCriteria: JSON.parse(row.match_criteria) as DeliveryMatchCriteria,
    target: JSON.parse(row.target) as DeliveryTarget,
    formatTemplate: row.format_template ?? undefined,
    maxPerMinute: row.max_per_minute,
    skipOriginChannel: row.skip_origin_channel === 1,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    createdBy: row.created_by ?? undefined,
  };
}

export function createDeliveryRule(rule: DeliveryRule): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO delivery_rules (id, event_type, match_criteria, target, format_template,
      max_per_minute, skip_origin_channel, enabled, created_at, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    rule.id,
    rule.eventType,
    JSON.stringify(rule.matchCriteria),
    JSON.stringify(rule.target),
    rule.formatTemplate ?? null,
    rule.maxPerMinute,
    rule.skipOriginChannel ? 1 : 0,
    rule.enabled ? 1 : 0,
    rule.createdAt,
    rule.createdBy ?? null,
  );
}

export function getDeliveryRule(id: string): DeliveryRule | undefined {
  const db = getDb();
  const row = db.prepare("SELECT * FROM delivery_rules WHERE id = ?").get(id) as DeliveryRuleRow | undefined;
  return row ? rowToRule(row) : undefined;
}

export function listDeliveryRules(enabled?: boolean): DeliveryRule[] {
  const db = getDb();
  let query = "SELECT * FROM delivery_rules";
  const params: unknown[] = [];
  if (enabled !== undefined) {
    query += " WHERE enabled = ?";
    params.push(enabled ? 1 : 0);
  }
  query += " ORDER BY created_at DESC";
  return (db.prepare(query).all(...params) as DeliveryRuleRow[]).map(rowToRule);
}

export function updateDeliveryRule(id: string, updates: Partial<DeliveryRule>): void {
  const db = getDb();
  const sets: string[] = [];
  const values: unknown[] = [];

  if (updates.eventType !== undefined) { sets.push("event_type = ?"); values.push(updates.eventType); }
  if (updates.matchCriteria !== undefined) { sets.push("match_criteria = ?"); values.push(JSON.stringify(updates.matchCriteria)); }
  if (updates.target !== undefined) { sets.push("target = ?"); values.push(JSON.stringify(updates.target)); }
  if (updates.formatTemplate !== undefined) { sets.push("format_template = ?"); values.push(updates.formatTemplate); }
  if (updates.maxPerMinute !== undefined) { sets.push("max_per_minute = ?"); values.push(updates.maxPerMinute); }
  if (updates.skipOriginChannel !== undefined) { sets.push("skip_origin_channel = ?"); values.push(updates.skipOriginChannel ? 1 : 0); }
  if (updates.enabled !== undefined) { sets.push("enabled = ?"); values.push(updates.enabled ? 1 : 0); }

  if (sets.length === 0) return;
  values.push(id);
  db.prepare(`UPDATE delivery_rules SET ${sets.join(", ")} WHERE id = ?`).run(...values);
}

export function deleteDeliveryRule(id: string): void {
  const db = getDb();
  db.prepare("DELETE FROM delivery_log WHERE rule_id = ?").run(id);
  db.prepare("DELETE FROM delivery_rules WHERE id = ?").run(id);
}

/**
 * Find all enabled rules matching the event type + context criteria.
 * All set criteria fields are AND (all must match).
 */
export function findMatchingRules(
  eventType: string,
  context: { templateId?: string; roleId?: string; prompt?: string; taskStatus?: string },
): DeliveryRule[] {
  const rules = listDeliveryRules(true);
  return rules.filter(rule => {
    // Event type match: exact or wildcard
    if (rule.eventType !== "*" && rule.eventType !== eventType) return false;

    const mc = rule.matchCriteria;
    if (mc.templateId && mc.templateId !== context.templateId) return false;
    if (mc.roleId && mc.roleId !== context.roleId) return false;
    if (mc.taskStatus && mc.taskStatus !== context.taskStatus) return false;
    if (mc.promptPattern) {
      try {
        if (!new RegExp(mc.promptPattern, "i").test(context.prompt ?? "")) return false;
      } catch { return false; }
    }
    if (mc.excludePromptPatterns && mc.excludePromptPatterns.length > 0) {
      const prompt = context.prompt ?? "";
      for (const pattern of mc.excludePromptPatterns) {
        if (typeof pattern !== "string" || pattern.length > 200) continue;
        try {
          if (new RegExp(pattern, "i").test(prompt)) return false;
        } catch {
          // Invalid regex — skip silently (fail-closed for exclude per threat model)
          continue;
        }
      }
    }

    return true;
  });
}
