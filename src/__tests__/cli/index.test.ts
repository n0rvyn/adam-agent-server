import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// --- Hoisted mocks ---

const {
  mockStartDaemon,
  mockStopDaemon,
  mockGetDaemonStatus,
  mockGetLogPath,
  mockGetHealth,
  mockRunCommand,
  mockListTasksHandler,
  mockShowTaskHandler,
  mockCancelTaskHandler,
  mockConfigHandler,
  mockEvolutionHandler,
  mockRender,
  mockGetVersion,
} = vi.hoisted(() => ({
  mockStartDaemon: vi.fn(),
  mockStopDaemon: vi.fn(),
  mockGetDaemonStatus: vi.fn(),
  mockGetLogPath: vi.fn(() => "/tmp/.adam/server.log"),
  mockGetHealth: vi.fn(),
  mockRunCommand: vi.fn(),
  mockListTasksHandler: vi.fn(),
  mockShowTaskHandler: vi.fn(),
  mockCancelTaskHandler: vi.fn(),
  mockConfigHandler: vi.fn(),
  mockEvolutionHandler: vi.fn(),
  mockRender: vi.fn(() => ({ waitUntilExit: vi.fn() })),
  mockGetVersion: vi.fn(() => "0.2.1"),
}));

vi.mock("../../cli/daemon.js", () => ({
  startDaemon: mockStartDaemon,
  stopDaemon: mockStopDaemon,
  getDaemonStatus: mockGetDaemonStatus,
  getLogPath: mockGetLogPath,
}));

vi.mock("../../cli/client.js", () => ({
  getHealth: mockGetHealth,
}));

vi.mock("../../cli/commands/run.js", () => ({
  runCommand: mockRunCommand,
}));

vi.mock("../../cli/commands/tasks.js", () => ({
  listTasksHandler: mockListTasksHandler,
  showTaskHandler: mockShowTaskHandler,
  cancelTaskHandler: mockCancelTaskHandler,
}));

vi.mock("../../cli/commands/config.js", () => ({
  configHandler: mockConfigHandler,
}));

vi.mock("../../cli/commands/evolution.js", () => ({
  evolutionHandler: mockEvolutionHandler,
}));

vi.mock("react", () => ({
  default: { createElement: vi.fn(() => "mock-element") },
}));

vi.mock("ink", () => ({
  render: mockRender,
}));

vi.mock("../../cli/tui/App.js", () => ({
  default: vi.fn(),
}));

vi.mock("../../lib/version.js", () => ({
  getVersion: mockGetVersion,
  getName: vi.fn(() => "adam"),
}));

vi.mock("fs", () => ({
  readFileSync: vi.fn(() => "log line 1\nlog line 2\n"),
  existsSync: vi.fn(() => true),
  createReadStream: vi.fn(() => ({
    [Symbol.asyncIterator]: async function* () {
      yield "streaming log line\n";
    },
  })),
}));

// --- Test Suite ---

describe("src/cli/index.ts", () => {
  let originalArgv: string[];
  let originalExit: typeof process.exit;
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    originalArgv = process.argv;
    originalExit = process.exit;
    process.exit = vi.fn() as never;

    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.exit = originalExit;
    consoleSpy.mockRestore();
    errorSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  function setArgv(...args: string[]) {
    process.argv = ["node", "adam", ...args];
  }

  async function importCli() {
    vi.resetModules();
    await import("../../cli/index.js");
    // Commander's async actions need a tick to settle
    await new Promise((r) => setTimeout(r, 100));
  }

  // --- Server commands ---

  describe("server start", () => {
    it("starts daemon successfully", async () => {
      setArgv("server", "start");
      mockStartDaemon.mockResolvedValueOnce({ pid: 1234, port: 3000 });

      await importCli();

      expect(mockStartDaemon).toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith("Server started (PID 1234, port 3000)");
    });

    it("handles start failure", async () => {
      setArgv("server", "start");
      mockStartDaemon.mockRejectedValueOnce(new Error("already running"));

      await importCli();

      expect(errorSpy).toHaveBeenCalledWith(
        "Failed to start server:",
        "already running",
      );
      expect(process.exit).toHaveBeenCalledWith(1);
    });
  });

  describe("server stop", () => {
    it("stops daemon successfully", async () => {
      setArgv("server", "stop");
      mockStopDaemon.mockResolvedValueOnce(undefined);

      await importCli();

      expect(mockStopDaemon).toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith("Server stopped");
    });

    it("handles stop failure", async () => {
      setArgv("server", "stop");
      mockStopDaemon.mockRejectedValueOnce(new Error("not running"));

      await importCli();

      expect(errorSpy).toHaveBeenCalledWith(
        "Failed to stop server:",
        "not running",
      );
      expect(process.exit).toHaveBeenCalledWith(1);
    });
  });

  describe("server status", () => {
    it("shows running status", async () => {
      setArgv("server", "status");
      mockGetDaemonStatus.mockReturnValueOnce({
        running: true,
        pid: 1234,
        port: 3000,
      });

      await importCli();

      expect(consoleSpy).toHaveBeenCalledWith(
        "Server is running (PID 1234, port 3000)",
      );
    });

    it("shows stale PID status", async () => {
      setArgv("server", "status");
      mockGetDaemonStatus.mockReturnValueOnce({
        running: false,
        pid: 1234,
        port: null,
      });

      await importCli();

      expect(consoleSpy).toHaveBeenCalledWith("Server not running (stale PID file)");
    });

    it("shows not running status", async () => {
      setArgv("server", "status");
      mockGetDaemonStatus.mockReturnValueOnce({
        running: false,
        pid: null,
        port: null,
      });

      await importCli();

      expect(consoleSpy).toHaveBeenCalledWith("Server not running");
    });
  });

  describe("server logs", () => {
    it("shows log file content", async () => {
      setArgv("server", "logs");

      await importCli();

      expect(consoleSpy).toHaveBeenCalledWith("log line 1\nlog line 2\n");
    });

    it("shows no log file message when absent", async () => {
      setArgv("server", "logs");
      const fs = await import("fs");
      const { existsSync } = fs;
      (existsSync as ReturnType<typeof vi.fn>).mockReturnValueOnce(false);

      await importCli();

      expect(consoleSpy).toHaveBeenCalledWith("No log file found");
    });

    it("follows logs with -f flag", async () => {
      setArgv("server", "logs", "-f");

      await importCli();

      expect(stdoutSpy).toHaveBeenCalledWith("streaming log line\n");
    });
  });

  // --- Run command ---

  describe("run", () => {
    it("invokes runCommand with prompt and options", async () => {
      setArgv("run", "test prompt", "--model", "claude-sonnet-4-20250514");

      await importCli();

      expect(mockRunCommand).toHaveBeenCalledWith(
        "test prompt",
        expect.objectContaining({ model: "claude-sonnet-4-20250514" }),
        expect.anything(),
      );
    });
  });

  // --- Task commands ---

  describe("tasks list", () => {
    it("invokes listTasksHandler", async () => {
      setArgv("tasks", "list", "-s", "pending");

      await importCli();

      expect(mockListTasksHandler).toHaveBeenCalledWith(
        expect.objectContaining({ status: "pending" }),
        expect.anything(),
      );
    });
  });

  describe("tasks show", () => {
    it("invokes showTaskHandler with id", async () => {
      setArgv("tasks", "show", "task-123");

      await importCli();

      expect(mockShowTaskHandler).toHaveBeenCalledWith(
        "task-123",
        expect.anything(),
        expect.anything(),
      );
    });
  });

  describe("tasks cancel", () => {
    it("invokes cancelTaskHandler with id", async () => {
      setArgv("tasks", "cancel", "task-123");

      await importCli();

      expect(mockCancelTaskHandler).toHaveBeenCalledWith(
        "task-123",
        expect.anything(),
        expect.anything(),
      );
    });
  });

  // --- Other commands ---

  describe("config", () => {
    it("invokes configHandler with --json", async () => {
      setArgv("config", "--json");

      await importCli();

      expect(mockConfigHandler).toHaveBeenCalledWith(
        expect.objectContaining({ json: true }),
        expect.anything(),
      );
    });
  });

  describe("evolution", () => {
    it("invokes evolutionHandler with -l option", async () => {
      setArgv("evolution", "-l", "10");

      await importCli();

      expect(mockEvolutionHandler).toHaveBeenCalledWith(
        expect.objectContaining({ limit: "10" }),
        expect.anything(),
      );
    });
  });

  // --- Default action (TUI) ---

  describe("default action (TUI)", () => {
    it("launches TUI when server is reachable", async () => {
      setArgv(); // no subcommand
      mockGetHealth.mockResolvedValueOnce({ status: "ok" });

      await importCli();

      expect(mockGetHealth).toHaveBeenCalled();
      expect(mockRender).toHaveBeenCalled();
    });

    it("shows error when server running but not responding", async () => {
      setArgv(); // no subcommand
      mockGetHealth.mockRejectedValueOnce(new Error("connection refused"));
      mockGetDaemonStatus.mockReturnValueOnce({ running: true, pid: 1234, port: 3000 });

      await importCli();

      expect(errorSpy).toHaveBeenCalledWith(
        "Server is running but not responding. Check: adam server logs",
      );
      expect(process.exit).toHaveBeenCalledWith(1);
    });

    it("shows error when server not running", async () => {
      setArgv(); // no subcommand
      mockGetHealth.mockRejectedValueOnce(new Error("connection refused"));
      mockGetDaemonStatus.mockReturnValueOnce({ running: false, pid: null, port: null });

      await importCli();

      expect(errorSpy).toHaveBeenCalledWith(
        "Server not running. Run: adam server start",
      );
      expect(process.exit).toHaveBeenCalledWith(1);
    });
  });
});
