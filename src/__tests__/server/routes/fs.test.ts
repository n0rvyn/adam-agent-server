import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import type BetterSqlite3 from "better-sqlite3";
import { setupTestDb, clearTestDb } from "../../helpers/test-db.js";

let testDb: BetterSqlite3.Database;
let cleanup: () => void;

vi.mock("../../../store/db.js", () => ({
  getDb: () => testDb,
  closeDb: () => {},
}));

vi.mock("../../../lib/embedding.js", () => ({
  isModelAvailable: () => true,
}));

import Fastify from "fastify";
import { fsRoutes } from "../../../server/routes/fs.js";

describe("fs routes", () => {
  beforeAll(() => {
    const result = setupTestDb();
    testDb = result.db;
    cleanup = result.cleanup;
  });

  afterAll(() => cleanup());

  beforeEach(() => {
    clearTestDb();
  });

  async function buildApp() {
    const app = Fastify();
    await app.register(fsRoutes);
    return app;
  }

  describe("GET /fs/suggest-dirs", () => {
    it("returns matched subdirectories for a valid prefix", async () => {
      const app = await buildApp();
      // Use /tmp/ (trailing slash) to get subdirectories of /tmp
      const res = await app.inject({
        method: "GET",
        url: "/fs/suggest-dirs?prefix=/tmp/",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveProperty("suggestions");
      expect(Array.isArray(body.suggestions)).toBe(true);
      // All results should be absolute paths under /tmp
      for (const s of body.suggestions) {
        expect(s).toMatch(/^\/tmp\//);
      }
    });

    it("filters by partial prefix", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/fs/suggest-dirs?prefix=/usr/l",
      });
      expect(res.statusCode).toBe(200);
      const { suggestions } = res.json();
      for (const s of suggestions) {
        expect(s.toLowerCase()).toMatch(/^\/usr\/l/);
      }
    });

    it("returns empty array for non-existent parent directory", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/fs/suggest-dirs?prefix=/this/path/does/not/exist/foo",
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().suggestions).toEqual([]);
    });

    it("returns empty array for relative paths", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/fs/suggest-dirs?prefix=relative/path",
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().suggestions).toEqual([]);
    });

    it("returns empty array for denied paths under ~/.ssh", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/fs/suggest-dirs?prefix=~/.ssh/subdir",
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().suggestions).toEqual([]);
    });

    it("returns empty array for denied paths under ~/.aws", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/fs/suggest-dirs?prefix=~/.aws/credentials",
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().suggestions).toEqual([]);
    });

    it("skips hidden directories unless partial starts with .", async () => {
      const app = await buildApp();
      // /tmp may contain hidden dirs — the filter should exclude them by default
      const res = await app.inject({
        method: "GET",
        url: "/fs/suggest-dirs?prefix=/tmp",
      });
      expect(res.statusCode).toBe(200);
      const { suggestions } = res.json();
      const hiddenDirs = suggestions.filter((s: string) => s.split("/").pop()!.startsWith("."));
      expect(hiddenDirs).toHaveLength(0);
    });

    it("returns at most 20 suggestions", async () => {
      const app = await buildApp();
      // Use a broad directory to increase chance of hitting the cap
      const res = await app.inject({
        method: "GET",
        url: "/fs/suggest-dirs?prefix=/",
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().suggestions.length).toBeLessThanOrEqual(20);
    });
  });
});
