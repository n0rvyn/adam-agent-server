import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = join(tmpdir(), `adam-role-env-sync-${Date.now()}`);

vi.mock("../../store/role-workspace.js", () => ({
  getRoleWorkspacePath: (name: string) => join(TEST_DIR, name),
}));

vi.mock("../../lib/logger.js", () => ({
  getLogger: () => ({
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  }),
}));

import {
  readRoleEnvFile,
  seedRoleEnvFromFile,
  computeRoleEnvDiff,
  syncRoleDbToEnvFile,
} from "../../config/role-env-sync.js";

describe("role-env-sync", () => {
  beforeEach(() => {
    mkdirSync(join(TEST_DIR, "test-role"), { recursive: true });
  });

  afterEach(() => {
    try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
  });

  describe("readRoleEnvFile", () => {
    it("returns null when .env does not exist", () => {
      expect(readRoleEnvFile("test-role")).toBeNull();
    });

    it("parses key-value pairs", () => {
      writeFileSync(join(TEST_DIR, "test-role", ".env"), "MY_KEY=hello\nSECRET=world\n");
      const env = readRoleEnvFile("test-role");
      expect(env).toEqual({ MY_KEY: "hello", SECRET: "world" });
    });

    it("strips quotes and handles export prefix", () => {
      writeFileSync(join(TEST_DIR, "test-role", ".env"), 'export FOO="bar"\nBAZ=\'qux\'\n');
      const env = readRoleEnvFile("test-role");
      expect(env).toEqual({ FOO: "bar", BAZ: "qux" });
    });

    it("skips comments and blank lines", () => {
      writeFileSync(join(TEST_DIR, "test-role", ".env"), "# comment\n\nKEY=val\n");
      expect(readRoleEnvFile("test-role")).toEqual({ KEY: "val" });
    });
  });

  describe("seedRoleEnvFromFile", () => {
    it("returns existing DB envVars when no .env file", () => {
      const result = seedRoleEnvFromFile("test-role", { EXISTING: "yes" });
      expect(result).toEqual({ EXISTING: "yes" });
    });

    it("seeds only keys not in DB", () => {
      writeFileSync(join(TEST_DIR, "test-role", ".env"), "NEW_KEY=new\nEXISTING=file_val\n");
      const result = seedRoleEnvFromFile("test-role", { EXISTING: "db_val" });
      expect(result).toEqual({ EXISTING: "db_val", NEW_KEY: "new" });
    });

    it("filters ANTHROPIC_* keys", () => {
      writeFileSync(join(TEST_DIR, "test-role", ".env"), "ANTHROPIC_API_KEY=bad\nGOOD_KEY=ok\n");
      const result = seedRoleEnvFromFile("test-role", undefined);
      expect(result).toEqual({ GOOD_KEY: "ok" });
    });

    it("returns undefined for empty result", () => {
      writeFileSync(join(TEST_DIR, "test-role", ".env"), "ANTHROPIC_API_KEY=bad\n");
      const result = seedRoleEnvFromFile("test-role", undefined);
      expect(result).toBeUndefined();
    });
  });

  describe("computeRoleEnvDiff", () => {
    it("returns empty when no .env file", () => {
      expect(computeRoleEnvDiff("test-role", { KEY: "val" })).toEqual([]);
    });

    it("detects differences", () => {
      writeFileSync(join(TEST_DIR, "test-role", ".env"), "KEY=file_val\nNEW=only_file\n");
      const diffs = computeRoleEnvDiff("test-role", { KEY: "db_val", OLD: "only_db" });
      expect(diffs).toContainEqual({ envKey: "KEY", dbValue: "db_val", envValue: "file_val" });
      expect(diffs).toContainEqual({ envKey: "NEW", dbValue: "", envValue: "only_file" });
      expect(diffs).toContainEqual({ envKey: "OLD", dbValue: "only_db", envValue: "" });
    });

    it("ignores ANTHROPIC_* keys in .env", () => {
      writeFileSync(join(TEST_DIR, "test-role", ".env"), "ANTHROPIC_API_KEY=x\nMY_KEY=y\n");
      const diffs = computeRoleEnvDiff("test-role", {});
      expect(diffs).toHaveLength(1);
      expect(diffs[0].envKey).toBe("MY_KEY");
    });
  });

  describe("syncRoleDbToEnvFile", () => {
    it("writes DB env vars to .env", () => {
      const changed = syncRoleDbToEnvFile("test-role", { A: "1", B: "2" });
      expect(changed).toBe(2);
      const content = readFileSync(join(TEST_DIR, "test-role", ".env"), "utf-8");
      expect(content).toContain("A=1");
      expect(content).toContain("B=2");
    });

    it("preserves comments in existing .env", () => {
      writeFileSync(join(TEST_DIR, "test-role", ".env"), "# My config\nA=old\n");
      syncRoleDbToEnvFile("test-role", { A: "new", B: "added" });
      const content = readFileSync(join(TEST_DIR, "test-role", ".env"), "utf-8");
      expect(content).toContain("# My config");
      expect(content).toContain("A=new");
      expect(content).toContain("B=added");
    });

    it("handles empty DB env vars", () => {
      const changed = syncRoleDbToEnvFile("test-role", undefined);
      expect(changed).toBe(0);
    });
  });
});
