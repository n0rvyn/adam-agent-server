/**
 * Unit tests for commit_claim MCP tool in adam-tools.
 *
 * Verifies:
 * - Tool invocation with valid outbound claim → persists to assistant_claims
 * - Tool invocation with valid mixed batch (outbound + field_change + batch)
 * - Tool invocation without traceId → structured error
 * - Tool invocation with invalid claim shape → error from validator
 * - Multiple sequential invocations in the same traceId → two rows persisted
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";
import { buildTools } from "../../manager/adam-tools.js";
import type { AdamToolsRuntimeContext } from "../../manager/adam-tools.js";
import { withTrace } from "../../lib/trace-context.js";

const { emittedEvents } = vi.hoisted(() => {
  const emittedEvents: Array<{ type: string; [key: string]: unknown }> = [];
  return { emittedEvents };
});

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

vi.mock("../../server/events/server-bus.js", () => ({
  serverBus: {
    emit: (event: { type: string; [key: string]: unknown }) => { emittedEvents.push(event); },
  },
}));

const { cleanup } = setupTestDb();

afterAll(() => cleanup());

beforeEach(() => {
  clearTestDb();
  emittedEvents.length = 0;
});

function buildDefaultRuntimeContext(sessionId = "s-default"): AdamToolsRuntimeContext {
  return {
    getActiveChatOrigin: () => ({
      source: { type: "channel" as const, channelId: "ch-A" },
      chatSessionId: sessionId,
    }),
  };
}

function parseResult(result: unknown) {
  return JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
}

describe("commit_claim tool in adam-tools", () => {
  it("persists a valid outbound claim to assistant_claims", async () => {
    const traceId = "trace-commit-1";
    await withTrace(traceId, "chat", async () => {
      const tools = buildTools(buildDefaultRuntimeContext("s-1"));
      const commitClaimTool = tools.find((t: { name: string }) => t.name === "commit_claim");
      expect(commitClaimTool).toBeDefined();

      const result = await (commitClaimTool as unknown as { handler: (args: unknown) => Promise<unknown> }).handler({
        claims: [{
          verb: "send",
          entityType: "channel_message",
          expected: {
            kind: "outbound",
            target: { channelId: "ch-A" },
            attachmentCount: 3,
            textPresent: true,
          },
        }],
      });

      const parsed = parseResult(result);
      if ("error" in parsed && parsed.error) {
        throw new Error(`Tool returned error: ${parsed.error}`);
      }
      expect(parsed.claimRowId).toBeDefined();
      expect(parsed.claimsCount).toBe(1);
      expect(parsed.declaredAt).toBeDefined();

      // Verify persistence
      const { listClaimsByTrace } = await import("../../store/assistant-claims.js");
      const claims = listClaimsByTrace(traceId);
      expect(claims).toHaveLength(1);
      expect(claims[0].claims).toHaveLength(1);
      expect(claims[0].claims[0].verb).toBe("send");
      expect(claims[0].sessionId).toBe("s-1");
    });
  });

  it("persists a mixed batch with outbound + field_change + batch claims", async () => {
    const traceId = "trace-commit-2";
    await withTrace(traceId, "chat", async () => {
      const tools = buildTools(buildDefaultRuntimeContext("s-2"));
      const commitClaimTool = tools.find((t: { name: string }) => t.name === "commit_claim") as unknown as { handler: (args: unknown) => Promise<unknown> };

      const result = await commitClaimTool.handler({
        claims: [
          {
            verb: "send",
            entityType: "channel_message",
            expected: { kind: "outbound", target: { channelId: "ch-X" } },
          },
          {
            verb: "update",
            entityType: "task_template",
            expected: { kind: "field_change", entityId: "tpl-1", fieldPath: "deliverTo", op: "list_add", added: ["ch-X"] },
          },
          {
            verb: "cancel",
            entityType: "task",
            expected: { kind: "batch", entityType: "task", entityIds: ["task-1", "task-2", "task-3"] },
          },
        ],
      });

      const parsed = parseResult(result);
      if ("error" in parsed && parsed.error) {
        throw new Error(`Tool returned error: ${parsed.error}`);
      }
      expect(parsed.claimsCount).toBe(3);

      const { listClaimsByTrace } = await import("../../store/assistant-claims.js");
      const claims = listClaimsByTrace(traceId);
      expect(claims[0].claims).toHaveLength(3);
      expect(claims[0].claims[0].expected.kind).toBe("outbound");
      expect(claims[0].claims[1].expected.kind).toBe("field_change");
      expect(claims[0].claims[2].expected.kind).toBe("batch");
    });
  });

  it("returns structured error when no traceId is resolvable", async () => {
    // No withTrace wrapping → getCurrentTraceId() returns null/undefined
    const tools = buildTools(buildDefaultRuntimeContext("s-3"));
    const commitClaimTool = tools.find((t: { name: string }) => t.name === "commit_claim") as unknown as { handler: (args: unknown) => Promise<unknown> };

    const result = await commitClaimTool.handler({
      claims: [{ verb: "send", entityType: "channel_message", expected: { kind: "outbound", target: { channelId: "ch-A" } } }],
    });

    const parsed = parseResult(result);
    expect(parsed.error).toContain("active trace context");
  });

  it("returns error when claim has invalid shape (missing target.channelId)", async () => {
    const traceId = "trace-commit-4";
    await withTrace(traceId, "chat", async () => {
      const tools = buildTools(buildDefaultRuntimeContext("s-4"));
      const commitClaimTool = tools.find((t: { name: string }) => t.name === "commit_claim") as unknown as { handler: (args: unknown) => Promise<unknown> };

      // Zod schema rejects this (outbound requires target.channelId)
      const result = await commitClaimTool.handler({
        claims: [{ verb: "send", entityType: "channel_message", expected: { kind: "outbound", target: {} } }],
      });

      const parsed = parseResult(result);
      // Either Zod rejects it at the schema level or writeClaims rejects it in the handler
      expect(parsed.error).toBeDefined();
    });
  });

  it("persists two separate commit_claim calls in the same traceId as two rows", async () => {
    const traceId = "trace-commit-5";
    await withTrace(traceId, "chat", async () => {
      const tools = buildTools(buildDefaultRuntimeContext("s-5"));
      const commitClaimTool = tools.find((t: { name: string }) => t.name === "commit_claim") as unknown as { handler: (args: unknown) => Promise<unknown> };

      await commitClaimTool.handler({
        claims: [{ verb: "send", entityType: "channel_message", expected: { kind: "outbound", target: { channelId: "ch-A" } } }],
      });
      await commitClaimTool.handler({
        claims: [{ verb: "update", entityType: "task_template", expected: { kind: "field_change", entityId: "tpl-1", fieldPath: "cron", op: "set", after: "0 9 * * *" } }],
      });

      const { listClaimsByTrace } = await import("../../store/assistant-claims.js");
      const claims = listClaimsByTrace(traceId);
      expect(claims).toHaveLength(2);
      expect(claims[0].claims[0].expected.kind).toBe("outbound");
      expect(claims[1].claims[0].expected.kind).toBe("field_change");
    });
  });
});
