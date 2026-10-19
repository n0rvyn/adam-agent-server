import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { listEvolutionAudit, listEvolutionAuditByRole } from "../../store/evolution-audit.js";

export async function evolutionRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /evolution-audit
  fastify.get(
    "/evolution-audit",
    {
      schema: {
        tags: ["Evolution"],
        summary: "List evolution audit records",
        description: "Returns evolution audit log entries with optional role filter.",
        querystring: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
            offset: { type: "integer", minimum: 0, default: 0 },
            roleId: { type: "string" },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{
        Querystring: { limit?: number; offset?: number; roleId?: string };
      }>,
      _reply: FastifyReply,
    ) => {
      const { limit = 20, offset = 0, roleId } = request.query;

      const records = roleId
        ? listEvolutionAuditByRole(roleId, limit, offset)
        : listEvolutionAudit(limit, offset);

      return records;
    },
  );
}
