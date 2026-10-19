import { randomUUID } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type BetterSqlite3 from "better-sqlite3";
import { getDb } from "./db.js";
import { RUNTIME_DIR } from "../shared/constants.js";
import type { McpbManifest } from "../extensions/mcpb-parser.js";
import { getLogger } from "../lib/logger.js";
import type { RoleExtension } from "./role-extensions.js";

// Re-export McpbManifest type for consumers
export type { McpbManifest } from "../extensions/mcpb-parser.js";

const log = getLogger("store");

// ── Extension entity ─────────────────────────────────────────────────────────

export interface Extension {
  id: string;
  name: string;
  version: string;
  manifestJson: string;
  installSource: string;
  packageHash: string;
  defaultConfigJson: string | null;
  createdAt: number;
  updatedAt: number;
}

// ── DB row → camelCase ───────────────────────────────────────────────────────

interface ExtensionRow {
  id: string;
  name: string;
  version: string;
  manifest_json: string;
  install_source: string;
  package_hash: string;
  default_config_json: string | null;
  created_at: number;
  updated_at: number;
}

function rowToExtension(row: ExtensionRow): Extension {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    manifestJson: row.manifest_json,
    installSource: row.install_source,
    packageHash: row.package_hash,
    defaultConfigJson: row.default_config_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── createOrUpgradeExtension (D-009 upgrade-in-place) ────────────────────────

export interface CreateOrUpgradePayload {
  name: string;
  version: string;
  manifestJson: string;
  installSource?: "upload";
  packageHash: string;
  defaultConfigJson: string | null;
}

/**
 * If an extension with the same `name` exists, updates it in-place preserving
 * the original `id` (D-009 upgrade-in-place). The `default_config_json` is
 * merged: retained keys preserve their existing value, new keys from the
 * incoming manifest are added, keys absent from the incoming manifest are
 * dropped. If no row exists, inserts a new one with a fresh UUID.
 */
export function createOrUpgradeExtension(
  db: BetterSqlite3.Database,
  payload: CreateOrUpgradePayload,
): Extension {
  const now = Date.now();
  const {
    name,
    version,
    manifestJson,
    installSource = "upload",
    packageHash,
    defaultConfigJson,
  } = payload;

  const result = db.transaction(() => {
    const existing = db
      .prepare<string, ExtensionRow>("SELECT * FROM extensions WHERE name = ?")
      .get(name);

    if (existing) {
      // D-009 merge: start from keys in incoming, but prefer existing values
      // for retained keys. Keys absent from incoming are dropped.
      const existingConfig: Record<string, unknown> = existing.default_config_json
        ? (JSON.parse(existing.default_config_json) as Record<string, unknown>)
        : {};
      const incomingConfig: Record<string, unknown> = defaultConfigJson
        ? (JSON.parse(defaultConfigJson) as Record<string, unknown>)
        : {};

      const merged: Record<string, unknown> = {};
      for (const key of Object.keys(incomingConfig)) {
        // Existing value wins; if key is new, use incoming
        merged[key] = key in existingConfig ? existingConfig[key] : incomingConfig[key];
      }
      const mergedJson = Object.keys(merged).length > 0 ? JSON.stringify(merged) : null;

      db.prepare(
        `UPDATE extensions
         SET version = ?, manifest_json = ?, install_source = ?, package_hash = ?,
             default_config_json = ?, updated_at = ?
         WHERE id = ?`,
      ).run(version, manifestJson, installSource, packageHash, mergedJson, now, existing.id);

      return db
        .prepare<string, ExtensionRow>("SELECT * FROM extensions WHERE id = ?")
        .get(existing.id)!;
    } else {
      const id = randomUUID();
      db.prepare(
        `INSERT INTO extensions
           (id, name, version, manifest_json, install_source, package_hash,
            default_config_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, name, version, manifestJson, installSource, packageHash, defaultConfigJson, now, now);

      return db
        .prepare<string, ExtensionRow>("SELECT * FROM extensions WHERE id = ?")
        .get(id)!;
    }
  })();

  return rowToExtension(result);
}

// ── Readers ──────────────────────────────────────────────────────────────────

export function getExtensionByName(
  db: BetterSqlite3.Database,
  name: string,
): Extension | null {
  const row = db
    .prepare<string, ExtensionRow>("SELECT * FROM extensions WHERE name = ?")
    .get(name);
  return row ? rowToExtension(row) : null;
}

export function getExtensionById(
  db: BetterSqlite3.Database,
  id: string,
): Extension | null {
  const row = db
    .prepare<string, ExtensionRow>("SELECT * FROM extensions WHERE id = ?")
    .get(id);
  return row ? rowToExtension(row) : null;
}

export function listExtensions(db: BetterSqlite3.Database): Extension[] {
  const rows = db
    .prepare<[], ExtensionRow>(
      "SELECT * FROM extensions ORDER BY created_at DESC, rowid DESC",
    )
    .all();
  return rows.map(rowToExtension);
}

// ── Mutations ────────────────────────────────────────────────────────────────

export function deleteExtension(db: BetterSqlite3.Database, id: string): void {
  // FK ON DELETE CASCADE handles role_extensions and extension_health
  db.prepare("DELETE FROM extensions WHERE id = ?").run(id);
}

export function updateDefaultConfig(
  db: BetterSqlite3.Database,
  id: string,
  configJson: string,
): Extension | null {
  const now = Date.now();
  db.prepare(
    "UPDATE extensions SET default_config_json = ?, updated_at = ? WHERE id = ?",
  ).run(configJson, now, id);
  return getExtensionById(db, id);
}

// ── computeEffectiveConfig ───────────────────────────────────────────────────

/**
 * Computes the effective configuration for a bound extension by merging
 * the extension's default_config_json with the binding's config_override_json.
 * Override keys win; unoverridden keys come from defaults.
 * Used by Phase 2 routes and Phase 3 Runtime Resolver.
 */
export function computeEffectiveConfig(
  extension: Extension,
  binding: RoleExtension | null,
): Record<string, unknown> {
  const defaults = extension.defaultConfigJson
    ? (JSON.parse(extension.defaultConfigJson) as Record<string, unknown>)
    : {};
  if (!binding?.configOverrideJson) return defaults;
  const override = JSON.parse(binding.configOverrideJson) as Record<string, unknown>;
  return { ...defaults, ...override };
}

// ── Convenience wrapper using getDb() ────────────────────────────────────────

export function getExtensionByNameFromDb(name: string): Extension | null {
  return getExtensionByName(getDb(), name);
}

// ── writeEnvMirror ───────────────────────────────────────────────────────────

export interface WriteEnvMirrorPayload {
  name: string;
  defaultConfigJson: string | null;
  manifest: McpbManifest;
}

/**
 * Writes `~/.adam/extensions/<name>/.env` with one `KEY=value` line per
 * `user_config` field where `sensitive: true`. Uses `defaultConfigJson`
 * value if present, falls back to manifest default, then empty string.
 *
 * DB row is authoritative — `.env` is a derived mirror only.
 * Failure to write is logged as a warning but does NOT throw.
 */
export async function writeEnvMirror(payload: WriteEnvMirrorPayload): Promise<void> {
  const { name, defaultConfigJson, manifest } = payload;
  const extensionsRoot = join(process.env.ADAM_TEST_DIR ?? RUNTIME_DIR, "extensions");
  const envDir = join(extensionsRoot, name);
  const envPath = join(envDir, ".env");

  const userConfig = manifest.user_config;
  if (!userConfig || Object.keys(userConfig).length === 0) {
    return;
  }

  const defaultCfg: Record<string, unknown> = defaultConfigJson
    ? (JSON.parse(defaultConfigJson) as Record<string, unknown>)
    : {};

  const lines: string[] = [];
  for (const [key, field] of Object.entries(userConfig)) {
    if (!field.sensitive) continue;
    const envKey = key.toUpperCase();
    let value: string;
    if (key in defaultCfg) {
      value = String(defaultCfg[key]);
    } else if (field.default !== undefined) {
      value = String(field.default);
    } else {
      value = "";
    }
    // Quote value if it contains whitespace
    const quotedValue = /\s/.test(value) ? `"${value}"` : value;
    lines.push(`${envKey}=${quotedValue}`);
  }

  if (lines.length === 0) {
    return;
  }

  try {
    await mkdir(envDir, { recursive: true });
    await writeFile(envPath, lines.join("\n") + "\n", { mode: 0o600 });
  } catch (err) {
    log.warn({ err, envPath }, "writeEnvMirror: failed to write .env file");
  }
}
