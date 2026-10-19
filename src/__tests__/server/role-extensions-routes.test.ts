import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import fastify from "fastify";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";
import { TEST_API_KEY } from "../helpers/test-auth.js";
import { roleExtensionRoutes } from "../../server/routes/role-extensions.js";

const { cleanup } = setupTestDb();
vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

afterAll(() => cleanup());
beforeEach(() => clearTestDb());

async function buildApp() {
  const app = fastify();
  app.addHook("onRequest", async (request, reply) => {
    const url = request.url;
    if (url === "/healthz" || url === "/readyz" || url.startsWith("/docs") || url.startsWith("/ui"))
      return;
    const headerKey = request.headers["x-api-key"] as string | undefined;
    if (headerKey && headerKey === TEST_API_KEY) return;
    return reply.status(401).send({ code: "UNAUTHORIZED", message: "Invalid or missing API key" });
  });
  await app.register(roleExtensionRoutes);
  await app.ready();
  return app;
}

/**
 * Seed a role and an extension in the test DB, returning their IDs and names.
 */
function seedRoleAndExtension(): { roleId: string; extensionId: string; extensionName: string } {
  const db = getTestDb();
  const now = Date.now();
  const roleId = "role-test-001";
  const extensionId = "ext-test-001";
  const extensionName = "browser-control-mcpb";

  db.prepare(
    `INSERT INTO roles (id, name, memory_stream_id, created_at) VALUES (?, ?, ?, ?)`,
  ).run(roleId, "TestRole", "ms-1", now);

  const manifest = JSON.stringify({
    manifest_version: "0.3",
    name: extensionName,
    version: "1.0.0",
    description: "Test extension",
    author: { name: "Test" },
    server: { type: "node", mcp_config: { command: "node" } },
    user_config: {
      transport: { type: "string", default: "localhost", description: "Transport type" },
      port: { type: "number", default: 9999, description: "Port number" },
    },
  });

  db.prepare(
    `INSERT INTO extensions (id, name, version, manifest_json, install_source, package_hash, default_config_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    extensionId,
    extensionName,
    "1.0.0",
    manifest,
    "upload",
    "abc123",
    JSON.stringify({ transport: "localhost", port: 9999 }),
    now,
    now,
  );

  return { roleId, extensionId, extensionName };
}

describe("role-extensions REST routes", () => {
  it("GET /roles/:rid/extensions returns empty array when no bindings", async () => {
    const db = getTestDb();
    const now = Date.now();
    db.prepare(
      `INSERT INTO roles (id, name, memory_stream_id, created_at) VALUES (?, ?, ?, ?)`,
    ).run("role-empty", "EmptyRole", "ms-2", now);

    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/roles/role-empty/extensions",
      headers: { "x-api-key": TEST_API_KEY },
    });
    expect(res.statusCode).toBe(200);
    const json = res.json() as { bindings: unknown[] };
    expect(Array.isArray(json.bindings)).toBe(true);
    expect(json.bindings.length).toBe(0);
    await app.close();
  });

  it("GET /roles/:rid/extensions returns bindings with effective config = default merge override", async () => {
    const { roleId, extensionName } = seedRoleAndExtension();
    // POST a binding with config_override = { transport: "native_messaging" }
    const app = await buildApp();

    const postRes = await app.inject({
      method: "POST",
      url: `/roles/${roleId}/extensions`,
      headers: { "x-api-key": TEST_API_KEY, "content-type": "application/json" },
      payload: JSON.stringify({
        extension_name: extensionName,
        config_override: { transport: "native_messaging" },
      }),
    });
    expect(postRes.statusCode).toBe(201);

    const getRes = await app.inject({
      method: "GET",
      url: `/roles/${roleId}/extensions`,
      headers: { "x-api-key": TEST_API_KEY },
    });
    expect(getRes.statusCode).toBe(200);
    const json = getRes.json() as { bindings: Array<{ effectiveConfig: Record<string, unknown>; configOverride: Record<string, unknown> | null; health?: unknown }> };
    expect(json.bindings.length).toBe(1);
    expect(json.bindings[0].configOverride).toEqual({ transport: "native_messaging" });
    // effectiveConfig = defaults merged with override: port from default, transport from override
    expect(json.bindings[0].effectiveConfig).toEqual({ transport: "native_messaging", port: 9999 });
    // Phase 3: each binding carries a `health` field (null when extension never ran)
    expect(json.bindings[0]).toHaveProperty("health");
    expect(json.bindings[0].health).toBeNull();
    await app.close();
  });

  it("GET /roles/:rid/extensions returns 404 for unknown role", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/roles/unknown-role-xyz/extensions",
      headers: { "x-api-key": TEST_API_KEY },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("POST /roles/:rid/extensions creates a binding with generated_server_name = extension.name", async () => {
    const { roleId, extensionName } = seedRoleAndExtension();
    const app = await buildApp();

    const res = await app.inject({
      method: "POST",
      url: `/roles/${roleId}/extensions`,
      headers: { "x-api-key": TEST_API_KEY, "content-type": "application/json" },
      payload: JSON.stringify({ extension_name: extensionName }),
    });
    expect(res.statusCode).toBe(201);
    const json = res.json() as {
      id: string;
      extensionName: string;
      generatedServerName: string;
      enabled: boolean;
      configOverride: null;
    };
    expect(json.extensionName).toBe(extensionName);
    expect(json.generatedServerName).toBe(extensionName);
    expect(json.enabled).toBe(true);
    expect(json.configOverride).toBeNull();
    await app.close();
  });

  it("POST /roles/:rid/extensions with same role+extension twice returns 409", async () => {
    const { roleId, extensionName } = seedRoleAndExtension();
    const app = await buildApp();

    const first = await app.inject({
      method: "POST",
      url: `/roles/${roleId}/extensions`,
      headers: { "x-api-key": TEST_API_KEY, "content-type": "application/json" },
      payload: JSON.stringify({ extension_name: extensionName }),
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: "POST",
      url: `/roles/${roleId}/extensions`,
      headers: { "x-api-key": TEST_API_KEY, "content-type": "application/json" },
      payload: JSON.stringify({ extension_name: extensionName }),
    });
    expect(second.statusCode).toBe(409);
    const json = second.json() as { code: string };
    expect(json.code).toBe("BINDING_EXISTS");
    await app.close();
  });

  it("POST /roles/:rid/extensions with unknown extension_name returns 404", async () => {
    const db = getTestDb();
    const now = Date.now();
    db.prepare(
      `INSERT INTO roles (id, name, memory_stream_id, created_at) VALUES (?, ?, ?, ?)`,
    ).run("role-noext", "NoExtRole", "ms-3", now);

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/roles/role-noext/extensions",
      headers: { "x-api-key": TEST_API_KEY, "content-type": "application/json" },
      payload: JSON.stringify({ extension_name: "nonexistent-ext-xyz" }),
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("POST /roles/:rid/extensions with unknown role returns 404", async () => {
    const { extensionName } = seedRoleAndExtension();
    const app = await buildApp();

    const res = await app.inject({
      method: "POST",
      url: "/roles/unknown-role-abc/extensions",
      headers: { "x-api-key": TEST_API_KEY, "content-type": "application/json" },
      payload: JSON.stringify({ extension_name: extensionName }),
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("POST /roles/:rid/extensions persists configOverride when provided", async () => {
    const { roleId, extensionName } = seedRoleAndExtension();
    const app = await buildApp();

    const res = await app.inject({
      method: "POST",
      url: `/roles/${roleId}/extensions`,
      headers: { "x-api-key": TEST_API_KEY, "content-type": "application/json" },
      payload: JSON.stringify({
        extension_name: extensionName,
        config_override: { transport: "native_messaging" },
      }),
    });
    expect(res.statusCode).toBe(201);
    const json = res.json() as { configOverride: Record<string, unknown> | null };
    expect(json.configOverride).toEqual({ transport: "native_messaging" });
    await app.close();
  });

  it("DELETE /roles/:rid/extensions/:eid removes the binding", async () => {
    const { roleId, extensionName } = seedRoleAndExtension();
    const app = await buildApp();

    const postRes = await app.inject({
      method: "POST",
      url: `/roles/${roleId}/extensions`,
      headers: { "x-api-key": TEST_API_KEY, "content-type": "application/json" },
      payload: JSON.stringify({ extension_name: extensionName }),
    });
    expect(postRes.statusCode).toBe(201);
    const bindingId = (postRes.json() as { id: string }).id;

    const delRes = await app.inject({
      method: "DELETE",
      url: `/roles/${roleId}/extensions/${bindingId}`,
      headers: { "x-api-key": TEST_API_KEY },
    });
    expect(delRes.statusCode).toBe(204);

    // Verify gone
    const getRes = await app.inject({
      method: "GET",
      url: `/roles/${roleId}/extensions`,
      headers: { "x-api-key": TEST_API_KEY },
    });
    const json = getRes.json() as { bindings: unknown[] };
    expect(json.bindings.length).toBe(0);
    await app.close();
  });

  it("DELETE /roles/:rid/extensions/:eid returns 404 for unknown binding", async () => {
    const { roleId } = seedRoleAndExtension();
    const app = await buildApp();

    const res = await app.inject({
      method: "DELETE",
      url: `/roles/${roleId}/extensions/nonexistent-binding-id`,
      headers: { "x-api-key": TEST_API_KEY },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("PATCH /roles/:rid/extensions/:eid updates configOverride (sparse override replaces)", async () => {
    const { roleId, extensionName } = seedRoleAndExtension();
    const app = await buildApp();

    const postRes = await app.inject({
      method: "POST",
      url: `/roles/${roleId}/extensions`,
      headers: { "x-api-key": TEST_API_KEY, "content-type": "application/json" },
      payload: JSON.stringify({ extension_name: extensionName }),
    });
    const bindingId = (postRes.json() as { id: string }).id;

    const patchRes = await app.inject({
      method: "PATCH",
      url: `/roles/${roleId}/extensions/${bindingId}`,
      headers: { "x-api-key": TEST_API_KEY, "content-type": "application/json" },
      payload: JSON.stringify({ config_override: { transport: "stdio" } }),
    });
    expect(patchRes.statusCode).toBe(200);
    const json = patchRes.json() as { configOverride: Record<string, unknown> | null };
    expect(json.configOverride).toEqual({ transport: "stdio" });
    await app.close();
  });

  it("PATCH /roles/:rid/extensions/:eid with configOverride=null wipes override", async () => {
    const { roleId, extensionName } = seedRoleAndExtension();
    const app = await buildApp();

    const postRes = await app.inject({
      method: "POST",
      url: `/roles/${roleId}/extensions`,
      headers: { "x-api-key": TEST_API_KEY, "content-type": "application/json" },
      payload: JSON.stringify({
        extension_name: extensionName,
        config_override: { transport: "native_messaging" },
      }),
    });
    const bindingId = (postRes.json() as { id: string }).id;

    const patchRes = await app.inject({
      method: "PATCH",
      url: `/roles/${roleId}/extensions/${bindingId}`,
      headers: { "x-api-key": TEST_API_KEY, "content-type": "application/json" },
      payload: JSON.stringify({ config_override: null }),
    });
    expect(patchRes.statusCode).toBe(200);
    const json = patchRes.json() as { configOverride: null; effectiveConfig: Record<string, unknown> };
    expect(json.configOverride).toBeNull();
    // effectiveConfig should now be back to defaults
    expect(json.effectiveConfig).toEqual({ transport: "localhost", port: 9999 });
    await app.close();
  });

  it("PATCH /roles/:rid/extensions/:eid with enabled=false persists toggle", async () => {
    const { roleId, extensionName } = seedRoleAndExtension();
    const app = await buildApp();

    const postRes = await app.inject({
      method: "POST",
      url: `/roles/${roleId}/extensions`,
      headers: { "x-api-key": TEST_API_KEY, "content-type": "application/json" },
      payload: JSON.stringify({ extension_name: extensionName }),
    });
    const bindingId = (postRes.json() as { id: string }).id;

    const patchRes = await app.inject({
      method: "PATCH",
      url: `/roles/${roleId}/extensions/${bindingId}`,
      headers: { "x-api-key": TEST_API_KEY, "content-type": "application/json" },
      payload: JSON.stringify({ enabled: false }),
    });
    expect(patchRes.statusCode).toBe(200);
    const json = patchRes.json() as { enabled: boolean; configOverride: null };
    expect(json.enabled).toBe(false);
    expect(json.configOverride).toBeNull(); // unaffected
    await app.close();
  });
});
