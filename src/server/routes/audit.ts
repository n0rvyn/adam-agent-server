import type { FastifyInstance } from "fastify";
import { getSecurityPosture } from "../../audit/audit-manager.js";

export async function auditRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /audit/posture — returns SecurityPosture for dashboard display
  fastify.get("/audit/posture", async (_request, reply) => {
    const posture = await getSecurityPosture();
    return reply.send(posture);
  });
}
