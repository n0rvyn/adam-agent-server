import { describe, it, expect, vi } from "vitest";

const { mockFastify, mockRegister, mockSetErrorHandler, mockSetNotFoundHandler, mockAddHook, mockGet } = vi.hoisted(() => ({
  mockRegister: vi.fn(),
  mockSetErrorHandler: vi.fn(),
  mockSetNotFoundHandler: vi.fn(),
  mockAddHook: vi.fn(),
  mockGet: vi.fn(),
  mockFastify: vi.fn(() => ({
    register: mockRegister,
    setErrorHandler: mockSetErrorHandler,
    setNotFoundHandler: mockSetNotFoundHandler,
    addHook: mockAddHook,
    get: mockGet,
  })),
}));

vi.mock("fastify", () => ({ default: mockFastify }));
vi.mock("@fastify/cors", () => ({ default: "cors-plugin" }));
vi.mock("@fastify/websocket", () => ({ default: "websocket-plugin" }));
vi.mock("@fastify/swagger", () => ({ default: "swagger-plugin" }));
vi.mock("@fastify/swagger-ui", () => ({ default: "swagger-ui-plugin" }));
vi.mock("@fastify/static", () => ({ default: "static-plugin" }));
vi.mock("node:fs", () => ({
  existsSync: () => false,
  readFileSync: () => '{"name":"test","version":"0.0.1"}',
}));

import { buildApp } from "../../server/app.js";
import { TEST_API_KEY } from "../helpers/test-auth.js";

describe("buildApp", () => {
  it("creates Fastify instance with logger", () => {
    buildApp({ server: { host: "127.0.0.1", port: 3000 }, defaults: {} as never }, TEST_API_KEY);
    expect(mockFastify).toHaveBeenCalledWith({ logger: false });
  });

  it("registers cors plugin", () => {
    buildApp({ server: { host: "127.0.0.1", port: 3000 }, defaults: {} as never }, TEST_API_KEY);
    expect(mockRegister).toHaveBeenCalledWith("cors-plugin", { origin: true });
  });

  it("registers websocket plugin with maxPayload", () => {
    buildApp({ server: { host: "127.0.0.1", port: 3000 }, defaults: {} as never }, TEST_API_KEY);
    expect(mockRegister).toHaveBeenCalledWith("websocket-plugin", {
      options: { maxPayload: 1024 * 1024 * 16 },
    });
  });

  it("returns the Fastify app instance", () => {
    const app = buildApp({ server: { host: "127.0.0.1", port: 3000 }, defaults: {} as never }, TEST_API_KEY);
    expect(app).toBeDefined();
    expect(app.register).toBe(mockRegister);
  });

  it("throws when apiKey is missing", () => {
    expect(() =>
      buildApp({ server: { host: "127.0.0.1", port: 3000 }, defaults: {} as never }),
    ).toThrow(/server\.apiKey required/);
  });
});
