import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod/v4";
import { listGoals, getGoal, createGoal, updateGoal, deleteGoal } from "../../store/goals.js";
import { parseGoal, persistGoal, buildMetricTree } from "../../goal-manager/goal-manager.js";
import type { GoalStatus } from "../../shared/types.js";
import { responses } from "../response-schemas.js";

const goalQuerySchema = z.object({
  status: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).default(20),
  offset: z.coerce.number().min(0).default(0),
});

const notifyTargetSchema = z.union([
  z.object({ type: z.literal("session"), sessionId: z.string() }),
  z.object({ type: z.literal("channel"), channelId: z.string(), chatId: z.string().optional() }),
]);

const createGoalBodySchema = z.object({
  input: z.string().min(1, "goal input is required"),
  deliverTo: z.array(notifyTargetSchema).optional(),
  reportTo: z.array(notifyTargetSchema).optional(),
});

const goalParamsSchema = z.object({
  id: z.string().min(1),
});

const updateGoalBodySchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  status: z.enum(["active", "paused", "completed", "failed"]).optional(),
  currentValue: z.number().optional(),
  budgetUsd: z.number().min(0).optional(),
  deliverTo: z.array(notifyTargetSchema).optional(),
  reportTo: z.array(notifyTargetSchema).optional(),
});

export async function goalRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /goals
  fastify.get("/goals", {
    schema: {
      tags: ["Goals"],
      summary: "List goals",
      description: "List goals with optional status filter and pagination.",
      querystring: {
        type: "object",
        properties: {
          status: { type: "string", description: "Filter by goal status" },
          limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
          offset: { type: "integer", minimum: 0, default: 0 },
        },
      },
      response: responses.goalList,
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parse = goalQuerySchema.safeParse(request.query);
    if (!parse.success) {
      return reply.status(400).send({ code: "VALIDATION_ERROR", message: z.prettifyError(parse.error) });
    }

    const { status, limit, offset } = parse.data;
    const goals = listGoals(status as GoalStatus | undefined, limit, offset);
    return { goals };
  });

  // GET /goals/:id
  fastify.get("/goals/:id", {
    schema: {
      tags: ["Goals"],
      summary: "Get goal by ID",
      description: "Retrieve a single goal by its ID, including metric tree and progress.",
      params: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string" },
        },
      },
      response: responses.goalDetail,
    },
  }, async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const goal = getGoal(request.params.id);
    if (!goal) {
      return reply.status(404).send({ code: "NOT_FOUND", message: "Goal not found" });
    }
    return { goal };
  });

  // POST /goals
  fastify.post("/goals", {
    schema: {
      tags: ["Goals"],
      summary: "Create a goal",
      description: "Create a new goal from a natural language input. The input is parsed, validated, and a metric tree is built.",
      body: {
        type: "object",
        required: ["input"],
        properties: {
          input: { type: "string", minLength: 1, description: "Natural language goal description" },
          deliverTo: { type: "array", items: { type: "object" }, description: "Delivery targets (result output)" },
          reportTo: { type: "array", items: { type: "object" }, description: "Report targets (status notifications)" },
        },
      },
      response: responses.goalCreated,
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parse = createGoalBodySchema.safeParse(request.body);
    if (!parse.success) {
      return reply.status(400).send({ code: "VALIDATION_ERROR", message: z.prettifyError(parse.error) });
    }

    const parsed = await parseGoal(parse.data.input);
    if (!parsed.validationResult.isValid) {
      return reply.status(400).send({
        code: "INVALID_GOAL",
        errors: parsed.validationResult.errors,
        warnings: parsed.validationResult.warnings,
      });
    }

    const goal = persistGoal(parsed.goalState, parse.data.deliverTo, parse.data.reportTo);
    buildMetricTree(goal.id, goal.metricType);

    return reply.status(201).send({ goal });
  });

  // PATCH /goals/:id
  fastify.patch("/goals/:id", {
    schema: {
      tags: ["Goals"],
      summary: "Update a goal",
      description: "Partially update a goal's name, description, status, currentValue, or budgetUsd.",
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
          status: { type: "string" },
          currentValue: { type: "number" },
          budgetUsd: { type: "number", minimum: 0 },
          deliverTo: { type: "array", items: { type: "object" }, description: "Delivery targets (result output)" },
          reportTo: { type: "array", items: { type: "object" }, description: "Report targets (status notifications)" },
        },
      },
      response: responses.goalDetail,
    },
  }, async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const paramsParse = goalParamsSchema.safeParse(request.params);
    if (!paramsParse.success) {
      return reply.status(400).send({ code: "VALIDATION_ERROR", message: z.prettifyError(paramsParse.error) });
    }

    const bodyParse = updateGoalBodySchema.safeParse(request.body);
    if (!bodyParse.success) {
      return reply.status(400).send({ code: "VALIDATION_ERROR", message: z.prettifyError(bodyParse.error) });
    }

    const existing = getGoal(paramsParse.data.id);
    if (!existing) {
      return reply.status(404).send({ code: "NOT_FOUND", message: "Goal not found" });
    }

    updateGoal(paramsParse.data.id, { ...bodyParse.data, updatedAt: Date.now() });
    const goal = getGoal(paramsParse.data.id);
    return { goal };
  });

  // DELETE /goals/:id
  fastify.delete("/goals/:id", {
    schema: {
      tags: ["Goals"],
      summary: "Delete a goal",
      description: "Delete a goal by ID.",
      params: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string" },
        },
      },
    },
  }, async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const paramsParse = goalParamsSchema.safeParse(request.params);
    if (!paramsParse.success) {
      return reply.status(400).send({ code: "VALIDATION_ERROR", message: z.prettifyError(paramsParse.error) });
    }

    const existing = getGoal(paramsParse.data.id);
    if (!existing) {
      return reply.status(404).send({ code: "NOT_FOUND", message: "Goal not found" });
    }

    deleteGoal(paramsParse.data.id);
    return { goalId: paramsParse.data.id, deleted: true };
  });
}
