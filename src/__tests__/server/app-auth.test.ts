import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { buildApp } from "../../server/app.js";

describe("server/app — API key authentication", () => {
  const TEST_API_KEY = "adam-test-key-2026";

  describe("without apiKey configured", () => {
    it("throws (auth is always enforced)", () => {
      expect(() =>
        buildApp({ defaults: {} as never, server: { port: 0, host: "127.0.0.1" } }, undefined),
      ).toThrow(/server\.apiKey required/);
    });
  });

  describe("with apiKey configured", () => {
    let app: ReturnType<typeof buildApp>;

    beforeEach(() => {
      app = buildApp({ defaults: {} as never, server: { port: 0, host: "127.0.0.1" } }, TEST_API_KEY);
    });

    afterEach(async () => {
      await app.close();
    });

    it("rejects requests without X-API-Key header and without query param", async () => {
      app.get("/protected", async () => ({ ok: true }));
      await app.ready();

      const response = await app.inject({
        method: "GET",
        url: "/protected",
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.code).toBe("UNAUTHORIZED");
      expect(body.message).toMatch(/api.?key/i);
    });

    it("rejects requests with wrong X-API-Key header", async () => {
      app.get("/protected", async () => ({ ok: true }));
      await app.ready();

      const response = await app.inject({
        method: "GET",
        url: "/protected",
        headers: { "x-api-key": "wrong-key-123" },
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.code).toBe("UNAUTHORIZED");
    });

    it("accepts requests with correct X-API-Key header", async () => {
      app.get("/protected", async () => ({ ok: true }));
      await app.ready();

      const response = await app.inject({
        method: "GET",
        url: "/protected",
        headers: { "x-api-key": TEST_API_KEY },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.ok).toBe(true);
    });

    it("accepts requests with correct api_key query param (browser WebSocket)", async () => {
      app.get("/protected", async () => ({ ok: true }));
      await app.ready();

      const response = await app.inject({
        method: "GET",
        url: `/protected?api_key=${TEST_API_KEY}`,
      });

      expect(response.statusCode).toBe(200);
    });

    it("accepts requests with correct x-api-key query param", async () => {
      app.get("/protected", async () => ({ ok: true }));
      await app.ready();

      const response = await app.inject({
        method: "GET",
        url: `/protected?x-api-key=${TEST_API_KEY}`,
      });

      expect(response.statusCode).toBe(200);
    });

    it("skips auth for /healthz endpoint", async () => {
      app.get("/healthz", async () => ({ status: "ok" }));
      await app.ready();

      const response = await app.inject({
        method: "GET",
        url: "/healthz",
      });

      expect(response.statusCode).toBe(200);
    });

    it("skips auth for /readyz endpoint", async () => {
      app.get("/readyz", async () => ({ status: "ready" }));
      await app.ready();

      const response = await app.inject({
        method: "GET",
        url: "/readyz",
      });

      expect(response.statusCode).toBe(200);
    });

    it("skips auth for /docs (Swagger UI)", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/docs",
      });

      // Either 200 (docs available) or 404 (not registered) — both mean auth passed
      expect([200, 404]).toContain(response.statusCode);
    });

    it("skips auth for /ui (Web UI static files)", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/ui",
      });

      // Either 200 (static files served) or 404 (not built) — both mean auth passed
      expect([200, 404]).toContain(response.statusCode);
    });

    it("rejects POST requests without auth", async () => {
      app.post("/protected", async () => ({ ok: true }));
      await app.ready();

      const response = await app.inject({
        method: "POST",
        url: "/protected",
        payload: { data: "test" },
      });

      expect(response.statusCode).toBe(401);
    });

    it("accepts POST requests with correct auth", async () => {
      app.post("/protected", async () => ({ received: true }));
      await app.ready();

      const response = await app.inject({
        method: "POST",
        url: "/protected",
        headers: { "x-api-key": TEST_API_KEY },
        payload: { data: "test" },
      });

      expect(response.statusCode).toBe(200);
    });

    it("returns 401 for HTTP request to /events without auth (onRequest hook)", async () => {
      await app.ready();

      // The onRequest auth hook rejects all non-exempt routes including /events
      const response = await app.inject({
        method: "GET",
        url: "/events",
      });

      expect(response.statusCode).toBe(401);
    });
  });
});
