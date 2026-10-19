/**
 * Unit tests for commit_claim MCP tool in execution-tools.
 *
 * Verifies:
 * - Tool present when createExecutionTools(roleId, taskId) is called for a normal task
 * - Tool ALSO present when called for a TemplateExecution step task (not filtered out)
 * - Tool invocation persists to assistant_claims with taskId set
 * - Tool invocation without traceId returns structured error
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";
import { withTrace } from "../../lib/trace-context.js";

// Hoisted mock so vi.mock processes before imports
const { mockCreateSdkMcpServer } = vi.hoisted(() => ({
  mockCreateSdkMcpServer: vi.fn().mockImplementation((config: unknown) => config as { tools: unknown[] }),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: mockCreateSdkMcpServer,
  tool: vi.fn((name: string, _desc: string, _schema: unknown, handler: unknown) => ({
    name,
    inputSchema: {},
    handler,
  })),
}));

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

vi.mock("../../server/events/server-bus.js", () => ({
  serverBus: {
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  },
}));

vi.mock("../../config/runtime.js", () => ({
  getRuntimeConfig: vi.fn().mockReturnValue({
    defaults: { maxConcurrent: 5, maxTurns: 50 },
    execution: { maxConcurrent: 5, pollIntervalMs: 30000 },
    watchdog: { enabled: false },
    chat: { sessionTimeoutMinutes: 60, maxSessionTurns: 200 },
  }),
  updateMutableConfig: vi.fn(),
}));

vi.mock("../../agent/memory-service.js", () => ({ queryMemory: vi.fn().mockResolvedValue([]) }));
vi.mock("../../lib/embedding.js", () => ({ generateEmbedding: vi.fn().mockResolvedValue(new Float32Array(768)) }));
vi.mock("../../strategy/engine.js", () => ({ StrategyEngine: vi.fn() }));
vi.mock("../../strategy/generator.js", () => ({ StrategyGenerator: vi.fn() }));
vi.mock("../../sandbox/provider.js", () => ({
  getSandboxProvider: () => ({ platform: "sandbox-exec", isAvailable: async () => true }),
  isSandboxAvailable: vi.fn().mockResolvedValue(true),
}));

const { cleanup } = setupTestDb();

afterAll(() => cleanup());

beforeEach(() => {
  clearTestDb();
  mockCreateSdkMcpServer.mockClear();
});

function parseResult(result: unknown) {
  return JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
}

describe("commit_claim tool in execution-tools", () => {
  it("tool is present for a normal task", async () => {
    const { createExecutionTools } = await import("../../manager/execution-tools.js");
    const server = createExecutionTools("role-test", "task-normal-1") as unknown as { tools: Array<{ name: string }> };
    expect(server.tools.map((t) => t.name)).toContain("commit_claim");
  });

  it("tool is ALSO present for a TemplateExecution step task (not filtered)", async () => {
    const { createExecutionTools } = await import("../../manager/execution-tools.js");
    // Insert a task with parentId+templateId+stepId so isTemplateExecutionStepTask returns true
    getTestDb().prepare(`
      INSERT INTO tasks (id, role_id, status, created_at, step_id, parent_id, template_id, prompt, config)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("tmpl-exec-step-abc123-s1", "role-test", "running", Date.now(), "step-1", "parent-exec-1", "tmpl-1", "", "{}");

    const server = createExecutionTools("role-test", "tmpl-exec-step-abc123-s1") as unknown as { tools: Array<{ name: string }> };
    expect(server.tools.map((t) => t.name)).toContain("commit_claim");
    // list_channels and send_to_channel should be filtered out for template steps
    expect(server.tools.map((t) => t.name)).not.toContain("list_channels");
    expect(server.tools.map((t) => t.name)).not.toContain("send_to_channel");
  });

  it("tool invocation persists to assistant_claims with taskId set", async () => {
    const { createExecutionTools } = await import("../../manager/execution-tools.js");
    const taskId = "task-worker-1";
    const traceId = "trace-exec-1";
    await withTrace(traceId, "template", async () => {
      const server = createExecutionTools("role-test", taskId) as unknown as { tools: Array<{ name: string; handler: (args: unknown) => Promise<unknown> }> };
      const commitClaimTool = server.tools.find((t) => t.name === "commit_claim");
      expect(commitClaimTool).toBeDefined();

      const result = await commitClaimTool!.handler({
        claims: [{
          verb: "update",
          entityType: "task_template",
          expected: { kind: "field_change", entityId: "tpl-1", fieldPath: "cron", op: "set", after: "0 9 * * *" },
        }],
      });

      const parsed = parseResult(result);
      if ("error" in parsed && parsed.error) {
        throw new Error(`Tool returned error: ${parsed.error}`);
      }
      expect(parsed.claimRowId).toBeDefined();
      expect(parsed.claimsCount).toBe(1);

      // Verify persistence
      const { listClaimsByTrace } = await import("../../store/assistant-claims.js");
      const claims = listClaimsByTrace(traceId);
      expect(claims).toHaveLength(1);
      expect(claims[0].taskId).toBe(taskId);
      expect(claims[0].claims[0].verb).toBe("update");
    });
  });

  it("tool invocation without traceId returns structured error", async () => {
    const { createExecutionTools } = await import("../../manager/execution-tools.js");
    const server = createExecutionTools("role-test", "task-no-trace") as unknown as { tools: Array<{ name: string; handler: (args: unknown) => Promise<unknown> }> };
    const commitClaimTool = server.tools.find((t) => t.name === "commit_claim")!;

    // No withTrace wrapping → getCurrentTraceId() returns undefined
    const result = await commitClaimTool.handler({
      claims: [{
        verb: "send",
        entityType: "channel_message",
        expected: { kind: "outbound", target: { channelId: "ch-A" } },
      }],
    });

    const parsed = parseResult(result);
    expect(parsed.error).toContain("active trace context");
  });
});
