/**
 * Task 1-tests: Runtime Resolver unit tests — must FAIL before Task 1-impl.
 *
 * Tests the contract of resolveExtensionsForTask:
 *   - binding lookup by roleId (enabled-only)
 *   - generated_server_name used as the key
 *   - computeEffectiveConfig integration (default merge + override)
 *   - placeholder substitution: ${HOME}, ${__dirname}, ${user_config.X}
 *   - throws UnresolvedPlaceholderError on missing user_config.X
 *   - returns SDK McpStdioServerConfig shape (type, command, args, env)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setupTestDb } from "../helpers/test-db.js";
import type BetterSqlite3 from "better-sqlite3";

// Extension store helpers
import { createOrUpgradeExtension } from "../../store/extensions.js";
import { createBinding } from "../../store/role-extensions.js";

// Module under test — will FAIL (module-not-found) before Task 1-impl
import { resolveExtensionsForTask } from "../../extensions/runtime-resolver.js";
import { UnresolvedPlaceholderError } from "../../extensions/placeholders.js";

// Mock getDb() so tests use the in-memory DB
vi.mock("../../store/db.js", () => ({
  getDb: () => db,
}));

let db: BetterSqlite3.Database;
let cleanup: () => void;

// ── Fixture helpers ──────────────────────────────────────────────────────────

const NODE_MANIFEST = {
  manifest_version: "0.3",
  name: "test-node-ext",
  display_name: "Test Node Extension",
  version: "0.1.0",
  description: "A node-type test extension",
  author: { name: "Test" },
  server: {
    type: "node",
    entry_point: "dist/index.js",
    mcp_config: {
      command: "node",
      args: ["dist/index.js"],
      env: {
        HOME_PATH: "${HOME}/data",
        API_KEY: "${user_config.api_key}",
      },
    },
  },
  user_config: {
    api_key: { type: "string" as const, title: "API Key", sensitive: true },
  },
};

const PYTHON_MANIFEST = {
  manifest_version: "0.3",
  name: "test-python-ext",
  display_name: "Test Python Extension",
  version: "0.2.0",
  description: "A python+uvx test extension",
  author: { name: "Test" },
  server: {
    type: "python",
    mcp_config: {
      command: "uvx",
      args: ["some-python-package"],
      env: {
        UV_CACHE_DIR: "${HOME}/Library/Caches/uv",
        DIRNAME_PATH: "${__dirname}/venv",
      },
    },
  },
};

const NO_USER_CONFIG_MANIFEST = {
  manifest_version: "0.3",
  name: "test-no-config-ext",
  display_name: "No Config Extension",
  version: "1.0.0",
  description: "An extension with no user_config",
  author: { name: "Test" },
  server: {
    type: "node",
    mcp_config: {
      command: "node",
      args: ["server.js"],
    },
  },
};

function makeTask(roleId: string) {
  return {
    id: "task-123",
    roleId,
    prompt: "do something",
    status: "running" as const,
    config: {},
    createdAt: Date.now(),
  };
}

function insertRole(roleId: string, name: string) {
  db.prepare(
    `INSERT INTO roles (id, name, cag_prompt, memory_stream_id, status, created_at)
     VALUES (?, ?, '', ?, 'active', ?)`,
  ).run(roleId, name, `mem-${roleId}`, Date.now());
}

// ── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  ({ db, cleanup } = setupTestDb());
});

afterEach(() => {
  cleanup();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("resolveExtensionsForTask", () => {
  it("returns empty object when role has no bindings", async () => {
    insertRole("role-a", "RoleA");
    const result = await resolveExtensionsForTask(makeTask("role-a"), { HOME: "/home/user" });
    expect(result).toEqual({});
  });

  it("returns empty object when task has no roleId", async () => {
    const task = { ...makeTask("role-a"), roleId: undefined };
    const result = await resolveExtensionsForTask(task as unknown as ReturnType<typeof makeTask>, { HOME: "/home/user" });
    expect(result).toEqual({});
  });

  it("returns one entry per enabled binding", async () => {
    insertRole("role-b", "RoleB");
    const ext = createOrUpgradeExtension(db, {
      name: "test-node-ext",
      version: "0.1.0",
      manifestJson: JSON.stringify(NODE_MANIFEST),
      packageHash: "hash1",
      defaultConfigJson: JSON.stringify({ api_key: "default-key" }),
    });
    createBinding(db, {
      roleId: "role-b",
      extensionId: ext.id,
      generatedServerName: "test-node-ext-mcpb",
      enabled: true,
    });

    const result = await resolveExtensionsForTask(makeTask("role-b"), { HOME: "/home/user" });
    expect(Object.keys(result)).toHaveLength(1);
    expect(result["test-node-ext-mcpb"]).toBeDefined();
  });

  it("EXCLUDES disabled bindings (enabled=false)", async () => {
    insertRole("role-c", "RoleC");
    const ext = createOrUpgradeExtension(db, {
      name: "test-node-ext",
      version: "0.1.0",
      manifestJson: JSON.stringify(NODE_MANIFEST),
      packageHash: "hash2",
      defaultConfigJson: JSON.stringify({ api_key: "default-key" }),
    });
    createBinding(db, {
      roleId: "role-c",
      extensionId: ext.id,
      generatedServerName: "test-node-ext-mcpb",
      enabled: false,
    });

    const result = await resolveExtensionsForTask(makeTask("role-c"), { HOME: "/home/user" });
    expect(result).toEqual({});
  });

  it("uses generated_server_name as the key in the returned map", async () => {
    insertRole("role-d", "RoleD");
    const ext = createOrUpgradeExtension(db, {
      name: "test-python-ext",
      version: "0.2.0",
      manifestJson: JSON.stringify(PYTHON_MANIFEST),
      packageHash: "hash3",
      defaultConfigJson: null,
    });
    createBinding(db, {
      roleId: "role-d",
      extensionId: ext.id,
      generatedServerName: "my-custom-server-name",
      enabled: true,
    });

    const result = await resolveExtensionsForTask(makeTask("role-d"), { HOME: "/home/user" });
    expect(result["my-custom-server-name"]).toBeDefined();
    expect(result["test-python-ext"]).toBeUndefined();
  });

  it("resolves effective config via computeEffectiveConfig (default merge override)", async () => {
    insertRole("role-e", "RoleE");
    const ext = createOrUpgradeExtension(db, {
      name: "test-node-ext",
      version: "0.1.0",
      manifestJson: JSON.stringify(NODE_MANIFEST),
      packageHash: "hash4",
      defaultConfigJson: JSON.stringify({ api_key: "default-key" }),
    });
    createBinding(db, {
      roleId: "role-e",
      extensionId: ext.id,
      generatedServerName: "test-node-ext-mcpb",
      configOverrideJson: JSON.stringify({ api_key: "override-key" }),
      enabled: true,
    });

    const result = await resolveExtensionsForTask(makeTask("role-e"), { HOME: "/home/user" });
    // The override key should be used (not the default)
    expect(result["test-node-ext-mcpb"]?.env?.API_KEY).toBe("override-key");
  });

  it("substitutes ${HOME} with ctx.HOME in mcp_config.env values", async () => {
    insertRole("role-f", "RoleF");
    const ext = createOrUpgradeExtension(db, {
      name: "test-node-ext",
      version: "0.1.0",
      manifestJson: JSON.stringify(NODE_MANIFEST),
      packageHash: "hash5",
      defaultConfigJson: JSON.stringify({ api_key: "any-key" }),
    });
    createBinding(db, {
      roleId: "role-f",
      extensionId: ext.id,
      generatedServerName: "test-node-ext-mcpb",
      enabled: true,
    });

    const result = await resolveExtensionsForTask(makeTask("role-f"), { HOME: "/home/testuser" });
    expect(result["test-node-ext-mcpb"]?.env?.HOME_PATH).toBe("/home/testuser/data");
  });

  it("substitutes ${__dirname} with the extension install dir (~/.adam/extensions/<name>/)", async () => {
    insertRole("role-g", "RoleG");
    const ext = createOrUpgradeExtension(db, {
      name: "test-python-ext",
      version: "0.2.0",
      manifestJson: JSON.stringify(PYTHON_MANIFEST),
      packageHash: "hash6",
      defaultConfigJson: null,
    });
    createBinding(db, {
      roleId: "role-g",
      extensionId: ext.id,
      generatedServerName: "python-ext-server",
      enabled: true,
    });

    const result = await resolveExtensionsForTask(makeTask("role-g"), { HOME: "/home/user" });
    // __dirname should resolve to <RUNTIME_DIR>/extensions/test-python-ext
    const dirnameValue = result["python-ext-server"]?.env?.DIRNAME_PATH ?? "";
    expect(dirnameValue).toContain("extensions/test-python-ext");
    expect(dirnameValue).toContain("/venv");
  });

  it("substitutes ${user_config.api_key} with the effective config value", async () => {
    insertRole("role-h", "RoleH");
    const ext = createOrUpgradeExtension(db, {
      name: "test-node-ext",
      version: "0.1.0",
      manifestJson: JSON.stringify(NODE_MANIFEST),
      packageHash: "hash7",
      defaultConfigJson: JSON.stringify({ api_key: "test-api-key-123" }),
    });
    createBinding(db, {
      roleId: "role-h",
      extensionId: ext.id,
      generatedServerName: "test-node-ext-mcpb",
      enabled: true,
    });

    const result = await resolveExtensionsForTask(makeTask("role-h"), { HOME: "/home/user" });
    expect(result["test-node-ext-mcpb"]?.env?.API_KEY).toBe("test-api-key-123");
  });

  it("throws UnresolvedPlaceholderError when ${user_config.X} missing from effective config", async () => {
    insertRole("role-i", "RoleI");
    // Extension references ${user_config.api_key} but no default and no override
    const ext = createOrUpgradeExtension(db, {
      name: "test-node-ext",
      version: "0.1.0",
      manifestJson: JSON.stringify(NODE_MANIFEST),
      packageHash: "hash8",
      defaultConfigJson: null, // no defaults → api_key is missing
    });
    createBinding(db, {
      roleId: "role-i",
      extensionId: ext.id,
      generatedServerName: "test-node-ext-mcpb",
      configOverrideJson: null, // no overrides either
      enabled: true,
    });

    await expect(
      resolveExtensionsForTask(makeTask("role-i"), { HOME: "/home/user" }),
    ).rejects.toThrow(UnresolvedPlaceholderError);
  });

  it("returns mcp_config.command + args + env shape expected by SDK McpStdioServerConfig", async () => {
    insertRole("role-j", "RoleJ");
    const ext = createOrUpgradeExtension(db, {
      name: "test-node-ext",
      version: "0.1.0",
      manifestJson: JSON.stringify(NODE_MANIFEST),
      packageHash: "hash9",
      defaultConfigJson: JSON.stringify({ api_key: "sdk-shape-key" }),
    });
    createBinding(db, {
      roleId: "role-j",
      extensionId: ext.id,
      generatedServerName: "test-node-ext-mcpb",
      enabled: true,
    });

    const result = await resolveExtensionsForTask(makeTask("role-j"), { HOME: "/home/user" });
    const entry = result["test-node-ext-mcpb"];
    expect(entry).toBeDefined();
    expect(entry?.type).toBe("stdio");
    expect(typeof entry?.command).toBe("string");
    expect(Array.isArray(entry?.args)).toBe(true);
    expect(typeof entry?.env).toBe("object");
  });

  it("handles extension with no env in mcp_config", async () => {
    insertRole("role-k", "RoleK");
    const ext = createOrUpgradeExtension(db, {
      name: "test-no-config-ext",
      version: "1.0.0",
      manifestJson: JSON.stringify(NO_USER_CONFIG_MANIFEST),
      packageHash: "hash10",
      defaultConfigJson: null,
    });
    createBinding(db, {
      roleId: "role-k",
      extensionId: ext.id,
      generatedServerName: "no-config-server",
      enabled: true,
    });

    const result = await resolveExtensionsForTask(makeTask("role-k"), { HOME: "/home/user" });
    const entry = result["no-config-server"];
    expect(entry).toBeDefined();
    expect(entry?.command).toBe("node");
    // env should be undefined or empty when no env in manifest
    expect(entry?.env === undefined || Object.keys(entry?.env ?? {}).length === 0).toBe(true);
  });
});
