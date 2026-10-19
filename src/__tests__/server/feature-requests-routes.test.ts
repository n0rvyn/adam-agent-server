import { describe, it, expect, beforeAll, vi } from "vitest";
import fastify from "fastify";
import { setAuthKey } from "../../server/auth-key.js";
import { TEST_API_KEY } from "../helpers/test-auth.js";
import { setupTestDb, getTestDb } from "../helpers/test-db.js";

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

import { featureRequestRoutes } from "../../server/routes/feature-requests.js";

describe("server/routes/feature-requests", () => {
  beforeAll(() => {
    setAuthKey(TEST_API_KEY);
  });

  it("GET /feature-requests returns list; ?status=new filters correctly", async () => {
    const { cleanup } = setupTestDb();
    try {
      const app = fastify();
      // Add auth hook matching app.ts global hook so standalone registration behaves the same
      app.addHook("onRequest", async (request, reply) => {
        const url = request.url;
        if (url === "/healthz" || url === "/readyz" || url.startsWith("/docs") || url.startsWith("/ui")) return;
        const headerKey = request.headers["x-api-key"] as string | undefined;
        if (headerKey && headerKey === TEST_API_KEY) return;
        return reply.status(401).send({ code: "UNAUTHORIZED", message: "Invalid or missing API key" });
      });
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
    } finally {
      cleanup();
    }
  });

  it("GET /feature-requests/:id returns 404 for missing", async () => {
    const { cleanup } = setupTestDb();
    try {
      const app = fastify();
      app.addHook("onRequest", async (request, reply) => {
        const url = request.url;
        if (url === "/healthz" || url === "/readyz" || url.startsWith("/docs") || url.startsWith("/ui")) return;
        const headerKey = request.headers["x-api-key"] as string | undefined;
        if (headerKey && headerKey === TEST_API_KEY) return;
        return reply.status(401).send({ code: "UNAUTHORIZED", message: "Invalid or missing API key" });
      });
      await app.register(featureRequestRoutes);
      await app.ready();

      const response = await app.inject({
        method: "GET",
        url: "/feature-requests/does-not-exist",
        headers: { "x-api-key": TEST_API_KEY },
      });
      expect(response.statusCode).toBe(404);
      await app.close();
    } finally {
      cleanup();
    }
  });

  it("PATCH /feature-requests/:id with invalid body returns 400; with valid status mutates DB", async () => {
    const { cleanup } = setupTestDb();
    try {
      const app = fastify();
      app.addHook("onRequest", async (request, reply) => {
        const url = request.url;
        if (url === "/healthz" || url === "/readyz" || url.startsWith("/docs") || url.startsWith("/ui")) return;
        const headerKey = request.headers["x-api-key"] as string | undefined;
        if (headerKey && headerKey === TEST_API_KEY) return;
        return reply.status(401).send({ code: "UNAUTHORIZED", message: "Invalid or missing API key" });
      });
      await app.register(featureRequestRoutes);
      await app.ready();

      // Create a request first
      const createResp = await app.inject({
        method: "POST",
        url: "/feature-requests",
        headers: { "x-api-key": TEST_API_KEY, "Content-Type": "application/json" },
        payload: { content: "Adam should support Notion" },
      });
      expect(createResp.statusCode).toBe(201);
      const { featureRequest } = createResp.json();

      // Invalid status
      const badResp = await app.inject({
        method: "PATCH",
        url: `/feature-requests/${featureRequest.id}`,
        headers: { "x-api-key": TEST_API_KEY, "Content-Type": "application/json" },
        payload: { status: "not_a_valid_status" },
      });
      expect(badResp.statusCode).toBe(400);

      // Valid status
      const okResp = await app.inject({
        method: "PATCH",
        url: `/feature-requests/${featureRequest.id}`,
        headers: { "x-api-key": TEST_API_KEY, "Content-Type": "application/json" },
        payload: { status: "dismissed" },
      });
      expect(okResp.statusCode).toBe(200);
      const body = okResp.json();
      expect(body.status).toBe("dismissed");

      await app.close();
    } finally {
      cleanup();
    }
  });

  it("Auth header missing returns 401", async () => {
    const { cleanup } = setupTestDb();
    try {
      const app = fastify();
      app.addHook("onRequest", async (request, reply) => {
        const url = request.url;
        if (url === "/healthz" || url === "/readyz" || url.startsWith("/docs") || url.startsWith("/ui")) return;
        const headerKey = request.headers["x-api-key"] as string | undefined;
        if (headerKey && headerKey === TEST_API_KEY) return;
        return reply.status(401).send({ code: "UNAUTHORIZED", message: "Invalid or missing API key" });
      });
      await app.register(featureRequestRoutes);
      await app.ready();

      const response = await app.inject({
        method: "GET",
        url: "/feature-requests",
        // No x-api-key header
      });
      expect(response.statusCode).toBe(401);
      await app.close();
    } finally {
      cleanup();
    }
  });
});
