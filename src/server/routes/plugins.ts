import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod/v4";
import * as pluginCli from "../../lib/plugin-cli.js";
import {
  listInstalledPlugins,
  getInstalledPlugin,
  getPluginManifest,
  listMarketplaceSources,
  getGlobalEnabledState,
} from "../../store/plugin-registry.js";
import { getPluginUsageStats, getPluginUsageByRole } from "../../store/task-plugins.js";

const paramsSchema = z.object({ id: z.string().min(1) });
const installBodySchema = z.object({
  scope: z.enum(["user", "project"]).optional(),
  cwd: z.string().optional(),
});
const uninstallBodySchema = z.object({
  scope: z.enum(["user", "project"]).optional(),
  cwd: z.string().optional(),
});

export async function pluginRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /plugins — all installed plugins with scope + globalEnabled state
  fastify.get("/plugins", {
    schema: {
      tags: ["Plugins"],
      summary: "List all installed plugins",
      querystring: {
        type: "object",
        properties: {
          scope: { type: "string", enum: ["user", "project", "local"] },
        },
      },
    },
  }, async (request: FastifyRequest) => {
    const query = request.query as { scope?: string };
    const allPlugins = listInstalledPlugins({ scope: query.scope as "user" | "project" | "local" | undefined });
    const globalEnabled = getGlobalEnabledState();
    return {
      plugins: allPlugins.map((p) => ({
        ...p,
        globalEnabled: globalEnabled[p.id] ?? p.enabled,
      })),
    };
  });

  // GET /plugins/:id — single plugin with manifest
  fastify.get("/plugins/:id", {
    schema: {
      tags: ["Plugins"],
      summary: "Get plugin by ID",
      params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    },
  }, async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const parseResult = paramsSchema.safeParse(request.params);
    if (!parseResult.success) return reply.status(400).send({ code: "VALIDATION_ERROR", message: z.prettifyError(parseResult.error) });

    const plugin = getInstalledPlugin(parseResult.data.id);
    if (!plugin) return reply.status(404).send({ code: "NOT_FOUND", message: "Plugin not found" });

    const manifest = getPluginManifest(plugin.installPath);
    const globalEnabled = getGlobalEnabledState();
    return {
      plugin: {
        ...plugin,
        globalEnabled: globalEnabled[plugin.id] ?? plugin.enabled,
        manifest,
      },
    };
  });

  // POST /plugins/:id/enable — enable plugin globally via CLI
  fastify.post("/plugins/:id/enable", {
    schema: {
      tags: ["Plugins"],
      summary: "Enable a plugin globally",
      params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    },
  }, async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const parseResult = paramsSchema.safeParse(request.params);
    if (!parseResult.success) return reply.status(400).send({ code: "VALIDATION_ERROR", message: z.prettifyError(parseResult.error) });

    if (!pluginCli.isCliAvailable()) {
      return reply.status(503).send({ code: "CLI_NOT_AVAILABLE", message: "Claude CLI not found. Plugin enable/disable requires the Claude Agent SDK CLI." });
    }
    try {
      pluginCli.enablePlugin(parseResult.data.id);
      return { pluginId: parseResult.data.id, enabled: true };
    } catch (err) {
      return reply.status(500).send({ code: "CLI_ERROR", message: err instanceof Error ? err.message : "Enable failed" });
    }
  });

  // POST /plugins/:id/disable — disable plugin globally via CLI
  fastify.post("/plugins/:id/disable", {
    schema: {
      tags: ["Plugins"],
      summary: "Disable a plugin globally",
      params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    },
  }, async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const parseResult = paramsSchema.safeParse(request.params);
    if (!parseResult.success) return reply.status(400).send({ code: "VALIDATION_ERROR", message: z.prettifyError(parseResult.error) });

    if (!pluginCli.isCliAvailable()) {
      return reply.status(503).send({ code: "CLI_NOT_AVAILABLE", message: "Claude CLI not found. Plugin enable/disable requires the Claude Agent SDK CLI." });
    }
    try {
      pluginCli.disablePlugin(parseResult.data.id);
      return { pluginId: parseResult.data.id, enabled: false };
    } catch (err) {
      return reply.status(500).send({ code: "CLI_ERROR", message: err instanceof Error ? err.message : "Disable failed" });
    }
  });

  // === Stats Routes ===

  // GET /plugins/stats — aggregated plugin usage statistics
  fastify.get("/plugins/stats", {
    schema: {
      tags: ["Plugins"],
      summary: "Get plugin usage statistics",
      querystring: {
        type: "object",
        properties: { limit: { type: "integer", minimum: 1, maximum: 200, default: 50 } },
      },
    },
  }, async (request: FastifyRequest) => {
    const query = request.query as { limit?: number };
    return { stats: getPluginUsageStats(query.limit ?? 50) };
  });

  // GET /plugins/stats/role/:roleId — plugin usage for specific role
  const roleIdSchema = z.object({ roleId: z.string().min(1) });

  fastify.get("/plugins/stats/role/:roleId", {
    schema: {
      tags: ["Plugins"],
      summary: "Get plugin usage by role",
      params: { type: "object", required: ["roleId"], properties: { roleId: { type: "string" } } },
    },
  }, async (request: FastifyRequest<{ Params: { roleId: string } }>, reply: FastifyReply) => {
    const parsed = roleIdSchema.safeParse(request.params);
    if (!parsed.success) return reply.status(400).send({ code: "VALIDATION_ERROR", message: z.prettifyError(parsed.error) });
    return { roleId: parsed.data.roleId, stats: getPluginUsageByRole(parsed.data.roleId) };
  });

  // === Marketplace Routes ===

  // GET /plugins/marketplace — list available plugins from CLI
  fastify.get("/plugins/marketplace", {
    schema: { tags: ["Marketplace"], summary: "List available marketplace plugins" },
  }, async (_request: FastifyRequest, reply: FastifyReply) => {
    if (!pluginCli.isCliAvailable()) {
      return reply.status(503).send({ code: "CLI_NOT_AVAILABLE", message: "Claude Code CLI not found. Install Claude Code to use marketplace features." });
    }
    try {
      const data = pluginCli.listAvailablePlugins();
      return { available: data.available, installed: data.installed };
    } catch (err) {
      return reply.status(500).send({ code: "CLI_ERROR", message: err instanceof Error ? err.message : "CLI command failed" });
    }
  });

  // GET /plugins/marketplaces — list marketplace sources from known_marketplaces.json
  fastify.get("/plugins/marketplaces", {
    schema: { tags: ["Marketplace"], summary: "List known marketplace sources" },
  }, async () => {
    return { sources: listMarketplaceSources() };
  });

  // POST /plugins/marketplaces — add a marketplace source via CLI
  const addMarketplaceBodySchema = z.object({ url: z.string().min(1) });
  fastify.post("/plugins/marketplaces", {
    schema: {
      tags: ["Marketplace"],
      summary: "Add a marketplace source",
      body: {
        type: "object",
        required: ["url"],
        properties: { url: { type: "string", minLength: 1 } },
      },
    },
  }, async (request: FastifyRequest<{ Body: { url: string } }>, reply: FastifyReply) => {
    const parsed = addMarketplaceBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send({ code: "VALIDATION_ERROR", message: z.prettifyError(parsed.error) });

    if (!pluginCli.isCliAvailable()) {
      return reply.status(503).send({ code: "CLI_NOT_AVAILABLE", message: "Claude Code CLI not found" });
    }
    try {
      pluginCli.addMarketplace(parsed.data.url);
      return { success: true, url: parsed.data.url };
    } catch (err) {
      return reply.status(500).send({ code: "CLI_ERROR", message: err instanceof Error ? err.message : "Add marketplace failed" });
    }
  });

  // DELETE /plugins/marketplaces/:name — remove a marketplace source via CLI
  fastify.delete("/plugins/marketplaces/:name", {
    schema: {
      tags: ["Marketplace"],
      summary: "Remove a marketplace source",
      params: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
    },
  }, async (request: FastifyRequest<{ Params: { name: string } }>, reply: FastifyReply) => {
    const nameSchema = z.object({ name: z.string().min(1) });
    const parsed = nameSchema.safeParse(request.params);
    if (!parsed.success) return reply.status(400).send({ code: "VALIDATION_ERROR", message: z.prettifyError(parsed.error) });

    if (!pluginCli.isCliAvailable()) {
      return reply.status(503).send({ code: "CLI_NOT_AVAILABLE", message: "Claude Code CLI not found" });
    }
    try {
      pluginCli.removeMarketplace(parsed.data.name);
      return { success: true, name: parsed.data.name };
    } catch (err) {
      return reply.status(500).send({ code: "CLI_ERROR", message: err instanceof Error ? err.message : "Remove marketplace failed" });
    }
  });

  // POST /plugins/install/:name — install plugin via CLI
  fastify.post("/plugins/install/:name", {
    schema: {
      tags: ["Marketplace"],
      summary: "Install a plugin",
      params: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
      body: {
        type: "object",
        properties: {
          scope: { type: "string", enum: ["user", "project"] },
          cwd: { type: "string" },
        },
      },
    },
  }, async (request: FastifyRequest<{ Params: { name: string }; Body: { scope?: string; cwd?: string } }>, reply: FastifyReply) => {
    const nameSchema = z.object({ name: z.string().min(1) });
    const parsed = nameSchema.safeParse(request.params);
    if (!parsed.success) return reply.status(400).send({ code: "VALIDATION_ERROR", message: z.prettifyError(parsed.error) });

    const bodyParse = installBodySchema.safeParse(request.body ?? {});
    if (!bodyParse.success) return reply.status(400).send({ code: "VALIDATION_ERROR", message: z.prettifyError(bodyParse.error) });

    if (!pluginCli.isCliAvailable()) {
      return reply.status(503).send({ code: "CLI_NOT_AVAILABLE", message: "Claude Code CLI not found" });
    }
    try {
      pluginCli.installPlugin(parsed.data.name, bodyParse.data.scope ?? "user", bodyParse.data.cwd);
      return { success: true, pluginId: parsed.data.name };
    } catch (err) {
      return reply.status(500).send({ code: "CLI_ERROR", message: err instanceof Error ? err.message : "Install failed" });
    }
  });

  // POST /plugins/uninstall/:name — uninstall plugin via CLI
  fastify.post("/plugins/uninstall/:name", {
    schema: {
      tags: ["Marketplace"],
      summary: "Uninstall a plugin",
      params: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
      body: {
        type: "object",
        properties: {
          scope: { type: "string", enum: ["user", "project"] },
          cwd: { type: "string" },
        },
      },
    },
  }, async (request: FastifyRequest<{ Params: { name: string }; Body: { scope?: string; cwd?: string } }>, reply: FastifyReply) => {
    const nameSchema = z.object({ name: z.string().min(1) });
    const parsed = nameSchema.safeParse(request.params);
    if (!parsed.success) return reply.status(400).send({ code: "VALIDATION_ERROR", message: z.prettifyError(parsed.error) });

    const bodyParse = uninstallBodySchema.safeParse(request.body ?? {});
    if (!bodyParse.success) return reply.status(400).send({ code: "VALIDATION_ERROR", message: z.prettifyError(bodyParse.error) });

    if (!pluginCli.isCliAvailable()) {
      return reply.status(503).send({ code: "CLI_NOT_AVAILABLE", message: "Claude Code CLI not found" });
    }
    try {
      pluginCli.uninstallPlugin(parsed.data.name, bodyParse.data.scope, bodyParse.data.cwd);
      return { success: true, pluginId: parsed.data.name };
    } catch (err) {
      return reply.status(500).send({ code: "CLI_ERROR", message: err instanceof Error ? err.message : "Uninstall failed" });
    }
  });
}
