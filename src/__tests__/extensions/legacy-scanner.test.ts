import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";
import {
  scanLegacyMcpServers,
  getLegacyMcpServersSnapshot,
  refreshLegacyMcpServersScan,
  _resetSnapshotForTests,
} from "../../extensions/legacy-mcp-servers-scanner.js";

const { cleanup } = setupTestDb();
afterAll(() => cleanup());
beforeEach(() => {
  clearTestDb();
  _resetSnapshotForTests();
});

function seedRole(id: string, name: string, mcpServers: string) {
  const db = getTestDb();
  db.prepare(
    `INSERT INTO roles (id, name, cag_prompt, status, execution_mode, model, mcp_servers, memory_stream_id, created_at)
     VALUES (?, ?, '', 'active', 'auto', 'claude-3-5-sonnet-20241022', ?, ?, ?)`,
  ).run(id, name, mcpServers, `mem-${id}`, Date.now());
}

describe("legacy-mcp-servers-scanner", () => {
  it("scan finds roles with non-empty mcp_servers", () => {
    seedRole("role-1", "RoleA", JSON.stringify({ foo: { command: "node" } }));
    seedRole("role-2", "RoleB", "{}");
    seedRole("role-3", "RoleC", '{"bar":{}}');

    const db = getTestDb();
    const snapshot = scanLegacyMcpServers(db);
    expect(snapshot.count).toBe(2);
    const ids = snapshot.rows.map((r) => r.roleId);
    expect(ids).toContain("role-1");
    expect(ids).toContain("role-3");
    expect(ids).not.toContain("role-2");
  });

  it("getLegacyMcpServersSnapshot returns cached result without hitting DB", () => {
    seedRole("role-x", "RoleX", '{"x":{}}');
    const db = getTestDb();
    scanLegacyMcpServers(db);

    // Add another row AFTER scan — cache should not include it
    seedRole("role-y", "RoleY", '{"y":{}}');

    const snapshot = getLegacyMcpServersSnapshot();
    expect(snapshot.count).toBe(1);
    expect(snapshot.rows[0].roleId).toBe("role-x");
  });

  it("refreshLegacyMcpServersScan updates the cache", () => {
    seedRole("role-a", "RoleA", '{"a":{}}');
    const db = getTestDb();
    scanLegacyMcpServers(db);
    expect(getLegacyMcpServersSnapshot().count).toBe(1);

    seedRole("role-b", "RoleB", '{"b":{}}');
    refreshLegacyMcpServersScan(db);
    expect(getLegacyMcpServersSnapshot().count).toBe(2);
  });

  it("clear endpoint zeros the value — mcp_servers column NOT dropped", () => {
    seedRole("role-c", "RoleC", '{"c":{}}');
    const db = getTestDb();
    scanLegacyMcpServers(db);
    expect(getLegacyMcpServersSnapshot().count).toBe(1);

    // Simulate what the clear endpoint does
    db.prepare("UPDATE roles SET mcp_servers = '{}' WHERE id = ?").run("role-c");
    refreshLegacyMcpServersScan(db);

    expect(getLegacyMcpServersSnapshot().count).toBe(0);

    // Column still exists (was NOT dropped)
    const row = db.prepare("SELECT mcp_servers FROM roles WHERE id = ?").get("role-c") as
      | { mcp_servers: string }
      | undefined;
    expect(row).toBeDefined();
    expect(row!.mcp_servers).toBe("{}");
  });

  it("returns empty snapshot when no roles have legacy mcp_servers", () => {
    const db = getTestDb();
    const snapshot = scanLegacyMcpServers(db);
    expect(snapshot.count).toBe(0);
    expect(snapshot.rows).toHaveLength(0);
  });
});
