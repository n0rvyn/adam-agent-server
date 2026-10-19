import { describe, it, expect, beforeEach } from "vitest";
import { setupTestDb } from "../helpers/test-db.js";
import type BetterSqlite3 from "better-sqlite3";
import {
  upsertHealth,
  getHealth,
  listHealth,
} from "../../store/extension-health.js";

let db: BetterSqlite3.Database;

beforeEach(() => {
  ({ db } = setupTestDb());
  const now = Date.now();
  db.prepare(
    `INSERT INTO extensions (id, name, version, manifest_json, package_hash, created_at, updated_at)
     VALUES ('ext-1', 'my-ext', '1.0.0', '{}', 'hash1', ?, ?)`,
  ).run(now, now);
});

const BASE_HEALTH = {
  extensionId: "ext-1",
  lastRunAt: 1000,
  lastStatus: "ok",
  lastRoleId: "role-1",
  lastTaskId: "task-1",
};

describe("extension-health store", () => {
  it("upsertHealth inserts a new row", () => {
    const h = upsertHealth(db, BASE_HEALTH);
    expect(h.extensionId).toBe("ext-1");
    expect(h.lastStatus).toBe("ok");
    expect(h.lastError).toBeNull();
  });

  it("upsertHealth updates existing row (idempotent upsert)", () => {
    upsertHealth(db, BASE_HEALTH);
    const updated = upsertHealth(db, { ...BASE_HEALTH, lastStatus: "error", lastError: "timeout" });
    expect(updated.lastStatus).toBe("error");
    expect(updated.lastError).toBe("timeout");
  });

  it("getHealth returns null when no row exists", () => {
    expect(getHealth(db, "ext-1")).toBeNull();
  });

  it("getHealth returns the health row after upsert", () => {
    upsertHealth(db, BASE_HEALTH);
    const h = getHealth(db, "ext-1");
    expect(h?.lastRunAt).toBe(1000);
    expect(h?.lastRoleId).toBe("role-1");
  });

  it("listHealth returns all rows", () => {
    upsertHealth(db, BASE_HEALTH);
    const list = listHealth(db);
    expect(list.length).toBe(1);
    expect(list[0].extensionId).toBe("ext-1");
  });

  it("extension delete cascades to extension_health", () => {
    upsertHealth(db, BASE_HEALTH);
    db.prepare("DELETE FROM extensions WHERE id = ?").run("ext-1");
    expect(getHealth(db, "ext-1")).toBeNull();
  });
});
