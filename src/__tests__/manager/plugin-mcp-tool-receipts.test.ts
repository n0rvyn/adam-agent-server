/**
 * Unit tests for entity_mutation receipts written by plugin & MCP tools.
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

// Mock store modules used via require() inside tool handlers.
// getRoleByName returns a synthetic Engineer role so tests don't depend on
// DB-seeded presets (initializeDefaultRoles is intentionally skipped because
// roles are mocked here).
const { SYNTHETIC_ENGINEER_ROLE } = vi.hoisted(() => ({
  SYNTHETIC_ENGINEER_ROLE: {
    id: "role-synthetic-engineer",
    name: "Engineer",
    status: "active",
    cagPrompt: "Engineer",
    learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
    memoryStreamId: "mem-1",
    preferences: {},
    createdAt: Date.now(),
    allowedTools: [] as string[],
    disallowedTools: [] as string[],
    source: "system",
  },
}));
vi.mock("../../store/roles.js", () => ({
  getRole: vi.fn((id: string) => (id === SYNTHETIC_ENGINEER_ROLE.id ? SYNTHETIC_ENGINEER_ROLE : undefined)),
  getRoleByName: vi.fn((name: string) => (name === "Engineer" ? SYNTHETIC_ENGINEER_ROLE : undefined)),
  listRoles: vi.fn().mockReturnValue([SYNTHETIC_ENGINEER_ROLE]),
  // Patch the synthetic role in place so bind/unbind sequences see persisted state.
  updateRole: vi.fn((_id: string, patch: Partial<typeof SYNTHETIC_ENGINEER_ROLE>) => {
    Object.assign(SYNTHETIC_ENGINEER_ROLE, patch);
  }),
  createRole: vi.fn(),
  deleteRole: vi.fn(),
}));

vi.mock("../../store/role-workspace.js", () => ({
  getRoleWorkspacePath: vi.fn().mockReturnValue("/tmp/test-workspace"),
  ensureRoleWorkspace: vi.fn(),
}));

vi.mock("../../store/plugin-registry.js", () => ({
  listInstalledPlugins: vi.fn().mockReturnValue([]),
  getGlobalEnabledState: vi.fn().mockReturnValue({}),
}));

// Mock plugin CLI to avoid real filesystem operations
vi.mock("../../lib/plugin-cli.js", () => ({
  enablePlugin: vi.fn(),
  disablePlugin: vi.fn(),
  installPlugin: vi.fn(),
  uninstallPlugin: vi.fn(),
  listAvailablePlugins: vi.fn().mockReturnValue([]),
}));

const { withTrace } = await import("../../lib/trace-context.js");
const { createAdamTools } = await import("../../manager/adam-tools.js");
const { getRoleByName } = await import("../../store/roles.js");

describe("plugin tool receipts", () => {
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
    // Roles are fully mocked at module-level; no preset seeding needed.
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

  it("enable_plugin writes receipt with verb=enable, entityType=plugin", async () => {
    const tool = getTool("enable_plugin");
    expect(tool).toBeDefined();

    const traceId = "trace-ep-1";
    await withTrace(traceId, "manual", async () => {
      const result = await tool!.handler({ pluginId: "test-plugin-enable" });
      const parsed = parseResult(result);
      expect(parsed.error).toBeUndefined();

      const call = mockCalls.find((c) => c.toolName === "enable_plugin");
      expect(call).toBeDefined();
      expect(call!.verb).toBe("enable");
      expect(call!.entityType).toBe("plugin");
      expect(call!.entityId).toBe("test-plugin-enable");
      expect(call!.fieldChanges).toBeDefined();
      const enabledChange = call!.fieldChanges!.find((fc) => fc.path === "enabled");
      expect(enabledChange).toBeDefined();
      expect(enabledChange!.before).toBe(false);
      expect(enabledChange!.after).toBe(true);
    });
  });

  it("disable_plugin writes receipt with verb=disable, entityType=plugin", async () => {
    const tool = getTool("disable_plugin");
    expect(tool).toBeDefined();

    const traceId = "trace-dp-1";
    await withTrace(traceId, "manual", async () => {
      const result = await tool!.handler({ pluginId: "test-plugin-disable" });
      const parsed = parseResult(result);
      expect(parsed.error).toBeUndefined();

      const call = mockCalls.find((c) => c.toolName === "disable_plugin");
      expect(call).toBeDefined();
      expect(call!.verb).toBe("disable");
      expect(call!.entityType).toBe("plugin");
      expect(call!.entityId).toBe("test-plugin-disable");
      expect(call!.fieldChanges).toBeDefined();
      const enabledChange = call!.fieldChanges!.find((fc) => fc.path === "enabled");
      expect(enabledChange).toBeDefined();
      expect(enabledChange!.before).toBe(true);
      expect(enabledChange!.after).toBe(false);
    });
  });

  it("install_plugin_for_role writes receipt with verb=install, entityType=plugin, roleId set", async () => {
    const role = getRoleByName("Engineer");
    expect(role).toBeDefined();

    const tool = getTool("install_plugin_for_role");
    expect(tool).toBeDefined();

    const traceId = "trace-ipfr-1";
    await withTrace(traceId, "manual", async () => {
      const result = await tool!.handler({ roleId: role!.id, pluginId: "test-plugin-role" });
      const parsed = parseResult(result);
      expect(parsed.error).toBeUndefined();

      const call = mockCalls.find((c) => c.toolName === "install_plugin_for_role");
      expect(call).toBeDefined();
      expect(call!.verb).toBe("install");
      expect(call!.entityType).toBe("plugin");
      expect(call!.entityId).toBe("test-plugin-role");
      expect(call!.fieldChanges).toBeDefined();
      const scopeChange = call!.fieldChanges!.find((fc) => fc.path === "scope");
      expect(scopeChange).toBeDefined();
      expect(scopeChange!.after).toBe("role");
      const roleIdChange = call!.fieldChanges!.find((fc) => fc.path === "roleId");
      expect(roleIdChange).toBeDefined();
      expect(roleIdChange!.after).toBe(role!.id);
    });
  });

  it("uninstall_plugin_from_role writes receipt with verb=uninstall, entityType=plugin", async () => {
    const role = getRoleByName("Engineer");
    expect(role).toBeDefined();

    const tool = getTool("uninstall_plugin_from_role");
    expect(tool).toBeDefined();

    const traceId = "trace-upfr-1";
    await withTrace(traceId, "manual", async () => {
      const result = await tool!.handler({ roleId: role!.id, pluginId: "test-plugin-unrole" });
      const parsed = parseResult(result);
      expect(parsed.error).toBeUndefined();

      const call = mockCalls.find((c) => c.toolName === "uninstall_plugin_from_role");
      expect(call).toBeDefined();
      expect(call!.verb).toBe("uninstall");
      expect(call!.entityType).toBe("plugin");
      expect(call!.entityId).toBe("test-plugin-unrole");
      expect(call!.fieldChanges).toBeDefined();
      const scopeChange = call!.fieldChanges!.find((fc) => fc.path === "scope");
      expect(scopeChange).toBeDefined();
      expect(scopeChange!.before).toBe("role");
      expect(scopeChange!.after).toBeNull();
    });
  });
});

describe("MCP tool receipts", () => {
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
    // Reset synthetic role's mcpServers between tests so bind/unbind sequences start clean
    (SYNTHETIC_ENGINEER_ROLE as Record<string, unknown>).mcpServers = {};
    // Roles are fully mocked at module-level; no preset seeding needed.
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

  it("bind_mcp_to_role writes receipt with verb=bind, entityType=mcp_binding", async () => {
    const role = getRoleByName("Engineer");
    expect(role).toBeDefined();

    const tool = getTool("bind_mcp_to_role");
    expect(tool).toBeDefined();

    const mcpConfig = { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] };
    const traceId = "trace-bmcp-1";
    await withTrace(traceId, "manual", async () => {
      const result = await tool!.handler({ roleId: role!.id, mcpName: "filesystem", mcpConfig });
      const parsed = parseResult(result);
      expect(parsed.error).toBeUndefined();

      const call = mockCalls.find((c) => c.toolName === "bind_mcp_to_role");
      expect(call).toBeDefined();
      expect(call!.verb).toBe("bind");
      expect(call!.entityType).toBe("mcp_binding");
      expect(call!.entityId).toBe(`${role!.id}:filesystem`);
      expect(call!.fieldChanges).toBeDefined();
      const bindingChange = call!.fieldChanges!.find((fc) => fc.path === "mcpServers.filesystem");
      expect(bindingChange).toBeDefined();
      expect(bindingChange!.before).toBeNull();
      expect(bindingChange!.after).toEqual(mcpConfig);
    });
  });

  it("unbind_mcp_from_role writes receipt with verb=unbind, entityType=mcp_binding", async () => {
    const role = getRoleByName("Engineer");
    expect(role).toBeDefined();

    // First bind an MCP server so we have something to unbind
    const bindTool = getTool("bind_mcp_to_role");
    const mcpConfig = { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] };
    const bindTrace = "trace-bind-mcp-unbind";
    await withTrace(bindTrace, "manual", async () => {
      await bindTool!.handler({ roleId: role!.id, mcpName: "to-unbind", mcpConfig });
    });
    mockCalls.length = 0;

    const tool = getTool("unbind_mcp_from_role");
    expect(tool).toBeDefined();

    const traceId = "trace-umbmcp-1";
    await withTrace(traceId, "manual", async () => {
      const result = await tool!.handler({ roleId: role!.id, mcpName: "to-unbind" });
      const parsed = parseResult(result);
      expect(parsed.error).toBeUndefined();

      const call = mockCalls.find((c) => c.toolName === "unbind_mcp_from_role");
      expect(call).toBeDefined();
      expect(call!.verb).toBe("unbind");
      expect(call!.entityType).toBe("mcp_binding");
      expect(call!.entityId).toBe(`${role!.id}:to-unbind`);
      expect(call!.fieldChanges).toBeDefined();
      const bindingChange = call!.fieldChanges!.find((fc) => fc.path === "mcpServers.to-unbind");
      expect(bindingChange).toBeDefined();
      expect(bindingChange!.before).toEqual(mcpConfig);
      expect(bindingChange!.after).toBeNull();
    });
  });
});
