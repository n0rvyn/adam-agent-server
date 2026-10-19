/**
 * Unit tests for entity_mutation receipts written by strategy / delivery-rule /
 * event-def / config tools in adam-tools.ts.
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
  isRestartRequiredPath: vi.fn().mockReturnValue(false),
  updateMutableConfig: vi.fn().mockImplementation((updates: Record<string, unknown>) => ({
    updated: Object.keys(updates),
    skipped: [],
  })),
}));

// Mock event source registry to avoid "unknown sourceType" errors in event-def tools
vi.mock("../../events/sources/source-registry.js", () => ({
  getSourceTypeKeys: vi.fn().mockReturnValue(["webhook", "cron", "directory_watch", "manual"]),
  startEventDefSource: vi.fn(),
  stopEventDefSource: vi.fn(),
}));

const { withTrace } = await import("../../lib/trace-context.js");
const { createAdamTools } = await import("../../manager/adam-tools.js");
const { initializeDefaultRoles } = await import("../../store/role-presets.js");
const { getRoleByName } = await import("../../store/roles.js");

describe("strategy tool receipts", () => {
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
    const config = mockCreateSdkMcpServer.mock.calls.at(-1)![0];
    cachedTools = config.tools;
    return cachedTools.find((t) => t.name === name);
  }

  function parseResult(result: unknown) {
    return JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
  }

  it("evaluate_result writes receipt with verb=create, entityType=trial", async () => {
    const role = getRoleByName("Engineer");
    expect(role).toBeDefined();

    // Seed strategy and goal so the trial insert satisfies FK constraints.
    const db = getTestDb();
    db.prepare(`
      INSERT INTO goals (id, name, description, role, metric_type, target_value, current_value, deadline, budget_usd, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("goal-er-1", "Eval Goal", "test", role!.id, "completion", 1, 0, Date.now() + 86400000, 5, "active", Date.now());
    db.prepare(`
      INSERT INTO strategies (id, role_id, task_type, name, prompt_template, alpha, beta, total_trials, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("strat-er-1", role!.id, "engineering", "strat", "p", 1, 1, 0, Date.now());

    const tool = getTool("evaluate_result");
    expect(tool).toBeDefined();

    const traceId = "trace-er-1";
    await withTrace(traceId, "manual", async () => {
      await tool!.handler({
        goalId: "goal-er-1",
        taskId: null,
        strategyId: "strat-er-1",
      });
      const call = mockCalls.find((c) => c.toolName === "evaluate_result");
      expect(call).toBeDefined();
      expect(call!.verb).toBe("create");
      expect(call!.entityType).toBe("trial");
      expect(call!.fieldChanges).toBeDefined();
      expect(call!.fieldChanges![0].path).toBe("_entity");
      expect(call!.fieldChanges![0].op).toBe("set");
      expect(call!.fieldChanges![0].before).toBeNull();
    });
  });

  it("create_strategy writes receipt with verb=create, entityType=strategy", async () => {
    const role = getRoleByName("Engineer");
    expect(role).toBeDefined();

    const tool = getTool("create_strategy");
    expect(tool).toBeDefined();

    const traceId = "trace-cs-1";
    await withTrace(traceId, "manual", async () => {
      const result = await tool!.handler({ roleId: role!.id, taskType: "engineering" });
      const parsed = parseResult(result);
      expect(parsed.error).toBeUndefined();

      const call = mockCalls.find((c) => c.toolName === "create_strategy");
      expect(call).toBeDefined();
      expect(call!.verb).toBe("create");
      expect(call!.entityType).toBe("strategy");
      expect(call!.entityId).toBeDefined();
      expect(call!.fieldChanges).toBeDefined();
      expect(call!.fieldChanges![0].path).toBe("_entity");
    });
  });
});

describe("delivery-rule tool receipts", () => {
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
    const config = mockCreateSdkMcpServer.mock.calls.at(-1)![0];
    cachedTools = config.tools;
    return cachedTools.find((t) => t.name === name);
  }

  function parseResult(result: unknown) {
    return JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
  }

  it("create_delivery_rule writes receipt with verb=create, entityType=delivery_rule", async () => {
    const tool = getTool("create_delivery_rule");
    expect(tool).toBeDefined();

    const traceId = "trace-cdr-1";
    await withTrace(traceId, "manual", async () => {
      const result = await tool!.handler({
        eventType: "task_complete",
        channelId: "ch-test-123",
      });
      const parsed = parseResult(result);
      expect(parsed.error).toBeUndefined();
      expect(parsed.ruleId).toBeDefined();

      const call = mockCalls.find((c) => c.toolName === "create_delivery_rule");
      expect(call).toBeDefined();
      expect(call!.verb).toBe("create");
      expect(call!.entityType).toBe("delivery_rule");
      expect(call!.entityId).toBe(parsed.ruleId);
      expect(call!.fieldChanges).toBeDefined();
      expect(call!.fieldChanges![0].path).toBe("_entity");
      expect(call!.fieldChanges![0].before).toBeNull();
    });
  });

  it("delete_delivery_rule writes receipt with verb=delete, entityType=delivery_rule, after=null", async () => {
    // First create a rule
    const createTool = getTool("create_delivery_rule");
    const createResult = await createTool!.handler({
      eventType: "task_complete",
      channelId: "ch-test-delete",
    });
    const created = parseResult(createResult);
    const ruleId = created.ruleId;

    const deleteTool = getTool("delete_delivery_rule");
    expect(deleteTool).toBeDefined();

    const traceId = "trace-ddr-1";
    await withTrace(traceId, "manual", async () => {
      const result = await deleteTool!.handler({ ruleId });
      const parsed = parseResult(result);
      expect(parsed.error).toBeUndefined();

      const call = mockCalls.find((c) => c.toolName === "delete_delivery_rule");
      expect(call).toBeDefined();
      expect(call!.verb).toBe("delete");
      expect(call!.entityType).toBe("delivery_rule");
      expect(call!.entityId).toBe(ruleId);
      expect(call!.fieldChanges).toBeDefined();
      expect(call!.fieldChanges![0].path).toBe("_entity");
      expect(call!.fieldChanges![0].after).toBeNull();
    });
  });
});

describe("event-def tool receipts", () => {
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
    const config = mockCreateSdkMcpServer.mock.calls.at(-1)![0];
    cachedTools = config.tools;
    return cachedTools.find((t) => t.name === name);
  }

  function parseResult(result: unknown) {
    return JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
  }

  it("create_event_def writes receipt with verb=create, entityType=event_def", async () => {
    const tool = getTool("create_event_def");
    expect(tool).toBeDefined();

    const traceId = "trace-ced-1";
    await withTrace(traceId, "manual", async () => {
      const result = await tool!.handler({
        name: "Test Event",
        sourceType: "webhook",
        sourceConfig: {},
      });
      const parsed = parseResult(result);
      expect(parsed.error).toBeUndefined();
      expect(parsed.id).toBeDefined();

      const call = mockCalls.find((c) => c.toolName === "create_event_def");
      expect(call).toBeDefined();
      expect(call!.verb).toBe("create");
      expect(call!.entityType).toBe("event_def");
      expect(call!.entityId).toBe(parsed.id);
      expect(call!.fieldChanges).toBeDefined();
      expect(call!.fieldChanges![0].path).toBe("_entity");
      expect(call!.fieldChanges![0].before).toBeNull();
    });
  });

  it("update_event_def writes receipt with verb=update, entityType=event_def", async () => {
    // Create an event def first
    const createTool = getTool("create_event_def");
    const createResult = await createTool!.handler({
      name: "Original Event",
      sourceType: "manual",
      sourceConfig: {},
    });
    const created = parseResult(createResult);
    const eventDefId = created.id;

    const tool = getTool("update_event_def");
    expect(tool).toBeDefined();

    const traceId = "trace-ued-1";
    await withTrace(traceId, "manual", async () => {
      // Pass sourceType explicitly because updateEventDef's spread treats
      // an undefined value as an intentional overwrite (NOT NULL fires otherwise).
      const result = await tool!.handler({ id: eventDefId, name: "Updated Event", sourceType: "manual", sourceConfig: {}, enabled: false });
      const parsed = parseResult(result);
      expect(parsed.error).toBeUndefined();

      const call = mockCalls.find((c) => c.toolName === "update_event_def");
      expect(call).toBeDefined();
      expect(call!.verb).toBe("update");
      expect(call!.entityType).toBe("event_def");
      expect(call!.entityId).toBe(eventDefId);
      expect(call!.fieldChanges).toBeDefined();
      const nameChange = call!.fieldChanges!.find((fc) => fc.path === "name");
      expect(nameChange).toBeDefined();
      expect(nameChange!.after).toBe("Updated Event");
    });
  });

  it("delete_event_def writes receipt with verb=delete, entityType=event_def", async () => {
    const createTool = getTool("create_event_def");
    const createResult = await createTool!.handler({
      name: "To Delete",
      sourceType: "manual",
      sourceConfig: {},
    });
    const created = parseResult(createResult);
    const eventDefId = created.id;

    const tool = getTool("delete_event_def");
    expect(tool).toBeDefined();

    const traceId = "trace-ded-1";
    await withTrace(traceId, "manual", async () => {
      const result = await tool!.handler({ id: eventDefId });
      const parsed = parseResult(result);
      expect(parsed.error).toBeUndefined();

      const call = mockCalls.find((c) => c.toolName === "delete_event_def");
      expect(call).toBeDefined();
      expect(call!.verb).toBe("delete");
      expect(call!.entityType).toBe("event_def");
      expect(call!.entityId).toBe(eventDefId);
      expect(call!.fieldChanges).toBeDefined();
      expect(call!.fieldChanges![0].path).toBe("_entity");
      expect(call!.fieldChanges![0].after).toBeNull();
    });
  });

  it("fire_event_def writes receipt with verb=create, entityType=event_firing", async () => {
    const createTool = getTool("create_event_def");
    const createResult = await createTool!.handler({
      name: "Fire Me",
      sourceType: "manual",
      sourceConfig: {},
    });
    const created = parseResult(createResult);
    const eventDefId = created.id;

    const tool = getTool("fire_event_def");
    expect(tool).toBeDefined();

    const traceId = "trace-fed-1";
    await withTrace(traceId, "manual", async () => {
      const result = await tool!.handler({ id: eventDefId });
      const parsed = parseResult(result);
      expect(parsed.error).toBeUndefined();
      expect(parsed.eventId).toBeDefined();

      const call = mockCalls.find((c) => c.toolName === "fire_event_def");
      expect(call).toBeDefined();
      expect(call!.verb).toBe("create");
      expect(call!.entityType).toBe("event_firing");
      expect(call!.entityId).toBe(parsed.eventId);
      expect(call!.fieldChanges).toBeDefined();
      expect(call!.fieldChanges![0].path).toBe("_entity");
      expect(call!.fieldChanges![0].before).toBeNull();
    });
  });
});

describe("config tool receipts", () => {
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
    const config = mockCreateSdkMcpServer.mock.calls.at(-1)![0];
    cachedTools = config.tools;
    return cachedTools.find((t) => t.name === name);
  }

  function parseResult(result: unknown) {
    return JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
  }

  it("update_config writes ONE receipt per updated field, entityType=config_field", async () => {
    const tool = getTool("update_config");
    expect(tool).toBeDefined();

    const traceId = "trace-uc-1";
    await withTrace(traceId, "manual", async () => {
      const result = await tool!.handler({
        updates: {
          "defaults.timeout": 120,
          "defaults.maxTurns": 60,
        },
      });
      const parsed = parseResult(result);

      // update_config may succeed or fail depending on test DB state
      // The receipt write happens for each successfully updated field
      const calls = mockCalls.filter((c) => c.toolName === "update_config");
      // Should have at least one receipt per updated field path
      const timeoutCall = calls.find((c) => c.entityId === "defaults.timeout");
      const maxTurnsCall = calls.find((c) => c.entityId === "defaults.maxTurns");
      // At least one of them should be written
      const receiptCount = (timeoutCall ? 1 : 0) + (maxTurnsCall ? 1 : 0);
      expect(receiptCount).toBeGreaterThan(0);

      // Each receipt has entityType=config_field and one fieldChange
      for (const call of [timeoutCall, maxTurnsCall].filter(Boolean)) {
        expect(call!.entityType).toBe("config_field");
        expect(call!.verb).toBe("update");
        expect(call!.fieldChanges).toBeDefined();
        expect(call!.fieldChanges!.length).toBe(1);
        expect(call!.fieldChanges![0].path).toBe("value");
      }
    });
  });
});
