import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Set env before importing module
const originalEnv = process.env;

// Mock node:fs to prevent real file reads
vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn().mockReturnValue("file-api-key"),
}));

// Mock node:os
vi.mock("node:os", () => ({
  homedir: vi.fn().mockReturnValue("/home/testuser"),
}));

// Mock node:path
vi.mock("node:path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:path")>();
  return { ...actual };
});

import {
  listArtifacts,
  getArtifact,
  deleteArtifact,
  redeliverArtifact,
} from "../../../cli/tui/lib/artifacts-api.js";

const mockFetch = vi.fn();

describe("artifacts-api", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv, ADAM_API_KEY: "test-api-key", ADAM_PORT: "7100" };
    // Replace global fetch
    (globalThis as { fetch?: unknown }).fetch = mockFetch;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("listArtifacts", () => {
    it("calls GET /artifacts with no filter", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ artifacts: [], total: 0 }),
      });

      const result = await listArtifacts();

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:7100/artifacts");
      expect(opts.headers["x-api-key"]).toBe("test-api-key");
      expect(result.total).toBe(0);
    });

    it("encodes filter params into query string", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ artifacts: [], total: 0 }),
      });

      await listArtifacts({ limit: 50, sourceKind: "template_step" });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("limit=50");
      expect(url).toContain("sourceKind=template_step");
    });
  });

  describe("getArtifact", () => {
    it("calls GET /artifacts/:id with encoded id", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ artifact: { id: "abc" }, deliveryLog: [] }),
      });

      const result = await getArtifact("abc/def");

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:7100/artifacts/abc%2Fdef");
      expect(result.deliveryLog).toEqual([]);
    });
  });

  describe("deleteArtifact", () => {
    it("calls DELETE /artifacts/:id without confirm by default", async () => {
      mockFetch.mockResolvedValue({ ok: true, status: 204, json: async () => undefined });

      await deleteArtifact("artifact-123");

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:7100/artifacts/artifact-123");
      expect(url).not.toContain("confirm");
      expect(opts.method).toBe("DELETE");
    });

    it("appends ?confirm=true when confirm=true", async () => {
      mockFetch.mockResolvedValue({ ok: true, status: 204, json: async () => undefined });

      await deleteArtifact("artifact-123", true);

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("?confirm=true");
    });
  });

  describe("redeliverArtifact", () => {
    it("calls POST /artifacts/:id/redeliver with JSON body", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ deliveryLogId: "log-1", status: "pending" }),
      });

      const result = await redeliverArtifact("artifact-xyz", { channelId: "ch-1" });

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:7100/artifacts/artifact-xyz/redeliver");
      expect(opts.method).toBe("POST");
      expect(JSON.parse(opts.body)).toEqual({ channelId: "ch-1" });
      expect(opts.headers["Content-Type"]).toBe("application/json");
      expect(result.status).toBe("pending");
    });
  });

  describe("error handling", () => {
    it("throws on non-ok response", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => "Unauthorized",
      });

      await expect(listArtifacts()).rejects.toThrow("401: Unauthorized");
    });
  });
});
