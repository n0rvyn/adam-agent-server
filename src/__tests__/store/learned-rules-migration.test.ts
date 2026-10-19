import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setupTestDb, getTestDb } from "../helpers/test-db.js";
import type Database from "better-sqlite3";

// Belt-and-suspenders: setupTestDb gives us a separate Database instance which
// we pass explicitly into runMigrations(), so getDb() is never actually called
// here. The mock is a safety net for any future code path that transitively
// resolves getDb() during migration.
vi.mock("../../store/db.js", async (importActual) => {
  const actual = await importActual<typeof import("../../store/db.js")>();
  return {
    ...actual,
    getDb: () => getTestDb(),
    closeDb: () => {},
  };
});

import { runMigrations } from "../../store/db.js";

let db: Database.Database;
let cleanup: () => void;

beforeEach(() => {
  // setupTestDb() creates the full schema up to v52 (current version).
  // We then manually reset schema_version to 52 so the next runMigrations()
  // call fires v53 — the migration under test.
  const result = setupTestDb();
  db = result.db;
  cleanup = result.cleanup;
  db.prepare("UPDATE server_state SET schema_version = 52 WHERE id = 1").run();
});

afterEach(() => {
  db.close();
  cleanup();
});

describe("db migration v53 — learned_rules array→object wrap", () => {
  it("wraps legacy string[] learned_rules into structured object", () => {
    // Set schema to v52 so v53 migration fires
    db.prepare("UPDATE server_state SET schema_version = 52 WHERE id = 1").run();

    // Insert a role with legacy string[] learned_rules (v52 shape)
    db.prepare(
      `INSERT INTO roles (id, name, cag_prompt, learned_rules, memory_stream_id, status, created_at)
       VALUES ('role-legacy', 'LegacyRole', 'Test CAG', '["foo", "bar"]', 'mem-1', 'active', 1000)`,
    ).run();

    runMigrations(db);

    const row = db.prepare("SELECT learned_rules FROM roles WHERE id = 'role-legacy'").get() as { learned_rules: string } | undefined;
    expect(row).toBeDefined();
    const parsed = JSON.parse(row!.learned_rules);
    expect(parsed).toEqual({ stylePreferences: ["foo", "bar"], avoidedActions: [], pinnedParameters: [] });
  });

  it("is idempotent: already-migrated rows are unchanged on re-run", () => {
    db.prepare("UPDATE server_state SET schema_version = 52 WHERE id = 1").run();

    // Insert already-structured row
    db.prepare(
      `INSERT INTO roles (id, name, cag_prompt, learned_rules, memory_stream_id, status, created_at)
       VALUES ('role-structured', 'StructuredRole', 'Test CAG', '{"stylePreferences":["x"],"avoidedActions":["y"],"pinnedParameters":[{"tool":"Bash:foo","params":{"-v":"1"},"pinnedAt":1000}]}', 'mem-2', 'active', 1000)`,
    ).run();

    runMigrations(db);

    const row = db.prepare("SELECT learned_rules FROM roles WHERE id = 'role-structured'").get() as { learned_rules: string } | undefined;
    expect(row).toBeDefined();
    const parsed = JSON.parse(row!.learned_rules);
    expect(parsed.stylePreferences).toEqual(["x"]);
    expect(parsed.avoidedActions).toEqual(["y"]);
    expect(parsed.pinnedParameters).toHaveLength(1);
    expect(parsed.pinnedParameters[0].tool).toBe("Bash:foo");
  });

  it("skips rows with null learned_rules", () => {
    db.prepare("UPDATE server_state SET schema_version = 52 WHERE id = 1").run();
    db.prepare(
      `INSERT INTO roles (id, name, cag_prompt, learned_rules, memory_stream_id, status, created_at)
       VALUES ('role-null', 'NullRole', 'Test CAG', NULL, 'mem-3', 'active', 1000)`,
    ).run();

    // Should not throw
    runMigrations(db);

    const row = db.prepare("SELECT learned_rules FROM roles WHERE id = 'role-null'").get() as { learned_rules: string | null } | undefined;
    expect(row).toBeDefined();
    expect(row!.learned_rules).toBeNull();
  });

  it("second run does not re-wrap already-wrapped rows", () => {
    db.prepare("UPDATE server_state SET schema_version = 52 WHERE id = 1").run();
    db.prepare(
      `INSERT INTO roles (id, name, cag_prompt, learned_rules, memory_stream_id, status, created_at)
       VALUES ('role-legacy2', 'LegacyRole2', 'Test CAG', '["already-wrapped"]', 'mem-4', 'active', 1000)`,
    ).run();

    runMigrations(db);
    const afterFirst = db.prepare("SELECT learned_rules FROM roles WHERE id = 'role-legacy2'").get() as { learned_rules: string };
    expect(JSON.parse(afterFirst.learned_rules).stylePreferences).toEqual(["already-wrapped"]);

    // schema_version is now 53 — run again
    runMigrations(db);
    const afterSecond = db.prepare("SELECT learned_rules FROM roles WHERE id = 'role-legacy2'").get() as { learned_rules: string };
    // Should still be the wrapped form, not double-wrapped
    expect(JSON.parse(afterSecond.learned_rules).stylePreferences).toEqual(["already-wrapped"]);
  });
});
