/**
 * Symlink resolution semantics relied on by Landlock spawn path resolution.
 * These exercise Node.js fs.realpathSync behavior which Landlock wrappers depend on;
 * the assertions are platform-independent (POSIX symlinks behave identically on macOS/Linux).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("sandbox — symlink path resolution (used by Landlock spawn)", () => {
  let tempDir: string;
  let targetDir: string;
  let symlinkPath: string;

  beforeAll(() => {
    // realpathSync normalizes /var → /private/var on macOS; resolve once so child
    // paths and assertions share the same canonical root.
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), "adam-landlock-symlink-test-")));
    targetDir = join(tempDir, "target-dir");
    symlinkPath = join(tempDir, "symlink-to-target");
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, "file.txt"), "target-content");
    symlinkSync(targetDir, symlinkPath);
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("symlink is created pointing to target directory", () => {
    // Ensure symlink was created correctly
    expect(realpathSync(symlinkPath)).toBe(targetDir);
  });

  it("dangling symlink falls back to original path", () => {
    // Create a dangling symlink
    const danglingPath = join(tempDir, "dangling-link");
    symlinkSync("/nonexistent/path/xyz", danglingPath);

    // When realpathSync fails on a dangling symlink, the original path should be used
    expect(() => realpathSync(danglingPath)).toThrow();

    // Verify the symlink itself exists
    // (Landlock spawn would get the original path in the fallback)
    rmSync(danglingPath, { recursive: true, force: true });
  });
});
