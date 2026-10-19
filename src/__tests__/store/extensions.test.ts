import { describe, it, expect, beforeEach } from "vitest";
import { vi } from "vitest";
import { setupTestDb } from "../helpers/test-db.js";
import type BetterSqlite3 from "better-sqlite3";
import {
  createOrUpgradeExtension,
  getExtensionByName,
  listExtensions,
  getExtensionById,
  deleteExtension,
  updateDefaultConfig,
} from "../../store/extensions.js";

vi.mock("../../store/db.js", async () => {
  const { setupTestDb } = await import("../helpers/test-db.js");
  const { db } = setupTestDb();
  return { getDb: () => db };
});

let db: BetterSqlite3.Database;
let cleanup: () => void;

beforeEach(() => {
  const result = setupTestDb();
  db = result.db;
  cleanup = result.cleanup;
});

const BASE_MANIFEST = {
  manifest_version: "0.3",
  name: "test-ext",
  version: "1.0.0",
  description: "Test extension",
  author: { name: "Test Author" },
  server: { type: "node", mcp_config: { command: "node" } },
};

function makeExtInput(overrides?: object) {
  return {
    name: "test-ext",
    version: "1.0.0",
    manifestJson: JSON.stringify(BASE_MANIFEST),
    installSource: "upload" as const,
    packageHash: "abc123",
    defaultConfigJson: null,
    ...overrides,
  };
}

describe("extensions store", () => {
  it("createOrUpgradeExtension inserts new row when name is fresh", () => {
    const ext = createOrUpgradeExtension(db, makeExtInput());
    expect(ext.name).toBe("test-ext");
    expect(ext.version).toBe("1.0.0");
    expect(ext.id).toBeTruthy();
  });

  it("createOrUpgradeExtension preserves id when name already exists (D-009 upgrade-in-place)", () => {
    const first = createOrUpgradeExtension(db, makeExtInput());
    const second = createOrUpgradeExtension(db, makeExtInput({ version: "2.0.0", packageHash: "def456" }));
    expect(second.id).toBe(first.id);
    expect(second.version).toBe("2.0.0");
  });

  it("createOrUpgradeExtension merges default_config_json on upgrade: new keys added, deleted keys dropped, retained keys preserve previous value", () => {
    createOrUpgradeExtension(db, makeExtInput({
      defaultConfigJson: JSON.stringify({ keep: "old-value", drop: "gone" }),
    }));
    const upgraded = createOrUpgradeExtension(db, makeExtInput({
      version: "2.0.0",
      packageHash: "new-hash",
      defaultConfigJson: JSON.stringify({ keep: "new-default", added: "fresh" }),
    }));
    const config = JSON.parse(upgraded.defaultConfigJson ?? "{}");
    expect(config.keep).toBe("old-value"); // retained key preserves previous value
    expect(config.added).toBe("fresh"); // new key from new manifest
    expect(config.drop).toBeUndefined(); // deleted key dropped
  });

  it("getExtensionByName returns row or null", () => {
    createOrUpgradeExtension(db, makeExtInput());
    const found = getExtensionByName(db, "test-ext");
    const missing = getExtensionByName(db, "no-such-ext");
    expect(found).not.toBeNull();
    expect(found?.name).toBe("test-ext");
    expect(missing).toBeNull();
  });

  it("listExtensions returns rows sorted by created_at DESC", () => {
    createOrUpgradeExtension(db, makeExtInput({ name: "ext-a" }));
    createOrUpgradeExtension(db, makeExtInput({ name: "ext-b" }));
    const list = listExtensions(db);
    expect(list.length).toBeGreaterThanOrEqual(2);
    // sorted DESC — last inserted first
    expect(list[0].name).toBe("ext-b");
  });

  it("getExtensionById returns row or null", () => {
    const ext = createOrUpgradeExtension(db, makeExtInput());
    const found = getExtensionById(db, ext.id);
    const missing = getExtensionById(db, "non-existent-id");
    expect(found?.id).toBe(ext.id);
    expect(missing).toBeNull();
  });

  it("deleteExtension removes row and cascades to role_extensions / extension_health (FK ON DELETE CASCADE)", () => {
    const ext = createOrUpgradeExtension(db, makeExtInput());
    // Insert a role_extensions row to verify cascade
    const now = Date.now();
    db.prepare(`INSERT INTO roles (id, name, memory_stream_id, created_at) VALUES ('role-1', 'test-role', 'ms-1', ?)`).run(now);
    db.prepare(`INSERT INTO role_extensions (id, role_id, extension_id, generated_server_name, created_at, updated_at)
      VALUES ('re-1', 'role-1', ?, 'test-server', ?, ?)`).run(ext.id, now, now);
    db.prepare(`INSERT INTO extension_health (extension_id) VALUES (?)`).run(ext.id);

    deleteExtension(db, ext.id);

    expect(getExtensionById(db, ext.id)).toBeNull();
    const reRows = db.prepare("SELECT * FROM role_extensions WHERE extension_id = ?").all(ext.id);
    expect(reRows.length).toBe(0);
    const ehRow = db.prepare("SELECT * FROM extension_health WHERE extension_id = ?").get(ext.id);
    expect(ehRow).toBeUndefined();
  });

  it("updateDefaultConfig only mutates default_config_json + updated_at, leaves manifest_json untouched", () => {
    const ext = createOrUpgradeExtension(db, makeExtInput({ defaultConfigJson: JSON.stringify({ k: "v" }) }));
    const originalManifest = ext.manifestJson;
    updateDefaultConfig(db, ext.id, JSON.stringify({ k: "updated" }));
    const after = getExtensionById(db, ext.id)!;
    expect(after.manifestJson).toBe(originalManifest);
    const cfg = JSON.parse(after.defaultConfigJson ?? "{}");
    expect(cfg.k).toBe("updated");
  });
});
