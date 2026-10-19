/**
 * Integration test for Phase 3 Task 5: x-api-key middleware coverage on /artifacts routes.
 * Uses real buildApp() so the auth hook applies.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestDb, getTestDb } from "../../helpers/test-db.js";
import { vi } from "vitest";
import type { FastifyInstance } from "fastify";

const { cleanup } = setupTestDb();

vi.mock("../../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

const TEST_API_KEY = "test-api-key-phase3";

let app: FastifyInstance;

beforeAll(async () => {
  const { buildApp } = await import("../../../server/app.js");
  const { artifactRoutes } = await import("../../../server/routes/artifacts.js");
  // ServerConfig — only field accessed in buildApp is _config (unused). Pass minimal stub.
  app = buildApp({ port: 0, host: "127.0.0.1", apiKey: TEST_API_KEY } as never, TEST_API_KEY);
  await app.register(artifactRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  cleanup();
});

describe("x-api-key middleware on /artifacts routes", () => {
  it("A: GET /artifacts without x-api-key → 401", async () => {
    const res = await app.inject({ method: "GET", url: "/artifacts" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("B: GET /artifacts with wrong x-api-key → 401", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/artifacts",
      headers: { "x-api-key": "wrong-key" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("C: GET /artifacts with correct x-api-key → 200", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/artifacts",
      headers: { "x-api-key": TEST_API_KEY },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ artifacts: expect.any(Array), total: expect.any(Number) });
  });

  it("D: GET /artifacts via ?api_key= query param → 200", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/artifacts?api_key=${TEST_API_KEY}`,
    });
    expect(res.statusCode).toBe(200);
  });

  it("E: DELETE /artifacts/:id without x-api-key → 401 (not 404)", async () => {
    // Without auth, middleware short-circuits before route handler — should never see 404
    const res = await app.inject({ method: "DELETE", url: "/artifacts/some-id" });
    expect(res.statusCode).toBe(401);
  });
});
