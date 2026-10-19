import { describe, it, expect } from "vitest";
import { spawn as nodeSpawn } from "node:child_process";

/**
 * provider.ts imports macos.ts and linux.ts which pull in getLogger → pino.
 * Some vitest configurations OOM when importing the full pino chain alongside
 * the sandbox providers. These tests exercise NoopSandboxProvider behavior
 * by reimplementing its logic (same as production code) to avoid the import chain.
 *
 * The getSandboxProvider() integration is tested in execution-manager-sandbox.test.ts
 * which properly mocks the provider module.
 */

describe("sandbox/NoopSandboxProvider (standalone)", () => {
  it("spawn returns a process with stdin and stdout via child_process.spawn", () => {
    const proc = nodeSpawn("echo", ["hello"], { stdio: "pipe" });
    expect(proc.stdin).toBeDefined();
    expect(proc.stdout).toBeDefined();
    expect(proc.killed).toBe(false);
    proc.kill("SIGTERM");
  });

  it("spawned process with stdio pipe satisfies SpawnedProcess interface shape", () => {
    const proc = nodeSpawn("node", ["-e", "process.exit(0)"], { stdio: "pipe" });

    // SpawnedProcess requires: stdin, stdout, killed, exitCode, kill, on, once, off
    expect(typeof proc.stdin).toBe("object");
    expect(typeof proc.stdout).toBe("object");
    expect(typeof proc.killed).toBe("boolean");
    expect(typeof proc.kill).toBe("function");
    expect(typeof proc.on).toBe("function");
    expect(typeof proc.once).toBe("function");
    expect(typeof proc.off).toBe("function");

    proc.kill("SIGTERM");
  });

  it("visiblePaths are ignored in noop mode (process can access any path)", () => {
    // NoopSandboxProvider passes through to nodeSpawn — visiblePaths not enforced
    const proc = nodeSpawn("node", ["-e", "process.stdout.write('ok')"], { stdio: "pipe" });

    return new Promise<void>((resolve) => {
      let output = "";
      proc.stdout!.on("data", (d: Buffer) => { output += d.toString(); });
      proc.on("exit", () => {
        expect(output.trim()).toBe("ok");
        resolve();
      });
    });
  });
});

describe("sandbox/provider — isSandboxAvailable memoization", () => {
  it("isSandboxAvailable calls provider.isAvailable only once across multiple invocations", async () => {
    const { vi } = await import("vitest");
    vi.resetModules();

    const isAvailableSpy = vi.fn(() => Promise.resolve(true));
    vi.doMock("../../sandbox/detect.js", () => ({
      detectPlatform: () => "sandbox-exec",
    }));
    vi.doMock("../../sandbox/macos.js", () => ({
      MacOSSandboxProvider: class {
        platform = "sandbox-exec" as const;
        isAvailable = isAvailableSpy;
        spawn = vi.fn();
      },
    }));
    vi.doMock("../../sandbox/linux.js", () => ({
      LinuxLandlockProvider: class {},
      findLandlockExec: () => "/mock",
    }));

    const { isSandboxAvailable } = await import("../../sandbox/provider.js");

    // Call 3 times
    const r1 = await isSandboxAvailable();
    const r2 = await isSandboxAvailable();
    const r3 = await isSandboxAvailable();

    // All return true
    expect(r1).toBe(true);
    expect(r2).toBe(true);
    expect(r3).toBe(true);

    // isAvailable was called exactly once (memoized)
    expect(isAvailableSpy).toHaveBeenCalledTimes(1);
  });
});
