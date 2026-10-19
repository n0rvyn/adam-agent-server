import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import fastify from "fastify";
import multipart from "@fastify/multipart";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";
import { TEST_API_KEY } from "../helpers/test-auth.js";
import { extensionRoutes } from "../../server/routes/extensions.js";

// Build a minimal valid .mcpb buffer in-memory so tests don't depend on a
// gitignored 3MB production artifact (extensions/ChromeControl/browser-control-mcpb.mcpb).
// Matches the manifest schema in src/extensions/mcpb-parser.ts.
async function buildValidMcpb(
  overrides: { name?: string; version?: string } = {},
): Promise<Buffer> {
  const AdmZip = (await import("adm-zip")).default;
  const zip = new AdmZip();
  const manifest = {
    manifest_version: "0.3",
    name: overrides.name ?? "test-ext",
    version: overrides.version ?? "1.0.0",
    description: "Synthetic fixture for extensions-routes tests",
    author: { name: "Test Suite" },
    server: { type: "node", mcp_config: { command: "node" } },
  };
  zip.addFile("manifest.json", Buffer.from(JSON.stringify(manifest)));
  return zip.toBuffer();
}

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
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });
  await app.register(extensionRoutes);
  await app.ready();
  return app;
}

/**
 * Build a multipart form body with a single file field named "file".
 * Returns { body: Buffer, contentType: string }.
 */
function buildMultipartBody(
  fileName: string,
  fileBuffer: Buffer,
  mimeType = "application/octet-stream",
): { body: Buffer; contentType: string } {
  const boundary = "----TestBoundary1234567890";
  const CRLF = "\r\n";
  const header =
    `--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="file"; filename="${fileName}"${CRLF}` +
    `Content-Type: ${mimeType}${CRLF}` +
    CRLF;
  const footer = `${CRLF}--${boundary}--${CRLF}`;
  const body = Buffer.concat([
    Buffer.from(header),
    fileBuffer,
    Buffer.from(footer),
  ]);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

describe("extensions REST routes", () => {
  it("POST /extensions with valid .mcpb returns 201 + entity", async () => {
    const app = await buildApp();
    const mcpbBuffer = await buildValidMcpb();
    const { body, contentType } = buildMultipartBody("browser-control-mcpb.mcpb", mcpbBuffer);

    const res = await app.inject({
      method: "POST",
      url: "/extensions",
      headers: { "x-api-key": TEST_API_KEY, "content-type": contentType },
      payload: body,
    });
    expect(res.statusCode).toBe(201);
    const json = res.json() as { extension: { name: string; version: string; id: string } };
    expect(json.extension).toBeDefined();
    expect(json.extension.name).toBeTruthy();
    expect(json.extension.id).toBeTruthy();
    await app.close();
  });

  it("POST /extensions with same name twice triggers D-009 upgrade-in-place (same id)", async () => {
    const app = await buildApp();
    const mcpbBuffer = await buildValidMcpb();
    const { body, contentType } = buildMultipartBody("browser-control-mcpb.mcpb", mcpbBuffer);

    const res1 = await app.inject({
      method: "POST",
      url: "/extensions",
      headers: { "x-api-key": TEST_API_KEY, "content-type": contentType },
      payload: body,
    });
    expect(res1.statusCode).toBe(201);
    const id1 = (res1.json() as { extension: { id: string } }).extension.id;

    const res2 = await app.inject({
      method: "POST",
      url: "/extensions",
      headers: { "x-api-key": TEST_API_KEY, "content-type": contentType },
      payload: body,
    });
    expect(res2.statusCode).toBe(201);
    const id2 = (res2.json() as { extension: { id: string } }).extension.id;

    expect(id1).toBe(id2);
    await app.close();
  });

  it("POST /extensions with manifest.server.type='process' returns 400 with structured error code", async () => {
    const app = await buildApp();
    // Build a synthetic .mcpb with invalid server type
    const AdmZip = (await import("adm-zip")).default;
    const zip = new AdmZip();
    const manifest = JSON.stringify({
      manifest_version: "0.3",
      name: "bad-ext",
      version: "1.0.0",
      description: "bad",
      author: { name: "Test" },
      server: { type: "process", mcp_config: { command: "node" } },
    });
    zip.addFile("manifest.json", Buffer.from(manifest));
    const mcpbBuffer = zip.toBuffer();
    const { body, contentType } = buildMultipartBody("bad-ext.mcpb", mcpbBuffer);

    const res = await app.inject({
      method: "POST",
      url: "/extensions",
      headers: { "x-api-key": TEST_API_KEY, "content-type": contentType },
      payload: body,
    });
    expect(res.statusCode).toBe(400);
    const json = res.json() as { code: string };
    expect(json.code).toBe("INVALID_MANIFEST");
    await app.close();
  });

  it("POST /extensions with zip-slip entry returns 400 (parser rejects)", async () => {
    const app = await buildApp();
    const AdmZip = (await import("adm-zip")).default;
    const zip = new AdmZip();
    const manifest = JSON.stringify({
      manifest_version: "0.3",
      name: "slip-ext",
      version: "1.0.0",
      description: "test",
      author: { name: "Attacker" },
      server: { type: "node", mcp_config: { command: "node" } },
    });
    zip.addFile("manifest.json", Buffer.from(manifest));
    // adm-zip normalizes addFile paths; override entryName directly to simulate
    // a maliciously-crafted zip with a path-traversal entry
    zip.addFile("safe.txt", Buffer.from("harmless"));
    const entries = zip.getEntries();
    const safeEntry = entries.find((e) => e.entryName === "safe.txt");
    if (safeEntry) {
      (safeEntry as unknown as { entryName: string }).entryName = "../../etc/passwd";
    }
    const mcpbBuffer = zip.toBuffer();
    const { body, contentType } = buildMultipartBody("slip.mcpb", mcpbBuffer);

    const res = await app.inject({
      method: "POST",
      url: "/extensions",
      headers: { "x-api-key": TEST_API_KEY, "content-type": contentType },
      payload: body,
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("POST /extensions with no file part returns 400", async () => {
    const app = await buildApp();
    // Send JSON body instead of multipart
    const res = await app.inject({
      method: "POST",
      url: "/extensions",
      headers: { "x-api-key": TEST_API_KEY, "content-type": "application/json" },
      payload: JSON.stringify({ name: "test" }),
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("POST /extensions with file > 10 MB returns 413", async () => {
    const app = await buildApp();
    // Build a >10MB buffer
    const bigBuffer = Buffer.alloc(11 * 1024 * 1024, 0xaa);
    const { body, contentType } = buildMultipartBody("big.mcpb", bigBuffer);

    const res = await app.inject({
      method: "POST",
      url: "/extensions",
      headers: { "x-api-key": TEST_API_KEY, "content-type": contentType },
      payload: body,
    });
    expect(res.statusCode).toBe(413);
    await app.close();
  });

  it("GET /extensions returns list sorted by created_at DESC", async () => {
    const app = await buildApp();
    const mcpbBuffer = await buildValidMcpb();
    const { body, contentType } = buildMultipartBody("browser-control-mcpb.mcpb", mcpbBuffer);
    await app.inject({
      method: "POST",
      url: "/extensions",
      headers: { "x-api-key": TEST_API_KEY, "content-type": contentType },
      payload: body,
    });

    const res = await app.inject({
      method: "GET",
      url: "/extensions",
      headers: { "x-api-key": TEST_API_KEY },
    });
    expect(res.statusCode).toBe(200);
    const json = res.json() as { extensions: Array<Record<string, unknown>> };
    expect(Array.isArray(json.extensions)).toBe(true);
    expect(json.extensions.length).toBeGreaterThanOrEqual(1);
    // Phase 3: each extension carries a `health` field (null when never run)
    expect(json.extensions[0]).toHaveProperty("health");
    expect(json.extensions[0].health).toBeNull();
    await app.close();
  });

  it("GET /extensions/:name returns single entity with manifest", async () => {
    const app = await buildApp();
    const mcpbBuffer = await buildValidMcpb();
    const { body, contentType } = buildMultipartBody("browser-control-mcpb.mcpb", mcpbBuffer);
    const postRes = await app.inject({
      method: "POST",
      url: "/extensions",
      headers: { "x-api-key": TEST_API_KEY, "content-type": contentType },
      payload: body,
    });
    const extName = (postRes.json() as { extension: { name: string } }).extension.name;

    const res = await app.inject({
      method: "GET",
      url: `/extensions/${extName}`,
      headers: { "x-api-key": TEST_API_KEY },
    });
    expect(res.statusCode).toBe(200);
    const json = res.json() as { extension: Record<string, unknown> };
    expect(json.extension.manifestJson).toBeTruthy();
    // Phase 3: detail response carries `health` field (null when never run)
    expect(json.extension).toHaveProperty("health");
    expect(json.extension.health).toBeNull();
    await app.close();
  });

  it("GET /extensions/nonexistent returns 404", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/extensions/nonexistent-extension-name",
      headers: { "x-api-key": TEST_API_KEY },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("PATCH /extensions/:name with new default_config_json updates DB", async () => {
    const app = await buildApp();
    const mcpbBuffer = await buildValidMcpb();
    const { body, contentType } = buildMultipartBody("browser-control-mcpb.mcpb", mcpbBuffer);
    const postRes = await app.inject({
      method: "POST",
      url: "/extensions",
      headers: { "x-api-key": TEST_API_KEY, "content-type": contentType },
      payload: body,
    });
    const extName = (postRes.json() as { extension: { name: string } }).extension.name;

    const patchRes = await app.inject({
      method: "PATCH",
      url: `/extensions/${extName}`,
      headers: { "x-api-key": TEST_API_KEY, "content-type": "application/json" },
      payload: JSON.stringify({ defaultConfigJson: { api_key: "test-123" } }),
    });
    expect(patchRes.statusCode).toBe(200);
    const updated = (patchRes.json() as { extension: { defaultConfigJson: string } }).extension;
    const cfg = JSON.parse(updated.defaultConfigJson);
    expect(cfg.api_key).toBe("test-123");
    await app.close();
  });

  it("PATCH /extensions/:name CANNOT mutate manifest_json or name", async () => {
    const app = await buildApp();
    const mcpbBuffer = await buildValidMcpb();
    const { body, contentType } = buildMultipartBody("browser-control-mcpb.mcpb", mcpbBuffer);
    const postRes = await app.inject({
      method: "POST",
      url: "/extensions",
      headers: { "x-api-key": TEST_API_KEY, "content-type": contentType },
      payload: body,
    });
    const { name: extName, manifestJson: originalManifest } = (postRes.json() as { extension: { name: string; manifestJson: string } }).extension;

    // Attempt to mutate manifest_json — should be ignored or rejected
    const patchRes = await app.inject({
      method: "PATCH",
      url: `/extensions/${extName}`,
      headers: { "x-api-key": TEST_API_KEY, "content-type": "application/json" },
      payload: JSON.stringify({
        defaultConfigJson: { k: "v" },
        manifestJson: '{"hacked":true}',
        name: "hacked-name",
      }),
    });
    // Either 200 (ignored) or 400 (rejected) — manifest_json must not change
    const getRes = await app.inject({
      method: "GET",
      url: `/extensions/${extName}`,
      headers: { "x-api-key": TEST_API_KEY },
    });
    expect(getRes.statusCode).toBe(200);
    const fetched = (getRes.json() as { extension: { manifestJson: string } }).extension;
    expect(fetched.manifestJson).toBe(originalManifest);
    await app.close();
  });

  it("DELETE /extensions/:name removes row (and cascades to role_extensions when seeded)", async () => {
    const app = await buildApp();
    const mcpbBuffer = await buildValidMcpb();
    const { body, contentType } = buildMultipartBody("browser-control-mcpb.mcpb", mcpbBuffer);
    const postRes = await app.inject({
      method: "POST",
      url: "/extensions",
      headers: { "x-api-key": TEST_API_KEY, "content-type": contentType },
      payload: body,
    });
    const { name: extName, id: extId } = (postRes.json() as { extension: { name: string; id: string } }).extension;

    // Seed a role_extensions binding to verify cascade
    const db = getTestDb();
    const now = Date.now();
    db.prepare(
      `INSERT INTO roles (id, name, memory_stream_id, created_at) VALUES ('role-1', 'TestRole', 'ms-1', ?)`,
    ).run(now);
    db.prepare(
      `INSERT INTO role_extensions (id, role_id, extension_id, generated_server_name, created_at, updated_at)
       VALUES ('re-1', 'role-1', ?, 'test-server', ?, ?)`,
    ).run(extId, now, now);

    const deleteRes = await app.inject({
      method: "DELETE",
      url: `/extensions/${extName}`,
      headers: { "x-api-key": TEST_API_KEY },
    });
    expect(deleteRes.statusCode).toBe(204);

    // Verify cascade
    const reRows = db.prepare("SELECT * FROM role_extensions WHERE extension_id = ?").all(extId);
    expect(reRows.length).toBe(0);

    // Verify 404 after delete
    const getRes = await app.inject({
      method: "GET",
      url: `/extensions/${extName}`,
      headers: { "x-api-key": TEST_API_KEY },
    });
    expect(getRes.statusCode).toBe(404);
    await app.close();
  });
});
