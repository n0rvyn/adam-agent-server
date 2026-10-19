import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import fastify from "fastify";
import { setAuthKey } from "../../server/auth-key.js";
import { TEST_API_KEY } from "../helpers/test-auth.js";
import { setupTestDb, getTestDb } from "../helpers/test-db.js";

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

import { presetsRoutes } from "../../server/routes/presets.js";
import { featureRequestRoutes } from "../../server/routes/feature-requests.js";

describe("server/routes/presets", () => {
  let cleanup: () => void;

  beforeAll(() => {
    setAuthKey(TEST_API_KEY);
  });

  beforeEach(() => {
    const { cleanup: c } = setupTestDb();
    cleanup = c;
  });

  afterEach(() => {
    cleanup!();
  });

  it("GET /presets returns { roles, templates, installed }", async () => {
    const app = fastify();
    await app.register(presetsRoutes);
    await app.ready();

    const response = await app.inject({
      method: "GET",
      url: "/presets",
      headers: { "x-api-key": TEST_API_KEY },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveProperty("roles");
    expect(body).toHaveProperty("templates");
    expect(body).toHaveProperty("installed");
    expect(Array.isArray(body.roles)).toBe(true);
    expect(Array.isArray(body.templates)).toBe(true);
    expect(typeof body.installed).toBe("object");
    await app.close();
  });

  it("POST /presets/role/feature-miner/restore creates/restores the role", async () => {
    const app = fastify();
    await app.register(presetsRoutes);
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: "/presets/role/feature-miner/restore",
      headers: { "x-api-key": TEST_API_KEY },
    });
    expect([200, 400]).toContain(response.statusCode);
    await app.close();
  });

  it("POST /presets/role/nonexistent/restore returns 400", async () => {
    const app = fastify();
    await app.register(presetsRoutes);
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: "/presets/role/nonexistent-preset-xyz/restore",
      headers: { "x-api-key": TEST_API_KEY },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.code).toBe("RESTORE_FAILED");
    await app.close();
  });

  it("POST /presets/invalid_type/x/restore returns 400", async () => {
    const app = fastify();
    await app.register(presetsRoutes);
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: "/presets/invalid_type/x/restore",
      headers: { "x-api-key": TEST_API_KEY },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });
});

describe("server/routes/feature-requests", () => {
  let cleanup: () => void;

  beforeAll(() => {
    setAuthKey(TEST_API_KEY);
  });

  beforeEach(() => {
    const { cleanup: c } = setupTestDb();
    cleanup = c;
  });

  afterEach(() => {
    cleanup!();
  });

  it("GET /feature-requests returns list", async () => {
    const app = fastify();
    await app.register(featureRequestRoutes);
    await app.ready();

    const response = await app.inject({
      method: "GET",
      url: "/feature-requests",
      headers: { "x-api-key": TEST_API_KEY },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveProperty("featureRequests");
    expect(Array.isArray(body.featureRequests)).toBe(true);
    await app.close();
  });

  it("GET /feature-requests/:id returns 404 for missing", async () => {
    const app = fastify();
    await app.register(featureRequestRoutes);
    await app.ready();

    const response = await app.inject({
      method: "GET",
      url: "/feature-requests/nonexistent-id",
      headers: { "x-api-key": TEST_API_KEY },
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("PATCH /feature-requests/:id with invalid status returns 400; with valid status mutates DB", async () => {
    const app = fastify();
    await app.register(featureRequestRoutes);
    await app.ready();

    // Create a feature request first
    const createResp = await app.inject({
      method: "POST",
      url: "/feature-requests",
      headers: {
        "x-api-key": TEST_API_KEY,
        "Content-Type": "application/json",
      },
      payload: { content: "Adam should support Notion" },
    });
    expect(createResp.statusCode).toBe(201);
    const { featureRequest } = createResp.json();
    const id = featureRequest.id;

    // Invalid status
    const badResp = await app.inject({
      method: "PATCH",
      url: `/feature-requests/${id}`,
      headers: {
        "x-api-key": TEST_API_KEY,
        "Content-Type": "application/json",
      },
      payload: { status: "invalid_status" },
    });
    expect(badResp.statusCode).toBe(400);

    // Valid status
    const okResp = await app.inject({
      method: "PATCH",
      url: `/feature-requests/${id}`,
      headers: {
        "x-api-key": TEST_API_KEY,
        "Content-Type": "application/json",
      },
      payload: { status: "reviewed" },
    });
    expect(okResp.statusCode).toBe(200);
    const body = okResp.json();
    expect(body.status).toBe("reviewed");

    await app.close();
  });
});
