import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import { mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type BetterSqlite3 from "better-sqlite3";
import { setupTestDb, clearTestDb } from "../helpers/test-db.js";

let testDb: BetterSqlite3.Database;
let cleanup: () => void;
let tempDir: string;

// Mock db so all store modules use the test db
vi.mock("../../store/db.js", () => ({
  getDb: () => testDb,
  closeDb: () => {},
}));

// Mock constants to use a temp dir
const { mockRuntimeDir } = vi.hoisted(() => ({
  mockRuntimeDir: { value: "/tmp" },
}));
vi.mock("../../shared/constants.js", () => ({
  get RUNTIME_DIR() { return mockRuntimeDir.value; },
  DEFAULT_SENSITIVE_PATHS: ["~/.ssh", "~/.aws", "~/.gnupg", "/etc/shadow"],
  DEFAULT_DENIED_READ_PATHS: ["~/.ssh", "~/.aws", "~/.gnupg", "/etc/shadow"],
  REDACTION_PATTERNS: [],
  MAX_TOOL_OUTPUT_SIZE: 1024,
}));

import {
  writeRoleCLAUDEmd,
  syncRoleSettings,
  getRoleWorkspacePath,
  ensureRoleWorkspace,
} from "../../store/role-workspace.js";
import { createRole, getRole, updateRole } from "../../store/roles.js";

describe("store/role-workspace", () => {
  beforeAll(() => {
    const result = setupTestDb();
    testDb = result.db;
    cleanup = result.cleanup;
  });

  beforeEach(() => {
    clearTestDb();
    tempDir = join(tmpdir(), `adam-ws-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    mockRuntimeDir.value = tempDir;
  });

  afterAll(() => {
    cleanup();
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  describe("getRoleWorkspacePath", () => {
    it("returns path under RUNTIME_DIR/roles/{roleName}", () => {
      const p = getRoleWorkspacePath("审慎者");
      expect(p).toContain("roles");
      expect(p).toContain("审慎者");
    });
  });

  describe("writeRoleCLAUDEmd", () => {
    it("writes CLAUDE.md with CAG prompt and learned rules", () => {
      const role = {
        id: "r1", name: "匠人",
        cagPrompt: "Test CAG prompt",
        learnedRules: { stylePreferences: ["rule1", "rule2"], avoidedActions: [], pinnedParameters: [] },
        memoryStreamId: "m1", status: "active" as const,
        preferences: {}, createdAt: Date.now(),
      };
      const wsPath = join(tempDir, "roles", "匠人");
      mkdirSync(wsPath, { recursive: true });

      writeRoleCLAUDEmd(wsPath, role);

      const content = readFileSync(join(wsPath, "CLAUDE.md"), "utf-8");
      expect(content).toContain("# 匠人");
      expect(content).toContain("Test CAG prompt");
      expect(content).toContain("- rule1");
      expect(content).toContain("- rule2");
    });

    it("omits learned rules section when empty", () => {
      const role = {
        id: "r1", name: "探索者",
        cagPrompt: "CAG",
        learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
        memoryStreamId: "m1", status: "active" as const,
        preferences: {}, createdAt: Date.now(),
      };
      const wsPath = join(tempDir, "roles", "探索者");
      mkdirSync(wsPath, { recursive: true });

      writeRoleCLAUDEmd(wsPath, role);

      const content = readFileSync(join(wsPath, "CLAUDE.md"), "utf-8");
      expect(content).toContain("# 探索者");
      expect(content).toContain("CAG");
      expect(content).not.toContain("Learned Rules\n- ");
    });
  });

  describe("syncRoleSettings", () => {
    it("writes settings.json with allowedTools when provided", () => {
      const wsPath = join(tempDir, "roles", "审慎者");
      mkdirSync(join(wsPath, ".claude"), { recursive: true });

      syncRoleSettings("r1", ["Read", "Write", "Bash"], wsPath);

      const settings = JSON.parse(readFileSync(join(wsPath, ".claude", "settings.json"), "utf-8"));
      expect(settings.allowedTools).toContain("Read");
      expect(settings.allowedTools).toContain("Write");
      expect(settings.allowedTools).toContain("Bash");
      // enabledPlugins is no longer written by syncRoleSettings (D-005)
      expect(settings.enabledPlugins).toBeUndefined();
    });

    it("omits allowedTools when role has no explicit permissions", () => {
      const wsPath = join(tempDir, "roles", "探索者");
      mkdirSync(join(wsPath, ".claude"), { recursive: true });

      expect(() => syncRoleSettings("r2", undefined, wsPath)).not.toThrow();

      const settings = JSON.parse(readFileSync(join(wsPath, ".claude", "settings.json"), "utf-8"));
      expect(settings.allowedTools).toBeUndefined();
      expect(settings.enabledPlugins).toBeUndefined();
    });
  });

  describe("ensureRoleWorkspace", () => {
    it("Role creation -> workspace initialized with correct settings.json", () => {
      const role = {
        id: "r-ensure-001",
        name: "匠人",
        cagPrompt: "Focus on clean code.",
        learnedRules: { stylePreferences: ["Write tests first"], avoidedActions: [], pinnedParameters: [] },
        memoryStreamId: "m-ensure-001",
        status: "active" as const,
        preferences: { effort: "high" as const },
        createdAt: Date.now(),
        allowedTools: ["Read", "Bash"],
      };
      const wsPath = ensureRoleWorkspace(role);

      const settings = JSON.parse(readFileSync(join(wsPath, ".claude", "settings.json"), "utf-8"));
      expect(settings.allowedTools).toContain("Read");
      expect(settings.allowedTools).toContain("Bash");
      // enabledPlugins no longer written (D-005: role_plugins removed)
      expect(settings.enabledPlugins).toBeUndefined();
    });

    it("creates CLAUDE.md in workspace", () => {
      const role = {
        id: "r-claude-001",
        name: "Test Role",
        cagPrompt: "A test role.",
        learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
        memoryStreamId: "m-claude-001",
        status: "active" as const,
        preferences: {},
        createdAt: Date.now(),
      };
      const wsPath = ensureRoleWorkspace(role);

      const claudeMd = join(wsPath, "CLAUDE.md");
      expect(existsSync(claudeMd)).toBe(true);
      const content = readFileSync(claudeMd, "utf-8");
      expect(content).toContain("# Test Role");
      expect(content).toContain("A test role.");
    });
  });

  describe("additionalDirectories (AdditionalDirectory[])", () => {
    it("Role creation with additionalDirectories persists and reads correctly", () => {
      const role = {
        id: "r-add-dir-001",
        name: "匠人-add-dirs",
        cagPrompt: "Test",
        learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
        memoryStreamId: "m-add-dir-001",
        status: "active" as const,
        preferences: {},
        createdAt: Date.now(),
        additionalDirectories: [{ path: tempDir }],
      };
      createRole(role);

      const saved = getRole("r-add-dir-001");
      expect(saved?.additionalDirectories).toHaveLength(1);
      expect(saved?.additionalDirectories?.[0]).toEqual({ path: tempDir });
    });

    it("backward-compat: bare string additionalDirectories parsed as { path: string }", () => {
      // Simulate DB storing old string[] format by inserting raw JSON with bare strings.
      // rowToRole backward-compat wraps bare strings as { path: string }.
      const db = testDb;
      const id = "r-backcompat-001";
      db.prepare(`
        INSERT INTO roles (id, name, cag_prompt, learned_rules, memory_stream_id, status, preferences, created_at, additional_directories)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, "backcompat-test", "Test", "[]", "m-backcompat-001", "active", "{}", Date.now(), JSON.stringify([tempDir]));

      const saved = getRole(id);
      expect(saved?.additionalDirectories?.[0]).toEqual({ path: tempDir });
    });

    it("updateRole with additionalDirectories overwrites existing value", () => {
      const id = "r-upd-dir-001";
      createRole({
        id,
        name: "upd-dir-test",
        cagPrompt: "Test",
        learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
        memoryStreamId: "m-upd-dir-001",
        status: "active",
        preferences: {},
        createdAt: Date.now(),
        additionalDirectories: [{ path: tempDir }],
      });

      updateRole(id, { additionalDirectories: [{ path: "/var/tmp" }, { path: "/opt" }] });
      const saved = getRole(id);
      expect(saved?.additionalDirectories).toHaveLength(2);
      expect(saved?.additionalDirectories?.[0].path).toBe("/var/tmp");
      expect(saved?.additionalDirectories?.[1].path).toBe("/opt");
    });

    it("updateRole with empty array clears additionalDirectories", () => {
      const id = "r-clr-dir-001";
      createRole({
        id,
        name: "clr-dir-test",
        cagPrompt: "Test",
        learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
        memoryStreamId: "m-clr-dir-001",
        status: "active",
        preferences: {},
        createdAt: Date.now(),
        additionalDirectories: [{ path: tempDir }],
      });

      updateRole(id, { additionalDirectories: [] });
      const saved = getRole(id);
      expect(saved?.additionalDirectories).toEqual([]);
    });

    describe("path security validation", () => {
      it("rejects relative paths (not absolute)", () => {
        expect(() =>
          createRole({
            id: "r-rej-001", name: "rej-rel", cagPrompt: "Test",
            learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] }, memoryStreamId: "m-rej-001",
            status: "active", preferences: {}, createdAt: Date.now(),
            additionalDirectories: [{ path: "foo/bar/baz" }],
          }),
        ).toThrow("must be absolute paths");
      });

      it("rejects hardcoded denied paths (e.g. ~/.ssh)", () => {
        const sshPath = join(process.env.HOME ?? "/Users/example", ".ssh");
        mkdirSync(sshPath, { recursive: true });
        expect(() =>
          createRole({
            id: "r-rej-002", name: "rej-deny", cagPrompt: "Test",
            learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] }, memoryStreamId: "m-rej-002",
            status: "active", preferences: {}, createdAt: Date.now(),
            additionalDirectories: [{ path: sshPath }],
          }),
        ).toThrow("hardcoded denied path");
      });

      it("accepts valid absolute paths that exist", () => {
        expect(() =>
          createRole({
            id: "r-ok-001", name: "ok-abs", cagPrompt: "Test",
            learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] }, memoryStreamId: "m-ok-001",
            status: "active", preferences: {}, createdAt: Date.now(),
            additionalDirectories: [{ path: tempDir }],
          }),
        ).not.toThrow();
        const saved = getRole("r-ok-001");
        expect(saved?.additionalDirectories?.[0].path).toBe(tempDir);
      });

      it("validates AdditionalDirectory with inherit flags", () => {
        expect(() =>
          createRole({
            id: "r-inherit-001", name: "inherit-test", cagPrompt: "Test",
            learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] }, memoryStreamId: "m-inherit-001",
            status: "active", preferences: {}, createdAt: Date.now(),
            additionalDirectories: [{ path: tempDir, inheritPlugins: true, inheritMcp: false }],
          }),
        ).not.toThrow();
        const saved = getRole("r-inherit-001");
        expect(saved?.additionalDirectories?.[0].inheritPlugins).toBe(true);
        expect(saved?.additionalDirectories?.[0].inheritMcp).toBe(false);
      });
    });
  });
});
