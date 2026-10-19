/**
 * Unit tests for entity_mutation receipts written by the final batch of mutation tools:
 * - shared-tools.ts: save_memory (create + update), delete_memory (adam-tools + execution-tools)
 * - execution-tools.ts: write_artifact, publish_artifact_file
 * - adam-tools.ts: create_skill, authorize_task_operation, deny_task_operation
 *
 * Each test wraps the handler in a withTrace block and asserts the mock writeMutationReceipt
 * call contains the correct verb/entityType/entityId/fieldChanges.
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
const { mockCreateSdkMcpServer, mockTool: sdkMockTool } = vi.hoisted(() => {
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
  tool: sdkMockTool,
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
    mockCalls.push({
      toolName: input.toolName,
      entityType: input.entityType,
      verb: input.verb,
      entityId: input.entityId,
      fieldChanges: input.fieldChanges,
    });
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

// Mock task-dispatch to avoid real task creation
vi.mock("../../lib/task-dispatch.js", () => ({
  createTaskWithAdmission: vi.fn(),
}));

// Mock config
vi.mock("../../config/runtime.js", () => ({
  getRuntimeConfig: vi.fn().mockReturnValue({ defaults: {} }),
}));

// Mock skill-registry
vi.mock("../../manager/skill-registry.js", () => ({
  SkillRegistry: { query: vi.fn().mockReturnValue([]), match: vi.fn().mockReturnValue([]) },
}));

// Mock artifact-storage so publish_artifact_file does not touch the file system
vi.mock("../../lib/artifact-storage.js", () => ({
  publishBlob: vi.fn().mockReturnValue({ blobPath: "/tmp/mock-blob", sizeBytes: 1024 }),
  unlinkSourceFileStrict: vi.fn(),
  unlinkBlob: vi.fn(),
  fetchBlob: vi.fn(),
  validatePathInWorkspace: vi.fn(),
}));

// Mock role-workspace for getRoleWorkspacePath (preserve other exports for adam-tools)
vi.mock("../../store/role-workspace.js", async () => {
  const actual = await vi.importActual<typeof import("../../store/role-workspace.js")>("../../store/role-workspace.js");
  return {
    ...actual,
    getRoleWorkspacePath: vi.fn((name?: string) => name ? `/tmp/role-workspace/${name}` : "/tmp/role-workspace"),
  };
});

const { withTrace } = await import("../../lib/trace-context.js");
const { createSharedMemoryTools } = await import("../../manager/shared-tools.js");
const { createAdamTools } = await import("../../manager/adam-tools.js");
const { initializeDefaultRoles } = await import("../../store/role-presets.js");
const { getRoleByName } = await import("../../store/roles.js");
const { createTask } = await import("../../store/tasks.js");
const { listTaskPlans } = await import("../../store/task-plans.js");
const { createTaskPlan } = await import("../../store/task-plans.js");

function parseResult(result: unknown) {
  return JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
}

describe("shared-tools memory receipts (adam-tools scope — unscoped)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWriteMutationReceipt.mockClear();
    mockWriteMutationReceipt.mockImplementation((input) => {
      mockCalls.push({
        toolName: input.toolName,
        entityType: input.entityType,
        verb: input.verb,
        entityId: input.entityId,
        fieldChanges: input.fieldChanges,
      });
    });
    mockCalls.length = 0;
    clearTestDb();
    initializeDefaultRoles();
    sdkMockTool.mockClear();
  });

  it("save_memory (create branch) writes verb=create, entityType=memory", async () => {
    const tools = createSharedMemoryTools(/* unscoped */);
    const saveTool = tools.find((t) => t.name === "save_memory")!;
    expect(saveTool).toBeDefined();

    const traceId = "trace-sm-create";
    await withTrace(traceId, "manual", async () => {
      const role = getRoleByName("Engineer");
      expect(role).toBeDefined();
      const result = await (saveTool.handler as (args: unknown) => unknown)({
        roleId: role!.id,
        content: "Test memory content for create",
      });
      const parsed = parseResult(result);
      expect(parsed.error).toBeUndefined();
      expect(parsed.id).toBeDefined();

      const call = mockCalls.find((c) => c.toolName === "save_memory" && c.verb === "create");
      expect(call).toBeDefined();
      expect(call!.verb).toBe("create");
      expect(call!.entityType).toBe("memory");
      expect(call!.entityId).toBe(parsed.id);
      expect(call!.fieldChanges).toBeDefined();
      expect(call!.fieldChanges![0].path).toBe("_entity");
      expect(call!.fieldChanges![0].op).toBe("set");
      expect(call!.fieldChanges![0].before).toBeNull();
      expect(call!.fieldChanges![0].after).toBeDefined();
      expect((call!.fieldChanges![0].after as { roleId: string }).roleId).toBe(role!.id);
    });
  });

  it("save_memory (update branch) writes verb=update, entityType=memory, captures before/after content", async () => {
    const tools = createSharedMemoryTools(/* unscoped */);
    const saveTool = tools.find((t) => t.name === "save_memory")!;
    expect(saveTool).toBeDefined();

    const role = getRoleByName("Engineer");
    expect(role).toBeDefined();

    // Create a memory first
    const createResult = await (saveTool.handler as (args: unknown) => unknown)({
      roleId: role!.id,
      content: "Original content",
    });
    const created = parseResult(createResult);
    const memoryId = created.id;
    mockCalls.length = 0; // clear create call

    const traceId = "trace-sm-update";
    await withTrace(traceId, "manual", async () => {
      const result = await (saveTool.handler as (args: unknown) => unknown)({
        roleId: role!.id,
        id: memoryId,
        content: "Updated content",
      });
      const parsed = parseResult(result);
      expect(parsed.error).toBeUndefined();

      const call = mockCalls.find((c) => c.toolName === "save_memory" && c.verb === "update");
      expect(call).toBeDefined();
      expect(call!.verb).toBe("update");
      expect(call!.entityType).toBe("memory");
      expect(call!.entityId).toBe(memoryId);
      expect(call!.fieldChanges).toBeDefined();
      const contentChange = call!.fieldChanges!.find((fc) => fc.path === "content");
      expect(contentChange).toBeDefined();
      expect(contentChange!.before).toBe("Original content");
      expect(contentChange!.after).toBe("Updated content");
    });
  });

  it("delete_memory writes verb=delete, entityType=memory, before snapshot captured", async () => {
    const tools = createSharedMemoryTools(/* unscoped */);
    const saveTool = tools.find((t) => t.name === "save_memory")!;
    const deleteTool = tools.find((t) => t.name === "delete_memory")!;
    expect(deleteTool).toBeDefined();

    const role = getRoleByName("Engineer");
    expect(role).toBeDefined();

    // Create a memory
    const createResult = await (saveTool.handler as (args: unknown) => unknown)({
      roleId: role!.id,
      content: "Memory to delete",
    });
    const created = parseResult(createResult);
    const memoryId = created.id;
    mockCalls.length = 0; // clear create call

    const traceId = "trace-dm-delete";
    await withTrace(traceId, "manual", async () => {
      const result = await (deleteTool.handler as (args: unknown) => unknown)({ id: memoryId });
      const parsed = parseResult(result);
      expect(parsed.error).toBeUndefined();
      expect(parsed.deleted).toBe(true);

      const call = mockCalls.find((c) => c.toolName === "delete_memory");
      expect(call).toBeDefined();
      expect(call!.verb).toBe("delete");
      expect(call!.entityType).toBe("memory");
      expect(call!.entityId).toBe(memoryId);
      expect(call!.fieldChanges).toBeDefined();
      expect(call!.fieldChanges![0].path).toBe("_entity");
      expect(call!.fieldChanges![0].op).toBe("set");
      expect(call!.fieldChanges![0].after).toBeNull();
      expect(call!.fieldChanges![0].before).toBeDefined();
      expect((call!.fieldChanges![0].before as { id: string }).id).toBe(memoryId);
    });
  });
});

describe("shared-tools memory receipts (execution-tools scope — role-scoped)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWriteMutationReceipt.mockClear();
    mockWriteMutationReceipt.mockImplementation((input) => {
      mockCalls.push({
        toolName: input.toolName,
        entityType: input.entityType,
        verb: input.verb,
        entityId: input.entityId,
        fieldChanges: input.fieldChanges,
      });
    });
    mockCalls.length = 0;
    clearTestDb();
    initializeDefaultRoles();
    sdkMockTool.mockClear();
  });

  it("save_memory (scoped, create) writes verb=create, entityType=memory, roleId set", async () => {
    const role = getRoleByName("Engineer");
    expect(role).toBeDefined();

    // Create shared tools scoped to this role
    const tools = createSharedMemoryTools(role!.id);
    const saveTool = tools.find((t) => t.name === "save_memory")!;
    expect(saveTool).toBeDefined();

    const traceId = "trace-sm-scoped-create";
    await withTrace(traceId, "manual", async () => {
      const result = await (saveTool.handler as (args: unknown) => unknown)({
        content: "Scoped memory content",
      });
      const parsed = parseResult(result);
      expect(parsed.error).toBeUndefined();
      expect(parsed.id).toBeDefined();

      const call = mockCalls.find((c) => c.toolName === "save_memory" && c.verb === "create");
      expect(call).toBeDefined();
      expect(call!.verb).toBe("create");
      expect(call!.entityType).toBe("memory");
      expect(call!.entityId).toBe(parsed.id);
      // roleId should be set on the receipt (from scopedRoleId, not from args)
      expect(call!.fieldChanges).toBeDefined();
    });
  });

  it("save_memory (scoped, update) writes verb=update, entityType=memory", async () => {
    const role = getRoleByName("Engineer");
    expect(role).toBeDefined();

    const tools = createSharedMemoryTools(role!.id);
    const saveTool = tools.find((t) => t.name === "save_memory")!;

    // Create a memory
    const createResult = await (saveTool.handler as (args: unknown) => unknown)({
      content: "Original scoped content",
    });
    const created = parseResult(createResult);
    const memoryId = created.id;
    mockCalls.length = 0;

    const traceId = "trace-sm-scoped-update";
    await withTrace(traceId, "manual", async () => {
      const result = await (saveTool.handler as (args: unknown) => unknown)({
        id: memoryId,
        content: "Updated scoped content",
      });
      const parsed = parseResult(result);
      expect(parsed.error).toBeUndefined();

      const call = mockCalls.find((c) => c.toolName === "save_memory" && c.verb === "update");
      expect(call).toBeDefined();
      expect(call!.verb).toBe("update");
      expect(call!.entityType).toBe("memory");
      const contentChange = call!.fieldChanges!.find((fc) => fc.path === "content");
      expect(contentChange!.before).toBe("Original scoped content");
      expect(contentChange!.after).toBe("Updated scoped content");
    });
  });

  it("delete_memory (scoped) writes verb=delete, entityType=memory", async () => {
    const role = getRoleByName("Engineer");
    expect(role).toBeDefined();

    const tools = createSharedMemoryTools(role!.id);
    const saveTool = tools.find((t) => t.name === "save_memory")!;
    const deleteTool = tools.find((t) => t.name === "delete_memory")!;

    // Create a memory
    const createResult = await (saveTool.handler as (args: unknown) => unknown)({
      content: "Scoped delete me",
    });
    const created = parseResult(createResult);
    const memoryId = created.id;
    mockCalls.length = 0;

    const traceId = "trace-dm-scoped-delete";
    await withTrace(traceId, "manual", async () => {
      const result = await (deleteTool.handler as (args: unknown) => unknown)({ id: memoryId });
      const parsed = parseResult(result);
      expect(parsed.error).toBeUndefined();

      const call = mockCalls.find((c) => c.toolName === "delete_memory");
      expect(call).toBeDefined();
      expect(call!.verb).toBe("delete");
      expect(call!.entityType).toBe("memory");
      expect(call!.fieldChanges![0].after).toBeNull();
    });
  });
});

describe("adam-tools privilege escalation + skill receipts", () => {
  let cachedTools: Array<{ name: string; handler: (args: unknown) => unknown }> = [];

  beforeEach(() => {
    vi.clearAllMocks();
    mockWriteMutationReceipt.mockClear();
    mockWriteMutationReceipt.mockImplementation((input) => {
      mockCalls.push({
        toolName: input.toolName,
        entityType: input.entityType,
        verb: input.verb,
        entityId: input.entityId,
        fieldChanges: input.fieldChanges,
      });
    });
    mockCalls.length = 0;
    clearTestDb();
    initializeDefaultRoles();
    sdkMockTool.mockClear();
    cachedTools = [];
  });

  function getTool(name: string) {
    createAdamTools();
    const config = mockCreateSdkMcpServer.mock.calls.at(-1)![0] as { tools: Array<{ name: string; handler: (args: unknown) => unknown }> };
    cachedTools = config.tools;
    return cachedTools.find((t) => t.name === name);
  }

  it("create_skill writes verb=create, entityType=skill_file", async () => {
    const role = getRoleByName("Engineer");
    expect(role).toBeDefined();

    const tool = getTool("create_skill");
    expect(tool).toBeDefined();

    const traceId = "trace-cs-1";
    await withTrace(traceId, "manual", async () => {
      const result = await tool!.handler({
        roleId: role!.id,
        skillName: "test_skill_receipt",
        description: "A test skill",
        instructions: "Do the thing",
      });
      const parsed = parseResult(result);
      expect(parsed.error).toBeUndefined();
      expect(parsed.path).toBeDefined();

      const call = mockCalls.find((c) => c.toolName === "create_skill");
      expect(call).toBeDefined();
      expect(call!.verb).toBe("create");
      expect(call!.entityType).toBe("skill_file");
      expect(call!.entityId).toBe("test_skill_receipt");
      expect(call!.fieldChanges).toBeDefined();
      expect(call!.fieldChanges![0].path).toBe("_entity");
      expect(call!.fieldChanges![0].before).toBeNull();
      expect(call!.fieldChanges![0].after).toBeDefined();
      expect((call!.fieldChanges![0].after as { skillName: string }).skillName).toBe("test_skill_receipt");
    });
  });

  it("authorize_task_operation writes verb=update, entityType=task_authorization, after=authorized", async () => {
    const role = getRoleByName("Engineer");
    expect(role).toBeDefined();

    // Create a running task
    createTask({
      id: "task-auth-test",
      prompt: "Test task for auth",
      roleId: role!.id,
      status: "pending",
      config: { timeout: 30000, approvalRequired: [], approvalTimeout: 60000 },
      createdAt: Date.now(),
    });

    // Create a pending task plan
    createTaskPlan({
      id: "plan-auth-1",
      taskId: "task-auth-test",
      status: "pending",
      plan: {
        steps: [],
        requiredPermissions: { allowedTools: [], disallowedTools: [], approvalRequired: [], maxBudgetUsd: 0, plugins: [] },
        overallRisk: "low",
      },
      createdAt: Date.now(),
    });

    const tool = getTool("authorize_task_operation");
    expect(tool).toBeDefined();

    const traceId = "trace-ato-1";
    await withTrace(traceId, "manual", async () => {
      const result = await tool!.handler({ taskId: "task-auth-test" });
      const parsed = parseResult(result);
      expect(parsed.error).toBeUndefined();
      expect(parsed.decision).toBe("allow");

      const call = mockCalls.find((c) => c.toolName === "authorize_task_operation");
      expect(call).toBeDefined();
      expect(call!.verb).toBe("update");
      expect(call!.entityType).toBe("task_authorization");
      expect(call!.entityId).toBe("task-auth-test");
      expect(call!.fieldChanges).toBeDefined();
      const statusChange = call!.fieldChanges!.find((fc) => fc.path === "approvalStatus");
      expect(statusChange).toBeDefined();
      expect(statusChange!.before).toBe("pending");
      expect(statusChange!.after).toBe("authorized");
    });
  });

  it("deny_task_operation writes verb=update, entityType=task_authorization, after=denied", async () => {
    const role = getRoleByName("Engineer");
    expect(role).toBeDefined();

    createTask({
      id: "task-deny-test",
      prompt: "Test task for deny",
      roleId: role!.id,
      status: "pending",
      config: { timeout: 30000, approvalRequired: [], approvalTimeout: 60000 },
      createdAt: Date.now(),
    });

    createTaskPlan({
      id: "plan-deny-1",
      taskId: "task-deny-test",
      status: "pending",
      plan: {
        steps: [],
        requiredPermissions: { allowedTools: [], disallowedTools: [], approvalRequired: [], maxBudgetUsd: 0, plugins: [] },
        overallRisk: "low",
      },
      createdAt: Date.now(),
    });

    const tool = getTool("deny_task_operation");
    expect(tool).toBeDefined();

    const traceId = "trace-dto-1";
    await withTrace(traceId, "manual", async () => {
      const result = await tool!.handler({ taskId: "task-deny-test" });
      const parsed = parseResult(result);
      expect(parsed.error).toBeUndefined();
      expect(parsed.decision).toBe("deny");

      const call = mockCalls.find((c) => c.toolName === "deny_task_operation");
      expect(call).toBeDefined();
      expect(call!.verb).toBe("update");
      expect(call!.entityType).toBe("task_authorization");
      expect(call!.entityId).toBe("task-deny-test");
      expect(call!.fieldChanges).toBeDefined();
      const statusChange = call!.fieldChanges!.find((fc) => fc.path === "approvalStatus");
      expect(statusChange).toBeDefined();
      expect(statusChange!.before).toBe("pending");
      expect(statusChange!.after).toBe("denied");
    });
  });
});

describe("execution-tools artifact receipts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWriteMutationReceipt.mockClear();
    mockWriteMutationReceipt.mockImplementation((input) => {
      mockCalls.push({
        toolName: input.toolName,
        entityType: input.entityType,
        verb: input.verb,
        entityId: input.entityId,
        fieldChanges: input.fieldChanges,
      });
    });
    mockCalls.length = 0;
    clearTestDb();
    initializeDefaultRoles();
    sdkMockTool.mockClear();
  });

  async function setupTemplateExecutionTask(): Promise<{
    roleId: string;
    roleName: string;
    taskId: string;
    executionId: string;
    stepId: string;
    templateId: string;
  }> {
    const role = getRoleByName("Engineer");
    expect(role).toBeDefined();

    const templateId = "tmpl-artifact-test";
    const executionId = "exec-artifact-test";
    const stepId = "step-1";
    const taskId = "task-artifact-step-1";

    const { createTaskTemplate } = await import("../../store/task-templates.js");
    createTaskTemplate({
      id: templateId,
      name: "Artifact Test Template",
      description: "test",
      trigger: { type: "manual" },
      steps: [{ id: stepId, prompt: "do step", outputAs: "artifact_key_default" }],
      rolePreference: role!.id,
      createdAt: Date.now(),
      enabled: true,
    });

    const { createTemplateExecution } = await import("../../store/template-executions.js");
    createTemplateExecution(executionId, templateId);

    // Directly insert the task row so we have full control of parent_id / template_id / step_id
    getTestDb().prepare(`
      INSERT INTO tasks (id, role_id, status, created_at, step_id, parent_id, template_id, prompt, config)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(taskId, role!.id, "running", Date.now(), stepId, executionId, templateId, "", "{}");

    return { roleId: role!.id, roleName: role!.name, taskId, executionId, stepId, templateId };
  }

  it("write_artifact writes verb=create, entityType=artifact", async () => {
    const { roleId, taskId } = await setupTemplateExecutionTask();

    const { createExecutionTools } = await import("../../manager/execution-tools.js");
    const server = createExecutionTools(roleId, taskId) as unknown as {
      tools: Array<{ name: string; handler: (args: unknown) => Promise<unknown> }>;
    };
    const writeTool = server.tools.find((t) => t.name === "write_artifact");
    expect(writeTool).toBeDefined();

    const traceId = "trace-write-artifact-1";
    await withTrace(traceId, "manual", async () => {
      const result = await writeTool!.handler({
        key: "artifact_key_default",
        value: { summary: "hello world" },
      });
      const parsed = parseResult(result);
      expect(parsed.error).toBeUndefined();
      expect(parsed.success).toBe(true);
      expect(parsed.artifactId).toBeDefined();

      const call = mockCalls.find((c) => c.toolName === "write_artifact");
      expect(call).toBeDefined();
      expect(call!.verb).toBe("create");
      expect(call!.entityType).toBe("artifact");
      expect(call!.entityId).toBe(parsed.artifactId);
      expect(call!.fieldChanges).toBeDefined();
      expect(call!.fieldChanges![0].path).toBe("_entity");
      expect(call!.fieldChanges![0].before).toBeNull();
      expect((call!.fieldChanges![0].after as { kind: string }).kind).toBe("json");
    });
  });

  it("publish_artifact_file writes verb=create, entityType=artifact, kind=file", async () => {
    const { roleId, taskId } = await setupTemplateExecutionTask();

    const { createExecutionTools } = await import("../../manager/execution-tools.js");
    const server = createExecutionTools(roleId, taskId) as unknown as {
      tools: Array<{ name: string; handler: (args: unknown) => Promise<unknown> }>;
    };
    const publishTool = server.tools.find((t) => t.name === "publish_artifact_file");
    expect(publishTool).toBeDefined();

    const traceId = "trace-publish-artifact-1";
    await withTrace(traceId, "manual", async () => {
      const result = await publishTool!.handler({
        key: "artifact_key_default",
        sourcePath: "/tmp/role-workspace/output.txt",
        mime: "text/plain",
      });
      const parsed = parseResult(result);
      expect(parsed.error).toBeUndefined();
      expect(parsed.success).toBe(true);
      expect(parsed.artifactId).toBeDefined();

      const call = mockCalls.find((c) => c.toolName === "publish_artifact_file");
      expect(call).toBeDefined();
      expect(call!.verb).toBe("create");
      expect(call!.entityType).toBe("artifact");
      expect(call!.entityId).toBe(parsed.artifactId);
      expect(call!.fieldChanges).toBeDefined();
      expect(call!.fieldChanges![0].path).toBe("_entity");
      expect(call!.fieldChanges![0].before).toBeNull();
      expect((call!.fieldChanges![0].after as { kind: string }).kind).toBe("file");
    });
  });
});
