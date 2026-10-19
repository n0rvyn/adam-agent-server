import type { Database } from "better-sqlite3";
import { getLogger } from "../lib/logger.js";

const log = getLogger("store");

interface LegacyMcpServersRow {
  roleId: string;
  roleName: string;
  mcpServers: Record<string, unknown>;
}

interface Snapshot {
  count: number;
  rows: LegacyMcpServersRow[];
}

let _snapshot: Snapshot = { count: 0, rows: [] };

/**
 * Scan roles table for non-empty mcp_servers values.
 * Caches the result in module-level state; call refreshLegacyMcpServersScan to update.
 */
export function scanLegacyMcpServers(db: Database): Snapshot {
  const rows = db
    .prepare(
      "SELECT id, name, mcp_servers FROM roles WHERE mcp_servers IS NOT NULL AND mcp_servers != '{}' AND mcp_servers != ''",
    )
    .all() as Array<{ id: string; name: string; mcp_servers: string }>;

  const mapped: LegacyMcpServersRow[] = rows.map((r) => {
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(r.mcp_servers) as Record<string, unknown>;
    } catch {
      // best-effort: leave as empty object
    }
    return { roleId: r.id, roleName: r.name, mcpServers: parsed };
  });

  _snapshot = { count: mapped.length, rows: mapped };

  if (_snapshot.count > 0) {
    log.warn(
      { count: _snapshot.count },
      `Found ${_snapshot.count} role(s) with legacy mcp_servers field. Visit /extensions in the Web UI to review.`,
    );
  }

  return _snapshot;
}

/** Returns the cached snapshot without hitting the DB. */
export function getLegacyMcpServersSnapshot(): Snapshot {
  return _snapshot;
}

/** Re-runs the DB scan and updates the cached snapshot (called by clear endpoint). */
export function refreshLegacyMcpServersScan(db: Database): Snapshot {
  return scanLegacyMcpServers(db);
}

/** Exposed for tests: reset module-level state. */
export function _resetSnapshotForTests(): void {
  _snapshot = { count: 0, rows: [] };
}
