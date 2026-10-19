import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod/v4";
import { createTaskWithAdmission, type CreateTaskSuccess, type CreateTaskFailure } from "../../lib/task-dispatch.js";
import { withNewTrace } from "../../lib/trace-context.js";
import { getTask, listTasks } from "../../store/tasks.js";
import { getStepLogs } from "../../store/logs.js";
import { getDeliveryLogByTask } from "../../store/delivery-log.js";
import type { Task, TaskStatus, TaskConfig, TaskRequirements } from "../../shared/types.js";
import { TaskController } from "./task-controller.js";
import { listTaskPlans } from "../../store/task-plans.js";
import { responses } from "../response-schemas.js";
import { TaskRequirementsSchema } from "../../lib/task-admission.js";
import { publicTaskView } from "../../security/redaction.js";

const notifyTargetSchema = z.union([
  z.object({ type: z.literal("session"), sessionId: z.string() }),
  z.object({ type: z.literal("channel"), channelId: z.string(), chatId: z.string().optional() }),
]);

const createTaskBodySchema = z.object({
  prompt: z.string().min(1, "prompt is required"),
  roleId: z.string().optional(),
  requirements: TaskRequirementsSchema.optional(),
  autoSelectRole: z.boolean().optional(),
  deliverTo: z.array(notifyTargetSchema).optional(),
  reportTo: z.array(notifyTargetSchema).optional(),
  config: z
    .object({
      allowedTools: z.array(z.string()).optional(),
      disallowedTools: z.array(z.string()).optional(),
      maxTurns: z.number().optional(),
      maxBudgetUsd: z.number().optional(),
      mcpServers: z.record(z.string(), z.unknown()).optional(),
      model: z.string().optional(),
      effort: z.enum(["low", "medium", "high", "max"]).optional(),
      settingSources: z.array(z.string()).optional(),
      workspacePath: z.string().optional(),
      timeout: z.number().optional(),
      approvalRequired: z.array(z.string()).optional(),
      approvalTimeout: z.number().optional(),
      env: z.record(z.string(), z.string()).optional(),
      plugins: z.array(z.string()).optional(),
    })
    .optional(),
});

const taskParamsSchema = z.object({
  id: z.string().uuid(),
});

const VALID_STATUSES = [
  "pending",
  "queued",
  "running",
  "paused",
  "completed",
  "failed",
  "cancelled",
  "blocked",
] as const;

const listTasksQuerySchema = z.object({
  status: z.enum(VALID_STATUSES).optional(),
  roleId: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).default(100),
  offset: z.coerce.number().min(0).default(0),
});

export async function taskRoutes(fastify: FastifyInstance): Promise<void> {
  const taskController = new TaskController();
  // POST /tasks
  fastify.post(
    "/tasks",
    {
      schema: {
        tags: ["Tasks"],
        summary: "Create a task",
        description: "Create a new task with a prompt and optional agent/config overrides. The task enters 'pending' status and is picked up by the scheduler.",
        body: {
          type: "object",
          required: ["prompt"],
          properties: {
            prompt: { type: "string", minLength: 1, description: "Task prompt" },
            roleId: { type: "string", description: "Role to assign" },
            config: {
              type: "object",
              description: "Optional task configuration overrides",
              properties: {
                model: { type: "string" },
                maxTurns: { type: "integer" },
                maxBudgetUsd: { type: "number" },
                timeout: { type: "integer" },
                effort: { type: "string", enum: ["low", "medium", "high", "max"] },
              },
            },
          },
        },
        response: responses.taskCreated,
      },
    },
    async (
      request: FastifyRequest<{
        Body: {
          prompt: string;
          roleId?: string;
          requirements?: TaskRequirements;
          autoSelectRole?: boolean;
          config?: Partial<TaskConfig>;
          deliverTo?: Array<{ type: string; sessionId?: string; channelId?: string; chatId?: string }>;
          reportTo?: Array<{ type: string; sessionId?: string; channelId?: string; chatId?: string }>;
        };
      }>,
      reply: FastifyReply,
    ) => {
      return withNewTrace("manual", async () => {
        const parseResult = createTaskBodySchema.safeParse(request.body);
        if (!parseResult.success) {
          return reply.status(400).send({
            code: "VALIDATION_ERROR",
            message: z.prettifyError(parseResult.error),
          });
        }

        const { prompt, roleId, requirements, autoSelectRole, config, deliverTo, reportTo } = parseResult.data;

        const result = await createTaskWithAdmission({
          prompt,
          roleId,
          requirements,
          autoSelectRole,
          deliverTo,
          reportTo,
          config,
          dispatchSource: "rest_api",
        });

        if (!result.ok) {
          return reply.status(400).send({
            code: result.code,
            message: result.reason,
            missing: result.missing,
            candidates: result.candidates,
          });
        }

        return reply.status(201).send({
          taskId: result.taskId,
          roleId: result.roleId,
          fitScore: result.fitScore,
        });
      });
    },
  );

  // GET /tasks
  fastify.get(
    "/tasks",
    {
      schema: {
        tags: ["Tasks"],
        summary: "List tasks",
        description: "List tasks with optional status filter and pagination.",
        querystring: {
          type: "object",
          properties: {
            status: { type: "string", enum: ["pending", "queued", "running", "paused", "completed", "failed", "cancelled", "blocked"] },
            limit: { type: "integer", minimum: 1, maximum: 100, default: 100 },
            offset: { type: "integer", minimum: 0, default: 0 },
          },
        },
        response: responses.taskList,
      },
    },
    async (
      request: FastifyRequest<{
        Querystring: { status?: TaskStatus; limit?: number; offset?: number };
      }>,
      reply: FastifyReply,
    ) => {
      const parseResult = listTasksQuerySchema.safeParse(request.query);
      if (!parseResult.success) {
        return reply.status(400).send({
          code: "VALIDATION_ERROR",
          message: z.prettifyError(parseResult.error),
        });
      }

      const { status, roleId, limit, offset } = parseResult.data;
      const tasks = listTasks(status, limit, offset, roleId);

      return { tasks: tasks.map(publicTaskView) };
    },
  );

  // GET /tasks/:id
  fastify.get(
    "/tasks/:id",
    {
      schema: {
        tags: ["Tasks"],
        summary: "Get task by ID",
        description: "Retrieve a single task by its UUID.",
        params: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string", format: "uuid" },
          },
        },
        response: responses.taskDetail,
      },
    },
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const parseResult = taskParamsSchema.safeParse(request.params);
      if (!parseResult.success) {
        return reply.status(400).send({
          code: "VALIDATION_ERROR",
          message: z.prettifyError(parseResult.error),
        });
      }

      const task = getTask(parseResult.data.id);
      if (!task) {
        return reply.status(404).send({
          code: "NOT_FOUND",
          message: "Task not found",
        });
      }

      return { task: publicTaskView(task) };
    },
  );

  // POST /tasks/:id/cancel
  fastify.post(
    "/tasks/:id/cancel",
    {
      schema: {
        tags: ["Tasks"],
        summary: "Cancel a task",
        description: "Cancel a running, queued, pending, or paused task. Returns 400 if the task is in a terminal state.",
        params: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string", format: "uuid" },
          },
        },
        response: responses.taskAction,
      },
    },
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const parseResult = taskParamsSchema.safeParse(request.params);
      if (!parseResult.success) {
        return reply.status(400).send({
          code: "VALIDATION_ERROR",
          message: z.prettifyError(parseResult.error),
        });
      }

      const task = getTask(parseResult.data.id);
      if (!task) {
        return reply.status(404).send({
          code: "NOT_FOUND",
          message: "Task not found",
        });
      }

      if (task.status !== "running" && task.status !== "queued" && task.status !== "pending" && task.status !== "paused") {
        return reply.status(400).send({
          code: "INVALID_STATE",
          message: `Cannot cancel task in status: ${task.status}`,
        });
      }

      taskController.cancelTask(task.id);
      return { taskId: task.id, status: "cancelled" };
    },
  );

  // POST /tasks/batch-cancel — cancel multiple tasks at once
  const batchCancelBodySchema = z.object({
    taskIds: z.array(z.string()).min(1).max(500),
  });

  fastify.post(
    "/tasks/batch-cancel",
    {
      schema: {
        tags: ["Tasks"],
        summary: "Batch cancel tasks",
        description: "Cancel multiple tasks at once. Skips tasks that are already in terminal state. Returns count of cancelled tasks.",
        body: {
          type: "object",
          required: ["taskIds"],
          properties: {
            taskIds: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 500 },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{ Body: { taskIds: string[] } }>,
      reply: FastifyReply,
    ) => {
      const parse = batchCancelBodySchema.safeParse(request.body);
      if (!parse.success) {
        return reply.status(400).send({ code: "VALIDATION_ERROR", message: z.prettifyError(parse.error) });
      }

      const cancellable = new Set(["pending", "queued", "running", "paused"]);
      let cancelled = 0;
      const errors: Array<{ taskId: string; reason: string }> = [];

      for (const taskId of parse.data.taskIds) {
        const task = getTask(taskId);
        if (!task) {
          errors.push({ taskId, reason: "not found" });
          continue;
        }
        if (!cancellable.has(task.status)) {
          errors.push({ taskId, reason: `already ${task.status}` });
          continue;
        }
        taskController.cancelTask(taskId);
        cancelled++;
      }

      return { cancelled, total: parse.data.taskIds.length, errors: errors.length > 0 ? errors : undefined };
    },
  );

  // GET /tasks/:id/logs
  fastify.get(
    "/tasks/:id/logs",
    {
      schema: {
        tags: ["Tasks"],
        summary: "Get task step logs",
        description: "Returns execution step logs for a task (reasoning, tool calls, results).",
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        querystring: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
            offset: { type: "integer", minimum: 0, default: 0 },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Querystring: { limit?: number; offset?: number };
      }>,
      reply: FastifyReply,
    ) => {
      const task = getTask(request.params.id);
      if (!task) {
        return reply.status(404).send({ code: "NOT_FOUND", message: "Task not found" });
      }
      const { limit = 50, offset = 0 } = request.query;
      const logs = getStepLogs(task.id, limit, offset);
      return { logs };
    },
  );

  // Approval schemas
  const approvalBodySchema = z.object({
    approvalId: z.string().uuid(),
    reason: z.string().optional(),
  });

  // POST /tasks/:id/approve
  fastify.post(
    "/tasks/:id/approve",
    {
      schema: {
        tags: ["Tasks"],
        summary: "Approve a pending approval",
        description: "Approve a tool-use approval request for a paused task. The skill agent resumes execution with the approved tool call.",
        params: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string", format: "uuid" },
          },
        },
        body: {
          type: "object",
          required: ["approvalId"],
          properties: {
            approvalId: { type: "string", format: "uuid" },
            reason: { type: "string" },
          },
        },
        response: responses.approvalAction,
      },
    },
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Body: { approvalId: string; reason?: string };
      }>,
      reply: FastifyReply,
    ) => {
      const idParse = taskParamsSchema.safeParse(request.params);
      if (!idParse.success) {
        return reply.status(400).send({
          code: "VALIDATION_ERROR",
          message: z.prettifyError(idParse.error),
        });
      }

      const bodyParse = approvalBodySchema.safeParse(request.body);
      if (!bodyParse.success) {
        return reply.status(400).send({
          code: "VALIDATION_ERROR",
          message: z.prettifyError(bodyParse.error),
        });
      }

      const task = getTask(idParse.data.id);
      if (!task) {
        return reply.status(404).send({
          code: "NOT_FOUND",
          message: "Task not found",
        });
      }

      const resolved = taskController.resolveApproval(bodyParse.data.approvalId, "allow", bodyParse.data.reason);
      if (!resolved) {
        return reply.status(404).send({
          code: "NOT_FOUND",
          message: "Approval not found or already resolved",
        });
      }

      return { approvalId: bodyParse.data.approvalId, decision: "allow" };
    },
  );

  // POST /tasks/:id/reject
  fastify.post(
    "/tasks/:id/reject",
    {
      schema: {
        tags: ["Tasks"],
        summary: "Reject a pending approval",
        description: "Reject a tool-use approval request for a paused task. The skill agent skips the denied tool call.",
        params: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string", format: "uuid" },
          },
        },
        body: {
          type: "object",
          required: ["approvalId"],
          properties: {
            approvalId: { type: "string", format: "uuid" },
            reason: { type: "string" },
          },
        },
        response: responses.approvalAction,
      },
    },
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Body: { approvalId: string; reason?: string };
      }>,
      reply: FastifyReply,
    ) => {
      const idParse = taskParamsSchema.safeParse(request.params);
      if (!idParse.success) {
        return reply.status(400).send({
          code: "VALIDATION_ERROR",
          message: z.prettifyError(idParse.error),
        });
      }

      const bodyParse = approvalBodySchema.safeParse(request.body);
      if (!bodyParse.success) {
        return reply.status(400).send({
          code: "VALIDATION_ERROR",
          message: z.prettifyError(bodyParse.error),
        });
      }

      const task = getTask(idParse.data.id);
      if (!task) {
        return reply.status(404).send({
          code: "NOT_FOUND",
          message: "Task not found",
        });
      }

      const resolved = taskController.resolveApproval(bodyParse.data.approvalId, "deny", bodyParse.data.reason);
      if (!resolved) {
        return reply.status(404).send({
          code: "NOT_FOUND",
          message: "Approval not found or already resolved",
        });
      }

      return { approvalId: bodyParse.data.approvalId, decision: "deny" };
    },
  );

  // POST /tasks/:id/approve-plan (D-010)
  const planApprovalBodySchema = z.object({
    planId: z.string(),
    decision: z.enum(["allow", "deny"]),
    approvalType: z.enum(["once", "permanent"]).optional(),
    reason: z.string().optional(),
  });

  fastify.post(
    "/tasks/:id/approve-plan",
    {
      schema: {
        tags: ["Tasks"],
        summary: "Approve or deny an execution plan",
        description: "Respond to a plan approval request. Allow once (single task), allow permanent (create rule for similar tasks), or deny.",
        params: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string", format: "uuid" },
          },
        },
        body: {
          type: "object",
          required: ["planId", "decision"],
          properties: {
            planId: { type: "string" },
            decision: { type: "string", enum: ["allow", "deny"] },
            approvalType: { type: "string", enum: ["once", "permanent"] },
            reason: { type: "string" },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Body: { planId: string; decision: "allow" | "deny"; approvalType?: "once" | "permanent"; reason?: string };
      }>,
      reply: FastifyReply,
    ) => {
      const idParse = taskParamsSchema.safeParse(request.params);
      if (!idParse.success) {
        return reply.status(400).send({
          code: "VALIDATION_ERROR",
          message: z.prettifyError(idParse.error),
        });
      }

      const bodyParse = planApprovalBodySchema.safeParse(request.body);
      if (!bodyParse.success) {
        return reply.status(400).send({
          code: "VALIDATION_ERROR",
          message: z.prettifyError(bodyParse.error),
        });
      }

      const task = getTask(idParse.data.id);
      if (!task) {
        return reply.status(404).send({ code: "NOT_FOUND", message: "Task not found" });
      }

      const { planId, decision, approvalType, reason } = bodyParse.data;
      const resolved = taskController.resolvePlanApproval(planId, decision, approvalType, reason);
      if (!resolved) {
        return reply.status(404).send({ code: "NOT_FOUND", message: "Plan approval not found or already resolved" });
      }

      return { planId, decision, approvalType };
    },
  );

  // GET /tasks/:id/plan — fetch all plans for a task
  fastify.get(
    "/tasks/:id/plan",
    {
      schema: {
        tags: ["Tasks"],
        summary: "Get execution plans for a task",
        params: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string", format: "uuid" },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const idParse = taskParamsSchema.safeParse(request.params);
      if (!idParse.success) {
        return reply.status(400).send({
          code: "VALIDATION_ERROR",
          message: z.prettifyError(idParse.error),
        });
      }

      const task = getTask(idParse.data.id);
      if (!task) {
        return reply.status(404).send({ code: "NOT_FOUND", message: "Task not found" });
      }

      const plans = listTaskPlans(idParse.data.id);
      return { plans };
    },
  );

  // GET /tasks/:id/delivery-log
  fastify.get(
    "/tasks/:id/delivery-log",
    {
      schema: {
        tags: ["Tasks"],
        summary: "Get delivery log for a task",
        description: "Returns delivery log entries for a task, including channel and webhook delivery attempts.",
        params: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string", format: "uuid" },
          },
        },
        querystring: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Querystring: { limit?: number };
      }>,
      reply: FastifyReply,
    ) => {
      const idParse = taskParamsSchema.safeParse(request.params);
      if (!idParse.success) {
        return reply.status(400).send({
          code: "VALIDATION_ERROR",
          message: z.prettifyError(idParse.error),
        });
      }

      const task = getTask(idParse.data.id);
      if (!task) {
        return reply.status(404).send({ code: "NOT_FOUND", message: "Task not found" });
      }

      const { limit = 50 } = request.query;
      const logs = getDeliveryLogByTask(task.id, limit);
      return { logs };
    },
  );
}
