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

// Mock SDK so createAdamTools() initialises without a live SDK session
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

// Mock filesystem so writeRoleCLAUDEmd() is a no-op
// Use importOriginal so that setupTestDb() (called at module level) still gets mkdtempSync
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

// Inline Zod schema matching pin_role_parameter's tool() definition
const roleIdSchema = z.string().min(1);
const pinRoleParameterShape = {
  roleId: roleIdSchema,
  tool: z.string().min(1),
  params: z.record(z.string(), z.unknown()),
  condition: z.string().optional(),
};

const { createAdamTools } = await import("../../manager/adam-tools.js");
const { getRole } = await import("../../store/roles.js");

// ─── Helpers ─────────────────────────────────────────────────────────────────

function findTool(toolName: string) {
  const config = createAdamTools() as unknown as { tools: Array<{ name: string; inputSchema: unknown; handler: (args: unknown) => Promise<unknown> }> };
  return config.tools.find((t) => t.name === toolName);
}

const TEST_ROLE_ID = "test-pin-style-role";
const TEST_ROLE_ID_2 = "test-pin-style-role-2";
const TEST_ROLE_ID_3 = "test-pin-style-role-3";

function insertRole(id: string, learnedRulesJson = '{"stylePreferences":[],"avoidedActions":[],"pinnedParameters":[]}') {
  getTestDb().prepare(
    `INSERT OR REPLACE INTO roles (id, name, cag_prompt, learned_rules, memory_stream_id, status, created_at)
     VALUES (?, ?, 'Test CAG', ?, 'mem-test', 'active', 1000)`,
  ).run(id, id, learnedRulesJson);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("pin_role_parameter tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  });

  afterAll(() => cleanup());

  it("adds a pinned parameter to the pinnedParameters slot", () => {
    insertRole(TEST_ROLE_ID);
    const pinTool = findTool("pin_role_parameter");
    expect(pinTool).toBeDefined();

    pinTool!.handler({
      roleId: TEST_ROLE_ID,
      tool: "Bash:generate_voice.sh",
      params: { "-v": "male-qn-qing-xx" },
      condition: "for podcast voice",
    });

    const role = getRole(TEST_ROLE_ID);
    expect(role?.learnedRules.pinnedParameters).toHaveLength(1);
    expect(role?.learnedRules.pinnedParameters[0].tool).toBe("Bash:generate_voice.sh");
    expect(role?.learnedRules.pinnedParameters[0].params).toEqual({ "-v": "male-qn-qing-xx" });
    expect(role?.learnedRules.pinnedParameters[0].condition).toBe("for podcast voice");
    expect(typeof role?.learnedRules.pinnedParameters[0].pinnedAt).toBe("number");
  });

  it("replaces existing pin with same tool+params-key set instead of appending", () => {
    insertRole(TEST_ROLE_ID_2);
    const pinTool = findTool("pin_role_parameter");

    // First call
    pinTool!.handler({ roleId: TEST_ROLE_ID_2, tool: "Bash:generate_voice.sh", params: { "-v": "female-zh-cn" } });

    // Second call — same tool + same params keys → replace
    pinTool!.handler({ roleId: TEST_ROLE_ID_2, tool: "Bash:generate_voice.sh", params: { "-v": "male-qn-qing-xx" } });

    const role = getRole(TEST_ROLE_ID_2);
    const pins = role?.learnedRules.pinnedParameters ?? [];
    expect(pins).toHaveLength(1); // not 2 — replaced, not appended
    expect(pins[0].params).toEqual({ "-v": "male-qn-qing-xx" });
    expect(pins[0].pinnedAt).toBeGreaterThan(0);
  });

  it("adds a second entry when tool pattern differs", () => {
    insertRole(TEST_ROLE_ID_3);
    const pinTool = findTool("pin_role_parameter");

    pinTool!.handler({ roleId: TEST_ROLE_ID_3, tool: "Bash:generate_voice.sh", params: { "-v": "x" } });
    pinTool!.handler({ roleId: TEST_ROLE_ID_3, tool: "Bash:other_script.sh", params: { "--flag": "y" } });

    const role = getRole(TEST_ROLE_ID_3);
    expect(role?.learnedRules.pinnedParameters).toHaveLength(2);
    expect(role?.learnedRules.pinnedParameters.map((p) => p.tool)).toEqual(["Bash:generate_voice.sh", "Bash:other_script.sh"]);
  });

  it("Zod validation rejects missing tool", () => {
    const result = pinRoleParameterShape.roleId.optional().safeParse(undefined);
    // roleId is required; test that the overall shape requires it
    const fullResult = z.object(pinRoleParameterShape).safeParse({ roleId: TEST_ROLE_ID, params: { "-v": "x" } });
    expect(fullResult.success).toBe(false);
    expect(fullResult.error?.issues.some((i) => i.path.includes("tool"))).toBe(true);
  });

  it("Zod validation rejects non-object params", () => {
    const fullResult = z.object(pinRoleParameterShape).safeParse({ roleId: TEST_ROLE_ID, tool: "Bash:test.sh", params: "not-an-object" });
    expect(fullResult.success).toBe(false);
    expect(fullResult.error?.issues.some((i) => i.path.includes("params"))).toBe(true);
  });

  it("Zod validation rejects empty tool string", () => {
    const fullResult = z.object(pinRoleParameterShape).safeParse({ roleId: TEST_ROLE_ID, tool: "", params: { "-v": "x" } });
    expect(fullResult.success).toBe(false);
  });
});
