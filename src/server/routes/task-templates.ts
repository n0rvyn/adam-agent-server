import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod/v4";
import { v4 as uuidv4 } from "uuid";
import {
  createTaskTemplate,
  getTaskTemplate,
  listTaskTemplates,
  updateTaskTemplate,
  deleteTaskTemplate,
  getTaskTemplateDependents,
  TemplateRoleConfigError,
  TemplateValidationError,
  type DeleteTemplateMode,
} from "../../store/task-templates.js";
import {
  listTemplateVersions,
  getTemplateVersion,
  diffTemplateVersions,
  restoreTemplateVersion,
} from "../../store/template-versions.js";
import type { TaskTemplate, NotifyTarget } from "../../shared/types.js";
import type { BreeEngine } from "../../scheduler/bree-engine.js";
import { responses } from "../response-schemas.js";
import { TaskRequirementsSchema } from "../../lib/task-admission.js";
import { ContractRuleItemSchema } from "../../store/contract-rules.js";
import { renderConfigDoc } from "../../store/config-doc/renderer.js";

const notifyTargetSchema = z.union([
  z.object({ type: z.literal("session"), sessionId: z.string() }),
  z.object({ type: z.literal("channel"), channelId: z.string(), chatId: z.string().optional() }),
]);

export const taskStepSchema = z.object({
  id: z.string(),
  prompt: z.string(),
  dependsOn: z.array(z.string()).optional(),
  minDependencies: z.number().int().min(1).optional(),
  outputAs: z.string().optional(),
  roleId: z.string().optional(),
  autoSelectRole: z.boolean().optional(),
  requirements: TaskRequirementsSchema.optional(),
  config: z.object({
    timeout: z.number().optional(),
    maxTurns: z.number().optional(),
  }).optional(),
  kind: z.string().optional(),
  consumesFrom: z.array(z.string()).optional(),
  consumesFromOptional: z.array(z.string()).optional(),
  persona: z.object({
    speakAs: z.string().min(1),
    voiceConstraints: z.string().optional(),
  }).optional(),
  // Single-vocabulary pure design: the ONE contract vocabulary is `contractRules` (Track A/B rules
  // enforced at SDK hook time). The legacy lengthTarget/format/expectedArtifacts fields and the
  // expectedArtifacts→outputAs refine were removed; per-rule validation lives in ContractRuleItemSchema.
  outputContract: z.object({
    mustReferenceArtifacts: z.boolean().optional(),
    customAssertions: z.array(z.string()).optional(),
    contractRules: z.array(ContractRuleItemSchema).optional(),
  }).optional(),
  assertions: z.array(z.string()).optional(),
});

const triggerSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("cron"),
    cron: z.string().min(1),
    event: z.undefined().optional(),
    runAt: z.undefined().optional(),
    eventDefId: z.undefined().optional(),
  }),
  z.object({
    type: z.literal("manual"),
    cron: z.undefined().optional(),
    event: z.undefined().optional(),
    runAt: z.undefined().optional(),
    eventDefId: z.undefined().optional(),
  }),
  z.object({
    type: z.literal("once"),
    cron: z.undefined().optional(),
    event: z.undefined().optional(),
    runAt: z.string().min(1),
    eventDefId: z.undefined().optional(),
  }),
  z.object({
    type: z.literal("template_complete"),
    cron: z.undefined().optional(),
    event: z.string().regex(/^template_complete:[\w-]+$/),
    runAt: z.undefined().optional(),
    eventDefId: z.undefined().optional(),
  }),
  z.object({
    type: z.literal("event"),
    cron: z.undefined().optional(),
    event: z.undefined().optional(),
    runAt: z.undefined().optional(),
    eventDefId: z.string().uuid(),
  }),
]);

export const createBodySchema = z.object({
  id: z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/i, "id must be a slug").optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  trigger: triggerSchema,
  steps: z.array(taskStepSchema).min(1),
  rolePreference: z.string().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  enabled: z.boolean().default(true),
  goalIds: z.array(z.string()).optional(),
  deliverTo: z.array(notifyTargetSchema).optional(),
  reportTo: z.array(notifyTargetSchema).optional(),
  retryPolicy: z.object({ maxAttempts: z.number().int().positive() }).optional(),
});

const createBodyTyped = createBodySchema
  .transform((data) => ({
    ...data,
    deliverTo: data.deliverTo as NotifyTarget[] | undefined,
    reportTo: data.reportTo as NotifyTarget[] | undefined,
  }));

const updateBodySchema = createBodySchema.partial()
  .transform((data: ReturnType<typeof createBodySchema.partial> extends z.ZodType<infer T> ? T : never) => ({
    ...data,
    deliverTo: (data as { deliverTo?: unknown[] }).deliverTo as NotifyTarget[] | undefined,
    reportTo: (data as { reportTo?: unknown[] }).reportTo as NotifyTarget[] | undefined,
  }));

const paramsSchema = z.object({
  id: z.string().min(1),
});

const runBodySchema = z.object({
  reportTo: z.array(notifyTargetSchema).optional(),
  reason: z.string().optional(),
  rerunMode: z.enum(["normal", "rerun"]).optional(),
}).optional();

export async function taskTemplateRoutes(
  fastify: FastifyInstance,
  breeEngine: BreeEngine,
): Promise<void> {
  // POST /task-templates
  fastify.post("/task-templates", {
    schema: {
      tags: ["Templates"],
      summary: "Create a task template",
      description: "Create a new task template with trigger (cron/manual/once/template_complete/event) and execution steps. Cron-triggered templates are automatically scheduled.",
      body: {
        type: "object",
        required: ["name", "trigger", "steps"],
        properties: {
          id: { type: "string", description: "Optional. Stable friendly id for re-importable templates (e.g. pkos-scan-and-sync). If omitted, a UUIDv4 is generated." },
          name: { type: "string", minLength: 1 },
          description: { type: "string" },
          trigger: {
            type: "object",
            required: ["type"],
            properties: {
              type: { type: "string", enum: ["cron", "manual", "once", "template_complete", "event"] },
              cron: { type: "string", description: "Cron expression (required when type is cron)" },
              event: { type: "string", description: "Required when type is template_complete; format 'template_complete:<targetId>'" },
              eventDefId: { type: "string", description: "Event def ID (required when type is event)" },
              runAt: { type: "string", description: "ISO 8601 timestamp (required when type is once)" },
            },
          },
          steps: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              required: ["id", "prompt"],
              properties: {
                id: { type: "string" },
                prompt: { type: "string" },
                dependsOn: { type: "array", items: { type: "string" } },
                outputAs: { type: "string" },
                roleId: { type: "string", description: "Role ID for this step (overrides template rolePreference)" },
                autoSelectRole: { type: "boolean", description: "If true, Adam picks the best-fit role at dispatch time; mutually exclusive with roleId." },
                requirements: { type: "object", additionalProperties: true, description: "Task requirements object (tools, paths, osCapabilities, network, plugins). Required when autoSelectRole is true." },
                config: {
                  type: "object",
                  properties: {
                    timeout: { type: "number", description: "Step-level timeout override (seconds)" },
                    maxTurns: { type: "number", description: "Step-level maxTurns override" },
                  },
                },
                consumesFrom: { type: "array", items: { type: "string" } },
                consumesFromOptional: { type: "array", items: { type: "string" } },
                persona: {
                  type: "object",
                  properties: {
                    speakAs: { type: "string" },
                    voiceConstraints: { type: "string" },
                  },
                },
                outputContract: {
                  type: "object",
                  properties: {
                    mustReferenceArtifacts: { type: "boolean" },
                    customAssertions: { type: "array", items: { type: "string" } },
                    contractRules: {
                      type: "array",
                      description: "The single contract vocabulary. Each item is a discriminated union keyed by `kind` (lengthTarget | format | requireHeading | mime | fileSizeBytes | audioZeroCrossingRatePerS | audioDurationMs). See src/store/contract-rules.ts.",
                      items: { type: "object", additionalProperties: true },
                    },
                  },
                },
              },
            },
          },
          rolePreference: { type: "string" },
          config: { type: "object", additionalProperties: true },
          enabled: { type: "boolean", default: true },
          goalIds: { type: "array", items: { type: "string" } },
          deliverTo: { type: "array", items: { type: "object" } },
          reportTo: { type: "array", items: { type: "object" } },
        },
      },
      response: responses.templateCreated,
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parseResult = createBodySchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({ code: "VALIDATION_ERROR", message: z.prettifyError(parseResult.error) });
    }

    const data = parseResult.data;
    const template: TaskTemplate = {
      ...data,
      id: data.id ?? uuidv4(),
      createdAt: Date.now(),
    };

    try {
      const result = createTaskTemplate(template);
      // 200 OK = existing row preserved (INSERT OR IGNORE skipped); 201 Created = newly inserted
      const status = result.changes === 0 ? 200 : 201;
      if (template.enabled && template.trigger.type === "cron" && template.trigger.cron) {
        await breeEngine.scheduleJob(template.id);
      } else if (template.enabled && template.trigger.type === "once" && template.trigger.runAt) {
        breeEngine.scheduleOnceJob(template.id);
      }
      return reply.status(status).send({ templateId: template.id });
    } catch (err) {
      if (err instanceof TemplateRoleConfigError) {
        return reply.status(400).send({ code: err.code, message: err.message, failingStepIds: err.failingStepIds });
      }
      if (err instanceof TemplateValidationError) {
        return reply.status(400).send({ code: err.code, message: err.message, failingStepIds: err.failingStepIds });
      }
      throw err;
    }
  });

  // GET /task-templates
  fastify.get("/task-templates", {
    schema: {
      tags: ["Templates"],
      summary: "List task templates",
      description: "List all task templates, optionally filtering to enabled-only.",
      querystring: {
        type: "object",
        properties: {
          enabled: { type: "string", enum: ["true", "false"], description: "Filter to enabled templates only when 'true'" },
        },
      },
      response: responses.templateList,
    },
  }, async (request: FastifyRequest) => {
    const query = request.query as { enabled?: string };
    const enabledOnly = query.enabled === "true";
    const templates = listTaskTemplates(enabledOnly);
    return { templates };
  });

  // GET /task-templates/:id
  fastify.get("/task-templates/:id", {
    schema: {
      tags: ["Templates"],
      summary: "Get task template by ID",
      description: "Retrieve a single task template by its ID.",
      params: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string" },
        },
      },
      response: responses.templateDetail,
    },
  }, async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const parseResult = paramsSchema.safeParse(request.params);
    if (!parseResult.success) {
      return reply.status(400).send({ code: "VALIDATION_ERROR", message: z.prettifyError(parseResult.error) });
    }
    const template = getTaskTemplate(parseResult.data.id);
    if (!template) {
      return reply.status(404).send({ code: "NOT_FOUND", message: "Template not found" });
    }
    return { template };
  });

  // GET /task-templates/:id/dependents
  fastify.get("/task-templates/:id/dependents", {
    schema: {
      tags: ["Templates"],
      summary: "Get delete dependents for a task template",
      description: "Returns counts of template_executions and tasks that reference this template. Used by the UI to present delete mode choices (template_only vs with_tasks).",
      params: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string" } },
      },
    },
  }, async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const parseResult = paramsSchema.safeParse(request.params);
    if (!parseResult.success) {
      return reply.status(400).send({ code: "VALIDATION_ERROR", message: z.prettifyError(parseResult.error) });
    }
    const template = getTaskTemplate(parseResult.data.id);
    if (!template) {
      return reply.status(404).send({ code: "NOT_FOUND", message: "Template not found" });
    }
    const dependents = getTaskTemplateDependents(parseResult.data.id);
    return { dependents };
  });

  // PATCH /task-templates/:id
  fastify.patch("/task-templates/:id", {
    schema: {
      tags: ["Templates"],
      summary: "Update a task template",
      description: "Partially update a task template. Cron schedules are automatically rescheduled if the trigger changes.",
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
          description: { type: "string" },
          trigger: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["cron", "manual", "once", "template_complete", "event"] },
              cron: { type: "string", description: "Cron expression (required when type is cron)" },
              event: { type: "string", description: "Event string: 'template_complete:<id>'" },
              runAt: { type: "string", description: "ISO 8601 timestamp (required when type is once)" },
            },
          },
          steps: { type: "array", items: { type: "object" } },
          rolePreference: { type: "string" },
          config: { type: "object", additionalProperties: true },
          enabled: { type: "boolean" },
          goalIds: { type: "array", items: { type: "string" } },
          deliverTo: { type: "array", items: { type: "object" } },
          reportTo: { type: "array", items: { type: "object" } },
        },
      },
      response: responses.templateUpdated,
    },
  }, async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const idParse = paramsSchema.safeParse(request.params);
    if (!idParse.success) return reply.status(400).send({ code: "VALIDATION_ERROR", message: z.prettifyError(idParse.error) });
    const bodyParse = updateBodySchema.safeParse(request.body);
    if (!bodyParse.success) return reply.status(400).send({ code: "VALIDATION_ERROR", message: z.prettifyError(bodyParse.error) });

    const existing = getTaskTemplate(idParse.data.id);
    if (!existing) return reply.status(404).send({ code: "NOT_FOUND", message: "Template not found" });

    try {
      updateTaskTemplate(idParse.data.id, bodyParse.data);
    } catch (err) {
      if (err instanceof TemplateRoleConfigError) {
        return reply.status(400).send({ code: err.code, message: err.message, failingStepIds: err.failingStepIds });
      }
      if (err instanceof TemplateValidationError) {
        return reply.status(400).send({ code: err.code, message: err.message, failingStepIds: err.failingStepIds });
      }
      throw err;
    }

    // Reschedule if needed
    await breeEngine.unscheduleJob(idParse.data.id);
    const updated = getTaskTemplate(idParse.data.id);
    if (updated?.enabled && updated.trigger.type === "cron" && updated.trigger.cron) {
      await breeEngine.scheduleJob(updated.id);
    } else if (updated?.enabled && updated.trigger.type === "once" && updated.trigger.runAt) {
      breeEngine.scheduleOnceJob(updated.id);
    }

    return { templateId: idParse.data.id };
  });

  // DELETE /task-templates/:id
  fastify.delete("/task-templates/:id", {
    schema: {
      tags: ["Templates"],
      summary: "Delete a task template",
      description: "Delete a task template by ID. Cron jobs are automatically unscheduled. Use ?mode=template_only (default) to keep tasks as orphans, or ?mode=with_tasks to also delete all tasks created by this template (including their role_scores and manager_decisions; chat_messages.task_id is nulled). template_executions are always removed.",
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
          mode: { type: "string", enum: ["template_only", "with_tasks"], default: "template_only" },
        },
      },
      response: responses.templateDeleted,
    },
  }, async (request: FastifyRequest<{ Params: { id: string }; Querystring: { mode?: string } }>, reply: FastifyReply) => {
    const parseResult = paramsSchema.safeParse(request.params);
    if (!parseResult.success) return reply.status(400).send({ code: "VALIDATION_ERROR", message: z.prettifyError(parseResult.error) });

    const rawMode = (request.query as { mode?: string }).mode ?? "template_only";
    if (rawMode !== "template_only" && rawMode !== "with_tasks") {
      return reply.status(400).send({ code: "VALIDATION_ERROR", message: `mode must be 'template_only' or 'with_tasks' (got '${rawMode}')` });
    }
    const mode: DeleteTemplateMode = rawMode;

    const existing = getTaskTemplate(parseResult.data.id);
    if (!existing) return reply.status(404).send({ code: "NOT_FOUND", message: "Template not found" });

    const dependentsBefore = getTaskTemplateDependents(parseResult.data.id);

    await breeEngine.unscheduleJob(parseResult.data.id);
    try {
      deleteTaskTemplate(parseResult.data.id, mode);
    } catch (err) {
      const sqliteErr = err as { code?: string; message?: string };
      if (sqliteErr.code === "SQLITE_CONSTRAINT_FOREIGNKEY") {
        return reply.status(409).send({
          code: "FOREIGN_KEY_CONFLICT",
          message: `Cannot delete template: a referenced row blocks removal. Detail: ${sqliteErr.message ?? "unknown"}`,
        });
      }
      throw err;
    }

    return {
      templateId: parseResult.data.id,
      deleted: true,
      mode,
      deletedCounts: {
        template: 1,
        templateExecutions: dependentsBefore.executionCount,
        tasks: mode === "with_tasks" ? dependentsBefore.taskCount : 0,
      },
    };
  });

  // POST /task-templates/:id/run — manual trigger
  fastify.post("/task-templates/:id/run", {
    schema: {
      tags: ["Templates"],
      summary: "Run a task template",
      description: "Manually trigger execution of a task template regardless of its trigger type.",
      params: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string" },
        },
      },
      response: responses.templateRun,
    },
  }, async (request: FastifyRequest<{ Params: { id: string }; Body?: unknown }>, reply: FastifyReply) => {
    const parseResult = paramsSchema.safeParse(request.params);
    if (!parseResult.success) return reply.status(400).send({ code: "VALIDATION_ERROR", message: z.prettifyError(parseResult.error) });
    const bodyParse = runBodySchema.safeParse(request.body);
    if (!bodyParse.success) return reply.status(400).send({ code: "VALIDATION_ERROR", message: z.prettifyError(bodyParse.error) });

    const template = getTaskTemplate(parseResult.data.id);
    if (!template) return reply.status(404).send({ code: "NOT_FOUND", message: "Template not found" });

    const body = bodyParse.data ?? {};
    const warnings = (!template.reportTo?.length && !body.reportTo?.length)
      ? ["manual-run-no-report-target"]
      : [];
    const executionId = await breeEngine.runNow(parseResult.data.id, {
      originReportTo: body.reportTo as NotifyTarget[] | undefined,
      triggerContext: {
        source: "manual-api",
        reason: body.reason,
        rerunMode: body.rerunMode,
      },
    });
    return {
      executionId,
      status: "started",
      monitorUrl: `/template-executions/${executionId}`,
      warnings,
    };
  });

  // === Template Version History (Phase 0.5) ===

  // GET /task-templates/:id/versions — list all versions, newest first
  fastify.get("/task-templates/:id/versions", {
    schema: {
      tags: ["Templates"],
      summary: "List template versions",
      description: "List all saved versions of a task template, newest first. Each version contains the pre-change snapshot, the reason it was captured (update/delete/restore), the author, and the trace ID.",
      params: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string" } },
      },
    },
  }, async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const parseResult = paramsSchema.safeParse(request.params);
    if (!parseResult.success) return reply.status(400).send({ code: "VALIDATION_ERROR", message: z.prettifyError(parseResult.error) });
    const template = getTaskTemplate(parseResult.data.id);
    if (!template) return reply.status(404).send({ code: "NOT_FOUND", message: "Template not found" });
    const versions = listTemplateVersions(parseResult.data.id);
    return {
      templateId: parseResult.data.id,
      templateName: template.name,
      count: versions.length,
      versions: versions.map((v) => ({
        versionNo: v.versionNo,
        reason: v.reason,
        author: v.author,
        traceId: v.traceId,
        createdAt: v.createdAt,
        snapshotName: v.snapshot.name,
      })),
    };
  });

  // GET /task-templates/:id/versions/:v — get a single version with full snapshot
  fastify.get("/task-templates/:id/versions/:v", {
    schema: {
      tags: ["Templates"],
      summary: "Get a template version",
      description: "Get the full snapshot for a single template version (by version number).",
      params: {
        type: "object",
        required: ["id", "v"],
        properties: {
          id: { type: "string" },
          v: { type: "integer", minimum: 1 },
        },
      },
    },
  }, async (request: FastifyRequest<{ Params: { id: string; v: string } }>, reply: FastifyReply) => {
    const parseResult = z.object({ id: z.string(), v: z.coerce.number().int().positive() }).safeParse(request.params);
    if (!parseResult.success) return reply.status(400).send({ code: "VALIDATION_ERROR", message: z.prettifyError(parseResult.error) });
    const versionNo = parseResult.data.v;
    const version = getTemplateVersion(parseResult.data.id, versionNo);
    if (!version) return reply.status(404).send({ code: "NOT_FOUND", message: `Version not found: ${parseResult.data.id}#${versionNo}` });
    return {
      templateId: parseResult.data.id,
      versionNo: version.versionNo,
      reason: version.reason,
      author: version.author,
      traceId: version.traceId,
      createdAt: version.createdAt,
      snapshot: version.snapshot,
    };
  });

  // GET /task-templates/:id/versions/diff?a=&b= — diff two versions
  fastify.get("/task-templates/:id/versions/diff", {
    schema: {
      tags: ["Templates"],
      summary: "Diff two template versions",
      description: "Field-level diff between two version numbers. Walks steps by step id, config keys (excluding last_run_at), and top-level fields. Returns an array of {path, before, after} entries.",
      params: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string" } },
      },
      querystring: {
        type: "object",
        required: ["a", "b"],
        properties: {
          a: { type: "integer", minimum: 1 },
          b: { type: "integer", minimum: 1 },
        },
      },
    },
  }, async (request: FastifyRequest<{ Params: { id: string }; Querystring: { a?: string; b?: string } }>, reply: FastifyReply) => {
    const paramsParse = paramsSchema.safeParse(request.params);
    if (!paramsParse.success) return reply.status(400).send({ code: "VALIDATION_ERROR", message: z.prettifyError(paramsParse.error) });
    const qsParse = z.object({ a: z.coerce.number().int().positive(), b: z.coerce.number().int().positive() }).safeParse(request.query);
    if (!qsParse.success) return reply.status(400).send({ code: "VALIDATION_ERROR", message: z.prettifyError(qsParse.error) });

    const a = getTemplateVersion(paramsParse.data.id, qsParse.data.a);
    if (!a) return reply.status(404).send({ code: "NOT_FOUND", message: `Version not found: ${paramsParse.data.id}#${qsParse.data.a}` });
    const b = getTemplateVersion(paramsParse.data.id, qsParse.data.b);
    if (!b) return reply.status(404).send({ code: "NOT_FOUND", message: `Version not found: ${paramsParse.data.id}#${qsParse.data.b}` });
    const diffs = diffTemplateVersions(a.snapshot, b.snapshot);
    return {
      templateId: paramsParse.data.id,
      a: qsParse.data.a,
      b: qsParse.data.b,
      changeCount: diffs.length,
      changes: diffs,
    };
  });

  // POST /task-templates/:id/versions/:v/restore — restore a version
  fastify.post("/task-templates/:id/versions/:v/restore", {
    schema: {
      tags: ["Templates"],
      summary: "Restore a template version",
      description: "Non-destructively restore a template's content to a previous version. The current content is first captured as a 'restore' version, then the old content is written back. Version history is preserved. Does NOT change the enabled flag.",
      params: {
        type: "object",
        required: ["id", "v"],
        properties: {
          id: { type: "string" },
          v: { type: "integer", minimum: 1 },
        },
      },
    },
  }, async (request: FastifyRequest<{ Params: { id: string; v: string } }>, reply: FastifyReply) => {
    const parseResult = z.object({ id: z.string(), v: z.coerce.number().int().positive() }).safeParse(request.params);
    if (!parseResult.success) return reply.status(400).send({ code: "VALIDATION_ERROR", message: z.prettifyError(parseResult.error) });
    const versionNo = parseResult.data.v;
    const version = getTemplateVersion(parseResult.data.id, versionNo);
    if (!version) return reply.status(404).send({ code: "NOT_FOUND", message: `Version not found: ${parseResult.data.id}#${versionNo}` });
    try {
      const result = restoreTemplateVersion(parseResult.data.id, versionNo);
      const after = getTaskTemplate(parseResult.data.id);
      return {
        success: true,
        templateId: parseResult.data.id,
        restoredFromVersion: result.restoredFromVersion,
        preRestoreVersionNo: result.preRestoreVersionNo,
        currentName: after?.name,
      };
    } catch (err) {
      return reply.status(500).send({ code: "RESTORE_FAILED", message: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /task-templates/:id/export — single template config-doc export
  fastify.get("/task-templates/:id/export", {
    schema: {
      tags: ["Templates"],
      summary: "Export a template as a config-doc",
      description: "Returns the rendered config-doc text for a single template plus an inventory of included templates/roles.",
      params: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string" } },
      },
    },
  }, async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const parseResult = paramsSchema.safeParse(request.params);
    if (!parseResult.success) {
      return reply.status(400).send({ code: "VALIDATION_ERROR", message: z.prettifyError(parseResult.error) });
    }
    const template = getTaskTemplate(parseResult.data.id);
    if (!template) {
      return reply.status(404).send({ code: "NOT_FOUND", message: "Template not found" });
    }
    const doc = renderConfigDoc([parseResult.data.id]);
    return {
      format: "config-doc",
      doc,
      inventory: {
        templates: [{ id: template.id, name: template.name }],
      },
    };
  });

  // GET /config-doc/export?ids=a,b — multi-id export with deduped closure
  // Path is intentionally NOT /task-templates/export because the existing
  // GET /task-templates/:id route would match that as id="export".
  fastify.get("/config-doc/export", {
    schema: {
      tags: ["Templates"],
      summary: "Export multiple templates as a single config-doc",
      description: "Comma-separated ids. Role closure is deduplicated across the template set.",
      querystring: {
        type: "object",
        required: ["ids"],
        properties: { ids: { type: "string" } },
      },
    },
  }, async (request: FastifyRequest<{ Querystring: { ids: string } }>, reply: FastifyReply) => {
    const idsStr = request.query?.ids;
    if (!idsStr || typeof idsStr !== "string" || idsStr.trim() === "") {
      return reply.status(400).send({ code: "VALIDATION_ERROR", message: "ids query param is required (comma-separated)" });
    }
    const ids = idsStr.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    if (ids.length === 0) {
      return reply.status(400).send({ code: "VALIDATION_ERROR", message: "ids must contain at least one non-empty id" });
    }
    // Verify all ids exist (so we can 404 cleanly rather than partial-render)
    const missing: string[] = [];
    for (const id of ids) {
      if (!getTaskTemplate(id)) missing.push(id);
    }
    if (missing.length > 0) {
      return reply.status(404).send({ code: "NOT_FOUND", message: `Template(s) not found: ${missing.join(", ")}` });
    }
    const doc = renderConfigDoc(ids);
    return {
      format: "config-doc",
      doc,
      inventory: {
        templateIds: ids,
      },
    };
  });
}
