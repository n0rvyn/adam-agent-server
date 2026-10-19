import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshot, diff } from "../../platform/workspace-snapshot.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "ws-snap-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("snapshot", () => {
  it("returns Map<path, {mtime_ns, size, inode}> for files in root", async () => {
    await writeFile(join(tmpDir, "a.txt"), "hello");
    await writeFile(join(tmpDir, "b.txt"), "world");
    const snap = await snapshot(tmpDir);
    expect(snap.size).toBe(2);
    const entryA = snap.get(join(tmpDir, "a.txt"));
    const entryB = snap.get(join(tmpDir, "b.txt"));
    expect(entryA).toBeDefined();
    expect(entryB).toBeDefined();
    expect(typeof entryA!.mtime_ns).toBe("bigint");
    expect(typeof entryA!.size).toBe("number");
    expect(typeof entryA!.inode).toBe("bigint");
    expect(entryA!.size).toBe(5); // "hello".length
  });

  it("recurses into subdirectories", async () => {
    await mkdir(join(tmpDir, "sub"));
    await writeFile(join(tmpDir, "sub", "deep.txt"), "deep content");
    const snap = await snapshot(tmpDir);
    expect(snap.has(join(tmpDir, "sub", "deep.txt"))).toBe(true);
  });

  it("excludes node_modules, .cache, .uv-cache, .youtube-venv, .signals, .git", async () => {
    const excludedDirs = ["node_modules", ".cache", ".uv-cache", ".youtube-venv", ".signals", ".git"];
    for (const dir of excludedDirs) {
      await mkdir(join(tmpDir, dir));
      await writeFile(join(tmpDir, dir, "should-be-excluded.txt"), "ignored");
    }
    await writeFile(join(tmpDir, "kept.txt"), "kept");
    const snap = await snapshot(tmpDir);
    expect(snap.has(join(tmpDir, "kept.txt"))).toBe(true);
    for (const dir of excludedDirs) {
      expect(snap.has(join(tmpDir, dir, "should-be-excluded.txt"))).toBe(false);
    }
  });

  it("excludes *.log files", async () => {
    await writeFile(join(tmpDir, "a.txt"), "text file");
    await writeFile(join(tmpDir, "b.log"), "log file");
    const snap = await snapshot(tmpDir);
    expect(snap.has(join(tmpDir, "a.txt"))).toBe(true);
    expect(snap.has(join(tmpDir, "b.log"))).toBe(false);
  });

  it("returns empty Map for non-existent root without throwing", async () => {
    const snap = await snapshot(join(tmpDir, "nonexistent-path-xyz"));
    expect(snap).toBeInstanceOf(Map);
    expect(snap.size).toBe(0);
  });
});

describe("diff", () => {
  it("identifies added files", async () => {
    const before = await snapshot(tmpDir);
    await writeFile(join(tmpDir, "new.txt"), "new content");
    const after = await snapshot(tmpDir);
    const result = diff(before, after);
    const addedPaths = result.added.map((e) => e.path);
    expect(addedPaths).toContain(join(tmpDir, "new.txt"));
    expect(result.modified).toHaveLength(0);
    expect(result.deleted).toHaveLength(0);
  });

  it("identifies deleted files", async () => {
    await writeFile(join(tmpDir, "to-delete.txt"), "will be deleted");
    const before = await snapshot(tmpDir);
    await rm(join(tmpDir, "to-delete.txt"));
    const after = await snapshot(tmpDir);
    const result = diff(before, after);
    expect(result.deleted).toContain(join(tmpDir, "to-delete.txt"));
    expect(result.added).toHaveLength(0);
    expect(result.modified).toHaveLength(0);
  });

  it("identifies modified files (size change)", async () => {
    await writeFile(join(tmpDir, "mod.txt"), "original");
    const before = await snapshot(tmpDir);
    await writeFile(join(tmpDir, "mod.txt"), "much longer content now");
    const after = await snapshot(tmpDir);
    const result = diff(before, after);
    const modifiedPaths = result.modified.map((e) => e.path);
    expect(modifiedPaths).toContain(join(tmpDir, "mod.txt"));
    expect(result.added).toHaveLength(0);
    expect(result.deleted).toHaveLength(0);
  });

  it("identifies modified files (mtime change with same size)", async () => {
    const content = "exactly8b"; // 9 bytes
    await writeFile(join(tmpDir, "mtime.txt"), content);
    const before = await snapshot(tmpDir);
    // Force mtime forward by 1 second
    const futureTime = new Date(Date.now() + 2000);
    await utimes(join(tmpDir, "mtime.txt"), futureTime, futureTime);
    const after = await snapshot(tmpDir);
    const result = diff(before, after);
    const modifiedPaths = result.modified.map((e) => e.path);
    expect(modifiedPaths).toContain(join(tmpDir, "mtime.txt"));
  });

  it("returns empty diff when nothing changed", async () => {
    await writeFile(join(tmpDir, "unchanged.txt"), "same content");
    const snap = await snapshot(tmpDir);
    const result = diff(snap, snap);
    expect(result.added).toHaveLength(0);
    expect(result.modified).toHaveLength(0);
    expect(result.deleted).toHaveLength(0);
  });
});
