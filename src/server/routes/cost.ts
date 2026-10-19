import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { getCostSummary, getCostDetail } from "../../store/llm-costs.js";
import type { CostSummaryParams, CostDetailParams } from "../../store/llm-costs.js";
import { getConfigValue } from "../../store/config.js";

export async function costRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /cost/summary
  fastify.get(
    "/cost/summary",
    {
      schema: {
        tags: ["Cost"],
        summary: "Aggregated LLM cost summary",
        description: "Returns grouped cost sums for a time window, including unpriced call accounting.",
        querystring: {
          type: "object",
          required: ["from", "to", "groupBy", "granularity"],
          properties: {
            from: { type: "integer", description: "Start of window (epoch ms)" },
            to: { type: "integer", description: "End of window (epoch ms)" },
            groupBy: { type: "string", enum: ["model", "role", "source", "date"] },
            granularity: { type: "string", enum: ["day", "week", "month"] },
            tzOffsetMinutes: { type: "integer", description: "Minutes east of UTC for local-day bucketing (e.g. UTC+8 → 480). Default 0." },
            trendStackBy: { type: "string", enum: ["source", "model"], description: "When set, also return a per-bucket cost series split by this dimension." },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{
        Querystring: { from: number; to: number; groupBy: string; granularity: string; tzOffsetMinutes?: number; trendStackBy?: string };
      }>,
      _reply: FastifyReply,
    ) => {
      const { from, to, groupBy, granularity, tzOffsetMinutes, trendStackBy } = request.query;
      const params: CostSummaryParams = {
        from: Number(from),
        to: Number(to),
        groupBy: groupBy as CostSummaryParams["groupBy"],
        granularity: granularity as CostSummaryParams["granularity"],
        ...(tzOffsetMinutes !== undefined ? { tzOffsetMinutes: Number(tzOffsetMinutes) } : {}),
        ...(trendStackBy !== undefined ? { trendStackBy: trendStackBy as CostSummaryParams["trendStackBy"] } : {}),
      };
      const thresholdUsd = Number(getConfigValue("cost.dailyThresholdUsd") ?? 0) || 0;
      const summary = await getCostSummary(params);
      return { ...summary, thresholdUsd };
    },
  );

  // GET /cost/detail
  fastify.get(
    "/cost/detail",
    {
      schema: {
        tags: ["Cost"],
        summary: "Per-call detail for a cost group",
        description: "Returns individual calls for a given group key (for inline drill-down).",
        querystring: {
          type: "object",
          required: ["groupBy", "groupKey", "from", "to"],
          properties: {
            groupBy: { type: "string", enum: ["model", "role", "source", "date"] },
            groupKey: { type: "string" },
            from: { type: "integer" },
            to: { type: "integer" },
            tzOffsetMinutes: { type: "integer", description: "Minutes east of UTC for date-group local-day matching. Default 0." },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{
        Querystring: { groupBy: string; groupKey: string; from: number; to: number; tzOffsetMinutes?: number };
      }>,
      _reply: FastifyReply,
    ) => {
      const { groupBy, groupKey, from, to, tzOffsetMinutes } = request.query;
      const params: CostDetailParams = {
        groupBy: groupBy as CostDetailParams["groupBy"],
        groupKey,
        from: Number(from),
        to: Number(to),
        ...(tzOffsetMinutes !== undefined ? { tzOffsetMinutes: Number(tzOffsetMinutes) } : {}),
      };
      return getCostDetail(params);
    },
  );
}
