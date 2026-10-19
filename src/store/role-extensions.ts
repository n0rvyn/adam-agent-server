import { randomUUID } from "node:crypto";
import type BetterSqlite3 from "better-sqlite3";

// ── RoleExtension entity ─────────────────────────────────────────────────────

export interface RoleExtension {
  id: string;
  roleId: string;
  extensionId: string;
  enabled: boolean;
  configOverrideJson: string | null;
  generatedServerName: string;
  createdAt: number;
  updatedAt: number;
}

interface RoleExtensionRow {
  id: string;
  role_id: string;
  extension_id: string;
  enabled: number;
  config_override_json: string | null;
  generated_server_name: string;
  created_at: number;
  updated_at: number;
}

function rowToRoleExtension(row: RoleExtensionRow): RoleExtension {
  return {
    id: row.id,
    roleId: row.role_id,
    extensionId: row.extension_id,
    enabled: row.enabled === 1,
    configOverrideJson: row.config_override_json,
    generatedServerName: row.generated_server_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── Create ───────────────────────────────────────────────────────────────────

export interface CreateBindingPayload {
  roleId: string;
  extensionId: string;
  generatedServerName: string;
  configOverrideJson?: string | null;
  enabled?: boolean;
}

export function createBinding(
  db: BetterSqlite3.Database,
  payload: CreateBindingPayload,
): RoleExtension {
  const now = Date.now();
  const id = randomUUID();
  const {
    roleId,
    extensionId,
    generatedServerName,
    configOverrideJson = null,
    enabled = true,
  } = payload;

  db.prepare(
    `INSERT INTO role_extensions
       (id, role_id, extension_id, enabled, config_override_json,
        generated_server_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    roleId,
    extensionId,
    enabled ? 1 : 0,
    configOverrideJson,
    generatedServerName,
    now,
    now,
  );

  return rowToRoleExtension(
    db
      .prepare<string, RoleExtensionRow>("SELECT * FROM role_extensions WHERE id = ?")
      .get(id)!,
  );
}

// ── Readers ──────────────────────────────────────────────────────────────────

export function listBindingsByRole(
  db: BetterSqlite3.Database,
  roleId: string,
): RoleExtension[] {
  const rows = db
    .prepare<string, RoleExtensionRow>(
      "SELECT * FROM role_extensions WHERE role_id = ? ORDER BY created_at ASC",
    )
    .all(roleId);
  return rows.map(rowToRoleExtension);
}

export function listBindingsByExtension(
  db: BetterSqlite3.Database,
  extensionId: string,
): RoleExtension[] {
  const rows = db
    .prepare<string, RoleExtensionRow>(
      "SELECT * FROM role_extensions WHERE extension_id = ? ORDER BY created_at ASC",
    )
    .all(extensionId);
  return rows.map(rowToRoleExtension);
}

export function getBinding(
  db: BetterSqlite3.Database,
  id: string,
): RoleExtension | null {
  const row = db
    .prepare<string, RoleExtensionRow>("SELECT * FROM role_extensions WHERE id = ?")
    .get(id);
  return row ? rowToRoleExtension(row) : null;
}

export function bindingExists(
  db: BetterSqlite3.Database,
  roleId: string,
  extensionId: string,
): boolean {
  const row = db
    .prepare(
      "SELECT id FROM role_extensions WHERE role_id = ? AND extension_id = ?",
    )
    .get(roleId, extensionId);
  return row !== undefined;
}

// ── Mutations ────────────────────────────────────────────────────────────────

export interface UpdateBindingPayload {
  configOverrideJson?: string | null;
  enabled?: boolean;
}

export function updateBinding(
  db: BetterSqlite3.Database,
  id: string,
  updates: UpdateBindingPayload,
): RoleExtension | null {
  const now = Date.now();
  const fields: string[] = ["updated_at = ?"];
  const values: unknown[] = [now];

  if (updates.configOverrideJson !== undefined) {
    fields.push("config_override_json = ?");
    values.push(updates.configOverrideJson);
  }
  if (updates.enabled !== undefined) {
    fields.push("enabled = ?");
    values.push(updates.enabled ? 1 : 0);
  }

  values.push(id);
  db.prepare(`UPDATE role_extensions SET ${fields.join(", ")} WHERE id = ?`).run(
    ...values,
  );

  return getBinding(db, id);
}

export function deleteBinding(db: BetterSqlite3.Database, id: string): void {
  db.prepare("DELETE FROM role_extensions WHERE id = ?").run(id);
}
