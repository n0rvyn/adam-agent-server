import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * detect.ts tests.
 *
 * Because detectPlatform() calls accessSync() at the module top level
 * (for the darwin case) and calls findLandlockExec() from linux.ts,
 * we must reset modules + set up fresh mocks before each test.
 *
 * Strategy: vi.resetModules() + vi.doMock() (per-test, not hoisted) + dynamic import.
 */

const LANDLOCK_PATH = "/mock/landlock-exec/landlock-exec";

describe("sandbox/detect", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    // Always mock linux.js to control findLandlockExec
    vi.doMock("../../sandbox/linux.js", () => ({
      findLandlockExec: () => LANDLOCK_PATH,
    }));
  });

  // ---- Darwin ----

  it("returns 'sandbox-exec' on darwin when /usr/bin/sandbox-exec is executable", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      return { ...actual, accessSync: vi.fn() };
    });

    const { detectPlatform } = await import("../../sandbox/detect.js");
    expect(detectPlatform()).toBe("sandbox-exec");
  });

  it("returns 'none' on darwin when /usr/bin/sandbox-exec is not executable", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      return {
        ...actual,
        accessSync: vi.fn(() => {
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        }),
      };
    });

    const { detectPlatform } = await import("../../sandbox/detect.js");
    expect(detectPlatform()).toBe("none");
  });

  // ---- Linux ----

  it("returns 'none' on linux when landlock-exec binary not found", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      return {
        ...actual,
        accessSync: vi.fn(() => {
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        }),
      };
    });

    const { detectPlatform } = await import("../../sandbox/detect.js");
    expect(detectPlatform()).toBe("none");
  });

  it("returns 'landlock' on linux when landlock-exec binary exists and is executable", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      return { ...actual, accessSync: vi.fn() };
    });

    const { detectPlatform } = await import("../../sandbox/detect.js");
    expect(detectPlatform()).toBe("landlock");
  });

  // ---- Unsupported platforms ----

  it("returns 'none' on win32", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32" as NodeJS.Platform);

    const { detectPlatform } = await import("../../sandbox/detect.js");
    expect(detectPlatform()).toBe("none");
  });
});
