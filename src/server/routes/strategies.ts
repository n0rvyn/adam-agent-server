import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod/v4";
import { StrategyEngine } from "../../strategy/engine.js";
import { listStrategies, listStrategiesByRole } from "../../store/strategies.js";
import { responses } from "../response-schemas.js";

const strategyQuerySchema = z.object({
  role: z.string().optional(),
  taskType: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).default(50),
});

export async function strategyRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /strategies
  fastify.get("/strategies", {
    schema: {
      tags: ["Strategies"],
      summary: "List strategies",
      description: "List agent strategies with optional role/taskType filter. Returns evolutionary strategy entries used for agent routing.",
      querystring: {
        type: "object",
        properties: {
          role: { type: "string", description: "Filter by role ID" },
          taskType: { type: "string", description: "Filter by task type" },
          limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
        },
      },
      response: responses.strategyList,
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parse = strategyQuerySchema.safeParse(request.query);
    if (!parse.success) {
      return reply.status(400).send({ code: "VALIDATION_ERROR", message: z.prettifyError(parse.error) });
    }

    const { role, taskType, limit } = parse.data;

    let strategies;
    if (role && taskType) {
      strategies = StrategyEngine.getStrategies(role, taskType);
    } else if (role) {
      strategies = listStrategiesByRole(role);
    } else {
      strategies = listStrategies(limit);
    }

    return { strategies: strategies.slice(0, limit) };
  });

  // Removed: GET /strategies/:role/:taskType/probabilities (DP-001: no UI consumer, internal debugging only)
}
