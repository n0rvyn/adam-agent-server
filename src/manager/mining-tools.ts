/**
 * Feature-miner-specific MCP server.
 *
 * Provides a single tool: record_feature_request.
 * Only injected into ExecutionManager when role.presetId === "feature-miner"
 * (via role-mcp-registry.ts). No other Roles receive this MCP.
 */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { createFeatureRequest } from "../store/feature-requests.js";
import { v4 as uuidv4 } from "uuid";

// ---------------------------------------------------------------------------
// Tool schemas (plain objects, matching adam-tools.ts pattern)
// ---------------------------------------------------------------------------

const recordFeatureRequestShape = {
  /** The extracted feature request content. Max 5000 characters. */
  content: z.string().min(1).max(5000),
  /** Short one-line summary of the request. Max 500 chars. */
  summary: z.string().max(500).optional(),
  /** Array of category tags (max 10 tags, each max 50 chars). */
  tags: z.array(z.string().max(50)).max(10).optional(),
  /** Verbatim quote from the user showing the feature request. Max 1000 chars. */
  evidenceQuote: z.string().max(1000).optional(),
  /** ID of the chat session where this feature request was found. */
  sourceSessionId: z.string().optional(),
  /** ID of the specific chat message within the session. */
  sourceMessageId: z.string().optional(),
};

type RecordFeatureRequestArgs = {
  content: string;
  summary?: string;
  tags?: string[];
  evidenceQuote?: string;
  sourceSessionId?: string;
  sourceMessageId?: string;
};

// ---------------------------------------------------------------------------
// Tool implementation
// ---------------------------------------------------------------------------

function buildRecordFeatureRequestTool(roleId: string) {
  return tool(
    "record_feature_request",
    "Record a feature request extracted from chat sessions. Call this once per distinct feature request found in the provided chat data. Do not fabricate — only record requests that appear verbatim or clearly in the chat content.",
    recordFeatureRequestShape,
    async (args: unknown) => {
      const parsed = z.object(recordFeatureRequestShape).safeParse(args);
      if (!parsed.success) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: parsed.error.message }) }],
        };
      }
      const a: RecordFeatureRequestArgs = parsed.data;
      const now = Date.now();
      const id = uuidv4();
      const req = {
        id,
        content: a.content,
        summary: a.summary,
        status: "new" as const,
        tags: a.tags ?? [],
        evidenceQuote: a.evidenceQuote,
        sourceSessionId: a.sourceSessionId,
        sourceMessageId: a.sourceMessageId,
        extractedByRoleId: roleId,
        extractedAt: now,
        createdAt: now,
        updatedAt: now,
      };
      try {
        createFeatureRequest(req);
      } catch {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "failed to write feature request" }) }],
        };
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ success: true, featureRequestId: id, summary: a.summary ?? a.content.slice(0, 80) }) }],
      };
    },
  );
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export const KNOWN_PRESET_MCP_SERVERS = ["mining-tools", "audit-tools"] as const;

export function createMiningTools(roleId: string) {
  return createSdkMcpServer({
    name: "mining-tools",
    version: "1.0.0",
    tools: [buildRecordFeatureRequestTool(roleId)],
  });
}
