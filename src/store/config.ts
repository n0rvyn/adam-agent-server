import { getDb } from "./db.js";

interface ConfigRow {
  key: string;
  value: string;
  updated_at: number;
}

/**
 * Get a single config value by key. Returns the parsed JSON value, or undefined if not found.
 */
export function getConfigValue(key: string): unknown {
  const db = getDb();
  const row = db.prepare("SELECT value FROM config WHERE key = ?").get(key) as
    | Pick<ConfigRow, "value">
    | undefined;
  if (!row) return undefined;
  try {
    return JSON.parse(row.value);
  } catch {
    return row.value;
  }
}

/**
 * Set a config value. Upserts: inserts if new, updates if exists.
 * Value is JSON-serialized for storage.
 */
export function setConfigValue(key: string, value: unknown): void {
  const db = getDb();
  const serialized = JSON.stringify(value);
  const now = Date.now();
  db.prepare(
    `INSERT INTO config (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, serialized, now);
}

/**
 * Get all config values as a flat key-value map.
 */
export function getAllConfig(): Record<string, unknown> {
  const db = getDb();
  const rows = db.prepare("SELECT key, value FROM config").all() as Pick<ConfigRow, "key" | "value">[];
  const result: Record<string, unknown> = {};
  for (const row of rows) {
    try {
      result[row.key] = JSON.parse(row.value);
    } catch {
      result[row.key] = row.value;
    }
  }
  return result;
}

/**
 * Seed config from a flat key-value map. Only inserts keys that don't already exist in DB.
 * Used for first-boot migration from .env / YAML / defaults.
 */
export function seedConfig(entries: Record<string, unknown>): number {
  const db = getDb();
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO config (key, value, updated_at) VALUES (?, ?, ?)`,
  );
  const now = Date.now();
  let count = 0;

  const txn = db.transaction(() => {
    for (const [key, value] of Object.entries(entries)) {
      if (value === undefined || value === null || value === "") continue;
      const result = stmt.run(key, JSON.stringify(value), now);
      if (result.changes > 0) count++;
    }
  });
  txn();

  return count;
}

/**
 * Check if the config table has any rows.
 */
export function isConfigEmpty(): boolean {
  const db = getDb();
  const row = db.prepare("SELECT COUNT(*) as count FROM config").get() as { count: number };
  return row.count === 0;
}

/**
 * Delete a config value by key.
 */
export function deleteConfigValue(key: string): boolean {
  const db = getDb();
  const result = db.prepare("DELETE FROM config WHERE key = ?").run(key);
  return result.changes > 0;
}
