/**
 * Unit tests for adam-tools query_execution_status.
 * Task 6 of Phase C: chatmanager-truth plan.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { setupTestDb, getTestDb, clearTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

// Mock DB so stores hit the in-memory test DB
vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

// Mock the SDK (must use vi.hoisted so the factory can reference the mocks at parse time)
const { mockCreateSdkMcpServer, mockTool } = vi.hoisted(() => {
  const mockCreateSdkMcpServer = vi.fn().mockImplementation((config: unknown) => config);
  const mockTool = vi.fn().mockImplementation((name: string, description: string, schema: unknown, handler: unknown) => ({
    name,
    description,
    inputSchema: schema,
    handler,
  }));
  return { mockCreateSdkMcpServer, mockTool };
});

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: mockCreateSdkMcpServer,
  tool: mockTool,
}));

// Dynamically import adam-tools AFTER mocks are set up
const { createAdamTools } = await import("../../manager/adam-tools.js");

// Import real store for result verification
const { createTemplateExecution, updateTemplateExecution } = await import("../../store/template-executions.js");
const { createDeliveryLog } = await import("../../store/delivery-log.js");
const { createDeliveryRule } = await import("../../store/delivery-rules.js");
const { createTaskTemplate } = await import("../../store/task-templates.js");

function seedTaskTemplate(id: string) {
  createTaskTemplate({
    id,
    name: `test-template-${id}`,
    description: "Test template",
    trigger: { type: "manual" },
    steps: [{
      id: `${id}-step-1`,
      prompt: "Test step",
      requirements: { tools: [] },
      autoSelectRole: true,
    }],
    enabled: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
}

function seedDeliveryRule() {
  createDeliveryRule({
    id: "rule-seed",
    eventType: "task_complete",
    matchCriteria: {},
    target: { type: "channel", channelId: "default" },
    maxPerMinute: 60,
    skipOriginChannel: false,
    enabled: true,
    createdAt: Date.now(),
  });
}

function getTool(name: string) {
  createAdamTools();
  const config = mockCreateSdkMcpServer.mock.calls[0][0];
  return config.tools.find((t: { name: string }) => t.name === name);
}

async function callTool(tool: { handler: (args: unknown) => Promise<unknown> }, args: unknown) {
  const result = await tool.handler(args) as { content: Array<{ text: string }> };
  return JSON.parse(result.content[0].text);
}

describe("query_execution_status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateSdkMcpServer.mockClear();
    clearTestDb();
    seedDeliveryRule();
  });

  afterAll(() => cleanup());

  it("unknown executionId returns error", async () => {
    const tool = getTool("query_execution_status");
    expect(tool).toBeDefined();
    const result = await callTool(tool, { executionId: "nonexistent-exec" });
    expect(result.error).toContain("Execution not found");
  });

  it("known executionId returns template_execution fields", async () => {
    const execId = "exec-known";
    const tmplId = "tmpl-known";
    const now = Date.now();
    seedTaskTemplate(tmplId);
    createTemplateExecution(execId, tmplId);
    updateTemplateExecution(execId, {
      status: "completed",
      completedAt: now,
    });

    const tool = getTool("query_execution_status");
    const result = await callTool(tool, { executionId: execId });
    expect(result.id).toBe(execId);
    expect(result.templateId).toBe(tmplId);
    expect(result.status).toBe("completed");
    expect(result.completedAt).toBe(now);
  });

  it("deliveryCounts.delivered=5 and deliveryCounts.failed=1 for execution with 6 delivery rows", async () => {
    const execId = "exec-with-deliveries";
    const tmplId = "tmpl-deliveries";
    const now = Date.now();
    seedTaskTemplate(tmplId);
    createTemplateExecution(execId, tmplId);
    updateTemplateExecution(execId, { status: "completed", completedAt: now });

    // 5 delivered
    for (let i = 0; i < 5; i++) {
      createDeliveryLog({
        id: `dl-d-${i}`, ruleId: "rule-seed", executionId: execId,
        status: "delivered", target: { type: "channel", channelId: `ch-${i}` },
        attempts: 0,
        content: "ok", createdAt: now - i * 60_000, expiresAt: now + 86_400_000,
      });
    }
    // 1 failed
    createDeliveryLog({
      id: "dl-f-0", ruleId: "rule-seed", executionId: execId,
      status: "failed", target: { type: "channel", channelId: "ch-fail" },
      attempts: 0,
      content: "err", createdAt: now - 10_000, expiresAt: now + 86_400_000,
      error: "connection refused",
    });

    const tool = getTool("query_execution_status");
    const result = await callTool(tool, { executionId: execId });
    expect(result.deliveryCounts.delivered).toBe(5);
    expect(result.deliveryCounts.failed).toBe(1);
  });

  it("returned object does NOT include a receiptCounts field", async () => {
    const execId = "exec-no-receipt";
    const tmplId = "tmpl-no-receipt";
    seedTaskTemplate(tmplId);
    createTemplateExecution(execId, tmplId);

    const tool = getTool("query_execution_status");
    const result = await callTool(tool, { executionId: execId });
    expect(Object.keys(result)).not.toContain("receiptCounts");
    expect(result).toHaveProperty("deliveryCounts");
  });
});
