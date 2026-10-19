import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { stat as statAsync } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  registerTask,
  unregisterTask,
  getLastActivity,
  tickAll,
  _resetForTests,
} from "../../platform/workspace-watcher.js";

describe("workspace-watcher", () => {
  let tmp: string;

  beforeEach(() => {
    _resetForTests();
    tmp = mkdtempSync(join(tmpdir(), "ww-test-"));
  });

  afterEach(() => {
    _resetForTests();
    rmSync(tmp, { recursive: true, force: true });
  });

  // ── Test 1: register → touch file → tickAll → getLastActivity returns recent mtime ──
  it("register → touch file → tickAll → getLastActivity returns recent mtime", async () => {
    const before = Date.now();
    registerTask("task-1", tmp);
    // Sanity: registration seeds with current time
    expect(getLastActivity("task-1")).toBeGreaterThanOrEqual(before);

    // V8 Date.now() and Linux mtimeMs use different clock sources; on fast CI
    // tmpfs they can disagree by ~1ms. Sleep so the file mtime is strictly later
    // than the `before` snapshot.
    await new Promise((r) => setTimeout(r, 10));

    const marker = join(tmp, "output.txt");
    writeFileSync(marker, "hello");
    await tickAll();

    const activity = getLastActivity("task-1");
    expect(activity).toBeGreaterThan(before);
    // The activity should be close to the file we just wrote (within 2s rounding)
    const { mtimeMs: fileMtime } = await statAsync(marker);
    expect(Math.abs(fileMtime - (activity ?? 0))).toBeLessThan(2000);
  });

  // ── Test 2: touch file under node_modules/ → activity unchanged ──
  it("touch file under excluded dir (node_modules/) → activity unchanged", async () => {
    registerTask("task-2", tmp);
    const before = getLastActivity("task-2")!;

    const nm = join(tmp, "node_modules");
    mkdirSync(nm, { recursive: true });
    writeFileSync(join(nm, "package.json"), "{}");
    await tickAll();

    expect(getLastActivity("task-2")).toBe(before);
  });

  // ── Test 3: touch .log file → activity unchanged ──
  it("touch .log file → activity unchanged", async () => {
    registerTask("task-3", tmp);
    const before = getLastActivity("task-3")!;

    const logFile = join(tmp, "run.log");
    writeFileSync(logFile, "started\n");
    await tickAll();

    expect(getLastActivity("task-3")).toBe(before);
  });

  // ── Test 4: two tasks with different workspaces → mtimes independent ──
  it("two tasks with different workspaces → mtimes independent", async () => {
    const tmp2 = mkdtempSync(join(tmpdir(), "ww-test2-"));
    try {
      registerTask("task-a", tmp);
      registerTask("task-b", tmp2);

      // V8 Date.now() and Linux mtimeMs use slightly different clock sources;
      // on fast CI tmpfs they can disagree by ~1ms. Sleep ensures the file
      // mtime is clearly after both registration seeds.
      await new Promise((r) => setTimeout(r, 10));

      const fileA = join(tmp, "a.txt");
      writeFileSync(fileA, "a");
      await tickAll();

      const actA = getLastActivity("task-a");
      const actB = getLastActivity("task-b");

      // task-a should have seen the new file
      expect(actA).toBeGreaterThan(Date.now() - 5000);
      // task-b workspace had no changes, but registration seeded it
      expect(actA).not.toBeNull();
      expect(actB).toBeLessThanOrEqual(actA!);
    } finally {
      rmSync(tmp2, { recursive: true, force: true });
    }
  });

  // ── Test 5: unregister → getLastActivity returns null ──
  it("unregister → getLastActivity returns null", async () => {
    registerTask("task-5", tmp);
    expect(getLastActivity("task-5")).not.toBeNull();

    unregisterTask("task-5");
    expect(getLastActivity("task-5")).toBeNull();
  });

  // ── Test 6: registration seeds getLastActivity with Date.now()-ish value ──
  it("registration seeds getLastActivity with Date.now()-ish value", () => {
    const before = Date.now();
    registerTask("task-6", tmp);
    const activity = getLastActivity("task-6");
    expect(activity).toBeGreaterThanOrEqual(before);
    expect(activity).toBeLessThanOrEqual(Date.now());
  });
});
