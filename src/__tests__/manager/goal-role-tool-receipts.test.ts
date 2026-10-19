/**
 * Unit tests for entity_mutation receipts written by goal & role tools.
 * Verifies writeMutationReceipt is called with correct verb/entityType/entityId/fieldChanges.
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

// Mock mutation-receipt-writer
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

// Mock serverBus
vi.mock("../../server/events/server-bus.js", () => ({
  serverBus: { emit: vi.fn() },
}));

// Mock bree-engine
vi.mock("../../scheduler/bree-engine.js", () => ({
  getBreeEngine: vi.fn().mockReturnValue(null),
}));

// Mock task-dispatch
vi.mock("../../lib/task-dispatch.js", () => ({
  createTaskWithAdmission: vi.fn(),
}));

// Mock config
vi.mock("../../config/runtime.js", () => ({
  getRuntimeConfig: vi.fn().mockReturnValue({ defaults: {} }),
}));

const { withTrace } = await import("../../lib/trace-context.js");
const { createAdamTools } = await import("../../manager/adam-tools.js");
const { initializeDefaultRoles } = await import("../../store/role-presets.js");
const { getRoleByName } = await import("../../store/roles.js");
const { getGoal, createGoal } = await import("../../store/goals.js");

describe("goal tool receipts", () => {
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

  it("create_goal writes receipt with verb=create, entityType=goal", async () => {
    const tool = getTool("create_goal");
    expect(tool).toBeDefined();

    const traceId = "trace-cg-1";
    await withTrace(traceId, "manual", async () => {
      const result = await tool!.handler({ name: "Test Goal", description: "Test description" });
      const parsed = parseResult(result);
      expect(parsed.error).toBeUndefined();
      expect(parsed.goalId).toBeDefined();

      const call = mockCalls.find((c) => c.toolName === "create_goal");
      expect(call).toBeDefined();
      expect(call!.verb).toBe("create");
      expect(call!.entityType).toBe("goal");
      expect(call!.entityId).toBe(parsed.goalId);
      expect(call!.fieldChanges).toBeDefined();
      expect(call!.fieldChanges![0].path).toBe("_entity");
      expect(call!.fieldChanges![0].op).toBe("set");
      expect(call!.fieldChanges![0].before).toBeNull();
      expect((call!.fieldChanges![0].after as Record<string, unknown>).name).toBe("Test Goal");
    });
  });

  it("update_goal_state writes receipt with verb=update, entityType=goal, fieldChanges for status", async () => {
    // Seed a goal
    const role = getRoleByName("Engineer");
    expect(role).toBeDefined();
    createGoal({
      id: "goal-update-test",
      name: "Update Test Goal",
      description: "desc",
      roleId: role!.id,
      metricType: "completion",
      targetValue: 1,
      currentValue: 0,
      deadline: Date.now() + 86400000,
      budgetUsd: 5.0,
      status: "active",
      createdAt: Date.now(),
    });
    // createGoal returns void; existence verified by subsequent tool calls.

    const tool = getTool("update_goal_state");
    expect(tool).toBeDefined();

    const traceId = "trace-ugs-1";
    await withTrace(traceId, "manual", async () => {
      const result = await tool!.handler({ goalId: "goal-update-test", status: "paused" });
      const parsed = parseResult(result);
      expect(parsed.error).toBeUndefined();

      const call = mockCalls.find((c) => c.toolName === "update_goal_state");
      expect(call).toBeDefined();
      expect(call!.verb).toBe("update");
      expect(call!.entityType).toBe("goal");
      expect(call!.entityId).toBe("goal-update-test");
      expect(call!.fieldChanges).toBeDefined();
      const statusChange = call!.fieldChanges!.find((fc) => fc.path === "status");
      expect(statusChange).toBeDefined();
      expect(statusChange!.before).toBe("active");
      expect(statusChange!.after).toBe("paused");
    });
  });

  it("pause_goal writes receipt with verb=pause, entityType=goal", async () => {
    const role = getRoleByName("Engineer");
    expect(role).toBeDefined();
    createGoal({
      id: "goal-pause-test",
      name: "Pause Test Goal",
      description: "desc",
      roleId: role!.id,
      metricType: "completion",
      targetValue: 1,
      currentValue: 0,
      deadline: Date.now() + 86400000,
      budgetUsd: 5.0,
      status: "active",
      createdAt: Date.now(),
    });
    // createGoal returns void; existence verified by subsequent tool calls.

    const tool = getTool("pause_goal");
    expect(tool).toBeDefined();

    const traceId = "trace-pg-1";
    await withTrace(traceId, "manual", async () => {
      const result = await tool!.handler({ goalId: "goal-pause-test" });
      const parsed = parseResult(result);
      expect(parsed.error).toBeUndefined();

      const call = mockCalls.find((c) => c.toolName === "pause_goal");
      expect(call).toBeDefined();
      expect(call!.verb).toBe("pause");
      expect(call!.entityType).toBe("goal");
      expect(call!.entityId).toBe("goal-pause-test");
      expect(call!.fieldChanges).toBeDefined();
      const statusChange = call!.fieldChanges!.find((fc) => fc.path === "status");
      expect(statusChange).toBeDefined();
      expect(statusChange!.before).toBe("active");
      expect(statusChange!.after).toBe("paused");
    });
  });

  it("delete_goal writes receipt with verb=delete, entityType=goal, after=null", async () => {
    const role = getRoleByName("Engineer");
    expect(role).toBeDefined();
    createGoal({
      id: "goal-delete-test",
      name: "Delete Test Goal",
      description: "desc",
      roleId: role!.id,
      metricType: "completion",
      targetValue: 1,
      currentValue: 0,
      deadline: Date.now() + 86400000,
      budgetUsd: 5.0,
      status: "active",
      createdAt: Date.now(),
    });
    // createGoal returns void; existence verified by subsequent tool calls.

    const tool = getTool("delete_goal");
    expect(tool).toBeDefined();

    const traceId = "trace-dg-1";
    await withTrace(traceId, "manual", async () => {
      const result = await tool!.handler({ goalId: "goal-delete-test" });
      const parsed = parseResult(result);
      expect(parsed.error).toBeUndefined();

      const call = mockCalls.find((c) => c.toolName === "delete_goal");
      expect(call).toBeDefined();
      expect(call!.verb).toBe("delete");
      expect(call!.entityType).toBe("goal");
      expect(call!.entityId).toBe("goal-delete-test");
      expect(call!.fieldChanges).toBeDefined();
      expect(call!.fieldChanges![0].path).toBe("_entity");
      expect(call!.fieldChanges![0].after).toBeNull();
    });
  });
});

describe("role tool receipts", () => {
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

  it("create_role writes receipt with verb=create, entityType=role", async () => {
    const tool = getTool("create_role");
    expect(tool).toBeDefined();

    const traceId = "trace-cr-1";
    await withTrace(traceId, "manual", async () => {
      const result = await tool!.handler({ name: "TestRole", cagPrompt: "Test CAG" });
      const parsed = parseResult(result);
      expect(parsed.error).toBeUndefined();
      expect(parsed.roleId).toBeDefined();

      const call = mockCalls.find((c) => c.toolName === "create_role");
      expect(call).toBeDefined();
      expect(call!.verb).toBe("create");
      expect(call!.entityType).toBe("role");
      expect(call!.entityId).toBe(parsed.roleId);
      expect(call!.fieldChanges).toBeDefined();
      expect(call!.fieldChanges![0].path).toBe("_entity");
      expect(call!.fieldChanges![0].before).toBeNull();
      expect((call!.fieldChanges![0].after as Record<string, unknown>).name).toBe("TestRole");
    });
  });

  it("update_role writes receipt with verb=update, entityType=role, fieldChanges for name", async () => {
    const role = getRoleByName("Engineer");
    expect(role).toBeDefined();

    const tool = getTool("update_role");
    expect(tool).toBeDefined();

    const traceId = "trace-ur-1";
    await withTrace(traceId, "manual", async () => {
      const result = await tool!.handler({ roleId: role!.id, name: "Engineer Updated" });
      const parsed = parseResult(result);
      expect(parsed.error).toBeUndefined();

      const call = mockCalls.find((c) => c.toolName === "update_role");
      expect(call).toBeDefined();
      expect(call!.verb).toBe("update");
      expect(call!.entityType).toBe("role");
      expect(call!.entityId).toBe(role!.id);
      expect(call!.fieldChanges).toBeDefined();
      const nameChange = call!.fieldChanges!.find((fc) => fc.path === "name");
      expect(nameChange).toBeDefined();
      expect(nameChange!.after).toBe("Engineer Updated");
    });
  });

  it("retire_role writes receipt with verb=retire, entityType=role", async () => {
    const role = getRoleByName("Engineer");
    expect(role).toBeDefined();

    const tool = getTool("retire_role");
    expect(tool).toBeDefined();

    const traceId = "trace-rr-1";
    await withTrace(traceId, "manual", async () => {
      const result = await tool!.handler({ roleId: role!.id, reason: "test retirement" });
      const parsed = parseResult(result);
      expect(parsed.error).toBeUndefined();

      const call = mockCalls.find((c) => c.toolName === "retire_role");
      expect(call).toBeDefined();
      expect(call!.verb).toBe("retire");
      expect(call!.entityType).toBe("role");
      expect(call!.entityId).toBe(role!.id);
      expect(call!.fieldChanges).toBeDefined();
      const statusChange = call!.fieldChanges!.find((fc) => fc.path === "status");
      expect(statusChange).toBeDefined();
      expect(statusChange!.before).toBe("active");
      expect(statusChange!.after).toBe("retired");
    });
  });

  it("modify_role_permissions writes receipt with verb=update, entityType=role", async () => {
    const role = getRoleByName("Engineer");
    expect(role).toBeDefined();

    const tool = getTool("modify_role_permissions");
    expect(tool).toBeDefined();

    const traceId = "trace-mrp-1";
    await withTrace(traceId, "manual", async () => {
      const result = await tool!.handler({
        roleId: role!.id,
        allowedTools: ["Read", "Write", "Bash"],
      });
      const parsed = parseResult(result);
      expect(parsed.error).toBeUndefined();

      const call = mockCalls.find((c) => c.toolName === "modify_role_permissions");
      expect(call).toBeDefined();
      expect(call!.verb).toBe("update");
      expect(call!.entityType).toBe("role");
      expect(call!.entityId).toBe(role!.id);
      expect(call!.fieldChanges).toBeDefined();
      const toolsChange = call!.fieldChanges!.find((fc) => fc.path === "allowedTools");
      expect(toolsChange).toBeDefined();
      expect(toolsChange!.after).toEqual(["Read", "Write", "Bash"]);
    });
  });

  it("pin_role_parameter writes receipt with verb=update, entityType=role, path=pinnedParameters.<tool>", async () => {
    const role = getRoleByName("Engineer");
    expect(role).toBeDefined();

    const tool = getTool("pin_role_parameter");
    expect(tool).toBeDefined();

    const traceId = "trace-prp-1";
    await withTrace(traceId, "manual", async () => {
      const result = await tool!.handler({
        roleId: role!.id,
        tool: "Bash",
        params: { "timeout": 60 },
      });
      const parsed = parseResult(result);
      expect(parsed.error).toBeUndefined();

      const call = mockCalls.find((c) => c.toolName === "pin_role_parameter");
      expect(call).toBeDefined();
      expect(call!.verb).toBe("update");
      expect(call!.entityType).toBe("role");
      expect(call!.entityId).toBe(role!.id);
      expect(call!.fieldChanges).toBeDefined();
      const paramChange = call!.fieldChanges!.find((fc) => fc.path === "pinnedParameters.Bash");
      expect(paramChange).toBeDefined();
      expect((paramChange!.after as Record<string, unknown>)?.tool).toBe("Bash");
    });
  });

  it("delete_role writes receipt with verb=delete, entityType=role, after=null", async () => {
    // Create a role to delete (use create_role tool so we have a real entry)
    const createTool = getTool("create_role");
    expect(createTool).toBeDefined();
    let createdRoleId = "";
    await withTrace("trace-delrole-create", "manual", async () => {
      const result = await createTool!.handler({ name: "ToDelete", cagPrompt: "Disposable" });
      const parsed = parseResult(result);
      expect(parsed.error).toBeUndefined();
      createdRoleId = parsed.roleId;
    });
    mockCalls.length = 0;

    const tool = getTool("delete_role");
    expect(tool).toBeDefined();

    const traceId = "trace-delrole-1";
    await withTrace(traceId, "manual", async () => {
      const result = await tool!.handler({ roleId: createdRoleId });
      const parsed = parseResult(result);
      expect(parsed.error).toBeUndefined();
      expect(parsed.success).toBe(true);

      const call = mockCalls.find((c) => c.toolName === "delete_role");
      expect(call).toBeDefined();
      expect(call!.verb).toBe("delete");
      expect(call!.entityType).toBe("role");
      expect(call!.entityId).toBe(createdRoleId);
      expect(call!.fieldChanges).toBeDefined();
      expect(call!.fieldChanges![0].path).toBe("_entity");
      expect(call!.fieldChanges![0].after).toBeNull();
      expect(call!.fieldChanges![0].before).toBeDefined();
    });
  });

  it("save_role_style writes receipt with verb=update, entityType=role", async () => {
    const role = getRoleByName("Engineer");
    expect(role).toBeDefined();

    const tool = getTool("save_role_style");
    expect(tool).toBeDefined();

    const traceId = "trace-srs-1";
    await withTrace(traceId, "manual", async () => {
      const result = await tool!.handler({
        roleId: role!.id,
        slot: "stylePreferences",
        text: "Always use Chinese comments in code",
      });
      const parsed = parseResult(result);
      expect(parsed.error).toBeUndefined();

      const call = mockCalls.find((c) => c.toolName === "save_role_style");
      expect(call).toBeDefined();
      expect(call!.verb).toBe("update");
      expect(call!.entityType).toBe("role");
      expect(call!.entityId).toBe(role!.id);
      expect(call!.fieldChanges).toBeDefined();
      const styleChange = call!.fieldChanges!.find((fc) => fc.path === "stylePreferences");
      expect(styleChange).toBeDefined();
    });
  });
});
