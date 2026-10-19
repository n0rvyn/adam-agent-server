import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock node:child_process
const mockSpawnSync = vi.fn();

vi.mock("node:child_process", () => ({
  spawnSync: mockSpawnSync,
}));

// Mock node:fs (for temp file operations)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockReadFileSync = vi.fn((_path?: any, _enc?: any) => '{"name":"test"}');
vi.mock("node:fs", () => ({
  openSync: vi.fn(() => 42),
  readFileSync: (...args: unknown[]) => mockReadFileSync(args[0], args[1]),
  unlinkSync: vi.fn(),
  closeSync: vi.fn(),
}));

// Mock node:os (tmpdir)
vi.mock("node:os", () => ({
  tmpdir: vi.fn(() => "/tmp"),
}));

// Import after mocks are set up
const pluginCli = await import("../../lib/plugin-cli.js");

beforeEach(() => {
  vi.clearAllMocks();
  // Default: CLI returns success
  mockSpawnSync.mockReturnValue({ status: 0, stdout: "{}", stderr: "" });
  mockReadFileSync.mockReturnValue('{}');
  // Ensure CLAUDE_BIN is not set in tests by default
  delete process.env.CLAUDE_BIN;
});

describe("plugin-cli", () => {
  describe("isCliAvailable", () => {
    it("returns true when claude --version exits 0", () => {
      mockSpawnSync.mockReturnValue({ status: 0, stdout: "2.1.143\n", stderr: "" });
      expect(pluginCli.isCliAvailable()).toBe(true);
      expect(mockSpawnSync).toHaveBeenCalledWith("claude", ["--version"], expect.objectContaining({ timeout: 2000 }));
    });

    it("returns false when claude --version exits non-zero or throws", () => {
      // Sub-case 1: non-zero exit
      mockSpawnSync.mockReturnValue({ status: 1, stdout: "", stderr: "not installed" });
      expect(pluginCli.isCliAvailable()).toBe(false);

      // Sub-case 2: binary not on PATH (throws)
      mockSpawnSync.mockImplementation(() => { throw new Error("ENOENT"); });
      expect(pluginCli.isCliAvailable()).toBe(false);
    });
  });

  describe("listMarketplaces", () => {
    it("calls CLI with --json flag and returns parsed output", () => {
      const data = [{ name: "mkt", source: "github", repo: "org/repo", installLocation: "/path" }];
      mockSpawnSync.mockReturnValue({ status: 0, stdout: "", stderr: "" });
      mockReadFileSync.mockReturnValue(JSON.stringify(data));

      const result = pluginCli.listMarketplaces();
      expect(result).toEqual(data);
      expect(mockSpawnSync).toHaveBeenCalledWith(
        "claude",
        expect.arrayContaining(["plugin", "marketplace", "list", "--json"]),
        expect.any(Object),
      );
    });

    it("throws on non-zero exit", () => {
      mockSpawnSync.mockReturnValue({ status: 1, stdout: "", stderr: "error" });
      expect(() => pluginCli.listMarketplaces()).toThrow();
    });
  });

  describe("listAvailablePlugins", () => {
    it("calls plugin list --available --json", () => {
      const data = { installed: [], available: [{ pluginId: "a@b", name: "a", description: "d", marketplaceName: "b", source: { source: "url", url: "x" }, installCount: 5 }] };
      mockSpawnSync.mockReturnValue({ status: 0, stdout: "", stderr: "" });
      mockReadFileSync.mockReturnValue(JSON.stringify(data));

      const result = pluginCli.listAvailablePlugins();
      expect(result.available).toHaveLength(1);
      expect(mockSpawnSync).toHaveBeenCalledWith(
        "claude",
        expect.arrayContaining(["plugin", "list", "--available", "--json"]),
        expect.any(Object),
      );
    });
  });

  describe("installPlugin", () => {
    it("calls CLI with --scope user by default", () => {
      mockSpawnSync.mockReturnValue({ status: 0, stdout: "Installed", stderr: "" });

      pluginCli.installPlugin("my-plugin@mkt");
      expect(mockSpawnSync).toHaveBeenCalledWith(
        "claude",
        ["plugin", "install", "my-plugin@mkt", "--scope", "user"],
        expect.objectContaining({ timeout: 120_000 }),
      );
    });

    it("passes custom scope and cwd", () => {
      mockSpawnSync.mockReturnValue({ status: 0, stdout: "Installed", stderr: "" });

      pluginCli.installPlugin("my-plugin@mkt", "project", "/my/cwd");
      expect(mockSpawnSync).toHaveBeenCalledWith(
        "claude",
        ["plugin", "install", "my-plugin@mkt", "--scope", "project"],
        expect.objectContaining({ cwd: "/my/cwd", timeout: 120_000 }),
      );
    });
  });

  describe("uninstallPlugin", () => {
    it("calls CLI with correct args", () => {
      mockSpawnSync.mockReturnValue({ status: 0, stdout: "Removed", stderr: "" });

      pluginCli.uninstallPlugin("my-plugin@mkt", "project", "/my/cwd");
      expect(mockSpawnSync).toHaveBeenCalledWith(
        "claude",
        ["plugin", "uninstall", "my-plugin@mkt", "--scope", "project"],
        expect.objectContaining({ cwd: "/my/cwd", timeout: 120_000 }),
      );
    });
  });

  describe("enablePlugin", () => {
    it("calls plugin enable", () => {
      mockSpawnSync.mockReturnValue({ status: 0, stdout: "Enabled", stderr: "" });

      pluginCli.enablePlugin("my-plugin");
      expect(mockSpawnSync).toHaveBeenCalledWith(
        "claude",
        expect.arrayContaining(["plugin", "enable"]),
        expect.any(Object),
      );
    });
  });

  describe("disablePlugin", () => {
    it("calls plugin disable", () => {
      mockSpawnSync.mockReturnValue({ status: 0, stdout: "Disabled", stderr: "" });

      pluginCli.disablePlugin("my-plugin");
      expect(mockSpawnSync).toHaveBeenCalledWith(
        "claude",
        expect.arrayContaining(["plugin", "disable"]),
        expect.any(Object),
      );
    });
  });

  describe("addMarketplace", () => {
    it("calls CLI with URL", () => {
      mockSpawnSync.mockReturnValue({ status: 0, stdout: "Added", stderr: "" });

      pluginCli.addMarketplace("https://github.com/org/repo");
      expect(mockSpawnSync).toHaveBeenCalledWith(
        "claude",
        expect.arrayContaining(["plugin", "marketplace", "add"]),
        expect.any(Object),
      );
    });
  });

  describe("removeMarketplace", () => {
    it("calls CLI with name", () => {
      mockSpawnSync.mockReturnValue({ status: 0, stdout: "Removed", stderr: "" });

      pluginCli.removeMarketplace("my-mkt");
      expect(mockSpawnSync).toHaveBeenCalledWith(
        "claude",
        expect.arrayContaining(["plugin", "marketplace", "remove"]),
        expect.any(Object),
      );
    });
  });

  describe("CLAUDE_BIN override", () => {
    it("uses CLAUDE_BIN env when set", () => {
      const original = process.env.CLAUDE_BIN;
      process.env.CLAUDE_BIN = "/opt/bin/claude";
      try {
        pluginCli.installPlugin("foo@mkt");
        expect(mockSpawnSync).toHaveBeenCalledWith("/opt/bin/claude", expect.any(Array), expect.any(Object));
      } finally {
        if (original === undefined) delete process.env.CLAUDE_BIN;
        else process.env.CLAUDE_BIN = original;
      }
    });

    it("isCliAvailable uses CLAUDE_BIN env when set", () => {
      const original = process.env.CLAUDE_BIN;
      process.env.CLAUDE_BIN = "/opt/bin/claude";
      mockSpawnSync.mockReturnValue({ status: 0, stdout: "2.1.143\n", stderr: "" });
      try {
        pluginCli.isCliAvailable();
        expect(mockSpawnSync).toHaveBeenCalledWith("/opt/bin/claude", ["--version"], expect.any(Object));
      } finally {
        if (original === undefined) delete process.env.CLAUDE_BIN;
        else process.env.CLAUDE_BIN = original;
      }
    });
  });
});
