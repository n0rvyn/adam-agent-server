import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod/v4";

const restoreParamsSchema = z.object({
  type: z.enum(["role", "template"]),
  presetId: z.string(),
});

export async function presetsRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /presets — list all Role and Template presets with install status
  fastify.get("/presets", {
    schema: {
      tags: ["Presets"],
      summary: "List all presets",
      description:
        "Returns all canonical Role and Template presets from the registry, with per-preset installed status.",
    },
  }, async () => {
    const { getPresetRoles, getPresetTemplates } = await import("../../presets/index.js");
    const { getRoleByName } = await import("../../store/roles.js");
    const { listTaskTemplates } = await import("../../store/task-templates.js");

    const roles = getPresetRoles();
    const templates = getPresetTemplates();

    // Build installed map: check if each preset has a DB row
    const installed: Record<string, boolean> = {};
    for (const role of roles) {
      const row = getRoleByName(role.name);
      installed[`role:${role.presetId}`] = row !== undefined;
    }
    for (const tmpl of templates) {
      const rows = listTaskTemplates();
      installed[`template:${tmpl.presetId}`] = rows.some((t: { presetId?: string }) => t.presetId === tmpl.presetId);
    }

    return { roles, templates, installed };
  });

  // GET /presets/:type/:presetId — get a specific preset
  fastify.get(
    "/presets/:type/:presetId",
    {
      schema: {
        tags: ["Presets"],
        summary: "Get a preset by type and ID",
        params: {
          type: "object",
          required: ["type", "presetId"],
          properties: {
            type: { type: "string", enum: ["role", "template"] },
            presetId: { type: "string" },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{
        Params: { type: "role" | "template"; presetId: string };
      }>,
      reply: FastifyReply,
    ) => {
      const { getPresetRole, getPresetTemplate } = await import("../../presets/index.js");
      const { type, presetId } = request.params;
      if (type === "role") {
        const preset = getPresetRole(presetId);
        if (!preset) {
          return reply.status(404).send({ code: "NOT_FOUND", message: "Preset not found" });
        }
        return { preset };
      } else {
        const preset = getPresetTemplate(presetId);
        if (!preset) {
          return reply.status(404).send({ code: "NOT_FOUND", message: "Preset not found" });
        }
        return { preset };
      }
    },
  );

  // POST /presets/:type/:presetId/restore — restore a preset to canonical values
  fastify.post(
    "/presets/:type/:presetId/restore",
    {
      schema: {
        tags: ["Presets"],
        summary: "Restore a preset to its canonical definition",
        params: {
          type: "object",
          required: ["type", "presetId"],
          properties: {
            type: { type: "string", enum: ["role", "template"] },
            presetId: { type: "string" },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{
        Params: { type: "role" | "template"; presetId: string };
      }>,
      reply: FastifyReply,
    ) => {
      const parseResult = restoreParamsSchema.safeParse(request.params);
      if (!parseResult.success) {
        return reply.status(400).send({
          code: "VALIDATION_ERROR",
          message: z.prettifyError(parseResult.error),
        });
      }
      const { restorePreset } = await import("../../presets/index.js");
      const result = restorePreset(parseResult.data.type, parseResult.data.presetId);
      if (!result.ok) {
        return reply.status(400).send({ code: "RESTORE_FAILED", message: result.reason });
      }
      return { ok: true };
    },
  );
}
