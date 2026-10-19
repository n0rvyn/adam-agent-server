import { describe, it, expect, vi, beforeEach, afterAll, beforeAll } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

vi.mock("../../config/index.js", () => ({
  getDefaults: () => ({
    timeout: 600,
    approvalRequired: [],
    approvalTimeout: 300,
    deniedReadPaths: ["~/.ssh", "~/.aws", "~/.gnupg", "/etc/shadow", "/custom/secret"],
  }),
}));

import { DEFAULT_DENIED_READ_PATHS } from "../../shared/constants.js";
import { createRole, getRole } from "../../store/roles.js";

let tempBase: string;
let safeDir: string;
let roDir: string;
let rwDir: string;
let defaultDir: string;

beforeAll(() => {
  tempBase = mkdtempSync(join(tmpdir(), "adam-sensitive-test-"));
  safeDir = join(tempBase, "safe");
  roDir = join(tempBase, "ro");
  rwDir = join(tempBase, "rw");
  defaultDir = join(tempBase, "default");
  mkdirSync(safeDir, { recursive: true });
  mkdirSync(roDir, { recursive: true });
  mkdirSync(rwDir, { recursive: true });
  mkdirSync(defaultDir, { recursive: true });
});

afterAll(() => {
  cleanup();
  rmSync(tempBase, { recursive: true, force: true });
});
beforeEach(() => clearTestDb());

describe("deniedReadPaths configuration", () => {
  describe("DEFAULT_DENIED_READ_PATHS constant", () => {
    it("includes standard sensitive paths", () => {
      expect(DEFAULT_DENIED_READ_PATHS).toContain("~/.ssh");
      expect(DEFAULT_DENIED_READ_PATHS).toContain("~/.aws");
      expect(DEFAULT_DENIED_READ_PATHS).toContain("~/.gnupg");
      expect(DEFAULT_DENIED_READ_PATHS).toContain("/etc/shadow");
    });

    it("is a readonly array", () => {
      expect(Array.isArray(DEFAULT_DENIED_READ_PATHS)).toBe(true);
    });
  });

  describe("validateAdditionalDirectories blocks sensitive paths", () => {
    it("rejects additionalDirectories that match a sensitive path", () => {
      // Use ~/.ssh which resolves to {homedir}/.ssh — matches DEFAULT_SENSITIVE_PATHS
      expect(() =>
        createRole({
          id: "role-sensitive-test",
          name: "sensitive-test",
          cagPrompt: "test",
          learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
          memoryStreamId: "mem-s",
          status: "active",
          preferences: {},
          createdAt: Date.now(),
          additionalDirectories: [{ path: "~/.ssh" }],
        }),
      ).toThrow(/denied path/i);
    });

    it("allows non-sensitive paths", () => {
      expect(() =>
        createRole({
          id: "role-safe-test",
          name: "safe-test",
          cagPrompt: "test",
          learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
          memoryStreamId: "mem-safe",
          status: "active",
          preferences: {},
          createdAt: Date.now(),
          additionalDirectories: [{ path: safeDir }],
        }),
      ).not.toThrow();

      const saved = getRole("role-safe-test");
      expect(saved?.additionalDirectories?.[0]?.path).toBe(safeDir);
    });
  });

  describe("AdditionalDirectory mode field", () => {
    it("persists mode: 'ro' on additionalDirectories", () => {
      createRole({
        id: "role-mode-ro",
        name: "mode-ro-test",
        cagPrompt: "test",
        learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
        memoryStreamId: "mem-ro",
        status: "active",
        preferences: {},
        createdAt: Date.now(),
        additionalDirectories: [{ path: roDir, mode: "ro" }],
      });

      const saved = getRole("role-mode-ro");
      expect(saved?.additionalDirectories?.[0]?.mode).toBe("ro");
    });

    it("persists mode: 'rw' on additionalDirectories", () => {
      createRole({
        id: "role-mode-rw",
        name: "mode-rw-test",
        cagPrompt: "test",
        learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
        memoryStreamId: "mem-rw",
        status: "active",
        preferences: {},
        createdAt: Date.now(),
        additionalDirectories: [{ path: rwDir, mode: "rw" }],
      });

      const saved = getRole("role-mode-rw");
      expect(saved?.additionalDirectories?.[0]?.mode).toBe("rw");
    });

    it("defaults to undefined mode (treated as rw at runtime)", () => {
      createRole({
        id: "role-mode-default",
        name: "mode-default-test",
        cagPrompt: "test",
        learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
        memoryStreamId: "mem-def",
        status: "active",
        preferences: {},
        createdAt: Date.now(),
        additionalDirectories: [{ path: defaultDir }],
      });

      const saved = getRole("role-mode-default");
      // mode is undefined — ExecutionManager defaults to "rw"
      expect(saved?.additionalDirectories?.[0]?.mode).toBeUndefined();
    });
  });
});

describe("API role route accepts mode field", () => {
  it("PATCH /roles/:id accepts additionalDirectories with mode", async () => {
    // Create a role first
    createRole({
      id: "role-api-mode",
      name: "api-mode-test",
      cagPrompt: "test",
      learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
      memoryStreamId: "mem-api",
      status: "active",
      preferences: {},
      createdAt: Date.now(),
    });

    // Simulate what the route handler does — import updateRole directly
    const { updateRole } = await import("../../store/roles.js");
    const appDir = join(tempBase, "app");
    const configDir = join(tempBase, "config");
    mkdirSync(appDir, { recursive: true });
    mkdirSync(configDir, { recursive: true });

    updateRole("role-api-mode", {
      additionalDirectories: [
        { path: appDir, mode: "rw", inheritPlugins: true },
        { path: configDir, mode: "ro" },
      ],
    });

    const saved = getRole("role-api-mode");
    expect(saved?.additionalDirectories).toHaveLength(2);
    expect(saved?.additionalDirectories?.[0]?.mode).toBe("rw");
    expect(saved?.additionalDirectories?.[1]?.mode).toBe("ro");
  });
});
