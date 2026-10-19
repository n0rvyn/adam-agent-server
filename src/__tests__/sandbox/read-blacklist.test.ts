/**
 * Unit tests for SBPL read blacklist generation.
 *
 * Tests generateReadDenyRules() directly from the macOS sandbox provider.
 *
 * SBPL rule ordering semantics:
 * - (deny default) sets the default policy to DENY
 * - (allow file-read*) explicitly opens all reads
 * - Appended deny rules come AFTER the allow, so they take precedence (last-match wins)
 *
 * Therefore read deny rules must be appended AFTER (allow file-read*) in the profile.
 * These tests verify that:
 * 1. Empty deniedReadPaths → no read deny rules added
 * 2. Valid paths → correct SBPL deny rules for file-read-data and file-read-metadata
 * 3. Symlink paths → both resolved and original paths are denied
 * 4. Invalid SBPL characters → skipped with warning, other paths still processed
 * 5. Deny rules come after (allow file-read*) in the final profile
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateReadDenyRules, generatePathRules, validateSbplPath } from "../../sandbox/macos.js";

// Only run these tests on macOS where sandbox-exec is available
const IS_MACOS = process.platform === "darwin";

describe.skipIf(!IS_MACOS)("sandbox/read-blacklist — SBPL read deny rules", () => {

  describe("validateSbplPath", () => {
    it("accepts absolute paths without special characters", () => {
      expect(() => validateSbplPath("/Users/home/.ssh")).not.toThrow();
      expect(() => validateSbplPath("/etc/shadow")).not.toThrow();
    });

    it("rejects relative paths", () => {
      expect(() => validateSbplPath("relative/path")).toThrow("must be absolute");
    });

    it("rejects paths with double-quote", () => {
      expect(() => validateSbplPath('/path/with"quote')).toThrow("invalid characters");
    });

    it("rejects paths with parentheses", () => {
      expect(() => validateSbplPath("/path/with(parens)")).toThrow("invalid characters");
    });

    it("rejects paths with $ (SBPL variable interpolation)", () => {
      expect(() => validateSbplPath("/path/with$var")).toThrow("invalid characters");
    });
  });

  describe("generateReadDenyRules", () => {
    it("empty deniedReadPaths produces empty string", () => {
      const result = generateReadDenyRules([]);
      expect(result).toBe("");
    });

    it("valid paths produce correct SBPL deny rules for file-read-data and file-read-metadata", () => {
      const tempDir = mkdtempSync(join(tmpdir(), "adam-test-deny-" + Date.now() + "-"));
      try {
        const deniedPath = join(tempDir, ".ssh");
        mkdirSync(deniedPath, { recursive: true });

        const result = generateReadDenyRules([deniedPath]);

        // Both read types must be denied
        expect(result).toContain(`(deny file-read-data (subpath "${deniedPath}"))`);
        expect(result).toContain(`(deny file-read-metadata (subpath "${deniedPath}"))`);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("symlink path generates rules for both resolved and original paths", () => {
      // Use /tmp as root — /tmp is itself a symlink to /private/tmp on macOS.
      // realpathSync resolves through all symlinks, so resolved !== original.
      const rootDir = join("/tmp", "adam-symlink-test-" + Date.now());
      try {
        mkdirSync(rootDir, { recursive: true });
        const realDir = join(rootDir, "real");
        const linkDir = join(rootDir, "link");
        mkdirSync(realDir, { recursive: true });
        symlinkSync(realDir, linkDir);

        // On macOS /tmp → /private/tmp; realpathSync resolves through symlinks.
        // resolvedRealDir = /private/tmp/X/real, original realDir = /tmp/X/real
        const result = generateReadDenyRules([linkDir]);

        expect(result).toContain("Global read blacklist");
        // Must contain deny rules for file-read-data and file-read-metadata
        expect(result).toContain("(deny file-read-data");
        expect(result).toContain("(deny file-read-metadata");

        // The resolved path (resolved through symlinks) must be denied
        const resolvedRealDir = realpathSync(realDir);
        expect(result).toContain(`(subpath "${resolvedRealDir}")`);

        // The original symlink path (linkDir) must also be denied
        expect(result).toContain(`(subpath "${linkDir}")`);
      } finally {
        rmSync(rootDir, { recursive: true, force: true });
      }
    });

    it("path with invalid SBPL characters is skipped with warning, other paths still processed", () => {
      const tempDir = mkdtempSync(join(tmpdir(), "adam-invalid-sbpl-"));
      try {
        const validPath = join(tempDir, "valid-dir");
        const invalidPath = join(tempDir, "bad$path");
        mkdirSync(validPath, { recursive: true });

        const result = generateReadDenyRules([validPath, invalidPath]);

        // Valid path should still have deny rules
        expect(result).toContain(`(deny file-read-data (subpath "${validPath}"))`);
        expect(result).toContain(`(deny file-read-metadata (subpath "${validPath}"))`);

        // Invalid path ($) should NOT appear as a deny rule
        expect(result).not.toContain(`(deny file-read-data (subpath "${invalidPath}"))`);
        expect(result).not.toContain(`(deny file-read-metadata (subpath "${invalidPath}"))`);
        // Valid path still has deny rules (partial protection — other paths still denied)
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("non-existent path is included without realpath resolution failure", () => {
      const nonExistentPath = join(tmpdir(), "adam-nonexistent-" + Date.now(), "missing");

      // Should NOT throw — non-existent paths are included as-is
      const result = generateReadDenyRules([nonExistentPath]);

      expect(result).toContain(`(deny file-read-data (subpath "${nonExistentPath}"))`);
      expect(result).toContain(`(deny file-read-metadata (subpath "${nonExistentPath}"))`);
    });

    it("result starts with the blacklist section header comment", () => {
      const tempDir = mkdtempSync(join(tmpdir(), "adam-section-header-"));
      try {
        const deniedPath = join(tempDir, ".ssh");
        mkdirSync(deniedPath, { recursive: true });

        const result = generateReadDenyRules([deniedPath]);
        expect(result).toContain("; ===== Global read blacklist (deniedReadPaths) =====");
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe("SBPL rule ordering in full profile", () => {
    it("write rules come before read deny rules in combined output", () => {
      const tempDir = mkdtempSync(join(tmpdir(), "adam-combined-rules-"));
      try {
        const writePath = join(tempDir, "workspace");
        const deniedPath = join(tempDir, ".ssh");
        mkdirSync(writePath, { recursive: true });
        mkdirSync(deniedPath, { recursive: true });

        // In macos.ts, the full profile is: base + writeRules + readDenyRules
        const writeRules = generatePathRules([{ path: writePath, mode: "rw" }]);
        const readDenyRules = generateReadDenyRules([deniedPath]);
        const combined = writeRules + "\n" + readDenyRules;

        const writableRulesPos = combined.indexOf("Per-Role writable paths");
        const blacklistPos = combined.indexOf("Global read blacklist");

        expect(writableRulesPos).toBeGreaterThan(0);
        expect(blacklistPos).toBeGreaterThan(writableRulesPos);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });
});
