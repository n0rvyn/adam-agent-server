import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const IS_MACOS = process.platform === "darwin";

const spawnMock = vi.fn();

vi.mock("node:child_process", async (importActual) => {
  // Keep the real module (resolveDarwinUserTempDir uses execFileSync for getconf);
  // only override spawn so we can assert on the sandbox-exec invocation.
  const actual = await importActual<typeof import("node:child_process")>();
  return { ...actual, spawn: (...args: unknown[]) => spawnMock(...args) };
});

function makeMockProc() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: Writable;
    stdout: Readable;
    stderr: Readable;
    killed: boolean;
    exitCode: number | null;
    kill: () => boolean;
  };
  proc.stdin = new Writable({ write(_chunk, _encoding, cb) { cb(); } });
  proc.stdout = new Readable({ read() { this.push(null); } });
  proc.stderr = new Readable({ read() { this.push(null); } });
  proc.killed = false;
  proc.exitCode = null;
  proc.kill = () => true;
  return proc;
}

describe.skipIf(!IS_MACOS)("sandbox/macos — provider behavior", () => {
  let tempDir: string;
  let workspaceDir: string;
  let outsideDir: string;

  beforeEach(() => {
    vi.resetModules();
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => makeMockProc());

    tempDir = mkdtempSync(join(tmpdir(), "adam-sandbox-test-"));
    workspaceDir = join(tempDir, "workspace");
    outsideDir = join(tempDir, "outside");
    mkdirSync(workspaceDir, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(join(workspaceDir, "test.txt"), "workspace-content");
    writeFileSync(join(outsideDir, "secret.txt"), "secret-content");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function importProvider() {
    return import("../../sandbox/macos.js");
  }

  it("SBPL profile generation includes visible paths", async () => {
    const { MacOSSandboxProvider } = await importProvider();
    const provider = new MacOSSandboxProvider();
    expect(provider.platform).toBe("sandbox-exec");
  });

  it("isAvailable returns true on macOS", async () => {
    const { MacOSSandboxProvider } = await importProvider();
    const provider = new MacOSSandboxProvider();
    expect(await provider.isAvailable()).toBe(true);
  });

  it("validateSbplPath rejects paths containing $ (SBPL parameter injection)", async () => {
    const { MacOSSandboxProvider } = await importProvider();
    const provider = new MacOSSandboxProvider();
    expect(() =>
      provider.spawn({
        command: "node",
        args: ["-e", "process.exit(0)"],
        cwd: workspaceDir,
        env: {} as Record<string, string>,
        visiblePaths: [{ path: "/home/$USER/file.txt", mode: "rw" }],
      }),
    ).toThrow();
  });

  it("validateSbplPath rejects paths containing $(...) command substitution", async () => {
    const { MacOSSandboxProvider } = await importProvider();
    const provider = new MacOSSandboxProvider();
    expect(() =>
      provider.spawn({
        command: "node",
        args: ["-e", "process.exit(0)"],
        cwd: workspaceDir,
        env: {} as Record<string, string>,
        visiblePaths: [{ path: "/tmp/$(whoami)/secret", mode: "rw" }],
      }),
    ).toThrow();
  });

  it("adds rw visiblePaths to the generated SBPL profile", async () => {
    const { MacOSSandboxProvider } = await importProvider();
    const provider = new MacOSSandboxProvider();

    provider.spawn({
      command: "node",
      args: ["-e", "process.exit(0)"],
      cwd: workspaceDir,
      env: { ...process.env } as Record<string, string>,
      visiblePaths: [{ path: workspaceDir, mode: "rw" }],
    });

    const [, args] = spawnMock.mock.calls[0];
    const profilePath = args[1] as string;
    const profile = readFileSync(profilePath, "utf-8");

    expect(profile).toContain(`(allow file-write* (subpath "${workspaceDir}"))`);
  });

  it("does not add ro visiblePaths to write rules", async () => {
    const { MacOSSandboxProvider } = await importProvider();
    const provider = new MacOSSandboxProvider();

    provider.spawn({
      command: "node",
      args: ["-e", "process.exit(0)"],
      cwd: workspaceDir,
      env: { ...process.env } as Record<string, string>,
      visiblePaths: [
        { path: workspaceDir, mode: "rw" },
        { path: outsideDir, mode: "ro" },
      ],
    });

    const [, args] = spawnMock.mock.calls[0];
    const profilePath = args[1] as string;
    const profile = readFileSync(profilePath, "utf-8");

    expect(profile).toContain(`(allow file-write* (subpath "${workspaceDir}"))`);
    expect(profile).not.toContain(`(allow file-write* (subpath "${outsideDir}"))`);
  });

  it("includes deniedReadPaths in the generated profile", async () => {
    const { MacOSSandboxProvider } = await importProvider();
    const provider = new MacOSSandboxProvider();

    provider.spawn({
      command: "node",
      args: ["-e", "process.exit(0)"],
      cwd: workspaceDir,
      env: { ...process.env } as Record<string, string>,
      visiblePaths: [{ path: workspaceDir, mode: "rw" }],
      deniedReadPaths: [outsideDir],
    });

    const [, args] = spawnMock.mock.calls[0];
    const profilePath = args[1] as string;
    const profile = readFileSync(profilePath, "utf-8");

    expect(profile).toContain(`(deny file-read-data (subpath "${outsideDir}"))`);
    expect(profile).toContain(`(deny file-read-metadata (subpath "${outsideDir}"))`);
  });

  it("redirects TMPDIR and Claude temp paths into the per-spawn sandbox dir", async () => {
    const { MacOSSandboxProvider } = await importProvider();
    const provider = new MacOSSandboxProvider();

    provider.spawn({
      command: "node",
      args: ["-e", "process.exit(0)"],
      cwd: workspaceDir,
      env: { ...process.env, HOME: tempDir } as Record<string, string>,
      visiblePaths: [{ path: workspaceDir, mode: "rw" }],
    });

    const [command, args, options] = spawnMock.mock.calls[0];
    const sandboxArgs = args as string[];
    const profilePath = sandboxArgs[1];
    const sandboxDir = profilePath.slice(0, profilePath.lastIndexOf("/"));

    expect(command).toBe("/usr/bin/sandbox-exec");
    expect(sandboxArgs).toContain(`TMPDIR=${sandboxDir}`);
    expect(options.env.TMPDIR).toBe(sandboxDir);
    expect(options.env.CLAUDE_CODE_TMPDIR).toBe(sandboxDir);
    expect(options.env.CLAUDE_CONFIG_DIR).toBe(join(tempDir, ".claude"));
  });

  it("temp profile directory is cleaned up after sandboxed process exits", async () => {
    const { MacOSSandboxProvider } = await importProvider();
    const provider = new MacOSSandboxProvider();
    const proc = makeMockProc();
    spawnMock.mockImplementationOnce(() => proc);

    provider.spawn({
      command: "node",
      args: ["-e", "process.exit(0)"],
      cwd: workspaceDir,
      env: { ...process.env } as Record<string, string>,
      visiblePaths: [{ path: workspaceDir, mode: "rw" }],
    });

    const [, args] = spawnMock.mock.calls[0];
    const profilePath = (args as string[])[1];
    const sandboxDir = profilePath.slice(0, profilePath.lastIndexOf("/"));

    expect(existsSync(sandboxDir)).toBe(true);
    proc.emit("exit", 0, null);
    expect(existsSync(sandboxDir)).toBe(false);
  });

  it("grants write access to the macOS per-user temp dir (confstr) so mktemp -t in plugin scripts works", async () => {
    const { MacOSSandboxProvider, resolveDarwinUserTempDir } = await importProvider();
    const provider = new MacOSSandboxProvider();

    provider.spawn({
      command: "node",
      args: ["-e", "process.exit(0)"],
      cwd: workspaceDir,
      env: { ...process.env } as Record<string, string>,
      visiblePaths: [{ path: workspaceDir, mode: "rw" }],
    });

    const [, args] = spawnMock.mock.calls[0];
    const profilePath = (args as string[])[1];
    const profile = readFileSync(profilePath, "utf-8");

    const darwinTemp = resolveDarwinUserTempDir();
    // getconf is present on every macOS; this resolves under test.
    expect(darwinTemp).toBeTruthy();
    expect(profile).toContain(`(allow file-write* (subpath "${darwinTemp}"))`);
    // Scope guard: it must be the one per-user temp dir, NOT all of /var/folders and NOT /tmp.
    expect(profile).not.toContain(`(allow file-write* (subpath "/var/folders"))`);
    expect(profile).not.toContain(`(allow file-write* (subpath "/tmp"))`);
  });

  it("accepts runtime-enforced OS capability rules without breaking sandbox startup", async () => {
    const { MacOSSandboxProvider } = await importProvider();
    const provider = new MacOSSandboxProvider();

    provider.spawn({
      command: "node",
      args: ["-e", "process.exit(0)"],
      cwd: workspaceDir,
      env: { ...process.env } as Record<string, string>,
      visiblePaths: [{ path: workspaceDir, mode: "rw" }],
      osCapabilities: [
        { id: "automation", targets: ["com.apple.mail", "com.apple.systemevents"] },
        { id: "accessibility" },
      ],
    });

    const [, args] = spawnMock.mock.calls[0];
    const profilePath = (args as string[])[1];
    const profile = readFileSync(profilePath, "utf-8");

    expect(profile).toContain("; ===== Role OS capability: Automation =====");
    expect(profile).toContain("; ===== Role OS capability: Accessibility =====");
  });
});
