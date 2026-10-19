import { describe, it, expect, beforeEach } from "vitest";
import { setupTestDb } from "../helpers/test-db.js";
import type BetterSqlite3 from "better-sqlite3";
import {
  createBinding,
  listBindingsByRole,
  listBindingsByExtension,
  getBinding,
  updateBinding,
  deleteBinding,
  bindingExists,
} from "../../store/role-extensions.js";

let db: BetterSqlite3.Database;

beforeEach(() => {
  ({ db } = setupTestDb());
  const now = Date.now();
  // Seed a role and an extension required by FK
  db.prepare(
    `INSERT INTO roles (id, name, memory_stream_id, created_at) VALUES ('role-1', 'test-role', 'ms-1', ?)`,
  ).run(now);
  db.prepare(
    `INSERT INTO extensions (id, name, version, manifest_json, package_hash, created_at, updated_at)
     VALUES ('ext-1', 'my-ext', '1.0.0', '{}', 'hash1', ?, ?)`,
  ).run(now, now);
});

describe("role-extensions store", () => {
  it("createBinding inserts and returns a binding", () => {
    const binding = createBinding(db, {
      roleId: "role-1",
      extensionId: "ext-1",
      generatedServerName: "my-server",
    });
    expect(binding.id).toBeTruthy();
    expect(binding.roleId).toBe("role-1");
    expect(binding.extensionId).toBe("ext-1");
    expect(binding.enabled).toBe(true);
    expect(binding.configOverrideJson).toBeNull();
  });

  it("listBindingsByRole returns bindings for the given role", () => {
    createBinding(db, { roleId: "role-1", extensionId: "ext-1", generatedServerName: "srv" });
    const list = listBindingsByRole(db, "role-1");
    expect(list.length).toBe(1);
    expect(list[0].roleId).toBe("role-1");
  });

  it("listBindingsByExtension returns bindings for the given extension", () => {
    createBinding(db, { roleId: "role-1", extensionId: "ext-1", generatedServerName: "srv" });
    const list = listBindingsByExtension(db, "ext-1");
    expect(list.length).toBe(1);
    expect(list[0].extensionId).toBe("ext-1");
  });

  it("getBinding returns binding or null", () => {
    const b = createBinding(db, { roleId: "role-1", extensionId: "ext-1", generatedServerName: "srv" });
    expect(getBinding(db, b.id)?.id).toBe(b.id);
    expect(getBinding(db, "no-such-id")).toBeNull();
  });

  it("bindingExists returns true when exists, false otherwise", () => {
    createBinding(db, { roleId: "role-1", extensionId: "ext-1", generatedServerName: "srv" });
    expect(bindingExists(db, "role-1", "ext-1")).toBe(true);
    expect(bindingExists(db, "role-1", "ext-99")).toBe(false);
  });

  it("updateBinding mutates enabled and configOverrideJson", () => {
    const b = createBinding(db, { roleId: "role-1", extensionId: "ext-1", generatedServerName: "srv", enabled: true });
    const updated = updateBinding(db, b.id, { enabled: false, configOverrideJson: '{"k":"v"}' });
    expect(updated?.enabled).toBe(false);
    expect(updated?.configOverrideJson).toBe('{"k":"v"}');
  });

  it("deleteBinding removes the row", () => {
    const b = createBinding(db, { roleId: "role-1", extensionId: "ext-1", generatedServerName: "srv" });
    deleteBinding(db, b.id);
    expect(getBinding(db, b.id)).toBeNull();
  });

  it("UNIQUE(role_id, extension_id) constraint prevents duplicate bindings", () => {
    createBinding(db, { roleId: "role-1", extensionId: "ext-1", generatedServerName: "srv" });
    expect(() =>
      createBinding(db, { roleId: "role-1", extensionId: "ext-1", generatedServerName: "srv2" }),
    ).toThrow();
  });
});
