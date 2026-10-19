import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod/v4";
import { getDb } from "../../store/db.js";
import {
  createBinding,
  listBindingsByRole,
  getBinding,
  bindingExists,
  updateBinding,
  deleteBinding,
  type RoleExtension,
  type UpdateBindingPayload,
} from "../../store/role-extensions.js";
import {
  getExtensionByName,
  getExtensionById,
  computeEffectiveConfig,
  type Extension,
} from "../../store/extensions.js";
import { getRole } from "../../store/roles.js";
import { getHealth, type ExtensionHealth } from "../../store/extension-health.js";

// ── Zod schemas ──────────────────────────────────────────────────────────────

const paramsSchema = z.object({
  rid: z.string().min(1),
});

const bindingParamsSchema = z.object({
  rid: z.string().min(1),
  eid: z.string().min(1),
});

const postBodySchema = z.object({
  extension_name: z.string().min(1),
  config_override: z.record(z.string(), z.unknown()).optional(),
});

const patchBodySchema = z.object({
  config_override: z.record(z.string(), z.unknown()).nullable().optional(),
  enabled: z.boolean().optional(),
});

// ── Binding → response shape ─────────────────────────────────────────────────

function bindingToResponse(binding: RoleExtension, extension: Extension, health: ExtensionHealth | null = null) {
  const configOverride = binding.configOverrideJson
    ? (JSON.parse(binding.configOverrideJson) as Record<string, unknown>)
    : null;
  const effectiveConfig = computeEffectiveConfig(extension, binding);
  return {
    id: binding.id,
    extensionId: binding.extensionId,
    extensionName: extension.name,
    version: extension.version,
    toolsCount: (() => {
      try {
        const manifest = JSON.parse(extension.manifestJson) as { tools?: unknown[] };
        return Array.isArray(manifest.tools) ? manifest.tools.length : 0;
      } catch {
        return 0;
      }
    })(),
    enabled: binding.enabled,
    configOverride,
    effectiveConfig,
    generatedServerName: binding.generatedServerName,
    health,
  };
}

// ── Route handlers ───────────────────────────────────────────────────────────

export async function roleExtensionRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /roles/:rid/extensions
  fastify.get(
    "/roles/:rid/extensions",
    {
      schema: {
        tags: ["Roles", "Extensions"],
        summary: "List extensions bound to a role",
        params: {
          type: "object",
          properties: {
            rid: { type: "string" },
          },
          required: ["rid"],
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: { rid: string } }>,
      reply: FastifyReply,
    ) => {
      const paramsParse = paramsSchema.safeParse(request.params);
      if (!paramsParse.success) {
        return reply.status(400).send({
          code: "VALIDATION_ERROR",
          message: z.prettifyError(paramsParse.error),
        });
      }
      const { rid } = paramsParse.data;
      const db = getDb();

      const role = getRole(rid);
      if (!role) {
        return reply.status(404).send({ code: "NOT_FOUND", message: "Role not found" });
      }

      const bindings = listBindingsByRole(db, rid);
      const result = [];
      for (const binding of bindings) {
        const extension = getExtensionById(db, binding.extensionId);
        if (!extension) continue; // shouldn't happen with FK cascade, but guard anyway
        const health = getHealth(db, binding.extensionId);
        result.push(bindingToResponse(binding, extension, health));
      }

      return { bindings: result };
    },
  );

  // POST /roles/:rid/extensions
  fastify.post(
    "/roles/:rid/extensions",
    {
      schema: {
        tags: ["Roles", "Extensions"],
        summary: "Bind an extension to a role",
        params: {
          type: "object",
          properties: {
            rid: { type: "string" },
          },
          required: ["rid"],
        },
        body: {
          type: "object",
          properties: {
            extension_name: { type: "string" },
            config_override: { type: "object", additionalProperties: true },
          },
          required: ["extension_name"],
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: { rid: string } }>,
      reply: FastifyReply,
    ) => {
      const paramsParse = paramsSchema.safeParse(request.params);
      if (!paramsParse.success) {
        return reply.status(400).send({
          code: "VALIDATION_ERROR",
          message: z.prettifyError(paramsParse.error),
        });
      }
      const bodyParse = postBodySchema.safeParse(request.body);
      if (!bodyParse.success) {
        return reply.status(400).send({
          code: "VALIDATION_ERROR",
          message: z.prettifyError(bodyParse.error),
        });
      }

      const { rid } = paramsParse.data;
      const { extension_name, config_override } = bodyParse.data;
      const db = getDb();

      const role = getRole(rid);
      if (!role) {
        return reply.status(404).send({ code: "NOT_FOUND", message: "Role not found" });
      }

      const extension = getExtensionByName(db, extension_name);
      if (!extension) {
        return reply.status(404).send({
          code: "NOT_FOUND",
          message: `Extension '${extension_name}' not found`,
        });
      }

      if (bindingExists(db, rid, extension.id)) {
        return reply.status(409).send({
          code: "BINDING_EXISTS",
          message: `Extension '${extension_name}' is already bound to this role`,
        });
      }

      const binding = createBinding(db, {
        roleId: rid,
        extensionId: extension.id,
        generatedServerName: extension.name,
        configOverrideJson: config_override ? JSON.stringify(config_override) : null,
        enabled: true,
      });

      return reply.status(201).send(bindingToResponse(binding, extension));
    },
  );

  // DELETE /roles/:rid/extensions/:eid
  fastify.delete(
    "/roles/:rid/extensions/:eid",
    {
      schema: {
        tags: ["Roles", "Extensions"],
        summary: "Remove an extension binding from a role",
        params: {
          type: "object",
          properties: {
            rid: { type: "string" },
            eid: { type: "string" },
          },
          required: ["rid", "eid"],
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: { rid: string; eid: string } }>,
      reply: FastifyReply,
    ) => {
      const paramsParse = bindingParamsSchema.safeParse(request.params);
      if (!paramsParse.success) {
        return reply.status(400).send({
          code: "VALIDATION_ERROR",
          message: z.prettifyError(paramsParse.error),
        });
      }
      const { rid, eid } = paramsParse.data;
      const db = getDb();

      const binding = getBinding(db, eid);
      if (!binding || binding.roleId !== rid) {
        return reply.status(404).send({ code: "NOT_FOUND", message: "Binding not found" });
      }

      deleteBinding(db, eid);
      return reply.status(204).send();
    },
  );

  // PATCH /roles/:rid/extensions/:eid
  fastify.patch(
    "/roles/:rid/extensions/:eid",
    {
      schema: {
        tags: ["Roles", "Extensions"],
        summary: "Update a role extension binding (config override, enabled toggle)",
        params: {
          type: "object",
          properties: {
            rid: { type: "string" },
            eid: { type: "string" },
          },
          required: ["rid", "eid"],
        },
        body: {
          type: "object",
          properties: {
            config_override: { type: "object", additionalProperties: true, nullable: true },
            enabled: { type: "boolean" },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: { rid: string; eid: string } }>,
      reply: FastifyReply,
    ) => {
      const paramsParse = bindingParamsSchema.safeParse(request.params);
      if (!paramsParse.success) {
        return reply.status(400).send({
          code: "VALIDATION_ERROR",
          message: z.prettifyError(paramsParse.error),
        });
      }
      const bodyParse = patchBodySchema.safeParse(request.body);
      if (!bodyParse.success) {
        return reply.status(400).send({
          code: "VALIDATION_ERROR",
          message: z.prettifyError(bodyParse.error),
        });
      }

      const { rid, eid } = paramsParse.data;
      const { config_override, enabled } = bodyParse.data;
      const db = getDb();

      const binding = getBinding(db, eid);
      if (!binding || binding.roleId !== rid) {
        return reply.status(404).send({ code: "NOT_FOUND", message: "Binding not found" });
      }

      const updates: UpdateBindingPayload = {};
      if (config_override === null) {
        updates.configOverrideJson = null;
      } else if (config_override !== undefined) {
        updates.configOverrideJson = JSON.stringify(config_override);
      }
      if (enabled !== undefined) {
        updates.enabled = enabled;
      }

      const updated = updateBinding(db, eid, updates);
      if (!updated) {
        return reply.status(500).send({ code: "INTERNAL_ERROR", message: "Update failed" });
      }

      const extension = getExtensionById(db, updated.extensionId);
      if (!extension) {
        return reply.status(500).send({ code: "INTERNAL_ERROR", message: "Extension not found after update" });
      }

      return reply.status(200).send(bindingToResponse(updated, extension));
    },
  );
}
