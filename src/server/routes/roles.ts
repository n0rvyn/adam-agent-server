import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod/v4";
import { v4 as uuidv4 } from "uuid";
import { validateRoleOsCapabilitiesForStorage } from "../../shared/os-capabilities.js";
import {
  createRole,
  getRole,
  getRoleByName,
  listRoles,
  updateRole,
  deleteRole,
} from "../../store/roles.js";
import {
  ensureRoleWorkspace,
  writeRoleCLAUDEmd,
  getRoleWorkspacePath,
  syncRoleSettings,
} from "../../store/role-workspace.js";
import { getScoresByRole, getLatestEmaScore, getRoleContractComplianceEma } from "../../store/role-scores.js";
import { listInstalledPlugins, scanDirectoryConfig } from "../../store/plugin-registry.js";
import { listBeliefsByRole, getBelief, updateBeliefStatus } from "../../store/beliefs.js";
import type { Role, RoleStatus, AdditionalDirectory, LearnedRules } from "../../shared/types.js";
import { RoleHasActiveTasksError } from "../../shared/types.js";
import { computeRoleEnvDiff, syncRoleDbToEnvFile, readRoleEnvFile } from "../../config/role-env-sync.js";
import { rmSync, existsSync } from "node:fs";
import { CHAT_MANAGER_ROLE_ID } from "../../store/role-presets.js";

const preferencesSchema = z.object({
  model: z.string().optional(),
  effort: z.enum(["low", "medium", "high", "max"]).optional(),
  maxTurns: z.number().optional(),
});

const additionalDirectorySchema = z.object({
  path: z.string(),
  mode: z.enum(["ro", "rw"]).default("rw"),
  inheritPlugins: z.boolean().optional(),
  inheritMcp: z.boolean().optional(),
  inheritPermissions: z.boolean().optional(),
});

const envVarKeySchema = z.string().max(256).regex(
  /^[A-Za-z_][A-Za-z0-9_]*$/,
  "Env var key must match POSIX format: [A-Za-z_][A-Za-z0-9_]*"
).check(
  z.refine((k) => !k.startsWith("ANTHROPIC_"), "ANTHROPIC_* keys are managed globally in Settings")
);
const envVarsSchema = z.record(envVarKeySchema, z.string().max(4096)).optional().check(
  z.refine((v) => !v || Object.keys(v).length <= 100, "Maximum 100 environment variables per role")
);

const roleOsCapabilitySchema = z.object({
  id: z.string().min(1),
  targets: z.array(z.string().min(1)).optional(),
});

const roleBodySchema = z.object({
  name: z.string().min(1, "name is required").regex(
    /^[\p{L}\p{N}_-]+$/u,
    "name must contain only letters, numbers, underscores, or hyphens"
  ),
  cagPrompt: z.string().optional(),
  learnedRules: z.union([
    z.array(z.string()),
    z.object({
      stylePreferences: z.array(z.string()).optional(),
      avoidedActions: z.array(z.string()).optional(),
      pinnedParameters: z.array(z.object({
        tool: z.string(),
        params: z.record(z.string(), z.unknown()),
        condition: z.string().optional(),
        pinnedAt: z.number(),
      })).optional(),
    }),
  ]).optional(),
  allowedTools: z.array(z.string()).optional(),
  disallowedTools: z.array(z.string()).optional(),
  evaluationCriteria: z.record(z.string(), z.number()).optional(),
  executionMode: z.enum(["isolated", "inline"]).optional(),
  model: z.string().optional(),
  effortTier: z.enum(["low", "medium", "high"]).nullable().optional(),
  skills: z.union([z.array(z.string()), z.literal("all")]).nullable().optional(),
  maxBudgetUsd: z.number().optional(),
  approvalRequired: z.array(z.string()).optional(),
  preferences: preferencesSchema.optional(),
  additionalDirectories: z.array(additionalDirectorySchema).optional(),
  allowedChannels: z.array(z.string()).optional(),
  inheritUserSettings: z.boolean().optional(),
  envVars: envVarsSchema,
  osCapabilities: z.array(roleOsCapabilitySchema).optional(),
});

const rolePatchSchema = z.object({
  name: z.string().min(1).optional(),
  cagPrompt: z.string().optional(),
  learnedRules: z.union([
    z.array(z.string()),
    z.object({
      stylePreferences: z.array(z.string()).optional(),
      avoidedActions: z.array(z.string()).optional(),
      pinnedParameters: z.array(z.object({
        tool: z.string(),
        params: z.record(z.string(), z.unknown()),
        condition: z.string().optional(),
        pinnedAt: z.number(),
      })).optional(),
    }),
  ]).optional(),
  status: z.enum(["active", "inactive", "retired"]).optional(),
  allowedTools: z.array(z.string()).optional(),
  disallowedTools: z.array(z.string()).optional(),
  evaluationCriteria: z.record(z.string(), z.number()).optional(),
  executionMode: z.enum(["isolated", "inline"]).optional(),
  model: z.string().optional(),
  effortTier: z.enum(["low", "medium", "high"]).nullable().optional(),
  skills: z.union([z.array(z.string()), z.literal("all")]).nullable().optional(),
  maxBudgetUsd: z.number().optional(),
  approvalRequired: z.array(z.string()).optional(),
  preferences: preferencesSchema.optional(),
  additionalDirectories: z.array(additionalDirectorySchema).optional(),
  permissionMode: z.enum(["default", "acceptEdits", "dontAsk", "bypassPermissions", "plan", "auto"]).optional(),
  allowedBashPatterns: z.array(z.string()).optional(),
  deniedBashPatterns: z.array(z.string()).optional(),
  allowedChannels: z.array(z.string()).nullable().optional(),
  inheritUserSettings: z.boolean().optional(),
  envVars: envVarsSchema,
  osCapabilities: z.array(roleOsCapabilitySchema).optional(),
});

const roleParamsSchema = z.object({
  id: z.string().min(1),
});

const deleteRoleQuerySchema = z.object({
  force: z.coerce.boolean().optional().default(false),
});

const listRolesQuerySchema = z.object({
  status: z.enum(["active", "inactive", "retired"]).optional(),
  limit: z.coerce.number().min(1).max(1000).optional(),
  offset: z.coerce.number().min(0).default(0),
});

const scanDirectoryBodySchema = z.object({
  path: z.string().min(1),
});

export async function roleRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /roles
  fastify.get(
    "/roles",
    {
      schema: {
        tags: ["Roles"],
        summary: "List all roles",
        description: "List all roles with optional status filter and pagination.",
        querystring: {
          type: "object",
          properties: {
            status: { type: "string", enum: ["active", "inactive", "retired"] },
            limit: { type: "integer", minimum: 1, maximum: 1000 },
            offset: { type: "integer", minimum: 0, default: 0 },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{
        Querystring?: { status?: RoleStatus; limit?: number; offset?: number };
      }>,
      reply: FastifyReply,
    ) => {
      const parseResult = listRolesQuerySchema.safeParse(request.query);
      if (!parseResult.success) {
        return reply.status(400).send({
          code: "VALIDATION_ERROR",
          message: z.prettifyError(parseResult.error),
        });
      }

      const { status, limit, offset } = parseResult.data;
      const roles = listRoles(status, limit, offset);
      return {
        roles: roles.map((r) => ({
          ...r,
          workspacePath: getRoleWorkspacePath(r.name),
          contractComplianceEma: getRoleContractComplianceEma(r.id).emaScore,
        })),
      };
    },
  );

  // POST /roles
  fastify.post(
    "/roles",
    {
      schema: {
        tags: ["Roles"],
        summary: "Create a role",
        description: "Create a new role with a name, CAG prompt, and optional preferences.",
        body: {
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string", minLength: 1 },
            cagPrompt: { type: "string" },
            preferences: {
              type: "object",
              properties: {
                model: { type: "string" },
                effort: { type: "string", enum: ["low", "medium", "high", "max"] },
                maxTurns: { type: "number" },
              },
            },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{
        Body: { name: string; cagPrompt?: string; preferences?: object };
      }>,
      reply: FastifyReply,
    ) => {
      const parseResult = roleBodySchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          code: "VALIDATION_ERROR",
          message: z.prettifyError(parseResult.error),
        });
      }

      const {
        name,
        cagPrompt,
        learnedRules: rawLearnedRules,
        allowedTools,
        disallowedTools,
        evaluationCriteria,
        executionMode,
        model,
        effortTier,
        skills,
        maxBudgetUsd,
        approvalRequired,
        preferences,
        additionalDirectories,
        allowedChannels,
        inheritUserSettings,
        envVars,
        osCapabilities,
      } = parseResult.data;
      // Coerce legacy string[] learnedRules to structured LearnedRules (auto-migrate)
      const learnedRules: LearnedRules = Array.isArray(rawLearnedRules)
        ? { stylePreferences: rawLearnedRules.filter((s) => typeof s === "string"), avoidedActions: [], pinnedParameters: [] }
        : rawLearnedRules
          ? {
              stylePreferences: (rawLearnedRules as LearnedRules).stylePreferences ?? [],
              avoidedActions: (rawLearnedRules as LearnedRules).avoidedActions ?? [],
              pinnedParameters: (rawLearnedRules as LearnedRules).pinnedParameters ?? [],
            }
          : { stylePreferences: [], avoidedActions: [], pinnedParameters: [] };

      // Check for duplicate name
      if (getRoleByName(name)) {
        return reply.status(409).send({
          code: "CONFLICT",
          message: `Role with name '${name}' already exists`,
        });
      }

      let validatedOsCapabilities: Role["osCapabilities"];
      try {
        validatedOsCapabilities = validateRoleOsCapabilitiesForStorage(osCapabilities);
      } catch (error) {
        return reply.status(400).send({
          code: "VALIDATION_ERROR",
          message: error instanceof Error ? error.message : String(error),
        });
      }

      const id = `role-${uuidv4().slice(0, 8)}`;
      const role: Role = {
        id,
        name,
        cagPrompt: cagPrompt ?? "",
        learnedRules: learnedRules ?? { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
        memoryStreamId: `mem-${uuidv4().slice(0, 8)}`,
        status: "active",
        preferences: preferences ?? {},
        allowedTools: allowedTools,
        disallowedTools: disallowedTools,
        evaluationCriteria: evaluationCriteria,
        executionMode: executionMode,
        model: model,
        effortTier: effortTier ?? undefined,
        skills: skills ?? undefined,
        maxBudgetUsd: maxBudgetUsd,
        approvalRequired: approvalRequired,
        additionalDirectories: additionalDirectories,
        allowedChannels: allowedChannels,
        inheritUserSettings: inheritUserSettings,
        envVars: envVars,
        osCapabilities: validatedOsCapabilities,
        createdAt: Date.now(),
      };

      createRole(role);
      ensureRoleWorkspace(role);

      return reply.status(201).send({ role });
    },
  );

  // GET /roles/:id
  fastify.get(
    "/roles/:id",
    {
      schema: {
        tags: ["Roles"],
        summary: "Get role by ID",
        description: "Retrieve a single role with its project-scope plugins.",
        params: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string" },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const parseResult = roleParamsSchema.safeParse(request.params);
      if (!parseResult.success) {
        return reply.status(400).send({
          code: "VALIDATION_ERROR",
          message: z.prettifyError(parseResult.error),
        });
      }

      const role = getRole(parseResult.data.id);
      if (!role) {
        return reply.status(404).send({
          code: "NOT_FOUND",
          message: "Role not found",
        });
      }

      // Include project-scope plugins for this role's workspace
      const roleWorkspace = getRoleWorkspacePath(role.name);
      const projectPlugins = listInstalledPlugins({ scope: "project", projectPath: roleWorkspace });

      return { role, projectPlugins, workspacePath: roleWorkspace };
    },
  );

  // GET /roles/:id/scores — quality score history
  fastify.get("/roles/:id/scores", {
    schema: {
      tags: ["Roles"],
      summary: "Get role quality scores",
      params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
      querystring: {
        type: "object",
        properties: { limit: { type: "integer", minimum: 1, maximum: 100, default: 20 } },
      },
    },
  }, async (request: FastifyRequest<{ Params: { id: string }; Querystring: { limit?: number } }>, reply: FastifyReply) => {
    const parseResult = z.object({ id: z.string().min(1) }).safeParse(request.params);
    if (!parseResult.success) {
      return reply.status(400).send({ code: "VALIDATION_ERROR", message: z.prettifyError(parseResult.error) });
    }

    const role = getRole(parseResult.data.id);
    if (!role) {
      return reply.status(404).send({ code: "NOT_FOUND", message: "Role not found" });
    }

    const limit = (request.query as { limit?: number }).limit ?? 20;
    const scores = getScoresByRole(role.id, limit);
    const latestEma = getLatestEmaScore(role.id);
    const contractCompliance = getRoleContractComplianceEma(role.id);

    return { scores, latestEma: latestEma ?? null, contractCompliance };
  });

  // GET /roles/:id/beliefs — list beliefs for role
  fastify.get<{
    Params: { id: string };
    Querystring: { includeAnti?: string; includeSuperseded?: string; limit?: string };
  }>(
    "/roles/:id/beliefs",
    {
      schema: {
        tags: ["roles"],
        summary: "List role beliefs",
        description: "Read-only list of a role's stored beliefs. Embedding bytes are stripped.",
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const role = getRole(id);
      if (!role) {
        reply.code(404);
        return { error: "role_not_found" };
      }

      const includeAnti = request.query.includeAnti !== "false";
      const includeSuperseded = request.query.includeSuperseded === "true";
      const rawLimit = Number.parseInt(request.query.limit ?? "100", 10);
      const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(500, rawLimit)) : 100;

      const all = listBeliefsByRole(id, { includeAnti, includeSuperseded });
      const sorted = all
        .sort((a, b) => {
          if (b.successEma !== a.successEma) return (b.successEma ?? 0) - (a.successEma ?? 0);
          return b.lastUsedAt - a.lastUsedAt;
        })
        .slice(0, limit);

      const sanitized = sorted.map(({ embedding: _embedding, ...rest }) => rest);
      return { beliefs: sanitized, count: sanitized.length };
    },
  );

  // PATCH /roles/:id
  fastify.patch(
    "/roles/:id",
    {
      schema: {
        tags: ["Roles"],
        summary: "Update a role",
        description: "Partially update a role's CAG prompt, learned rules, status, or preferences.",
        params: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string" },
          },
        },
        body: {
          type: "object",
          properties: {
            name: { type: "string", minLength: 1 },
            cagPrompt: { type: "string" },
            learnedRules: {
              oneOf: [
                { type: "array", items: { type: "string" } },
                {
                  type: "object",
                  properties: {
                    stylePreferences: { type: "array", items: { type: "string" } },
                    avoidedActions: { type: "array", items: { type: "string" } },
                    pinnedParameters: { type: "array" },
                  },
                },
              ],
            },
            status: { type: "string", enum: ["active", "inactive", "retired"] },
            permissionMode: { type: "string", enum: ["default", "acceptEdits", "dontAsk", "bypassPermissions", "plan", "auto"] },
            allowedBashPatterns: { type: "array", items: { type: "string" } },
            deniedBashPatterns: { type: "array", items: { type: "string" } },
            preferences: {
              type: "object",
              properties: {
                model: { type: "string" },
                effort: { type: "string", enum: ["low", "medium", "high", "max"] },
                maxTurns: { type: "number" },
              },
            },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Body: Partial<Role>;
      }>,
      reply: FastifyReply,
    ) => {
      const idParse = roleParamsSchema.safeParse(request.params);
      if (!idParse.success) {
        return reply.status(400).send({
          code: "VALIDATION_ERROR",
          message: z.prettifyError(idParse.error),
        });
      }

      // D-011: mcpServers field removed from PATCH /roles. Zod strips unknown keys silently,
      // so we must check the raw body BEFORE safeParse to return 400.
      if (request.body && typeof request.body === "object" && "mcpServers" in request.body) {
        return reply.status(400).send({
          code: "MCP_SERVERS_REMOVED",
          message:
            "The `mcpServers` field was removed in Phase 2. Use POST /roles/:rid/extensions instead.",
        });
      }

      const bodyParse = rolePatchSchema.safeParse(request.body);
      if (!bodyParse.success) {
        return reply.status(400).send({
          code: "VALIDATION_ERROR",
          message: z.prettifyError(bodyParse.error),
        });
      }

      const existing = getRole(idParse.data.id);
      if (!existing) {
        return reply.status(404).send({
          code: "NOT_FOUND",
          message: "Role not found",
        });
      }

      const { allowedChannels: rawChannels, osCapabilities, learnedRules: rawLearnedRules, effortTier: rawEffortTier, skills: rawSkills, ...restFields } = bodyParse.data;
      // Coerce legacy string[] learnedRules to structured LearnedRules (auto-migrate)
      const coercedLearnedRules: LearnedRules | undefined = Array.isArray(rawLearnedRules)
        ? { stylePreferences: rawLearnedRules.filter((s) => typeof s === "string"), avoidedActions: [], pinnedParameters: [] }
        : rawLearnedRules
          ? {
              stylePreferences: (rawLearnedRules as LearnedRules).stylePreferences ?? [],
              avoidedActions: (rawLearnedRules as LearnedRules).avoidedActions ?? [],
              pinnedParameters: (rawLearnedRules as LearnedRules).pinnedParameters ?? [],
            }
          : undefined;
      // null from JSON means "clear this field" → convert to undefined for store layer
      const updates: Partial<Role> = { ...restFields, learnedRules: coercedLearnedRules, updatedAt: Date.now() };
      if (rawEffortTier !== undefined) updates.effortTier = rawEffortTier ?? undefined;
      if (rawSkills !== undefined) updates.skills = rawSkills ?? undefined;
      if (rawChannels !== undefined) updates.allowedChannels = rawChannels ?? undefined;
      if (osCapabilities !== undefined) {
        try {
          updates.osCapabilities = validateRoleOsCapabilitiesForStorage(osCapabilities);
        } catch (error) {
          return reply.status(400).send({
            code: "VALIDATION_ERROR",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      updateRole(idParse.data.id, updates);

      // If CAG prompt or learned rules changed, update workspace CLAUDE.md
      if (bodyParse.data.cagPrompt !== undefined || bodyParse.data.learnedRules !== undefined) {
        const updated = getRole(idParse.data.id);
        if (updated) {
          const wsPath = getRoleWorkspacePath(updated.name);
          if (existsSync(wsPath)) {
            writeRoleCLAUDEmd(wsPath, updated);
          }
        }
      }

      // If tool permissions changed, sync workspace settings
      const updated = getRole(idParse.data.id);
      if (updated && (bodyParse.data.allowedTools !== undefined || bodyParse.data.disallowedTools !== undefined)) {
        const wsPath = getRoleWorkspacePath(updated.name);
        if (existsSync(wsPath)) {
          syncRoleSettings(updated.id, updated.allowedTools, wsPath);
        }
      }

      return { role: updated };
    },
  );

  // DELETE /roles/:id
  fastify.delete(
    "/roles/:id",
    {
      schema: {
        tags: ["Roles"],
        summary: "Delete a role",
        description: "Delete a role and its workspace.",
        params: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string" },
          },
        },
        querystring: {
          type: "object",
          properties: {
            force: { type: "boolean", description: "Force deletion even if role has active tasks" },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: { id: string }; Querystring?: { force?: boolean } }>,
      reply: FastifyReply,
    ) => {
      const parseResult = roleParamsSchema.safeParse(request.params);
      if (!parseResult.success) {
        return reply.status(400).send({
          code: "VALIDATION_ERROR",
          message: z.prettifyError(parseResult.error),
        });
      }

      const queryParse = deleteRoleQuerySchema.safeParse(request.query ?? {});
      const force = queryParse.success ? queryParse.data.force : false;

      const role = getRole(parseResult.data.id);
      if (!role) {
        return reply.status(404).send({
          code: "NOT_FOUND",
          message: "Role not found",
        });
      }

      // System role deletion protection
      if (role.id === CHAT_MANAGER_ROLE_ID) {
        return reply.status(403).send({
          code: "FORBIDDEN",
          message: "System role 'chat-manager' cannot be deleted",
        });
      }

      try {
        // Delete workspace
        const wsPath = getRoleWorkspacePath(role.name);
        if (existsSync(wsPath)) {
          try { rmSync(wsPath, { recursive: true, force: true }); } catch { /* ignore */ }
        }

        deleteRole(parseResult.data.id, force);
      } catch (err) {
        if (err instanceof RoleHasActiveTasksError) {
          return reply.status(409).send({
            code: err.code,
            message: err.message,
            roleId: err.roleId,
            activeTaskCount: err.activeTaskCount,
            taskStatuses: err.taskStatuses,
          });
        }
        throw err;
      }
      return { roleId: parseResult.data.id, deleted: true };
    },
  );

  // POST /roles/:id/scan-directory — scan a directory for plugin/permission config
  fastify.post(
    "/roles/:id/scan-directory",
    {
      schema: {
        tags: ["Roles"],
        summary: "Scan directory for plugin/permission configuration",
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        body: {
          type: "object",
          required: ["path"],
          properties: { path: { type: "string", minLength: 1 } },
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: { id: string }; Body: { path: string } }>,
      reply: FastifyReply,
    ) => {
      const idParse = roleParamsSchema.safeParse(request.params);
      if (!idParse.success) {
        return reply.status(400).send({ code: "VALIDATION_ERROR", message: z.prettifyError(idParse.error) });
      }
      const bodyParse = scanDirectoryBodySchema.safeParse(request.body);
      if (!bodyParse.success) {
        return reply.status(400).send({ code: "VALIDATION_ERROR", message: z.prettifyError(bodyParse.error) });
      }

      const role = getRole(idParse.data.id);
      if (!role) {
        return reply.status(404).send({ code: "NOT_FOUND", message: "Role not found" });
      }

      const dirConfig = scanDirectoryConfig(bodyParse.data.path);
      return {
        path: bodyParse.data.path,
        enabledPlugins: dirConfig.enabledPlugins,
        mcpServers: dirConfig.mcpServers,
        allowedTools: dirConfig.allowedTools,
        disallowedTools: dirConfig.disallowedTools,
      };
    },
  );

  // ===== Role .env bidirectional sync =====

  // GET /roles/:id/env-diff — compare DB envVars with role .env file
  fastify.get("/roles/:id/env-diff", {
    schema: { tags: ["Roles"], summary: "Get role env diff", params: { type: "object", required: ["id"], properties: { id: { type: "string" } } } },
  }, async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const role = getRole(request.params.id);
    if (!role) return reply.status(404).send({ code: "NOT_FOUND", message: "Role not found" });
    const diffs = computeRoleEnvDiff(role.name, role.envVars);
    return { diffs, envFileExists: readRoleEnvFile(role.name) !== null };
  });

  // POST /roles/:id/sync-to-env — write DB envVars to role .env file
  fastify.post("/roles/:id/sync-to-env", {
    schema: { tags: ["Roles"], summary: "Sync role env to .env file", params: { type: "object", required: ["id"], properties: { id: { type: "string" } } } },
  }, async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const role = getRole(request.params.id);
    if (!role) return reply.status(404).send({ code: "NOT_FOUND", message: "Role not found" });
    const changed = syncRoleDbToEnvFile(role.name, role.envVars);
    return { success: true, changed };
  });

  // POST /roles/:id/load-from-env — read role .env into DB envVars (overwrite)
  fastify.post("/roles/:id/load-from-env", {
    schema: { tags: ["Roles"], summary: "Load role env from .env file", params: { type: "object", required: ["id"], properties: { id: { type: "string" } } } },
  }, async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const role = getRole(request.params.id);
    if (!role) return reply.status(404).send({ code: "NOT_FOUND", message: "Role not found" });
    const fileEnv = readRoleEnvFile(role.name);
    if (!fileEnv) return reply.status(400).send({ code: "NOT_FOUND", message: ".env file not found in role workspace" });
    // Filter ANTHROPIC_* and merge
    const filtered: Record<string, string> = {};
    for (const [k, v] of Object.entries(fileEnv)) {
      if (!k.startsWith("ANTHROPIC_")) filtered[k] = v;
    }
    updateRole(role.id, { envVars: Object.keys(filtered).length > 0 ? filtered : undefined, updatedAt: Date.now() });
    return { success: true, updated: Object.keys(filtered).length };
  });
}
