/**
 * Audit-tools MCP server.
 *
 * Provides a single tool: aggregate_mistakes.
 * Only injected into ExecutionManager when role.presetId === "mistake-digester"
 * (via role-mcp-registry.ts).
 */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { aggregateMistakes } from "../audit/mistake-aggregator.js";
import { MISTAKE_EMA_THRESHOLD, MISTAKE_TASK_THRESHOLD } from "../audit/mistake-aggregator.js";

// ---------------------------------------------------------------------------
// Tool schema
// ---------------------------------------------------------------------------

const aggregateMistakesShape = {
  /**
   * Scan window in days (1-365). Default 14.
   */
  windowDays: z.number().int().min(1).max(365).optional(),
  /**
   * Dimensions to aggregate. Default all three.
   */
  dimensions: z.enum(["event_type", "score_degradation", "tool_call_pattern"])
    .array()
    .min(1)
    .max(3)
    .optional(),
  /**
   * Minimum occurrences of a bucket to qualify. Default 3.
   */
  minOccurrences: z.number().int().min(1).max(100).optional(),
  /**
   * Minimum distinct roles in a bucket to qualify. Default 2.
   */
  minRoles: z.number().int().min(1).max(100).optional(),
};

type AggregateMistakesArgs = {
  windowDays?: number;
  dimensions?: Array<"event_type" | "score_degradation" | "tool_call_pattern">;
  minOccurrences?: number;
  minRoles?: number;
};

// ---------------------------------------------------------------------------
// Tool implementation
// ---------------------------------------------------------------------------

function buildAggregateMistakesTool() {
  return tool(
    "aggregate_mistakes",
    "Aggregate cross-role failure signals from the last N days into mistake patterns. Returns counts + dimensions; patterns are persisted to mistake_patterns for UI review. Notify-only: no role/permission/CAG mutation.",
    aggregateMistakesShape,
    async (args: unknown) => {
      const parsed = z.object(aggregateMistakesShape).safeParse(args);
      if (!parsed.success) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: parsed.error.message }) }],
        };
      }

      const a: AggregateMistakesArgs = parsed.data;

      const opts = {
        windowDays: a.windowDays ?? 14,
        dimensions: a.dimensions ?? ["event_type", "score_degradation", "tool_call_pattern"],
        minOccurrences: a.minOccurrences ?? 3,
        minRoles: a.minRoles ?? 2,
        scoreThresholdEma: MISTAKE_EMA_THRESHOLD,
        scoreThresholdTask: MISTAKE_TASK_THRESHOLD,
      };

      try {
        const result = aggregateMistakes(opts);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ ok: true, ...result }) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: String(err) }) }],
        };
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export const AUDIT_TOOLS_NAME = "audit-tools";

export function createAuditTools() {
  return createSdkMcpServer({
    name: AUDIT_TOOLS_NAME,
    version: "1.0.0",
    tools: [buildAggregateMistakesTool()],
  });
}
