import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { z } from "zod";
import { setupTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

vi.mock("../../config/runtime.js", () => ({
  getRuntimeConfig: () => ({
    defaults: { allowedTools: [], disallowedTools: [], plugins: [], timeout: 300, maxTurns: 50 },
    logging: { level: "info" },
    server: { port: 7100 },
  }),
  updateMutableConfig: vi.fn(),
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
  calculateReward: vi.fn().mockReturnValue({ reward: 0.8, breakdown: { L2: 0.7, L3: 0.6 }, source: "mock", confidence: 0.9 }),
}));

vi.mock("../../strategy/engine.js", () => ({
  StrategyEngine: { selectStrategy: vi.fn().mockReturnValue(null), recordTrial: vi.fn(), getStrategies: vi.fn().mockReturnValue([]) },
}));

vi.mock("../../strategy/generator.js", () => ({
  StrategyGenerator: { generateVariants: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock("../../server/events/server-bus.js", () => ({
  serverBus: { emit: vi.fn() },
}));

vi.mock("../../sandbox/provider.js", () => ({
  getSandboxProvider: () => ({ platform: "sandbox-exec", isAvailable: async () => true }),
  isSandboxAvailable: vi.fn().mockResolvedValue(true),
}));

const { mockCreateSdkMcpServer, mockTool } = vi.hoisted(() => ({
  mockCreateSdkMcpServer: vi.fn().mockImplementation((config: unknown) => config),
  mockTool: vi.fn().mockImplementation((name: string, description: string, schema: unknown, handler: unknown) => ({
    name, description, inputSchema: schema, handler,
  })),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: mockCreateSdkMcpServer,
  tool: mockTool,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    readFileSync: vi.fn(),
    mkdtempSync: actual.mkdtempSync,
  };
});

// Inline Zod schema matching save_role_style's tool() definition
const roleIdSchema = z.string().min(1);
const saveRoleStyleShape = {
  roleId: roleIdSchema,
  slot: z.enum(["stylePreferences", "avoidedActions"]),
  text: z.string().min(1),
};

const { createAdamTools } = await import("../../manager/adam-tools.js");
const { getRole } = await import("../../store/roles.js");

function findTool(toolName: string) {
  const config = createAdamTools() as unknown as { tools: Array<{ name: string; inputSchema: unknown; handler: (args: unknown) => Promise<unknown> }> };
  return config.tools.find((t) => t.name === toolName);
}

const TEST_ROLE_ID = "test-style-role";

function insertRole(id: string, learnedRulesJson = '{"stylePreferences":[],"avoidedActions":[],"pinnedParameters":[]}') {
  getTestDb().prepare(
    `INSERT OR REPLACE INTO roles (id, name, cag_prompt, learned_rules, memory_stream_id, status, created_at)
     VALUES (?, ?, 'Test CAG', ?, 'mem-style-test', 'active', 1000)`,
  ).run(id, id, learnedRulesJson);
}

describe("save_role_style tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    insertRole(TEST_ROLE_ID);
  });

  afterAll(() => cleanup());

  it("adds text to stylePreferences slot", () => {
    const tool = findTool("save_role_style");
    expect(tool).toBeDefined();

    tool!.handler({ roleId: TEST_ROLE_ID, slot: "stylePreferences", text: "Always greet the user in 卞旸's voice" });

    const role = getRole(TEST_ROLE_ID);
    expect(role?.learnedRules.stylePreferences).toContain("Always greet the user in 卞旸's voice");
    expect(role?.learnedRules.avoidedActions).toHaveLength(0);
  });

  it("adds text to avoidedActions slot", () => {
    const tool = findTool("save_role_style");
    expect(tool).toBeDefined();

    tool!.handler({ roleId: TEST_ROLE_ID, slot: "avoidedActions", text: "Avoid hardcoded paths in scripts" });

    const role = getRole(TEST_ROLE_ID);
    expect(role?.learnedRules.avoidedActions).toContain("Avoid hardcoded paths in scripts");
    expect(role?.learnedRules.stylePreferences).toHaveLength(0);
  });

  it("idempotent: duplicate text returns alreadyPresent without adding a second entry", () => {
    const tool = findTool("save_role_style");
    tool!.handler({ roleId: TEST_ROLE_ID, slot: "stylePreferences", text: "Same rule text" });

    const role1 = getRole(TEST_ROLE_ID);
    const countAfterFirst = role1?.learnedRules.stylePreferences.filter((r) => r === "Same rule text").length ?? 0;
    expect(countAfterFirst).toBe(1);

    tool!.handler({ roleId: TEST_ROLE_ID, slot: "stylePreferences", text: "Same rule text" });

    const role2 = getRole(TEST_ROLE_ID);
    const countAfterSecond = role2?.learnedRules.stylePreferences.filter((r) => r === "Same rule text").length ?? 0;
    expect(countAfterSecond).toBe(1); // still 1, not 2
  });

  it("Zod validation rejects invalid slot value", () => {
    const result = z.object(saveRoleStyleShape).safeParse({
      roleId: TEST_ROLE_ID,
      slot: "invalidSlot",
      text: "Some text",
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((i) => i.path.includes("slot"))).toBe(true);
  });

  it("Zod validation rejects empty text", () => {
    const result = z.object(saveRoleStyleShape).safeParse({
      roleId: TEST_ROLE_ID,
      slot: "stylePreferences",
      text: "",
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((i) => i.path.includes("text"))).toBe(true);
  });

  it("Zod validation rejects missing slot", () => {
    const result = z.object(saveRoleStyleShape).safeParse({
      roleId: TEST_ROLE_ID,
      text: "Some text",
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((i) => i.path.includes("slot"))).toBe(true);
  });
});
