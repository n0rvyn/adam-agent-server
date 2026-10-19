import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

// --- Hoisted mocks ---

const {
  mockFork,
  mockExistsSync,
  mockReadFileSync,
  mockWriteFileSync,
  mockUnlinkSync,
  mockMkdirSync,
  mockOpenSync,
} = vi.hoisted(() => ({
  mockFork: vi.fn(),
  mockExistsSync: vi.fn(),
  mockReadFileSync: vi.fn(),
  mockWriteFileSync: vi.fn(),
  mockUnlinkSync: vi.fn(),
  mockMkdirSync: vi.fn(),
  mockOpenSync: vi.fn(() => 3),
}));

vi.mock("child_process", () => ({
  fork: mockFork,
}));

vi.mock("fs", () => ({
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
  writeFileSync: mockWriteFileSync,
  unlinkSync: mockUnlinkSync,
  mkdirSync: mockMkdirSync,
  openSync: mockOpenSync,
}));

import { startDaemon, stopDaemon, getDaemonStatus, getLogPath } from "../../cli/daemon.js";

describe("daemon module", () => {
  let processKillSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    processKillSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
  });

  afterEach(() => {
    processKillSpy.mockRestore();
  });

  describe("getDaemonStatus", () => {
    it("returns not running when no PID file", () => {
      mockExistsSync.mockReturnValue(false);
      const status = getDaemonStatus();
      expect(status.running).toBe(false);
      expect(status.pid).toBeNull();
    });

    it("returns running when PID file exists and process alive", () => {
      mockExistsSync.mockImplementation((path: string) => {
        if (path.includes("adam.pid")) return true;
        if (path.includes("adam.port")) return true;
        return false;
      });
      mockReadFileSync.mockImplementation((path: string) => {
        if (typeof path === "string" && path.includes("adam.pid")) return "1234";
        if (typeof path === "string" && path.includes("adam.port")) return "3000";
        return "";
      });
      processKillSpy.mockImplementation(() => true);

      const status = getDaemonStatus();
      expect(status.running).toBe(true);
      expect(status.pid).toBe(1234);
      expect(status.port).toBe(3000);
    });

    it("returns not running when PID exists but process dead", () => {
      mockExistsSync.mockImplementation((path: string) => path.includes("adam.pid"));
      mockReadFileSync.mockReturnValue("9999");
      processKillSpy.mockImplementation(() => { throw new Error("ESRCH"); });

      const status = getDaemonStatus();
      expect(status.running).toBe(false);
      expect(status.pid).toBe(9999);
    });

    it("returns null pid when PID file contains NaN", () => {
      mockExistsSync.mockImplementation((path: string) => path.includes("adam.pid"));
      mockReadFileSync.mockReturnValue("not-a-number");
      const status = getDaemonStatus();
      expect(status.pid).toBeNull();
    });

    it("returns null port when port file missing", () => {
      mockExistsSync.mockReturnValue(false);
      const status = getDaemonStatus();
      expect(status.port).toBeNull();
    });

    it("returns null port when port file contains NaN", () => {
      mockExistsSync.mockImplementation((path: string) => path.includes("adam.port"));
      mockReadFileSync.mockReturnValue("invalid");
      const status = getDaemonStatus();
      expect(status.port).toBeNull();
    });
  });

  describe("getLogPath", () => {
    it("returns path under .adam containing server.log", () => {
      const logPath = getLogPath();
      expect(logPath).toContain(".adam");
      expect(logPath).toMatch(/server\.log$/);
    });
  });

  describe("startDaemon", () => {
    function createMockChild() {
      const child = new EventEmitter() as any;
      child.pid = 12345;
      child.kill = vi.fn();
      child.disconnect = vi.fn();
      child.unref = vi.fn();
      return child;
    }

    it("throws when server already running", async () => {
      mockExistsSync.mockImplementation((path: string) => path.includes("adam.pid"));
      mockReadFileSync.mockReturnValue("1234");
      processKillSpy.mockImplementation(() => true);

      await expect(startDaemon()).rejects.toThrow("already running");
    });

    it("starts successfully with IPC ready signal", async () => {
      mockExistsSync.mockReturnValue(false);

      const mockChild = createMockChild();
      mockFork.mockReturnValue(mockChild);

      const promise = startDaemon();

      // Simulate ready signal immediately
      setTimeout(() => {
        mockChild.emit("message", { type: "ready", port: 3000 });
      }, 5);

      const result = await promise;
      expect(result).toEqual({ pid: 12345, port: 3000 });
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        expect.stringContaining("adam.pid"),
        "12345",
      );
      expect(mockChild.disconnect).toHaveBeenCalled();
      expect(mockChild.unref).toHaveBeenCalled();
    });

    it("cleans up stale PID and port files", async () => {
      // PID file exists, but process dead
      mockExistsSync.mockImplementation((path: string) => {
        if (path.includes("adam.pid")) return true;
        if (path.includes("adam.port")) return true;
        if (path.includes(".adam")) return false;
        return false;
      });
      mockReadFileSync.mockReturnValue("9999");
      processKillSpy.mockImplementation((pid: number, signal?: string | number) => {
        if (signal === 0) throw new Error("ESRCH");
        return true;
      });

      const mockChild = createMockChild();
      mockFork.mockReturnValue(mockChild);

      const promise = startDaemon();

      setTimeout(() => {
        mockChild.emit("message", { type: "ready", port: 3000 });
      }, 5);

      await promise;

      // Should have cleaned up stale files
      expect(mockUnlinkSync).toHaveBeenCalledWith(expect.stringContaining("adam.pid"));
      expect(mockUnlinkSync).toHaveBeenCalledWith(expect.stringContaining("adam.port"));
    });

    it("rejects when server exits before ready", async () => {
      mockExistsSync.mockImplementation((path: string) => {
        if (path.includes("server.log")) return true;
        return false;
      });
      mockReadFileSync.mockReturnValue("error log\ncrash info\n");

      const mockChild = createMockChild();
      mockFork.mockReturnValue(mockChild);

      const promise = startDaemon();

      setTimeout(() => {
        mockChild.emit("exit", 1);
      }, 5);

      await expect(promise).rejects.toThrow("exited with code 1");
    });

    it("rejects on fork error", async () => {
      mockExistsSync.mockReturnValue(false);

      const mockChild = createMockChild();
      mockFork.mockReturnValue(mockChild);

      const promise = startDaemon();

      setTimeout(() => {
        mockChild.emit("error", new Error("ENOENT"));
      }, 5);

      await expect(promise).rejects.toThrow("ENOENT");
    });

    it("rejects when ready signal missing port", async () => {
      mockExistsSync.mockReturnValue(false);

      const mockChild = createMockChild();
      mockFork.mockReturnValue(mockChild);

      const promise = startDaemon();

      setTimeout(() => {
        mockChild.emit("message", { type: "ready" }); // no port
      }, 5);

      await expect(promise).rejects.toThrow("missing port");
    });

    it("shows last log lines when exit and log file exists", async () => {
      mockExistsSync.mockImplementation((path: string) => {
        if (path.includes("server.log")) return true;
        return false;
      });
      mockReadFileSync.mockReturnValue("line1\nline2\nline3\n");

      const mockChild = createMockChild();
      mockFork.mockReturnValue(mockChild);

      const promise = startDaemon();

      setTimeout(() => {
        mockChild.emit("exit", 1);
      }, 5);

      try {
        await promise;
      } catch (e) {
        expect((e as Error).message).toContain("line1");
      }
    });

    it("shows log path when exit and no log file", async () => {
      mockExistsSync.mockReturnValue(false);

      const mockChild = createMockChild();
      mockFork.mockReturnValue(mockChild);

      const promise = startDaemon();

      setTimeout(() => {
        mockChild.emit("exit", 1);
      }, 5);

      try {
        await promise;
      } catch (e) {
        expect((e as Error).message).toContain("Check logs:");
      }
    });
  });

  describe("stopDaemon", () => {
    it("throws when no PID file", async () => {
      mockExistsSync.mockReturnValue(false);
      await expect(stopDaemon()).rejects.toThrow("No PID file");
    });

    it("throws when process not running (stale PID)", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue("9999");
      processKillSpy.mockImplementation((pid: number, signal?: string | number) => {
        if (signal === 0) throw new Error("ESRCH");
        return true;
      });

      await expect(stopDaemon()).rejects.toThrow("stale PID file");
      // Should clean up stale files
      expect(mockUnlinkSync).toHaveBeenCalled();
    });

    it("stops running process with SIGTERM", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue("1234");

      let checkCount = 0;
      processKillSpy.mockImplementation((pid: number, signal?: string | number) => {
        if (signal === "SIGTERM") return true;
        if (signal === 0) {
          checkCount++;
          if (checkCount > 2) throw new Error("ESRCH"); // process dies
          return true;
        }
        return true;
      });

      await stopDaemon();

      expect(processKillSpy).toHaveBeenCalledWith(1234, "SIGTERM");
    });

    it("force kills with SIGKILL after 10 attempts", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue("1234");
      // Process never dies (kill signal 0 always succeeds)
      processKillSpy.mockImplementation(() => true);

      await stopDaemon();

      expect(processKillSpy).toHaveBeenCalledWith(1234, "SIGKILL");
    });
  });
});
