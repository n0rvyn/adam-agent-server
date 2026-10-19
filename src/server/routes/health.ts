import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { ServerConfig } from "../../shared/types.js";
import { getDb } from "../../store/db.js";
import { listRoles } from "../../store/roles.js";
import { listTasks, getTotalCostSince } from "../../store/tasks.js";
import { isModelAvailable } from "../../lib/embedding.js";
import { responses } from "../response-schemas.js";
import { getRuntimeConfig } from "../../config/runtime.js";
import { getVersion, getName } from "../../lib/version.js";
import { getStartOfDayMs } from "../../lib/time.js";
import { getIntentEvalStats } from "../../audit/intent-eval.js";
import { getLegacyMcpServersSnapshot } from "../../extensions/legacy-mcp-servers-scanner.js";

export async function healthRoutes(
  fastify: FastifyInstance,
  config: ServerConfig,
): Promise<void> {
  // GET /healthz
  fastify.get(
    "/healthz",
    {
      schema: {
        tags: ["Health"],
        summary: "Health check",
        description: "Basic liveness probe. Returns 200 if the server process is running.",
        response: responses.healthz,
      },
    },
    async (_request: FastifyRequest, _reply: FastifyReply) => {
      return { status: "ok" };
    },
  );

  // GET /readyz
  fastify.get(
    "/readyz",
    {
      schema: {
        tags: ["Health"],
        summary: "Readiness check",
        description: "Readiness probe that checks database, roles, config, embedding model, and task hub. Returns 503 if any check fails.",
        response: responses.readyz,
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const checks: Record<string, boolean> = {
        database: false,
        manager: false,
        config: false,
      };

      // Check database
      try {
        const db = getDb();
        db.prepare("SELECT 1").get();
        checks.database = true;
      } catch {
        checks.database = false;
      }

      // Check Manager Agent (present if server started)
      checks.manager = true;

      // Check config
      checks.config = !!config.server;

      // Check agents
      try {
        const agents = listRoles(undefined, 1, 0);
        checks.agents = agents.length > 0;
      } catch {
        checks.agents = false;
      }

      // Check embedding model (attempt to see if pipeline can initialize)
      checks.embedding = isModelAvailable();

      // Bree engine assumed ready if server started successfully
      checks.taskHub = true;

      const allReady = Object.values(checks).every((v) => v);

      if (!allReady) {
        return reply.status(503).send({
          status: "not_ready",
          checks,
          legacy_mcp_servers_count: getLegacyMcpServersSnapshot().count,
        });
      }

      return {
        status: "ready",
        checks,
        legacy_mcp_servers_count: getLegacyMcpServersSnapshot().count,
      };
    },
  );

  // GET /stats — runtime statistics including execution pool status
  fastify.get(
    "/stats",
    {
      schema: {
        tags: ["Health"],
        summary: "Runtime statistics",
        description: "Returns execution pool status, active/pending task counts, and cost summary.",
      },
    },
    async (_request: FastifyRequest, _reply: FastifyReply) => {
      const runtimeConfig = getRuntimeConfig();
      const maxConcurrent = runtimeConfig.execution?.maxConcurrent ?? 5;
      const runningTasks = listTasks("running");
      const pendingTasks = listTasks("pending");

      const totalCostToday = getTotalCostSince(getStartOfDayMs());
      const { intentEvalDegradedToday, intentEvalBudgetUsd } = getIntentEvalStats();

      return {
        executionPool: {
          active: runningTasks.length,
          max: maxConcurrent,
          queued: pendingTasks.length,
        },
        totalCostToday,
        intentEvalDegradedToday,
        intentEvalBudgetUsd,
      };
    },
  );

  // GET /version
  fastify.get(
    "/version",
    {
      schema: {
        tags: ["Health"],
        summary: "Server version",
        description: "Returns the server version from package.json.",
        response: {
          200: {
            type: "object",
            properties: {
              name: { type: "string" },
              version: { type: "string" },
            },
          },
        },
      },
    },
    async (_request: FastifyRequest, _reply: FastifyReply) => {
      return { name: getName(), version: getVersion() };
    },
  );
}
