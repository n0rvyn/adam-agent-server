import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import fastify from "fastify";
import multipart from "@fastify/multipart";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";
import { TEST_API_KEY } from "../helpers/test-auth.js";
import { extensionRoutes } from "../../server/routes/extensions.js";

// Synthesize a valid .mcpb buffer in-memory so tests don't depend on the
// gitignored 3MB production artifact (extensions/ChromeControl/browser-control-mcpb.mcpb).
// Mirrors buildValidMcpb in extensions-routes.test.ts.
async function buildValidMcpb(): Promise<Buffer> {
  const AdmZip = (await import("adm-zip")).default;
  const zip = new AdmZip();
  const manifest = {
    manifest_version: "0.3",
    name: "test-ext",
    version: "1.0.0",
    description: "Synthetic fixture for sync-to-env tests",
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
  const body = Buffer.concat([Buffer.from(header), fileBuffer, Buffer.from(footer)]);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

async function uploadChromeControl(app: ReturnType<typeof fastify>) {
  const mcpbBuffer = await buildValidMcpb();
  const { body, contentType } = buildMultipartBody("browser-control-mcpb.mcpb", mcpbBuffer);
  const res = await app.inject({
    method: "POST",
    url: "/extensions",
    headers: { "x-api-key": TEST_API_KEY, "content-type": contentType },
    payload: body,
  });
  return res.json() as { extension: { name: string; id: string } };
}

describe("POST /extensions/:name/sync-to-env", () => {
  it("returns 200 + envPath after rewriting", async () => {
    const app = await buildApp();
    const { extension } = await uploadChromeControl(app);

    const res = await app.inject({
      method: "POST",
      url: `/extensions/${extension.name}/sync-to-env`,
      headers: { "x-api-key": TEST_API_KEY },
    });
    expect(res.statusCode).toBe(200);
    const json = res.json() as { envPath: string };
    expect(json.envPath).toContain(extension.name);
    expect(json.envPath).toContain(".env");
    await app.close();
  });

  it("returns 404 for nonexistent extension", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/extensions/nonexistent-extension/sync-to-env",
      headers: { "x-api-key": TEST_API_KEY },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
