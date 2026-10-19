/**
 * Unit tests for entity_mutation receipts written by task tools.
 * Verifies writeMutationReceipt is called with correct verb/entityType/entityId/fieldChanges
 * for cancel_task (adam-tools) and report_blocked (execution-tools).
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { setupTestDb, getTestDb, clearTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();
afterAll(() => cleanup());

// Mock DB so stores hit the in-memory test DB
vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

// Mock the SDK tool factory
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

// Mock mutation-receipt-writer to capture call arguments
let mockCalls: Array<{
  toolName: string;
  entityType: string;
  verb: string;
  entityId?: string;
  fieldChanges?: Array<{ path: string; op: string; before: unknown; after: unknown }>;
}> = [];

const { mockWriteMutationReceipt } = vi.hoisted(() => {
  const mockWriteMutationReceipt = vi.fn((input) => {
    mockCalls.push({ toolName: input.toolName, entityType: input.entityType, verb: input.verb, entityId: input.entityId, fieldChanges: input.fieldChanges });
  });
  return { mockWriteMutationReceipt };
});

vi.mock("../../audit/mutation-receipt-writer.js", () => ({
  writeMutationReceipt: mockWriteMutationReceipt,
}));

// Mock serverBus to avoid emit errors
vi.mock("../../server/events/server-bus.js", () => ({
  serverBus: { emit: vi.fn() },
}));

// Mock bree-engine to avoid real scheduling
vi.mock("../../scheduler/bree-engine.js", () => ({
  getBreeEngine: vi.fn().mockReturnValue(null),
}));

// Mock task-dispatch to avoid real task creation
vi.mock("../../lib/task-dispatch.js", () => ({
  createTaskWithAdmission: vi.fn(),
}));

// Mock config
vi.mock("../../config/runtime.js", () => ({
  getRuntimeConfig: vi.fn().mockReturnValue({ defaults: {} }),
}));

const { withTrace } = await import("../../lib/trace-context.js");
const { createAdamTools } = await import("../../manager/adam-tools.js");
const { createTask } = await import("../../store/tasks.js");
const { getTask } = await import("../../store/tasks.js");
const { initializeDefaultRoles } = await import("../../store/role-presets.js");
const { getRoleByName } = await import("../../store/roles.js");

describe("task tool receipts (adam-tools)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWriteMutationReceipt.mockClear();
    mockWriteMutationReceipt.mockImplementation((input) => {
      mockCalls.push({ toolName: input.toolName, entityType: input.entityType, verb: input.verb, entityId: input.entityId, fieldChanges: input.fieldChanges });
    });
    mockCreateSdkMcpServer.mockClear();
    mockTool.mockClear();
    mockCalls.length = 0;
    clearTestDb();
    initializeDefaultRoles();
  });

  let cachedTools: Array<{ name: string; handler: (args: unknown) => unknown }> = [];

  function getTool(name: string) {
    createAdamTools();
    const config = mockCreateSdkMcpServer.mock.calls.at(-1)![0] as { tools: Array<{ name: string; handler: (args: unknown) => unknown }> };
    cachedTools = config.tools;
    return cachedTools.find((t) => t.name === name);
  }

  function parseResult(result: unknown) {
    return JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
  }

  describe("assign_role", () => {
    it("writes entity_mutation receipt with verb=update, entityType=task, fieldChanges roleId set", async () => {
      const role = getRoleByName("Engineer");
      const otherRole = getRoleByName("Researcher");
      expect(role).toBeDefined();
      expect(otherRole).toBeDefined();
      createTask({
        id: "task-assign-test",
        prompt: "Test task assign",
        roleId: role!.id,
        status: "pending",
        config: { timeout: 30000, approvalRequired: [], approvalTimeout: 60000 },
        createdAt: Date.now(),
      });

      const tool = getTool("assign_role");
      expect(tool).toBeDefined();

      const traceId = "trace-assign-1";
      await withTrace(traceId, "manual", async () => {
        const result = await tool!.handler({ taskId: "task-assign-test", roleId: otherRole!.id });
        const parsed = parseResult(result);
        expect(parsed.error).toBeUndefined();
        expect(parsed.success).toBe(true);

        const call = mockCalls.find((c) => c.toolName === "assign_role");
        expect(call).toBeDefined();
        expect(call!.verb).toBe("update");
        expect(call!.entityType).toBe("task");
        expect(call!.entityId).toBe("task-assign-test");
        expect(call!.fieldChanges).toBeDefined();

        const roleChange = call!.fieldChanges!.find((fc) => fc.path === "roleId");
        expect(roleChange).toBeDefined();
        expect(roleChange!.before).toBe(role!.id);
        expect(roleChange!.after).toBe(otherRole!.id);
      });
    });
  });

  describe("cancel_task", () => {
    it("writes entity_mutation receipt with verb=cancel, entityType=task", async () => {
      const role = getRoleByName("Engineer");
      expect(role).toBeDefined();
      createTask({
        id: "task-cancel-test",
        prompt: "Test task",
        roleId: role!.id,
        status: "running",
        config: { timeout: 30000, approvalRequired: [], approvalTimeout: 60000 },
        createdAt: Date.now(),
      });

      const tool = getTool("cancel_task");
      expect(tool).toBeDefined();

      const traceId = "trace-cancel-1";
      await withTrace(traceId, "manual", async () => {
        const result = await tool!.handler({ taskId: "task-cancel-test" });
        const parsed = parseResult(result);
        expect(parsed.error).toBeUndefined();
        expect(parsed.success).toBe(true);

        const call = mockCalls.find((c) => c.toolName === "cancel_task");
        expect(call).toBeDefined();
        expect(call!.verb).toBe("cancel");
        expect(call!.entityType).toBe("task");
        expect(call!.entityId).toBe("task-cancel-test");
        expect(call!.fieldChanges).toBeDefined();

        const statusChange = call!.fieldChanges!.find((fc) => fc.path === "status");
        expect(statusChange).toBeDefined();
        expect(statusChange!.before).toBe("running");
        expect(statusChange!.after).toBe("cancelled");

        const completedAtChange = call!.fieldChanges!.find((fc) => fc.path === "completedAt");
        expect(completedAtChange).toBeDefined();
        expect(completedAtChange!.after).toBeDefined();
      });
    });
  });
});

describe("task tool receipts (execution-tools)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWriteMutationReceipt.mockClear();
    mockWriteMutationReceipt.mockImplementation((input) => {
      mockCalls.push({ toolName: input.toolName, entityType: input.entityType, verb: input.verb, entityId: input.entityId, fieldChanges: input.fieldChanges });
    });
    mockCalls.length = 0;
    // No initializeDefaultRoles() — roles already seeded by the first describe block's beforeEach
  });

  it("report_blocked writes entity_mutation receipt with verb=update, entityType=task", async () => {
    // Seed a running task
    const role = getRoleByName("Engineer");
    expect(role).toBeDefined();
    createTask({
      id: "task-blocked-test",
      prompt: "Test task",
      roleId: role!.id,
      status: "running",
      config: { timeout: 30000, approvalRequired: [], approvalTimeout: 60000 },
      createdAt: Date.now(),
    });
    expect(getTask("task-blocked-test")).toBeDefined();

    const { createExecutionTools } = await import("../../manager/execution-tools.js");

    const traceId = "trace-blocked-1";
    await withTrace(traceId, "manual", async () => {
      const server = createExecutionTools(role!.id, "task-blocked-test") as unknown as {
        tools: Array<{ name: string; handler: (args: unknown) => Promise<unknown> }>;
      };
      const reportBlocked = server.tools.find((t) => t.name === "report_blocked");
      expect(reportBlocked).toBeDefined();

      const result = await reportBlocked!.handler({
        reason: "missing_credential",
        missingPrereqs: ["MINIMAX_API_KEY"],
        resumeHint: "Set MINIMAX_API_KEY in role env",
      });
      const parsed = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
      expect(parsed.error).toBeUndefined();
      expect(parsed.success).toBe(true);

      const call = mockCalls.find((c) => c.toolName === "report_blocked");
      expect(call).toBeDefined();
      expect(call!.verb).toBe("update");
      expect(call!.entityType).toBe("task");
      expect(call!.entityId).toBe("task-blocked-test");
      expect(call!.fieldChanges).toBeDefined();

      const statusChange = call!.fieldChanges!.find((fc) => fc.path === "status");
      expect(statusChange).toBeDefined();
      expect(statusChange!.before).toBe("running");
      expect(statusChange!.after).toBe("blocked");

      const blockReasonChange = call!.fieldChanges!.find((fc) => fc.path === "blockReason");
      expect(blockReasonChange).toBeDefined();
      expect(blockReasonChange!.after).toBe("missing_credential");

      const completedAtChange = call!.fieldChanges!.find((fc) => fc.path === "completedAt");
      expect(completedAtChange).toBeDefined();
    });
  });
});
