import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../../helpers/test-db.js";

const { cleanup } = setupTestDb();
vi.mock("../../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

// Mock plugin-registry (replaces global-plugins.js)
vi.mock("../../../store/plugin-registry.js", () => ({
  listInstalledPlugins: vi.fn(() => []),
  getGlobalEnabledState: vi.fn(() => ({})),
}));

// Mock plugin-cli
vi.mock("../../../lib/plugin-cli.js", () => ({
  isCliAvailable: vi.fn(() => true),
  listAvailablePlugins: vi.fn(() => ({ installed: [], available: [] })),
  installPlugin: vi.fn(() => ""),
  uninstallPlugin: vi.fn(() => ""),
  enablePlugin: vi.fn(() => ""),
  disablePlugin: vi.fn(() => ""),
  listMarketplaces: vi.fn(() => []),
  addMarketplace: vi.fn(() => ""),
  removeMarketplace: vi.fn(() => ""),
}));

import Fastify from "fastify";
import { pluginRoutes } from "../../../server/routes/plugins.js";
import { recordTaskPlugins } from "../../../store/task-plugins.js";

afterAll(() => cleanup());
beforeEach(() => clearTestDb());

function seedTask(id: string): void {
  const db = getTestDb();
  db.prepare("INSERT INTO tasks (id, status, prompt, config, created_at) VALUES (?, ?, ?, ?, ?)").run(
    id, "completed", "test", "{}", Date.now(),
  );
}

function seedRole(id: string): void {
  const db = getTestDb();
  db.prepare(
    "INSERT INTO roles (id, name, cag_prompt, memory_stream_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, `Role ${id}`, "", `stream-${id}`, "active", Date.now());
}

async function buildApp() {
  const app = Fastify();
  await app.register(pluginRoutes);
  await app.ready();
  return app;
}

describe("GET /plugins/stats", () => {
  it("returns empty stats when no data", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/plugins/stats" });
    expect(res.statusCode).toBe(200);
    expect(res.json().stats).toEqual([]);
    await app.close();
  });

  it("returns aggregated usage stats", async () => {
    seedTask("t1");
    seedTask("t2");
    recordTaskPlugins("t1", ["/plugin-a"]);
    recordTaskPlugins("t2", ["/plugin-a", "/plugin-b"]);

    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/plugins/stats" });
    expect(res.statusCode).toBe(200);
    const stats = res.json().stats;
    expect(stats).toHaveLength(2);
    expect(stats[0].usageCount).toBe(2); // plugin-a used twice
    await app.close();
  });

  it("respects limit parameter", async () => {
    seedTask("t1");
    recordTaskPlugins("t1", ["/a", "/b", "/c"]);

    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/plugins/stats?limit=2" });
    expect(res.json().stats).toHaveLength(2);
    await app.close();
  });
});

describe("GET /plugins/stats/role/:roleId", () => {
  it("returns usage for specific role", async () => {
    seedRole("role-1");
    seedTask("t1");
    recordTaskPlugins("t1", ["/plugin-a"], "role-1");

    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/plugins/stats/role/role-1" });
    expect(res.statusCode).toBe(200);
    expect(res.json().roleId).toBe("role-1");
    expect(res.json().stats).toHaveLength(1);
    await app.close();
  });

  it("returns empty for role with no usage", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/plugins/stats/role/no-usage" });
    expect(res.statusCode).toBe(200);
    expect(res.json().stats).toEqual([]);
    await app.close();
  });
});
