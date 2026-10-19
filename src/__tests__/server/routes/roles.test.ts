import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import type BetterSqlite3 from "better-sqlite3";
import { setupTestDb, clearTestDb } from "../../helpers/test-db.js";

let testDb: BetterSqlite3.Database;
let cleanup: () => void;

vi.mock("../../../store/db.js", () => ({
  getDb: () => testDb,
  closeDb: () => {},
}));

// Use vi.hoisted() so the factory can reference the mock fns
const { mockEnsureWorkspace, mockWriteCLAUDEmd, mockSyncSettings } = vi.hoisted(() => ({
  mockEnsureWorkspace: vi.fn(),
  mockWriteCLAUDEmd: vi.fn(),
  mockSyncSettings: vi.fn(),
}));

vi.mock("../../../store/role-workspace.js", () => ({
  ensureRoleWorkspace: mockEnsureWorkspace,
  writeRoleCLAUDEmd: mockWriteCLAUDEmd,
  syncRoleSettings: mockSyncSettings,
  getRoleWorkspacePath: (name: string) => `/tmp/roles/${name}`,
  existsSync: () => true,
}));

// Mock plugin-registry (D-012: plugin-registry replaces plugin/role-plugins stores)
vi.mock("../../../store/plugin-registry.js", () => ({
  listInstalledPlugins: vi.fn(() => []),
  scanDirectoryConfig: vi.fn(() => ({ enabledPlugins: {}, mcpServers: {}, allowedTools: [], disallowedTools: [] })),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    rmdirSync: vi.fn(),
  };
});

vi.mock("../../../lib/embedding.js", () => ({
  isModelAvailable: () => true,
}));

vi.mock("../../../config/role-env-sync.js", () => ({
  computeRoleEnvDiff: vi.fn(() => []),
  syncRoleDbToEnvFile: vi.fn(() => 0),
  readRoleEnvFile: vi.fn(() => null),
}));


import Fastify from "fastify";
import { roleRoutes } from "../../../server/routes/roles.js";
import { createRole } from "../../../store/roles.js";
import type { Role } from "../../../shared/types.js";

describe("role routes", () => {
  beforeAll(() => {
    const result = setupTestDb();
    testDb = result.db;
    cleanup = result.cleanup;
  });

  afterAll(() => cleanup());

  beforeEach(() => {
    clearTestDb();
    vi.clearAllMocks();
  });

  async function buildApp() {
    const app = Fastify();
    await app.register(roleRoutes);
    return app;
  }

  const makeRole = (overrides: Partial<Role> = {}): Role => ({
    id: `role-${Math.random().toString(36).slice(2)}`,
    name: "测试角色",
    cagPrompt: "Test CAG prompt",
    learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
    memoryStreamId: `mem-${Math.random().toString(36).slice(2)}`,
    status: "active",
    preferences: {},
    createdAt: Date.now(),
    ...overrides,
  });

  describe("GET /roles", () => {
    it("returns empty roles list", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/roles" });
      expect(res.statusCode).toBe(200);
      expect(res.json().roles).toEqual([]);
    });

    it("returns roles list", async () => {
      const role = makeRole({ name: "审慎者" });
      createRole(role);

      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/roles" });
      expect(res.statusCode).toBe(200);
      expect(res.json().roles).toHaveLength(1);
      expect(res.json().roles[0].name).toBe("审慎者");
    });

    it("filters by status", async () => {
      createRole(makeRole({ name: "审慎者", status: "active" }));
      createRole(makeRole({ name: "敏捷者", status: "inactive" }));

      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/roles?status=active" });
      expect(res.json().roles).toHaveLength(1);
      expect(res.json().roles[0].name).toBe("审慎者");
    });
  });

  describe("POST /roles", () => {
    it("creates a role and workspace", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/roles",
        payload: { name: "测试角色", cagPrompt: "A test role." },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().role.name).toBe("测试角色");
      expect(res.json().role.cagPrompt).toBe("A test role.");
      expect(mockEnsureWorkspace).toHaveBeenCalled();
    });

    it("returns 409 on duplicate name", async () => {
      createRole(makeRole({ name: "审慎者" }));
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/roles",
        payload: { name: "审慎者" },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe("CONFLICT");
    });

    it("creates a role with runtime-enforced osCapabilities", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/roles",
        payload: {
          name: "系统代理",
          osCapabilities: [
            { id: "automation", targets: ["com.apple.mail", "com.apple.systemevents"] },
            { id: "accessibility" },
          ],
        },
      });

      expect(res.statusCode).toBe(201);
      expect(res.json().role.osCapabilities).toEqual([
        { id: "accessibility" },
        { id: "automation", targets: ["com.apple.mail", "com.apple.systemevents"] },
      ]);
    });

    it("rejects non-editable osCapabilities", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/roles",
        payload: {
          name: "受限角色",
          osCapabilities: [{ id: "full-disk-access" }],
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain("not editable");
    });

    it("round-trips effortTier through POST", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/roles",
        payload: { name: "tier-create-role", effortTier: "high" },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().role.effortTier).toBe("high");
    });

    it("round-trips skills array through POST", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/roles",
        payload: { name: "skills-create-role", skills: ["pdf"] },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().role.skills).toEqual(["pdf"]);
    });

    it("round-trips skills='all' sentinel through POST", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/roles",
        payload: { name: "skills-all-create-role", skills: "all" },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().role.skills).toBe("all");
    });
  });

  describe("GET /roles/:id", () => {
    it("returns role by id", async () => {
      const role = makeRole({ name: "审慎者" });
      createRole(role);

      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: `/roles/${role.id}` });
      expect(res.statusCode).toBe(200);
      expect(res.json().role.name).toBe("审慎者");
    });

    it("returns 404 for non-existent role", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/roles/non-existent" });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("PATCH /roles/:id", () => {
    it("updates CAG prompt and learned rules", async () => {
      const role = makeRole({ name: "审慎者" });
      createRole(role);

      const app = await buildApp();
      const res = await app.inject({
        method: "PATCH",
        url: `/roles/${role.id}`,
        payload: { cagPrompt: "Updated CAG", learnedRules: ["newRule1"] },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().role.cagPrompt).toBe("Updated CAG");
      // Legacy string[] is auto-migrated to structured form
      expect(res.json().role.learnedRules).toEqual({ stylePreferences: ["newRule1"], avoidedActions: [], pinnedParameters: [] });
      expect(mockWriteCLAUDEmd).toHaveBeenCalled();
    });

    it("returns 404 for non-existent role", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "PATCH",
        url: "/roles/non-existent",
        payload: { cagPrompt: "Updated" },
      });
      expect(res.statusCode).toBe(404);
    });

    it("updates osCapabilities", async () => {
      const role = makeRole({ name: "自动化角色" });
      createRole(role);

      const app = await buildApp();
      const res = await app.inject({
        method: "PATCH",
        url: `/roles/${role.id}`,
        payload: {
          osCapabilities: [{ id: "automation", targets: ["com.apple.mail"] }],
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().role.osCapabilities).toEqual([
        { id: "automation", targets: ["com.apple.mail"] },
      ]);
    });

    it("rejects invalid automation target bundle ids", async () => {
      const role = makeRole({ name: "坏目标角色" });
      createRole(role);

      const app = await buildApp();
      const res = await app.inject({
        method: "PATCH",
        url: `/roles/${role.id}`,
        payload: {
          osCapabilities: [{ id: "automation", targets: ["Mail App"] }],
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain("Invalid automation target bundle id");
    });

    it("round-trips effortTier through PATCH", async () => {
      const role = makeRole({ name: "tier-test-role" });
      createRole(role);

      const app = await buildApp();
      const res = await app.inject({
        method: "PATCH",
        url: `/roles/${role.id}`,
        payload: { effortTier: "high" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().role.effortTier).toBe("high");
    });

    it("clears effortTier when PATCH body sets it to null", async () => {
      const role = makeRole({ name: "tier-clear-role", effortTier: "medium" });
      createRole(role);

      const app = await buildApp();
      const res = await app.inject({
        method: "PATCH",
        url: `/roles/${role.id}`,
        payload: { effortTier: null },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().role.effortTier).toBeUndefined();
    });

    it("round-trips skills array through PATCH", async () => {
      const role = makeRole({ name: "skills-array-role" });
      createRole(role);

      const app = await buildApp();
      const res = await app.inject({
        method: "PATCH",
        url: `/roles/${role.id}`,
        payload: { skills: ["pdf", "docx"] },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().role.skills).toEqual(["pdf", "docx"]);
    });

    it("round-trips skills='all' sentinel through PATCH", async () => {
      const role = makeRole({ name: "skills-all-role" });
      createRole(role);

      const app = await buildApp();
      const res = await app.inject({
        method: "PATCH",
        url: `/roles/${role.id}`,
        payload: { skills: "all" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().role.skills).toBe("all");
    });

    it("rejects invalid effortTier", async () => {
      const role = makeRole({ name: "bad-tier-role" });
      createRole(role);

      const app = await buildApp();
      const res = await app.inject({
        method: "PATCH",
        url: `/roles/${role.id}`,
        payload: { effortTier: "extreme" },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("DELETE /roles/:id", () => {
    it("deletes role and workspace", async () => {
      const role = makeRole({ name: "审慎者" });
      createRole(role);

      const app = await buildApp();
      const res = await app.inject({ method: "DELETE", url: `/roles/${role.id}` });
      expect(res.statusCode).toBe(200);
      expect(res.json().deleted).toBe(true);
    });

    it("returns 404 for non-existent role", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "DELETE", url: "/roles/non-existent" });
      expect(res.statusCode).toBe(404);
    });
  });

  // POST /roles/:id/scan-directory
  describe("POST /roles/:id/scan-directory", () => {
    it("scans a directory and returns config", async () => {
      const role = makeRole({ name: "审慎者" });
      createRole(role);

      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: `/roles/${role.id}/scan-directory`,
        payload: { path: "/tmp/test-project" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveProperty("path");
      expect(res.json()).toHaveProperty("enabledPlugins");
      expect(res.json()).toHaveProperty("mcpServers");
    });

    it("returns 400 for missing path", async () => {
      const role = makeRole({ name: "敏捷者" });
      createRole(role);

      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: `/roles/${role.id}/scan-directory`,
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 404 for non-existent role", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/roles/non-existent/scan-directory",
        payload: { path: "/tmp" },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("envVars", () => {
    it("creates role with envVars", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/roles",
        payload: { name: "env_role", envVars: { GITHUB_TOKEN: "ghp_abc", MY_KEY: "val" } },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().role.envVars).toEqual({ GITHUB_TOKEN: "ghp_abc", MY_KEY: "val" });
    });

    it("updates role envVars via PATCH", async () => {
      const role = makeRole({ name: "env_role2" });
      createRole(role);

      const app = await buildApp();
      const res = await app.inject({
        method: "PATCH",
        url: `/roles/${role.id}`,
        payload: { envVars: { NEW_KEY: "new_val" } },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().role.envVars).toEqual({ NEW_KEY: "new_val" });
    });

    it("rejects ANTHROPIC_* keys in envVars on create", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/roles",
        payload: { name: "bad_role", envVars: { ANTHROPIC_API_KEY: "sk-hacked" } },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe("VALIDATION_ERROR");
    });

    it("rejects ANTHROPIC_* keys in envVars on PATCH", async () => {
      const role = makeRole({ name: "env_role3" });
      createRole(role);

      const app = await buildApp();
      const res = await app.inject({
        method: "PATCH",
        url: `/roles/${role.id}`,
        payload: { envVars: { ANTHROPIC_BASE_URL: "http://evil" } },
      });
      expect(res.statusCode).toBe(400);
    });

    it("rejects invalid env var key format", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/roles",
        payload: { name: "bad_key_role", envVars: { "invalid-key": "val" } },
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns envVars in GET response", async () => {
      const role = makeRole({ name: "env_get_role", envVars: { SECRET_KEY: "s3cr3t" } });
      createRole(role);

      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: `/roles/${role.id}` });
      expect(res.statusCode).toBe(200);
      expect(res.json().role.envVars).toEqual({ SECRET_KEY: "s3cr3t" });
    });

    // D-011: mcpServers removed from PATCH /roles
    it("PATCH /roles/:id body { mcpServers: {} } returns 400 with MCP_SERVERS_REMOVED code", async () => {
      const role = makeRole({ name: "d011_reject_role" });
      createRole(role);

      const app = await buildApp();
      const res = await app.inject({
        method: "PATCH",
        url: `/roles/${role.id}`,
        payload: { mcpServers: {} },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe("MCP_SERVERS_REMOVED");
    });

    it("PATCH /roles/:id body { cagPrompt: 'new' } still returns 200 (regression)", async () => {
      const role = makeRole({ name: "d011_pass_role" });
      createRole(role);

      const app = await buildApp();
      const res = await app.inject({
        method: "PATCH",
        url: `/roles/${role.id}`,
        payload: { cagPrompt: "updated prompt" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().role.cagPrompt).toBe("updated prompt");
    });
  });
});
