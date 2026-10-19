/**
 * Unit tests for entity_mutation receipts written by template tools.
 * Verifies writeMutationReceipt is called with correct verb/entityType/entityId/fieldChanges.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { setupTestDb, getTestDb, clearTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

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

// Mock the mutation-receipt-writer to capture call arguments
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
const { getTaskTemplate } = await import("../../store/task-templates.js");
const { initializeDefaultRoles } = await import("../../store/role-presets.js");
const { getRoleByName } = await import("../../store/roles.js");

describe("template tool receipts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWriteMutationReceipt.mockClear();
    mockWriteMutationReceipt.mockImplementation((input) => {
      mockCalls.push({ toolName: input.toolName, entityType: input.entityType, verb: input.verb, entityId: input.entityId, fieldChanges: input.fieldChanges });
    });
    mockCreateSdkMcpServer.mockClear();
    mockTool.mockClear();
    // Mutate in place so the mock's closure still references the same array object
    mockCalls.length = 0;
    clearTestDb();
    initializeDefaultRoles();
  });

  afterAll(() => cleanup());

  const mockCalls: Array<{
    toolName: string;
    entityType: string;
    verb: string;
    entityId?: string;
    fieldChanges?: Array<{ path: string; op: string; before: unknown; after: unknown }>;
  }> = [];

  let cachedTools: Array<{ name: string; handler: (args: unknown) => unknown }> = [];

  function getTool(name: string) {
    createAdamTools();
    const config = mockCreateSdkMcpServer.mock.calls.at(-1)![0];
    cachedTools = config.tools;
    return cachedTools.find((t) => t.name === name);
  }

  function parseResult(result: unknown) {
    return JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
  }

  describe("create_template", () => {
    it("writes entity_mutation receipt with verb=create, entityType=task_template", async () => {
      const tool = getTool("create_template");
      expect(tool).toBeDefined();

      const traceId = "trace-ct-1";
      await withTrace(traceId, "manual", async () => {
        const result = await tool!.handler({
          name: "Test Template",
          prompt: "do the thing",
          autoSelectRole: true,
          requirements: {},
        });
        const parsed = parseResult(result);
        expect(parsed.error).toBeUndefined();

        // Verify receipt was called
        const call = mockCalls.find((c) => c.toolName === "create_template");
        expect(call).toBeDefined();
        expect(call!.verb).toBe("create");
        expect(call!.entityType).toBe("task_template");
        expect(call!.entityId).toBeDefined();
        expect(call!.fieldChanges).toBeDefined();
        expect(call!.fieldChanges!.length).toBeGreaterThan(0);
        expect(call!.fieldChanges![0].path).toBe("_entity");
        expect(call!.fieldChanges![0].op).toBe("set");
        expect(call!.fieldChanges![0].before).toBeNull();
        expect(call!.fieldChanges![0].after).toBeDefined();
        expect((call!.fieldChanges![0].after as Record<string, unknown>).name).toBe("Test Template");
      });
    });
  });

  describe("update_template", () => {
    it("writes receipt with verb=update and fieldChanges containing the updated name", async () => {
      // First create a template to update
      const createTool = getTool("create_template");
      const createResult = await createTool!.handler({
        name: "Original Name",
        prompt: "do the thing",
        autoSelectRole: true,
        requirements: {},
      });
      const created = parseResult(createResult);
      const templateId = created.templateId;

      // Now update it
      const tool = getTool("update_template");
      expect(tool).toBeDefined();

      const traceId = "trace-ut-1";
      await withTrace(traceId, "manual", async () => {
        const result = await tool!.handler({ templateId, name: "Updated Name" });
        const parsed = parseResult(result);
        expect(parsed.error).toBeUndefined();

        const call = mockCalls.find((c) => c.toolName === "update_template");
        expect(call).toBeDefined();
        expect(call!.verb).toBe("update");
        expect(call!.entityType).toBe("task_template");
        expect(call!.entityId).toBe(templateId);
        // name fieldChange should be present with before/after
        const nameChange = call!.fieldChanges!.find((fc) => fc.path === "name");
        expect(nameChange).toBeDefined();
        expect(nameChange!.before).toBe("Original Name");
        expect(nameChange!.after).toBe("Updated Name");
      });
    });
  });

  describe("delete_template", () => {
    it("writes receipt with verb=delete, after=null, and before=snapshot", async () => {
      // First create a template to delete
      const createTool = getTool("create_template");
      const createResult = await createTool!.handler({
        name: "To Be Deleted",
        prompt: "do the thing",
        autoSelectRole: true,
        requirements: {},
      });
      const created = parseResult(createResult);
      const templateId = created.templateId;

      // Now delete it
      const tool = getTool("delete_template");
      expect(tool).toBeDefined();

      const traceId = "trace-dt-1";
      await withTrace(traceId, "manual", async () => {
        const result = await tool!.handler({ templateId, mode: "template_only" });
        const parsed = parseResult(result);
        expect(parsed.error).toBeUndefined();
        expect(parsed.success).toBe(true);

        const call = mockCalls.find((c) => c.toolName === "delete_template");
        expect(call).toBeDefined();
        expect(call!.verb).toBe("delete");
        expect(call!.entityType).toBe("task_template");
        expect(call!.entityId).toBe(templateId);
        expect(call!.fieldChanges).toBeDefined();
        expect(call!.fieldChanges![0].path).toBe("_entity");
        expect(call!.fieldChanges![0].op).toBe("set");
        expect(call!.fieldChanges![0].after).toBeNull();
        expect(call!.fieldChanges![0].before).toBeDefined();
      });
    });
  });

  describe("run_template", () => {
    it("writes receipt with verb=create, entityType=template_execution, triggeredBy=manual", async () => {
      // First create a template to run
      const createTool = getTool("create_template");
      const createResult = await createTool!.handler({
        name: "Runnable Template",
        prompt: "do the thing",
        autoSelectRole: true,
        requirements: {},
      });
      const created = parseResult(createResult);
      const templateId = created.templateId;

      const tool = getTool("run_template");
      expect(tool).toBeDefined();

      const traceId = "trace-rt-1";
      await withTrace(traceId, "manual", async () => {
        const result = await tool!.handler({ templateId });
        const parsed = parseResult(result);
        expect(parsed.error).toBeUndefined();
        expect(parsed.executionId).toBeDefined();

        const call = mockCalls.find((c) => c.toolName === "run_template");
        expect(call).toBeDefined();
        expect(call!.verb).toBe("create");
        expect(call!.entityType).toBe("template_execution");
        expect(call!.entityId).toBe(parsed.executionId);
        expect(call!.fieldChanges).toBeDefined();
        expect(call!.fieldChanges![0].path).toBe("_entity");
        expect(call!.fieldChanges![0].op).toBe("set");
        expect(call!.fieldChanges![0].after).toBeDefined();
        const after = call!.fieldChanges![0].after as Record<string, unknown>;
        expect(after.triggeredBy).toBe("manual");
        expect(after.templateId).toBe(templateId);
        expect(after.executionId).toBe(parsed.executionId);
      });
    });
  });

  describe("cancel_scheduled_task", () => {
    it("writes receipt with verb=cancel, entityType=task_template, fieldChange path=enabled", async () => {
      // Seed and look up the Engineer role's actual ID
      initializeDefaultRoles();
      const engineerRole = getRoleByName("Engineer");
      expect(engineerRole).toBeDefined();
      const roleId = engineerRole!.id;

      // First create a scheduled task to cancel
      const scheduleTool = getTool("schedule_task");
      const schedResult = await scheduleTool!.handler({
        roleId,
        prompt: "scheduled task to cancel",
        delayMinutes: 60,
      });
      const sched = parseResult(schedResult);
      expect(sched.error).toBeUndefined();
      const templateId = sched.templateId;

      const tool = getTool("cancel_scheduled_task");
      expect(tool).toBeDefined();

      const traceId = "trace-cst-1";
      await withTrace(traceId, "manual", async () => {
        const result = await tool!.handler({ templateId });
        const parsed = parseResult(result);
        expect(parsed.error).toBeUndefined();
        expect(parsed.cancelled).toBe(true);

        const call = mockCalls.find((c) => c.toolName === "cancel_scheduled_task");
        expect(call).toBeDefined();
        expect(call!.verb).toBe("cancel");
        expect(call!.entityType).toBe("task_template");
        expect(call!.entityId).toBe(templateId);
        expect(call!.fieldChanges).toBeDefined();
        const enabledChange = call!.fieldChanges!.find((fc) => fc.path === "enabled");
        expect(enabledChange).toBeDefined();
        expect(enabledChange!.before).toBe(true);
        expect(enabledChange!.after).toBe(false);
      });
    });
  });

  describe("schedule_task", () => {
    it("writes receipt with verb=create, entityType=task_template, trigger.type=once", async () => {
      // Seed and look up the Engineer role's actual ID
      initializeDefaultRoles();
      const engineerRole = getRoleByName("Engineer");
      expect(engineerRole).toBeDefined();
      const roleId = engineerRole!.id;

      const tool = getTool("schedule_task");
      expect(tool).toBeDefined();

      const traceId = "trace-st-1";
      await withTrace(traceId, "manual", async () => {
        const result = await tool!.handler({
          roleId,
          prompt: "scheduled task instruction",
          delayMinutes: 30,
        });
        const parsed = parseResult(result);
        expect(parsed.error).toBeUndefined();
        const templateId = parsed.templateId;

        const call = mockCalls.find((c) => c.toolName === "schedule_task");
        expect(call).toBeDefined();
        expect(call!.verb).toBe("create");
        expect(call!.entityType).toBe("task_template");
        expect(call!.entityId).toBe(templateId);
        expect(call!.fieldChanges).toBeDefined();
        expect(call!.fieldChanges![0].path).toBe("_entity");
        expect(call!.fieldChanges![0].op).toBe("set");
        const after = call!.fieldChanges![0].after as Record<string, unknown>;
        expect(after.templateId).toBe(templateId);
        expect(after.trigger).toBeDefined();
        expect((after.trigger as Record<string, unknown>).type).toBe("once");
        expect(after.roleId).toBe(roleId);
      });
    });
  });

  describe("migrate_template_outputAs", () => {
    it("writes receipt with verb=update, fieldChanges per migrated step", async () => {
      // First create a template with steps
      const createTool = getTool("create_template");
      const createResult = await createTool!.handler({
        name: "Migrate Test",
        steps: [{ id: "step-1", prompt: "do something", autoSelectRole: true, requirements: {} }],
        autoSelectRole: true,
        requirements: {},
      });
      const created = parseResult(createResult);
      expect(created.templateId).toBeDefined(); // sanity check
      const templateId = created.templateId;

      const tool = getTool("migrate_template_outputAs");
      expect(tool).toBeDefined();

      const traceId = "trace-mto-1";
      await withTrace(traceId, "manual", async () => {
        const result = await tool!.handler({
          templateId,
          mapping: { "step-1": "ResultSummary" },
        });
        const parsed = parseResult(result);
        expect(parsed.error).toBeUndefined();

        const call = mockCalls.find((c) => c.toolName === "migrate_template_outputAs");
        expect(call).toBeDefined();
        expect(call!.verb).toBe("update");
        expect(call!.entityType).toBe("task_template");
        expect(call!.entityId).toBe(templateId);
        expect(call!.fieldChanges).toBeDefined();
        const stepChange = call!.fieldChanges!.find((fc) => fc.path === "steps.step-1.outputAs");
        expect(stepChange).toBeDefined();
        expect(stepChange!.before).toBeNull();
        expect(stepChange!.after).toBe("ResultSummary");
      });
    });
  });
});
