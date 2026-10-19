import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../../server/app.js";
import type { FastifyInstance } from "fastify";

const TEST_API_KEY = "test-secret-key-12345";

describe("API Key Auth Middleware", () => {
  describe("with API key configured", () => {
    let app: FastifyInstance;

    beforeAll(async () => {
      app = buildApp({ server: { host: "127.0.0.1", port: 0 }, defaults: {} } as never, TEST_API_KEY);
      // Register test routes before ready()
      app.get("/test-route", async () => ({ ok: true }));
      app.get("/healthz", async () => ({ status: "ok" }));
      app.get("/readyz", async () => ({ status: "ok" }));
      await app.ready();
    });

    afterAll(async () => {
      await app.close();
    });

    it("returns 401 without x-api-key header", async () => {
      const res = await app.inject({ method: "GET", url: "/test-route" });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ code: "UNAUTHORIZED", message: "Invalid or missing API key" });
    });

    it("returns 401 with wrong x-api-key header", async () => {
      const res = await app.inject({ method: "GET", url: "/test-route", headers: { "x-api-key": "wrong-key" } });
      expect(res.statusCode).toBe(401);
    });

    it("returns 200 with correct x-api-key header", async () => {
      const res = await app.inject({ method: "GET", url: "/test-route", headers: { "x-api-key": TEST_API_KEY } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
    });

    it("allows /healthz without API key", async () => {
      const res = await app.inject({ method: "GET", url: "/healthz" });
      expect(res.statusCode).toBe(200);
    });

    it("allows /readyz without API key", async () => {
      const res = await app.inject({ method: "GET", url: "/readyz" });
      expect(res.statusCode).toBe(200);
    });

    it("allows /docs without API key", async () => {
      const res = await app.inject({ method: "GET", url: "/docs" });
      // May return 302 redirect or 200 depending on swagger-ui, but NOT 401
      expect(res.statusCode).not.toBe(401);
    });

    it("allows /ui/ without API key", async () => {
      const res = await app.inject({ method: "GET", url: "/ui/index.html" });
      // Static file may not exist in test, but should NOT return 401
      expect(res.statusCode).not.toBe(401);
    });

    it("accepts API key via query param (for WebSocket clients)", async () => {
      const res = await app.inject({ method: "GET", url: "/test-route?api_key=" + TEST_API_KEY });
      expect(res.statusCode).toBe(200);
    });
  });

  describe("without API key configured", () => {
    it("throws (auth is always enforced — bootstrap must supply a key)", () => {
      expect(() =>
        buildApp({ server: { host: "127.0.0.1", port: 0 }, defaults: {} } as never, undefined),
      ).toThrow(/server\.apiKey required/);
    });
  });
});
