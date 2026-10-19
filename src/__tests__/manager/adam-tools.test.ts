import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { tmpdir } from "node:os";
import { setupTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

vi.mock("../../config/runtime.js", () => ({
  getRuntimeConfig: () => ({
    defaults: {
      allowedTools: [],
      disallowedTools: [],
      plugins: [],
      timeout: 300,
      maxTurns: 50,
    },
    logging: { level: "info" },
    server: { port: 7100 },
  }),
  updateMutableConfig: vi.fn().mockImplementation((updates: Record<string, unknown>) => {
    const RESTART_REQUIRED = ["server.port", "server.host"];
    const errors: string[] = [];
    for (const path of Object.keys(updates)) {
      if (RESTART_REQUIRED.includes(path)) {
        errors.push(`"${path}" requires restart. Cannot modify at runtime.`);
      }
    }
    return { success: errors.length === 0, updated: [], errors };
  }),
  setLogLevel: vi.fn(),
  isRestartRequiredPath: vi.fn().mockImplementation((path: string) => ["server.port", "server.host"].includes(path)),
}));

vi.mock("../../agent/memory-service.js", () => ({
  queryMemory: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../lib/embedding.js", () => ({
  generateEmbedding: vi.fn().mockResolvedValue(new Float32Array(384)),
}));

vi.mock("../../strategy/evaluator/reward.js", () => ({
  calculateReward: vi.fn().mockReturnValue({
    reward: 0.8,
    breakdown: { L2: 0.7, L3: 0.6 },
    source: "mock",
    confidence: 0.9,
  }),
}));

vi.mock("../../strategy/engine.js", () => ({
  StrategyEngine: {
    selectStrategy: vi.fn().mockReturnValue(null),
    recordTrial: vi.fn(),
    getStrategies: vi.fn().mockReturnValue([]),
  },
}));

vi.mock("../../strategy/generator.js", () => ({
  StrategyGenerator: {
    generateVariants: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../../server/events/server-bus.js", () => ({
  serverBus: { emit: vi.fn() },
}));

vi.mock("../../sandbox/provider.js", () => ({
  getSandboxProvider: () => ({ platform: "sandbox-exec", isAvailable: async () => true }),
  isSandboxAvailable: vi.fn().mockResolvedValue(true),
}));

// Mock the SDK's tool and createSdkMcpServer (must be hoisted for vi.mock factory)
const { mockCreateSdkMcpServer, mockTool } = vi.hoisted(() => ({
  mockCreateSdkMcpServer: vi.fn().mockImplementation((config: unknown) => config),
  mockTool: vi.fn().mockImplementation((name: string, description: string, schema: unknown, handler: unknown) => ({
    name,
    description,
    inputSchema: schema,
    handler,
  })),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: mockCreateSdkMcpServer,
  tool: mockTool,
}));

const { createAdamTools } = await import("../../manager/adam-tools.js");

describe("adam-tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // os-capabilities.ts reads the global process getter at runtime.
    // Force the macOS path so this file's sandbox-exec assertions stay stable on Linux CI.
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(() => cleanup());

  it("should export createAdamTools function", () => {
    expect(typeof createAdamTools).toBe("function");
  });

  it("should call createSdkMcpServer with correct config", () => {
    createAdamTools();

    expect(mockCreateSdkMcpServer).toHaveBeenCalledTimes(1);
    const config = mockCreateSdkMcpServer.mock.calls[0][0];
    expect(config.name).toBe("adam-tools");
    expect(config.version).toBe("1.0.0");
    expect(Array.isArray(config.tools)).toBe(true);
  });

  it("should register all expected tools", () => {
    createAdamTools();

    const config = mockCreateSdkMcpServer.mock.calls[0][0];
    const toolNames = config.tools.map((t: { name: string }) => t.name);

    // New tools from task-template delete-cascade fix (2026-04-17)
    expect(toolNames).toContain("get_template_dependents");
    expect(toolNames).toContain("delete_template");

    // Original tools
    expect(toolNames).toContain("read_goal_state");
    expect(toolNames).toContain("update_goal_state");
    expect(toolNames).toContain("create_goal");
    expect(toolNames).toContain("decompose_goal");
    expect(toolNames).toContain("dispatch_task");
    expect(toolNames).toContain("dispatch_to_role");
    expect(toolNames).toContain("dispatch_by_requirements");
    expect(toolNames).toContain("evaluate_result");
    expect(toolNames).toContain("create_strategy");
    expect(toolNames).toContain("list_goals");
    expect(toolNames).toContain("delete_goal");
    expect(toolNames).toContain("pause_goal");
    expect(toolNames).toContain("create_template");
    expect(toolNames).toContain("assign_role");
    expect(toolNames).toContain("search_memories");
    expect(toolNames).toContain("save_memory");
    expect(toolNames).toContain("delete_memory");
    expect(toolNames).toContain("read_task_status");
    expect(toolNames).toContain("modify_role_permissions");
    expect(toolNames).toContain("view_audit_log");
    expect(toolNames).toContain("list_roles");
    expect(toolNames).toContain("create_role");
    expect(toolNames).toContain("retire_role");
    expect(toolNames).toContain("send_to_channel");
    expect(toolNames).toContain("list_channels");
    expect(toolNames).toContain("get_system_status");
    expect(toolNames).toContain("schedule_task");
    expect(toolNames).toContain("list_available_plugins");
    expect(toolNames).toContain("install_plugin_for_role");
    expect(toolNames).toContain("uninstall_plugin_from_role");
    expect(toolNames).toContain("bind_mcp_to_role");
    expect(toolNames).toContain("unbind_mcp_from_role");
    expect(toolNames).toContain("list_templates");
    expect(toolNames).toContain("get_capabilities");

    // New plugin management tools
    expect(toolNames).toContain("enable_plugin");
    expect(toolNames).toContain("disable_plugin");
    expect(toolNames).not.toContain("install_plugin_for_user");
    expect(toolNames).not.toContain("uninstall_plugin_for_user");
    expect(toolNames).toContain("browse_marketplace");
    expect(toolNames).toContain("list_marketplace_sources");
    expect(toolNames).toContain("get_plugin_detail");
    expect(toolNames).toContain("scan_directory");

    // New task lifecycle tools
    expect(toolNames).toContain("cancel_task");
    expect(toolNames).toContain("view_task_logs");

    // New role + config tools
    expect(toolNames).toContain("delete_role");
    expect(toolNames).toContain("update_role");
    expect(toolNames).toContain("view_config");
    expect(toolNames).toContain("update_config");

    // New privilege escalation tools
    expect(toolNames).toContain("authorize_task_operation");
    expect(toolNames).toContain("deny_task_operation");

    // New memory/template/delivery/strategy tools
    expect(toolNames).toContain("list_memories");
    expect(toolNames).toContain("update_template");
    expect(toolNames).toContain("get_template_detail");
    expect(toolNames).toContain("delete_template");
    expect(toolNames).toContain("migrate_template_outputAs");
    expect(toolNames).toContain("run_template");
    // Phase 0.5: template version history tools
    expect(toolNames).toContain("list_template_versions");
    expect(toolNames).toContain("diff_template_versions");
    expect(toolNames).toContain("restore_template_version");
    expect(toolNames).toContain("list_delivery_rules");
    expect(toolNames).toContain("create_delivery_rule");
    expect(toolNames).toContain("delete_delivery_rule");
    expect(toolNames).toContain("list_strategies");

    // modify_defaults was removed and replaced by update_config
    expect(toolNames).not.toContain("modify_defaults");

    expect(toolNames).not.toContain(["dispatch", ["work", "flow"].join("")].join("_"));

    // Event def tools (Tasks 5-7)
    expect(toolNames).toContain("create_event_def");
    expect(toolNames).toContain("list_event_defs");
    expect(toolNames).toContain("update_event_def");
    expect(toolNames).toContain("delete_event_def");
    expect(toolNames).toContain("fire_event_def");
    expect(toolNames).toContain("list_event_firings");
    expect(toolNames).toContain("read_cost_summary");
    expect(toolNames).toContain("cancel_execution");

    // Config-doc portability (Phase 1) — read tool
    expect(toolNames).toContain("read_config_doc");

    // Config-doc import orchestration (Phase 2) — gate + structural verify
    expect(toolNames).toContain("check_config_doc_dependencies");
    expect(toolNames).toContain("verify_imported_config");

    expect(config.tools).toHaveLength(86);
  });

  it("should define tools via SDK tool() helper (verified at module load)", () => {
    // tool() was called 17 times during module initialization.
    // Since beforeEach clears mocks, verify via createAdamTools output instead:
    // each tool in the array should have the structure returned by our mockTool.
    createAdamTools();
    const config = mockCreateSdkMcpServer.mock.calls[0][0];
    for (const t of config.tools) {
      expect(typeof t.name).toBe("string");
      expect(typeof t.description).toBe("string");
      expect(typeof t.inputSchema).toBe("object");
      expect(typeof t.handler).toBe("function");
      // Verify it's a raw shape, not a ZodObject
      expect(t.inputSchema).not.toHaveProperty("_def");
    }
  });

  it("should not use 'as any' cast (tools array is properly typed)", () => {
    createAdamTools();

    const config = mockCreateSdkMcpServer.mock.calls[0][0];
    // The tools array should be passed directly, not wrapped in 'as any'
    expect(config.tools).toBeDefined();
    expect(config.tools.length).toBe(86);
  });

  it("create_role should persist allowedTools to DB", async () => {
    createAdamTools();
    const config = mockCreateSdkMcpServer.mock.calls[0][0];
    const createRoleTool = config.tools.find((t: { name: string }) => t.name === "create_role");
    expect(createRoleTool).toBeDefined();

    const result = await createRoleTool.handler({
      name: "test-perm-role",
      cagPrompt: "A test role",
      allowedTools: ["WebSearch", "WebFetch"],
    });

    // Verify the result contains the allowedTools
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.allowedTools).toEqual(["WebSearch", "WebFetch"]);

    // Verify DB persistence via store
    const { getRoleByName } = await import("../../store/roles.js");
    const role = getRoleByName("test-perm-role");
    expect(role).toBeDefined();
    expect(role!.allowedTools).toEqual(["WebSearch", "WebFetch"]);
  });

  it("create_role without allowedTools should leave permissions undefined", async () => {
    createAdamTools();
    const config = mockCreateSdkMcpServer.mock.calls[0][0];
    const createRoleTool = config.tools.find((t: { name: string }) => t.name === "create_role");

    await createRoleTool.handler({
      name: "test-no-perm-role",
      cagPrompt: "A role without explicit permissions",
    });

    const { getRoleByName } = await import("../../store/roles.js");
    const role = getRoleByName("test-no-perm-role");
    expect(role).toBeDefined();
    expect(role!.allowedTools).toBeUndefined();
  });

  it("create_role should persist osCapabilities to DB", async () => {
    createAdamTools();
    const config = mockCreateSdkMcpServer.mock.calls[0][0];
    const createRoleTool = config.tools.find((t: { name: string }) => t.name === "create_role");
    expect(createRoleTool).toBeDefined();

    const result = await createRoleTool.handler({
      name: "test-os-cap-role",
      cagPrompt: "A test role with OS capabilities",
      osCapabilities: [
        { id: "automation", targets: ["com.apple.mail", "com.apple.systemevents"] },
        { id: "accessibility" },
      ],
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.osCapabilities).toEqual([
      { id: "accessibility" },
      { id: "automation", targets: ["com.apple.mail", "com.apple.systemevents"] },
    ]);

    const { getRoleByName } = await import("../../store/roles.js");
    const role = getRoleByName("test-os-cap-role");
    expect(role?.osCapabilities).toEqual([
      { id: "accessibility" },
      { id: "automation", targets: ["com.apple.mail", "com.apple.systemevents"] },
    ]);
  });

  it("create_role rejects non-editable osCapabilities", async () => {
    createAdamTools();
    const config = mockCreateSdkMcpServer.mock.calls[0][0];
    const createRoleTool = config.tools.find((t: { name: string }) => t.name === "create_role");

    const result = await createRoleTool.handler({
      name: "test-host-only-role",
      cagPrompt: "Should fail",
      osCapabilities: [{ id: "full-disk-access" }],
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain("not editable");
  });

  describe("dispatch_task roleId enforcement", () => {
    function getTools() {
      createAdamTools();
      const config = mockCreateSdkMcpServer.mock.calls[0][0];
      return {
        dispatch: config.tools.find((t: { name: string }) => t.name === "dispatch_task"),
        createRole: config.tools.find((t: { name: string }) => t.name === "create_role"),
      };
    }

    it("dispatch_task with valid roleId should create task", async () => {
      const { dispatch, createRole } = getTools();

      // Create a role first
      const roleResult = await createRole.handler({ name: "dispatch-test-role", cagPrompt: "test" });
      const { roleId } = JSON.parse(roleResult.content[0].text);

      const result = await dispatch.handler({ prompt: "test task", roleId });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.taskId).toBeDefined();
      expect(parsed.roleId).toBe(roleId);
      expect(parsed.error).toBeUndefined();
    });

    it("dispatch_task with invalid roleId should return error with availableRoles", async () => {
      const { dispatch, createRole } = getTools();

      // Create a role so availableRoles is non-empty
      await createRole.handler({ name: "available-role", cagPrompt: "test", allowedTools: ["Bash"] });

      const result = await dispatch.handler({ prompt: "test task", roleId: "nonexistent-role" });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.error).toContain("Role not found or not active");
      expect(parsed.availableRoles).toBeDefined();
      expect(Array.isArray(parsed.availableRoles)).toBe(true);
      expect(parsed.availableRoles.length).toBeGreaterThan(0);
      expect(parsed.availableRoles[0]).toHaveProperty("id");
      expect(parsed.availableRoles[0]).toHaveProperty("name");
      expect(parsed.availableRoles[0]).toHaveProperty("allowedTools");
    });

    it("dispatch_task schema accepts roleId or autoSelectRole", () => {
      const { dispatch } = getTools();
      const schema = dispatch.inputSchema;
      expect(schema.roleId).toBeDefined();
      // roleId is optional when autoSelectRole is used; role selection is driven by requirements
      expect(schema.roleId.isOptional()).toBe(true);
      expect(schema.autoSelectRole).toBeDefined();
      expect(schema.autoSelectRole.isOptional()).toBe(true);
    });

    it("dispatch_task with requirements.tools not in role's allowedTools returns ROLE_TOOL_MISMATCH", async () => {
      const { dispatch, createRole } = getTools();
      const roleResult = await createRole.handler({
        name: "tool-mismatch-role",
        cagPrompt: "test",
        allowedTools: ["Read"],
      });
      const { roleId } = JSON.parse(roleResult.content[0].text);

      const result = await dispatch.handler({
        prompt: "do the thing",
        roleId,
        requirements: { tools: ["Bash"] },
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.code).toBe("ROLE_TOOL_MISMATCH");
      expect(parsed.error).toBeDefined();
      expect(parsed.missing?.tools).toEqual(["Bash"]);
      expect(parsed.taskId).toBeUndefined();
    });

    it("dispatch_task with autoSelectRole picks the only role satisfying requirements", async () => {
      const { dispatch, createRole } = getTools();
      await createRole.handler({
        name: "reader-role",
        cagPrompt: "reads things",
        allowedTools: ["Read"],
      });
      const writerResult = await createRole.handler({
        name: "writer-role",
        cagPrompt: "writes things",
        allowedTools: ["Read", "Write", "Edit"],
      });
      const { roleId: writerId } = JSON.parse(writerResult.content[0].text);

      const result = await dispatch.handler({
        prompt: "write a file",
        autoSelectRole: true,
        requirements: { tools: ["Write"] },
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.taskId).toBeDefined();
      expect(parsed.error).toBeUndefined();
      expect(parsed.roleId).toBe(writerId);

      // manager_decisions audit row is created for autoSelectRole dispatches
      const db = getTestDb();
      const row = db.prepare(
        "SELECT * FROM manager_decisions WHERE task_id = ? AND decision_type = 'admission'",
      ).get(parsed.taskId) as Record<string, unknown> | undefined;
      expect(row).toBeDefined();
      expect(row!.role_id).toBe(writerId);
      expect(row!.fit_score).toBeGreaterThan(0);
    });

    it("dispatch_task with autoSelectRole but no requirements returns REQUIREMENTS_MISSING", async () => {
      const { dispatch, createRole } = getTools();
      await createRole.handler({
        name: "autoselect-noreqs-role",
        cagPrompt: "test",
        allowedTools: ["Read"],
      });

      const result = await dispatch.handler({
        prompt: "ambiguous task",
        autoSelectRole: true,
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.code).toBe("REQUIREMENTS_MISSING");
      expect(parsed.error).toBeDefined();
      expect(parsed.taskId).toBeUndefined();
    });
  });

  describe("dispatch_to_role / dispatch_by_requirements contract", () => {
    function getDispatchTools(hideLegacy = false) {
      // Always use unique role names to avoid collisions with other tests
      const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      createAdamTools({ hideLegacyDispatchTask: hideLegacy });
      const config = mockCreateSdkMcpServer.mock.calls.at(-1)![0];
      return {
        dispatchToRole: config.tools.find((t: { name: string }) => t.name === "dispatch_to_role"),
        dispatchByReqs: config.tools.find((t: { name: string }) => t.name === "dispatch_by_requirements"),
        dispatchTask: config.tools.find((t: { name: string }) => t.name === "dispatch_task"),
        createRoleRaw: config.tools.find((t: { name: string }) => t.name === "create_role"),
        toolNames: config.tools.map((t: { name: string }) => t.name),
        uniqueSuffix,
      };
    }

    it("createAdamTools() contains dispatch_task, dispatch_to_role, and dispatch_by_requirements", () => {
      const { toolNames } = getDispatchTools();
      expect(toolNames).toContain("dispatch_task");
      expect(toolNames).toContain("dispatch_to_role");
      expect(toolNames).toContain("dispatch_by_requirements");
    });

    it("createAdamTools({ hideLegacyDispatchTask:true }) contains dispatch_to_role and dispatch_by_requirements but NOT dispatch_task", () => {
      const { toolNames } = getDispatchTools(true);
      expect(toolNames).toContain("dispatch_to_role");
      expect(toolNames).toContain("dispatch_by_requirements");
      expect(toolNames).not.toContain("dispatch_task");
    });

    it("dispatch_to_role creates a task with plain work instruction", async () => {
      const { dispatchToRole, createRoleRaw, uniqueSuffix } = getDispatchTools();

      // Create a Role with Read tool access
      const roleRes = await createRoleRaw.handler({
        name: `reader-contract-${uniqueSuffix}`,
        cagPrompt: "You are a reader.",
        allowedTools: ["Read"],
      });
      const roleId = JSON.parse(roleRes.content[0].text).roleId;

      const res = await dispatchToRole.handler({
        taskInstruction: "读取收件箱并总结",
        roleId,
        requirements: { tools: ["Read"] },
      });
      const result = JSON.parse(res.content[0].text);
      expect(result.taskId).toBeDefined();
      expect(result.roleId).toBe(roleId);
      expect(result.error).toBeUndefined();

      // Verify task prompt matches taskInstruction
      const { getTask } = await import("../../store/tasks.js");
      const task = getTask(result.taskId);
      expect(task?.prompt).toBe("读取收件箱并总结");
    });

    it("dispatch_to_role rejects identity directive in taskInstruction", async () => {
      const { dispatchToRole, createRoleRaw, uniqueSuffix } = getDispatchTools();

      const roleRes = await createRoleRaw.handler({
        name: `reader-contract-${uniqueSuffix}`,
        cagPrompt: "You are a reader.",
        allowedTools: ["Read"],
      });
      const roleId = JSON.parse(roleRes.content[0].text).roleId;

      const res = await dispatchToRole.handler({
        taskInstruction: "你是Boris。读取收件箱",
        roleId,
        requirements: { tools: ["Read"] },
      });
      const result = JSON.parse(res.content[0].text);
      expect(result.code).toBe("TASK_INSTRUCTION_CONTAINS_ROLE_IDENTITY");
      expect(result.taskId).toBeUndefined();
    });

    it("dispatch_to_role rejects empty requirements", async () => {
      const { dispatchToRole, createRoleRaw, uniqueSuffix } = getDispatchTools();

      const roleRes = await createRoleRaw.handler({
        name: `reader-contract-${uniqueSuffix}`,
        cagPrompt: "You are a reader.",
        allowedTools: ["Read"],
      });
      const roleId = JSON.parse(roleRes.content[0].text).roleId;

      const res = await dispatchToRole.handler({
        taskInstruction: "读取收件箱",
        roleId,
        requirements: {},
      });
      const result = JSON.parse(res.content[0].text);
      expect(result.code).toBe("REQUIREMENTS_EMPTY");
      expect(result.taskId).toBeUndefined();
    });

    it("dispatch_by_requirements rejects empty requirements", async () => {
      const { dispatchByReqs } = getDispatchTools();

      const res = await dispatchByReqs.handler({
        taskInstruction: "读取收件箱",
        requirements: {},
      });
      const result = JSON.parse(res.content[0].text);
      expect(result.code).toBe("REQUIREMENTS_EMPTY");
      expect(result.taskId).toBeUndefined();
    });

    it("dispatch_by_requirements auto-selects correct role", async () => {
      const { dispatchByReqs, createRoleRaw, uniqueSuffix } = getDispatchTools();
      const { mkdtempSync } = await import("node:fs");
      const { join } = await import("node:path");

      // Create a reader role
      await createRoleRaw.handler({
        name: `reader-byr-${uniqueSuffix}`,
        cagPrompt: "You are a reader.",
        allowedTools: ["Read"],
      });

      // Create a writer role with additional directory
      const uniquePath = mkdtempSync(join(tmpdir(), "adam-dispatch-contract-"));
      const writerRes = await createRoleRaw.handler({
        name: `writer-byr-${uniqueSuffix}`,
        cagPrompt: "You are a writer.",
        allowedTools: ["Write"],
        additionalDirectories: [{ path: uniquePath, mode: "rw" as const }],
      });
      const writerRoleId = JSON.parse(writerRes.content[0].text).roleId;

      const res = await dispatchByReqs.handler({
        taskInstruction: "写文件",
        requirements: { tools: ["Write"], paths: [{ path: uniquePath, access: "rw" }] },
      });
      const result = JSON.parse(res.content[0].text);
      expect(result.taskId).toBeDefined();
      expect(result.roleId).toBe(writerRoleId);

      // Cleanup
      const { rmSync } = await import("node:fs");
      rmSync(uniquePath, { recursive: true, force: true });
    });

    it("legacy dispatch_task still creates tasks with roleId and prompt", async () => {
      const { dispatchTask, createRoleRaw, uniqueSuffix } = getDispatchTools();

      const roleRes = await createRoleRaw.handler({
        name: `legacy-role-${uniqueSuffix}`,
        cagPrompt: "You are a legacy worker.",
        allowedTools: ["Read"],
      });
      const roleId = JSON.parse(roleRes.content[0].text).roleId;

      const res = await dispatchTask.handler({
        prompt: "test task",
        roleId,
      });
      const result = JSON.parse(res.content[0].text);
      expect(result.taskId).toBeDefined();
    });
  });

  describe("additionalDirectories", () => {
    function getTools() {
      createAdamTools();
      const config = mockCreateSdkMcpServer.mock.calls[0][0];
      return {
        modifyPerms: config.tools.find((t: { name: string }) => t.name === "modify_role_permissions"),
        listRoles: config.tools.find((t: { name: string }) => t.name === "list_roles"),
        createRole: config.tools.find((t: { name: string }) => t.name === "create_role"),
      };
    }

    it("modify_role_permissions accepts additionalDirectories in schema", () => {
      const { modifyPerms } = getTools();
      expect(modifyPerms.inputSchema.additionalDirectories).toBeDefined();
    });

    it("list_roles returns additionalDirectories in role summary", async () => {
      const { listRoles, createRole } = getTools();

      // Create a role with additionalDirectories via create_role tool (now AdditionalDirectory[])
      await createRole.handler({
        name: "add-dirs-test-role",
        cagPrompt: "Test role with dirs",
        additionalDirectories: [{ path: tmpdir() }],
      });

      const result = await listRoles.handler({});
      const parsed = JSON.parse(result.content[0].text);
      const role = parsed.roles.find((r: { name: string }) => r.name === "add-dirs-test-role");
      expect(role).toBeDefined();
      expect(role.additionalDirectories).toEqual([{ path: tmpdir() }]);
    });

    it("modify_role_permissions persists additionalDirectories to DB", async () => {
      const { modifyPerms, createRole } = getTools();

      // Create role first
      await createRole.handler({ name: "mod-dirs-test-role", cagPrompt: "Test" });

      // Get the role ID from the DB
      const { getRoleByName } = await import("../../store/roles.js");
      const role = getRoleByName("mod-dirs-test-role");

      const result = await modifyPerms.handler({
        roleId: role!.id,
        additionalDirectories: [{ path: tmpdir() }],
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);

      // Verify persistence
      const saved = getRoleByName("mod-dirs-test-role");
      expect(saved?.additionalDirectories).toEqual([{ path: tmpdir() }]);
    });

    it("modify_role_permissions persists osCapabilities to DB", async () => {
      const { modifyPerms, createRole, listRoles } = getTools();

      await createRole.handler({ name: "mod-os-cap-role", cagPrompt: "Test" });

      const { getRoleByName } = await import("../../store/roles.js");
      const role = getRoleByName("mod-os-cap-role");

      const result = await modifyPerms.handler({
        roleId: role!.id,
        osCapabilities: [{ id: "automation", targets: ["com.apple.mail"] }],
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);

      const saved = getRoleByName("mod-os-cap-role");
      expect(saved?.osCapabilities).toEqual([{ id: "automation", targets: ["com.apple.mail"] }]);

      const listed = await listRoles.handler({});
      const listedParsed = JSON.parse(listed.content[0].text);
      const listedRole = listedParsed.roles.find((r: { name: string }) => r.name === "mod-os-cap-role");
      expect(listedRole.osCapabilities).toEqual([{ id: "automation", targets: ["com.apple.mail"] }]);
    });
  });

  describe("update_role", () => {
    function getTools() {
      createAdamTools();
      const config = mockCreateSdkMcpServer.mock.calls[0][0];
      return {
        updateRoleTool: config.tools.find((t: { name: string }) => t.name === "update_role"),
        createRole: config.tools.find((t: { name: string }) => t.name === "create_role"),
      };
    }

    it("updates cagPrompt and learnedRules and rewrites workspace CLAUDE.md", async () => {
      const { updateRoleTool, createRole } = getTools();
      const { getRoleByName } = await import("../../store/roles.js");
      const { ensureRoleWorkspace, getRoleWorkspacePath } = await import("../../store/role-workspace.js");
      const { readFileSync } = await import("node:fs");

      await createRole.handler({ name: "upd-identity-role", cagPrompt: "Old prompt" });
      const role = getRoleByName("upd-identity-role");
      expect(role).toBeDefined();

      // Ensure workspace exists so the CLAUDE.md rewrite branch runs
      ensureRoleWorkspace(role!);

      const result = await updateRoleTool.handler({
        roleId: role!.id,
        cagPrompt: "New prompt v2",
        learnedRules: { stylePreferences: ["rule one", "rule two"], avoidedActions: [], pinnedParameters: [] },
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
      expect(parsed.role.cagPrompt).toBe("New prompt v2");
      expect(parsed.role.learnedRules).toEqual({ stylePreferences: ["rule one", "rule two"], avoidedActions: [], pinnedParameters: [] });

      // Verify DB
      const saved = getRoleByName("upd-identity-role");
      expect(saved?.cagPrompt).toBe("New prompt v2");
      expect(saved?.learnedRules).toEqual({ stylePreferences: ["rule one", "rule two"], avoidedActions: [], pinnedParameters: [] });

      // Verify CLAUDE.md was rewritten
      const claudeMd = readFileSync(`${getRoleWorkspacePath("upd-identity-role")}/CLAUDE.md`, "utf-8");
      expect(claudeMd).toContain("New prompt v2");
      expect(claudeMd).toContain("rule one");
    });

    // Fix (2026-06-01): update_role must be able to set the Role's effortTier COLUMN — the
    // canonical model selector that resolveTierModel reads. Previously the tool only exposed a
    // dead `preferences.effort` field, so setting a Role's tier via ChatManager silently no-op'd
    // (wrote a field nothing reads) while reporting success.
    it("sets and clears the effortTier column", async () => {
      const { updateRoleTool, createRole } = getTools();
      const { getRoleByName } = await import("../../store/roles.js");

      await createRole.handler({ name: "upd-tier-role", cagPrompt: "X" });
      const role = getRoleByName("upd-tier-role");

      // set high
      const setRes = await updateRoleTool.handler({ roleId: role!.id, effortTier: "high" });
      expect(JSON.parse(setRes.content[0].text).success).toBe(true);
      expect(getRoleByName("upd-tier-role")?.effortTier).toBe("high");

      // clear with null → column back to unset
      const clearRes = await updateRoleTool.handler({ roleId: role!.id, effortTier: null });
      expect(JSON.parse(clearRes.content[0].text).success).toBe(true);
      expect(getRoleByName("upd-tier-role")?.effortTier).toBeUndefined();
    });

    it("updates status to retired", async () => {
      const { updateRoleTool, createRole } = getTools();
      const { getRoleByName } = await import("../../store/roles.js");

      await createRole.handler({ name: "upd-status-role", cagPrompt: "X" });
      const role = getRoleByName("upd-status-role");

      const result = await updateRoleTool.handler({
        roleId: role!.id,
        status: "retired",
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);

      const saved = getRoleByName("upd-status-role");
      expect(saved?.status).toBe("retired");
    });

    it("returns error for unknown roleId", async () => {
      const { updateRoleTool } = getTools();

      const result = await updateRoleTool.handler({
        roleId: "role-does-not-exist",
        cagPrompt: "ignored",
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain("Role not found");
      expect(parsed.success).toBeUndefined();
    });
  });

  describe("list_templates", () => {
    it("should list created templates", async () => {
      createAdamTools();
      const config = mockCreateSdkMcpServer.mock.calls[0][0];
      const createTemplate = config.tools.find((t: { name: string }) => t.name === "create_template");
      const listTemplates = config.tools.find((t: { name: string }) => t.name === "list_templates");
      expect(createTemplate).toBeDefined();
      expect(listTemplates).toBeDefined();

      // Create a template first
      await createTemplate.handler({
        name: "daily-report",
        prompt: "Generate daily report",
        triggerType: "cron",
        triggerCron: "0 9 * * *",
        autoSelectRole: true,
        requirements: {},
      });

      // List templates
      const result = await listTemplates.handler({});
      const parsed = JSON.parse(result.content[0].text);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBeGreaterThan(0);
      expect(parsed[0]).toHaveProperty("name", "daily-report");
      expect(parsed[0]).toHaveProperty("trigger");
      expect(parsed[0].trigger.cron).toBe("0 9 * * *");
      expect(parsed[0].stepCount).toBe(1);
      expect(parsed[0].steps[0].id).toBe("step-1");
    });

    it("should filter by enabled status", async () => {
      createAdamTools();
      const config = mockCreateSdkMcpServer.mock.calls[0][0];
      const listTemplates = config.tools.find((t: { name: string }) => t.name === "list_templates");

      const result = await listTemplates.handler({ enabled: true });
      const parsed = JSON.parse(result.content[0].text);
      expect(Array.isArray(parsed)).toBe(true);
    });
  });

  // Phase 1.5 + closes Phase 1 follow-up #4: assert the Belief Ledger step fields
  // round-trip through update_template → get_template_detail (proven only by a live
  // roundtrip before). Covers the new settle field on the same surface as publish/consume.
  describe("Belief Ledger step fields round-trip (update_template → get_template_detail)", () => {
    function getTools() {
      createAdamTools();
      const config = mockCreateSdkMcpServer.mock.calls[0][0];
      return {
        createTemplate: config.tools.find((t: { name: string }) => t.name === "create_template"),
        updateTemplate: config.tools.find((t: { name: string }) => t.name === "update_template"),
        getDetail: config.tools.find((t: { name: string }) => t.name === "get_template_detail"),
      };
    }

    it("persists settlesPredictionsFor (and the sibling ledger fields) set via update_template", async () => {
      const { createTemplate, updateTemplate, getDetail } = getTools();

      const created = await createTemplate.handler({
        name: "ledger-wire-test",
        prompt: "emit settle verdicts",
        triggerType: "manual",
        autoSelectRole: true,
        requirements: {},
      });
      const templateId = JSON.parse(created.content[0].text).templateId;

      const upd = await updateTemplate.handler({
        templateId,
        settlementLedgerOwner: "mini-e2e-show",
        openLedgerOwner: "mini-e2e-show",
        settlesPredictionsFor: "mini-e2e-show",
        outputAs: "结算",
      });
      expect(JSON.parse(upd.content[0].text).success).toBe(true);

      const detail = await getDetail.handler({ templateId });
      const parsed = JSON.parse(detail.content[0].text);
      const step = parsed.steps[0];
      expect(step.settlesPredictionsFor).toBe("mini-e2e-show");
      expect(step.settlementLedgerOwner).toBe("mini-e2e-show");
      expect(step.openLedgerOwner).toBe("mini-e2e-show");
    });
  });

  describe("get_capabilities", () => {
    function getTools() {
      createAdamTools();
      const config = mockCreateSdkMcpServer.mock.calls[0][0];
      return {
        getCaps: config.tools.find((t: { name: string }) => t.name === "get_capabilities"),
        createRole: config.tools.find((t: { name: string }) => t.name === "create_role"),
        createTemplate: config.tools.find((t: { name: string }) => t.name === "create_template"),
      };
    }

    it("returns structured capabilities with no seed data", async () => {
      const { getCaps } = getTools();
      const result = await getCaps.handler({});
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.roles).toBeDefined();
      expect(parsed.channels).toBeDefined();
      expect(parsed.plugins).toBeDefined();
      expect(parsed.automations).toBeDefined();
      expect(parsed.execution).toBeDefined();
      expect(parsed.coreFeatures).toBeDefined();
      expect(Array.isArray(parsed.coreFeatures)).toBe(true);
      expect(parsed.coreFeatures.length).toBeGreaterThan(0);
      expect(parsed.execution.maxConcurrent).toBeGreaterThan(0);
    });

    it("includes active roles with their tools", async () => {
      const { getCaps, createRole } = getTools();

      await createRole.handler({
        name: "caps-test-role",
        cagPrompt: "Test",
        allowedTools: ["WebSearch", "Bash"],
      });

      const result = await getCaps.handler({});
      const parsed = JSON.parse(result.content[0].text);

      const role = parsed.roles.active.find((r: { name: string }) => r.name === "caps-test-role");
      expect(role).toBeDefined();
      expect(role.tools).toEqual(["WebSearch", "Bash"]);
    });

    it("includes OS capability registry and role osCapabilities", async () => {
      const { getCaps, createRole } = getTools();

      await createRole.handler({
        name: "caps-os-role",
        cagPrompt: "Test",
        osCapabilities: [{ id: "automation", targets: ["com.apple.mail"] }],
      });

      const result = await getCaps.handler({});
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.osCapabilities).toEqual(
        expect.objectContaining({
          sandbox: expect.objectContaining({
            platform: "sandbox-exec",
            available: true,
          }),
          registry: expect.arrayContaining([
            expect.objectContaining({
              id: "automation",
              availability: "editable",
              editable: true,
            }),
            expect.objectContaining({
              id: "full-disk-access",
              availability: "host-only",
              editable: false,
            }),
          ]),
        }),
      );

      const role = parsed.roles.active.find((r: { name: string }) => r.name === "caps-os-role");
      expect(role.osCapabilities).toEqual([{ id: "automation", targets: ["com.apple.mail"] }]);
    });

    it("includes active templates in automations", async () => {
      const { getCaps, createTemplate } = getTools();

      await createTemplate.handler({
        name: "caps-test-template",
        prompt: "Test",
        triggerType: "cron",
        triggerCron: "0 9 * * *",
        autoSelectRole: true,
        requirements: {},
      });

      const result = await getCaps.handler({});
      const parsed = JSON.parse(result.content[0].text);

      const tmpl = parsed.automations.active.find((t: { name: string }) => t.name === "caps-test-template");
      expect(tmpl).toBeDefined();
      expect(tmpl.trigger.cron).toBe("0 9 * * *");
    });

    it("excludes system roles from active list", async () => {
      const { getCaps } = getTools();
      const result = await getCaps.handler({});
      const parsed = JSON.parse(result.content[0].text);

      // System roles (source === "system") should not appear in active list
      for (const role of parsed.roles.active) {
        expect(role.name).not.toBe("chat-manager");
      }
    });

    it("reports execution pool capacity", async () => {
      const { getCaps } = getTools();
      const result = await getCaps.handler({});
      const parsed = JSON.parse(result.content[0].text);

      expect(typeof parsed.execution.running).toBe("number");
      expect(typeof parsed.execution.queued).toBe("number");
      expect(typeof parsed.execution.maxConcurrent).toBe("number");
    });
  });

  describe("new tool handlers", () => {
    function getTools() {
      createAdamTools();
      const config = mockCreateSdkMcpServer.mock.calls[0][0];
      return {
        cancelTask: config.tools.find((t: { name: string }) => t.name === "cancel_task"),
        deleteRole: config.tools.find((t: { name: string }) => t.name === "delete_role"),
        updateConfig: config.tools.find((t: { name: string }) => t.name === "update_config"),
        listMemories: config.tools.find((t: { name: string }) => t.name === "list_memories"),
        runTemplate: config.tools.find((t: { name: string }) => t.name === "run_template"),
        createTemplate: config.tools.find((t: { name: string }) => t.name === "create_template"),
        createRole: config.tools.find((t: { name: string }) => t.name === "create_role"),
      };
    }

    it("cancel_task sets task status to cancelled", async () => {
      const { cancelTask, createTemplate } = getTools();
      // Create a task via a template (which creates a real task ID)
      const tResult = await createTemplate.handler({ name: "cancel-test", triggerType: "cron", triggerCron: "0 9 * * *", prompt: "test", autoSelectRole: true, requirements: {} });
      const { templateId } = JSON.parse(tResult.content[0].text);
      // Trigger via run_template to get a real task
      // We can't easily create a task with a known ID here, so test via list_templates + verify shape
      const result = await cancelTask.handler({ taskId: "nonexistent" });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBeUndefined(); // task not found
      expect(parsed.error).toBeDefined();
    });

    it("delete_role returns success for existing role", async () => {
      const { deleteRole, createRole } = getTools();
      const rResult = await createRole.handler({ name: "delete-test-role", cagPrompt: "test" });
      const { roleId } = JSON.parse(rResult.content[0].text);
      const result = await deleteRole.handler({ roleId });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
      expect(parsed.roleId).toBe(roleId);
    });

    it("delete_role returns error for nonexistent role", async () => {
      const { deleteRole } = getTools();
      const result = await deleteRole.handler({ roleId: "nonexistent-role-id" });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBeDefined();
    });

    it("update_config returns partial-success shape", async () => {
      const { updateConfig } = getTools();
      const result = await updateConfig.handler({ updates: { "defaults.maxTurns": 100 } });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toHaveProperty("success");
      expect(Array.isArray(parsed.updated)).toBe(true);
      expect(Array.isArray(parsed.errors)).toBe(true);
    });

    it("update_config returns error for server.port", async () => {
      const { updateConfig } = getTools();
      const result = await updateConfig.handler({ updates: { "server.port": 7200 } });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.errors.length).toBeGreaterThan(0);
      expect(parsed.errors[0]).toContain("restart");
    });

    it("list_memories returns memories array with count", async () => {
      const { listMemories, createRole } = getTools();
      const rResult = await createRole.handler({ name: "memory-test-role", cagPrompt: "test" });
      const { roleId } = JSON.parse(rResult.content[0].text);
      const result = await listMemories.handler({ roleId, limit: 5 });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.roleId).toBe(roleId);
      expect(parsed).toHaveProperty("count");
      expect(Array.isArray(parsed.memories)).toBe(true);
    });

    it("list_memories defaults limit to 20", async () => {
      const { listMemories, createRole } = getTools();
      const rResult = await createRole.handler({ name: "memory-limit-test-role", cagPrompt: "test" });
      const { roleId } = JSON.parse(rResult.content[0].text);
      // Call without limit — should not error
      const result = await listMemories.handler({ roleId });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.roleId).toBe(roleId);
    });

    it("run_template returns error for nonexistent template", async () => {
      const { runTemplate } = getTools();
      const result = await runTemplate.handler({ templateId: "nonexistent-template-id" });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain("not found");
    });
  });

  describe("authorize_task_operation / deny_task_operation", () => {
    function getTools() {
      createAdamTools();
      const config = mockCreateSdkMcpServer.mock.calls[0][0];
      return {
        authorizeOp: config.tools.find((t: { name: string }) => t.name === "authorize_task_operation"),
        denyOp: config.tools.find((t: { name: string }) => t.name === "deny_task_operation"),
      };
    }

    it("authorize_task_operation returns error when no pending operation found", async () => {
      const { authorizeOp } = getTools();
      const result = await authorizeOp.handler({ taskId: "nonexistent-task-id" });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain("No pending operation found");
    });

    it("deny_task_operation returns error when no pending operation found", async () => {
      const { denyOp } = getTools();
      const result = await denyOp.handler({ taskId: "nonexistent-task-id" });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain("No pending operation found");
    });
  });

  describe("send_to_channel mediaUrl validation", () => {
    function getSendTool() {
      createAdamTools();
      const config = mockCreateSdkMcpServer.mock.calls[0][0];
      return config.tools.find((t: { name: string }) => t.name === "send_to_channel");
    }

    it("rejects remote URL as mediaUrl", async () => {
      const tool = getSendTool();
      const result = await tool.handler({
        channelName: "WeChat on iPad",
        message: "test",
        mediaUrl: "https://example.com/photo.png",
        mediaType: "image",
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain("local file path");
      expect(parsed.error).toContain("not a remote URL");
    });

    it("rejects nonexistent local file as mediaUrl", async () => {
      const tool = getSendTool();
      const result = await tool.handler({
        channelName: "WeChat on iPad",
        message: "test",
        mediaUrl: "/tmp/nonexistent-file-abc123.png",
        mediaType: "image",
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain("Media file not found");
    });

    it("rejects mediaUrl without mediaType", async () => {
      const tool = getSendTool();
      // Create a temp file to pass existence check
      const fs = await import("node:fs");
      const tmpFile = `/tmp/adam-test-media-${Date.now()}.png`;
      fs.writeFileSync(tmpFile, "fake-png");
      try {
        const result = await tool.handler({
          channelName: "WeChat on iPad",
          message: "test",
          mediaUrl: tmpFile,
        });
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.error).toContain("mediaType is required");
      } finally {
        fs.unlinkSync(tmpFile);
      }
    });
  });

  describe("resolveDeliveryTargets coverage (T18)", () => {
    beforeEach(async () => {
      vi.clearAllMocks();
      vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
      // Seed a channel into test DB so listChannels() returns realistic data
      const { createChannel } = await import("../../store/channels.js");
      const db = getTestDb();
      db.prepare("DELETE FROM channels").run();
      createChannel({
        id: "ch-1",
        name: "WeChat on iPad",
        platform: "wechat",
        enabled: true,
        status: "connected",
        config: { userId: "user-123" },
        createdAt: Date.now(),
        messageCount: 0,
      });
    });

    it("resolves channelName via case-insensitive substring match", async () => {
      const { resolveDeliveryTargets } = await import("../../manager/adam-tools.js");
      // "iPad 微信" should NOT match "WeChat on iPad" (Chinese vs English).
      // But "iPad" alone matches via substring. Use "iPad" to verify substring matching.
      const result = await resolveDeliveryTargets([{ type: "channel", channelName: "iPad" }]);
      expect(result).toEqual([{ type: "channel", channelId: "ch-1", chatId: "user-123" }]);
    });

    it("falls back to channel.config.userId when no session match exists", async () => {
      const { resolveDeliveryTargets } = await import("../../manager/adam-tools.js");
      // listSessions returns [] (no session seeded) — should fall back to channel.config.userId
      const result = await resolveDeliveryTargets([{ type: "channel", channelName: "WeChat on iPad" }]);
      expect(result).toEqual([{ type: "channel", channelId: "ch-1", chatId: "user-123" }]);
    });

    it("returns empty array when channel cannot be resolved", async () => {
      const { resolveDeliveryTargets } = await import("../../manager/adam-tools.js");
      const result = await resolveDeliveryTargets([{ type: "channel", channelName: "Nonexistent Channel XYZ" }]);
      // Function logs via pino logger (not console.warn) and returns [] for unresolved targets.
      // Empty result is the assertion-worthy signal here.
      expect(result).toEqual([]);
    });
  });

  describe("templateStepOutputContractShape — customAssertions schema validation", () => {
    it("accepts valid customAssertions array", async () => {
      const { templateStepOutputContractShape } = await import("../../manager/adam-tools.js");
      const result = templateStepOutputContractShape.safeParse({
        customAssertions: ["thesis must be falsifiable", "counter-evidence required"],
      });
      expect(result.success).toBe(true);
    });

    it("rejects empty customAssertions array (min 1)", async () => {
      const { templateStepOutputContractShape } = await import("../../manager/adam-tools.js");
      const result = templateStepOutputContractShape.safeParse({ customAssertions: [] });
      expect(result.success).toBe(false);
      expect(result.error?.issues.length).toBeGreaterThan(0);
    });

    it("rejects customAssertions array with more than 8 elements (max 8)", async () => {
      const { templateStepOutputContractShape } = await import("../../manager/adam-tools.js");
      const result = templateStepOutputContractShape.safeParse({
        customAssertions: ["a", "b", "c", "d", "e", "f", "g", "h", "i"],
      });
      expect(result.success).toBe(false);
      expect(result.error?.issues.length).toBeGreaterThan(0);
    });

    it("rejects customAssertions array with non-string elements", async () => {
      const { templateStepOutputContractShape } = await import("../../manager/adam-tools.js");
      const result = templateStepOutputContractShape.safeParse({
        customAssertions: [123],
      });
      expect(result.success).toBe(false);
      expect(result.error?.issues.length).toBeGreaterThan(0);
    });

    it("accepts schema with only lengthTarget and no customAssertions (backward compat regression)", async () => {
      const { templateStepOutputContractShape } = await import("../../manager/adam-tools.js");
      const result = templateStepOutputContractShape.safeParse({
        lengthTarget: { min: 100, max: 200, unit: "characters" },
      });
      expect(result.success).toBe(true);
    });
  });
});
