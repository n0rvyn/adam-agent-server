import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import fastify from "fastify";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";
import { TEST_API_KEY } from "../helpers/test-auth.js";
import { extensionRoutes } from "../../server/routes/extensions.js";
import {
  scanLegacyMcpServers,
  _resetSnapshotForTests,
} from "../../extensions/legacy-mcp-servers-scanner.js";

const { cleanup } = setupTestDb();
vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

afterAll(() => cleanup());

beforeEach(() => {
  clearTestDb();
  _resetSnapshotForTests();
});

function seedRole(
  db: ReturnType<typeof getTestDb>,
  id: string,
  name: string,
  mcpServers: string,
) {
  db.prepare(
    `INSERT INTO roles (id, name, cag_prompt, status, execution_mode, model, mcp_servers, memory_stream_id, created_at)
     VALUES (?, ?, '', 'active', 'auto', 'claude-3-5-sonnet-20241022', ?, ?, ?)`,
  ).run(id, name, mcpServers, `mem-${id}`, Date.now());
}

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
  await app.register(extensionRoutes);
  await app.ready();
  return app;
}

describe("GET /extensions/legacy", () => {
  it("returns empty snapshot when no legacy roles", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/extensions/legacy",
      headers: { "x-api-key": TEST_API_KEY },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { count: number; rows: unknown[] };
    expect(body.count).toBe(0);
    expect(body.rows).toHaveLength(0);
    await app.close();
  });

  it("returns cached legacy rows after scan", async () => {
    const db = getTestDb();
    seedRole(db, "role-1", "RoleA", JSON.stringify({ foo: { command: "node" } }));
    scanLegacyMcpServers(db);

    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/extensions/legacy",
      headers: { "x-api-key": TEST_API_KEY },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { count: number; rows: Array<{ roleId: string }> };
    expect(body.count).toBe(1);
    expect(body.rows[0].roleId).toBe("role-1");
    await app.close();
  });
});

describe("POST /extensions/legacy/clear/:roleId", () => {
  it("zeros mcp_servers and refreshes cache", async () => {
    const db = getTestDb();
    seedRole(db, "role-x", "RoleX", '{"x":{}}');
    scanLegacyMcpServers(db);

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/extensions/legacy/clear/role-x",
      headers: { "x-api-key": TEST_API_KEY },
    });
    expect(res.statusCode).toBe(204);

    // DB value should be '{}'
    const row = db.prepare("SELECT mcp_servers FROM roles WHERE id = ?").get("role-x") as
      | { mcp_servers: string }
      | undefined;
    expect(row?.mcp_servers).toBe("{}");

    // Cache should be refreshed to count=0
    const listRes = await app.inject({
      method: "GET",
      url: "/extensions/legacy",
      headers: { "x-api-key": TEST_API_KEY },
    });
    const body = JSON.parse(listRes.body) as { count: number };
    expect(body.count).toBe(0);

    await app.close();
  });

  it("returns 404 for non-existent roleId", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/extensions/legacy/clear/nonexistent-role",
      headers: { "x-api-key": TEST_API_KEY },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("does NOT drop the mcp_servers column", async () => {
    const db = getTestDb();
    seedRole(db, "role-z", "RoleZ", '{"z":{}}');
    scanLegacyMcpServers(db);

    const app = await buildApp();
    await app.inject({
      method: "POST",
      url: "/extensions/legacy/clear/role-z",
      headers: { "x-api-key": TEST_API_KEY },
    });

    // Column still present
    const tableInfo = db.prepare("PRAGMA table_info(roles)").all() as Array<{ name: string }>;
    const colNames = tableInfo.map((c) => c.name);
    expect(colNames).toContain("mcp_servers");

    await app.close();
  });
});
