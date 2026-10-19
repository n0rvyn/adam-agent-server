import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../../helpers/test-db.js";

const { cleanup } = setupTestDb();
vi.mock("../../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

/* eslint-disable @typescript-eslint/no-explicit-any */
const mockListInstalledPlugins = vi.fn((_opts?: any): any[] => []);
const mockGetInstalledPlugin = vi.fn((_id?: any): any => null);
const mockGetPluginManifest = vi.fn((_path?: any): any => null);
const mockListMarketplaceSources = vi.fn((): any[] => []);
const mockGetGlobalEnabledState = vi.fn((): Record<string, boolean> => ({}));
/* eslint-enable @typescript-eslint/no-explicit-any */

vi.mock("../../../store/plugin-registry.js", () => ({
  listInstalledPlugins: vi.fn((...a: unknown[]) => mockListInstalledPlugins(a[0])),
  getInstalledPlugin: vi.fn((...a: unknown[]) => mockGetInstalledPlugin(a[0])),
  getPluginManifest: vi.fn((...a: unknown[]) => mockGetPluginManifest(a[0])),
  listMarketplaceSources: vi.fn(() => mockListMarketplaceSources()),
  getGlobalEnabledState: vi.fn(() => mockGetGlobalEnabledState()),
  scanDirectoryConfig: vi.fn(() => ({ enabledPlugins: {}, mcpServers: {}, allowedTools: [], disallowedTools: [] })),
  resolvePluginPaths: vi.fn(() => new Map()),
}));

// Mock plugin-cli functions
const mockIsCliAvailable = vi.fn(() => true);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockListAvailablePlugins = vi.fn((): any => ({ installed: [], available: [] }));
const mockInstallPlugin = vi.fn();
const mockUninstallPlugin = vi.fn();
const mockEnablePlugin = vi.fn();
const mockDisablePlugin = vi.fn();
const mockAddMarketplace = vi.fn();
const mockRemoveMarketplace = vi.fn();

vi.mock("../../../lib/plugin-cli.js", () => ({
  isCliAvailable: vi.fn(() => mockIsCliAvailable()),
  listAvailablePlugins: vi.fn(() => mockListAvailablePlugins()),
  installPlugin: vi.fn((...a: unknown[]) => mockInstallPlugin(...a)),
  uninstallPlugin: vi.fn((...a: unknown[]) => mockUninstallPlugin(...a)),
  enablePlugin: vi.fn((...a: unknown[]) => mockEnablePlugin(...a)),
  disablePlugin: vi.fn((...a: unknown[]) => mockDisablePlugin(...a)),
  addMarketplace: vi.fn((...a: unknown[]) => mockAddMarketplace(...a)),
  removeMarketplace: vi.fn((...a: unknown[]) => mockRemoveMarketplace(...a)),
  listMarketplaces: vi.fn(() => []),
}));

import Fastify from "fastify";
import { pluginRoutes } from "../../../server/routes/plugins.js";

afterAll(() => cleanup());
beforeEach(() => {
  clearTestDb();
  vi.clearAllMocks();
  mockListInstalledPlugins.mockReturnValue([]);
  mockGetInstalledPlugin.mockReturnValue(null);
  mockGetPluginManifest.mockReturnValue(null);
  mockListMarketplaceSources.mockReturnValue([]);
  mockGetGlobalEnabledState.mockReturnValue({});
  mockIsCliAvailable.mockReturnValue(true);
  mockListAvailablePlugins.mockReturnValue({ installed: [], available: [] });
});

async function buildApp() {
  const app = Fastify();
  await app.register(pluginRoutes);
  await app.ready();
  return app;
}

describe("server/routes/plugins", () => {
  describe("GET /plugins", () => {
    it("returns installed plugins with scope and globalEnabled", async () => {
      mockListInstalledPlugins.mockReturnValue([
        { id: "github@anthropic", version: "1.0.0", scope: "user", installPath: "/path/a", enabled: true, installedAt: "", lastUpdated: "", globalEnabled: true },
        { id: "my-plugin@marketplace", version: "0.5.0", scope: "project", projectPath: "/proj", installPath: "/path/b", enabled: false, installedAt: "", lastUpdated: "", globalEnabled: false },
      ]);
      mockGetGlobalEnabledState.mockReturnValue({ "github@anthropic": true });

      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/plugins" });
      expect(res.statusCode).toBe(200);
      expect(res.json().plugins).toHaveLength(2);
      expect(res.json().plugins[0].scope).toBe("user");
      expect(res.json().plugins[0].globalEnabled).toBe(true);
      await app.close();
    });

    it("filters by scope", async () => {
      // The route passes scope to listInstalledPlugins; mock returns only matching scope
      mockListInstalledPlugins.mockImplementation((opts?: { scope?: string }) => {
        const all = [
          { id: "p1", version: "1", scope: "user", installPath: "/a", enabled: true, installedAt: "", lastUpdated: "" },
          { id: "p2", version: "1", scope: "project", installPath: "/b", enabled: true, installedAt: "", lastUpdated: "" },
        ];
        if (opts?.scope) return all.filter((p) => p.scope === opts.scope);
        return all;
      });

      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/plugins?scope=user" });
      expect(res.statusCode).toBe(200);
      expect(res.json().plugins.every((p: { scope: string }) => p.scope === "user")).toBe(true);
      await app.close();
    });
  });

  describe("GET /plugins/:id", () => {
    it("returns plugin with manifest", async () => {
      mockGetInstalledPlugin.mockReturnValue({
        id: "github@anthropic",
        version: "1.0.0",
        scope: "user",
        installPath: "/path/plugin",
        enabled: true,
        installedAt: "",
        lastUpdated: "",
      });
      mockGetPluginManifest.mockReturnValue({
        name: "github",
        skills: [{ name: "GitHub Tools", description: "Interact with GitHub" }],
        agents: [],
        mcpServers: ["github"],
        hooks: [],
        lspServers: [],
      });
      mockGetGlobalEnabledState.mockReturnValue({ "github@anthropic": true });

      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/plugins/github%40anthropic" });
      expect(res.statusCode).toBe(200);
      expect(res.json().plugin.id).toBe("github@anthropic");
      expect(res.json().plugin.manifest).not.toBeNull();
      expect(res.json().plugin.manifest.skills).toHaveLength(1);
      await app.close();
    });

    it("returns 404 for non-existent plugin", async () => {
      mockGetInstalledPlugin.mockReturnValue(null);

      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/plugins/nonexistent" });
      expect(res.statusCode).toBe(404);
      await app.close();
    });
  });

  describe("POST /plugins/:id/enable", () => {
    it("enables plugin via CLI", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "POST", url: "/plugins/test-plugin/enable" });
      expect(res.statusCode).toBe(200);
      expect(res.json().enabled).toBe(true);
      expect(mockEnablePlugin).toHaveBeenCalledWith("test-plugin");
      await app.close();
    });

    it("returns 500 on CLI error", async () => {
      mockEnablePlugin.mockImplementation(() => { throw new Error("CLI error"); });

      const app = await buildApp();
      const res = await app.inject({ method: "POST", url: "/plugins/test-plugin/enable" });
      expect(res.statusCode).toBe(500);
      expect(res.json().code).toBe("CLI_ERROR");
      await app.close();
    });
  });

  describe("POST /plugins/:id/disable", () => {
    it("disables plugin via CLI", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "POST", url: "/plugins/test-plugin/disable" });
      expect(res.statusCode).toBe(200);
      expect(res.json().enabled).toBe(false);
      expect(mockDisablePlugin).toHaveBeenCalledWith("test-plugin");
      await app.close();
    });
  });

  describe("GET /plugins/marketplace", () => {
    it("returns available plugins from CLI", async () => {
      mockListAvailablePlugins.mockReturnValue({
        installed: [],
        available: [{ pluginId: "test@mkt", name: "test", description: "d", marketplaceName: "mkt", source: { source: "url", url: "x" }, installCount: 10 }],
      });

      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/plugins/marketplace" });
      expect(res.statusCode).toBe(200);
      expect(res.json().available).toHaveLength(1);
      await app.close();
    });

    it("returns 503 when CLI not available", async () => {
      mockIsCliAvailable.mockReturnValue(false);

      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/plugins/marketplace" });
      expect(res.statusCode).toBe(503);
      expect(res.json().code).toBe("CLI_NOT_AVAILABLE");
      await app.close();
    });
  });

  describe("GET /plugins/marketplaces", () => {
    it("returns marketplace sources from known_marketplaces.json", async () => {
      mockListMarketplaceSources.mockReturnValue([
        { name: "anthropic", source: "github", repo: "anthropic/claude-plugins", installLocation: "/path" },
      ]);

      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/plugins/marketplaces" });
      expect(res.statusCode).toBe(200);
      expect(res.json().sources).toHaveLength(1);
      expect(res.json().sources[0].name).toBe("anthropic");
      await app.close();
    });
  });

  describe("POST /plugins/marketplaces", () => {
    it("adds a marketplace source via CLI", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/plugins/marketplaces",
        payload: { url: "https://github.com/n0rvyn/personal-os.git" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
      expect(res.json().url).toBe("https://github.com/n0rvyn/personal-os.git");
      expect(mockAddMarketplace).toHaveBeenCalledWith("https://github.com/n0rvyn/personal-os.git");
      await app.close();
    });

    it("returns 400 when url is missing", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "POST", url: "/plugins/marketplaces", payload: {} });
      expect(res.statusCode).toBe(400);
      expect(mockAddMarketplace).not.toHaveBeenCalled();
      await app.close();
    });

    it("returns 400 when url is empty string", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "POST", url: "/plugins/marketplaces", payload: { url: "" } });
      expect(res.statusCode).toBe(400);
      expect(mockAddMarketplace).not.toHaveBeenCalled();
      await app.close();
    });

    it("returns 503 when CLI not available", async () => {
      mockIsCliAvailable.mockReturnValue(false);

      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/plugins/marketplaces",
        payload: { url: "https://github.com/org/repo.git" },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json().code).toBe("CLI_NOT_AVAILABLE");
      expect(mockAddMarketplace).not.toHaveBeenCalled();
      await app.close();
    });

    it("returns 500 on CLI error", async () => {
      mockAddMarketplace.mockImplementation(() => { throw new Error("repo unreachable"); });

      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/plugins/marketplaces",
        payload: { url: "https://github.com/bad/repo.git" },
      });
      expect(res.statusCode).toBe(500);
      expect(res.json().code).toBe("CLI_ERROR");
      expect(res.json().message).toContain("repo unreachable");
      await app.close();
    });
  });

  describe("DELETE /plugins/marketplaces/:name", () => {
    it("removes a marketplace source via CLI", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "DELETE", url: "/plugins/marketplaces/personal-os" });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
      expect(res.json().name).toBe("personal-os");
      expect(mockRemoveMarketplace).toHaveBeenCalledWith("personal-os");
      await app.close();
    });

    it("returns 503 when CLI not available", async () => {
      mockIsCliAvailable.mockReturnValue(false);

      const app = await buildApp();
      const res = await app.inject({ method: "DELETE", url: "/plugins/marketplaces/personal-os" });
      expect(res.statusCode).toBe(503);
      expect(res.json().code).toBe("CLI_NOT_AVAILABLE");
      expect(mockRemoveMarketplace).not.toHaveBeenCalled();
      await app.close();
    });

    it("returns 500 on CLI error", async () => {
      mockRemoveMarketplace.mockImplementation(() => { throw new Error("not found"); });

      const app = await buildApp();
      const res = await app.inject({ method: "DELETE", url: "/plugins/marketplaces/ghost" });
      expect(res.statusCode).toBe(500);
      expect(res.json().code).toBe("CLI_ERROR");
      expect(res.json().message).toContain("not found");
      await app.close();
    });
  });

  describe("POST /plugins/install/:name", () => {
    it("installs plugin with default user scope", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "POST", url: "/plugins/install/test-plugin%40mkt", payload: {} });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
      expect(mockInstallPlugin).toHaveBeenCalledWith("test-plugin@mkt", "user", undefined);
      await app.close();
    });

    it("installs plugin with project scope and cwd", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/plugins/install/test-plugin%40mkt",
        payload: { scope: "project", cwd: "/my/project" },
      });
      expect(res.statusCode).toBe(200);
      expect(mockInstallPlugin).toHaveBeenCalledWith("test-plugin@mkt", "project", "/my/project");
      await app.close();
    });

    it("returns 503 when CLI not available", async () => {
      mockIsCliAvailable.mockReturnValue(false);

      const app = await buildApp();
      const res = await app.inject({ method: "POST", url: "/plugins/install/test-plugin", payload: {} });
      expect(res.statusCode).toBe(503);
      await app.close();
    });
  });

  describe("POST /plugins/uninstall/:name", () => {
    it("uninstalls plugin via CLI", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "POST", url: "/plugins/uninstall/test-plugin%40mkt", payload: {} });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
      expect(mockUninstallPlugin).toHaveBeenCalledWith("test-plugin@mkt", undefined, undefined);
      await app.close();
    });

    it("passes scope and cwd to uninstall", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/plugins/uninstall/test-plugin%40mkt",
        payload: { scope: "project", cwd: "/my/project" },
      });
      expect(res.statusCode).toBe(200);
      expect(mockUninstallPlugin).toHaveBeenCalledWith("test-plugin@mkt", "project", "/my/project");
      await app.close();
    });
  });
});
