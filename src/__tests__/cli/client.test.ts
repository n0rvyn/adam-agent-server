import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ApiError } from "../../cli/client.js";
import { existsSync } from "fs";

// Mock existsSync to simulate missing port file (server not running)
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    existsSync: vi.fn((path: string) => {
      if (typeof path === "string" && path.endsWith("adam.port")) return false;
      return actual.existsSync(path);
    }),
  };
});

// Note: request() and getHealth() read ~/.adam/adam.port directly.
// Without a running server, they throw "Server not running".
// We test the error class and verify error behavior.

describe("client module", () => {
  describe("ApiError", () => {
    it("includes status code and message", () => {
      const error = new ApiError(500, "Internal server error");
      expect(error.status).toBe(500);
      expect(error.message).toBe("Internal server error");
      expect(error.name).toBe("ApiError");
    });

    it("is instanceof Error", () => {
      const error = new ApiError(404, "Not found");
      expect(error).toBeInstanceOf(Error);
    });

    it("preserves stack trace", () => {
      const error = new ApiError(403, "Forbidden");
      expect(error.stack).toBeDefined();
      expect(error.stack).toContain("ApiError");
    });
  });

  describe("request (no server)", () => {
    it("throws when port file does not exist", async () => {
      const { request } = await import("../../cli/client.js");
      await expect(request("/healthz")).rejects.toThrow("Server not running");
    });
  });

  describe("getHealth (no server)", () => {
    it("throws when server is not running", async () => {
      const { getHealth } = await import("../../cli/client.js");
      await expect(getHealth()).rejects.toThrow("Server not running");
    });
  });

  describe("EventSocket (no server)", () => {
    it("throws on construction when no port file", async () => {
      const { EventSocket } = await import("../../cli/client.js");
      expect(() => new EventSocket()).toThrow("Server not running");
    });
  });

  describe("TaskStreamSocket (no server)", () => {
    it("throws on construction when no port file", async () => {
      const { TaskStreamSocket } = await import("../../cli/client.js");
      expect(() => new TaskStreamSocket("some-task-id")).toThrow("Server not running");
    });
  });
});
