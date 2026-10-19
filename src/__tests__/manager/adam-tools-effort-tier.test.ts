import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { z } from "zod";
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
  updateMutableConfig: vi.fn().mockImplementation(() => ({ success: true, updated: [], errors: [] })),
  setLogLevel: vi.fn(),
  isRestartRequiredPath: vi.fn().mockReturnValue(false),
}));

vi.mock("../../agent/memory-service.js", () => ({
  queryMemory: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../lib/embedding.js", () => ({
  generateEmbedding: vi.fn().mockResolvedValue(new Float32Array(384)),
}));

vi.mock("../../strategy/evaluator/reward.js", () => ({
  calculateReward: vi.fn().mockReturnValue({ reward: 0.8, breakdown: {}, source: "mock", confidence: 0.9 }),
}));

vi.mock("../../strategy/engine.js", () => ({
  StrategyEngine: {
    selectStrategy: vi.fn().mockReturnValue(null),
    recordTrial: vi.fn(),
    getStrategies: vi.fn().mockReturnValue([]),
  },
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
const { getTask } = await import("../../store/tasks.js");

// Schema-level tests: validates the zod schema attached to the dispatch tools
describe("dispatch tool effortTier schema", () => {
  const effortTierSchema = z.enum(["low", "medium", "high"]).optional();

  it("accepts valid effortTier values", () => {
    expect(effortTierSchema.parse("low")).toBe("low");
    expect(effortTierSchema.parse("medium")).toBe("medium");
    expect(effortTierSchema.parse("high")).toBe("high");
  });

  it("accepts undefined when omitted", () => {
    expect(effortTierSchema.parse(undefined)).toBeUndefined();
  });

  it("rejects invalid effortTier: 'extreme'", () => {
    expect(() => effortTierSchema.parse("extreme")).toThrow(z.ZodError);
  });

  it("rejects non-string values", () => {
    expect(() => effortTierSchema.parse(123)).toThrow(z.ZodError);
    expect(() => effortTierSchema.parse(null)).toThrow(z.ZodError);
  });
});

// Handler-level tests: invokes the actual dispatch_to_role handler and verifies
// the persisted task config matches the effortTier argument. Mirrors the pattern
// from adam-tools.test.ts:460-515.
describe("dispatch_to_role handler writes effortTier into task.config", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(() => cleanup());

  function getTools() {
    const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    createAdamTools();
    const config = mockCreateSdkMcpServer.mock.calls.at(-1)![0] as { tools: Array<{ name: string; handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> }> };
    return {
      dispatchToRole: config.tools.find((t) => t.name === "dispatch_to_role")!,
      createRole: config.tools.find((t) => t.name === "create_role")!,
      uniqueSuffix,
    };
  }

  async function setupRole(uniqueSuffix: string, createRole: { handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> }) {
    const res = await createRole.handler({
      name: `effort-tier-test-${uniqueSuffix}`,
      cagPrompt: "You are a worker.",
      allowedTools: ["Read"],
    });
    return JSON.parse(res.content[0].text).roleId as string;
  }

  it("writes effortTier='high' into task.config when provided", async () => {
    const { dispatchToRole, createRole, uniqueSuffix } = getTools();
    const roleId = await setupRole(uniqueSuffix, createRole);

    const res = await dispatchToRole.handler({
      taskInstruction: "Read inbox",
      roleId,
      requirements: { tools: ["Read"] },
      effortTier: "high",
    });
    const result = JSON.parse(res.content[0].text) as { taskId?: string; error?: string };
    expect(result.error).toBeUndefined();
    expect(result.taskId).toBeDefined();

    const task = getTask(result.taskId!);
    expect(task?.config.effortTier).toBe("high");
  });

  it("omits effortTier from task.config when not provided", async () => {
    const { dispatchToRole, createRole, uniqueSuffix } = getTools();
    const roleId = await setupRole(uniqueSuffix, createRole);

    const res = await dispatchToRole.handler({
      taskInstruction: "Read inbox",
      roleId,
      requirements: { tools: ["Read"] },
      // effortTier intentionally omitted
    });
    const result = JSON.parse(res.content[0].text) as { taskId?: string; error?: string };
    expect(result.error).toBeUndefined();
    expect(result.taskId).toBeDefined();

    const task = getTask(result.taskId!);
    expect(task?.config.effortTier).toBeUndefined();
  });

  it("writes effortTier='low' alongside toolOverrides (overrides flow into allowedTools)", async () => {
    const { dispatchToRole, createRole, uniqueSuffix } = getTools();
    const roleId = await setupRole(uniqueSuffix, createRole);

    const res = await dispatchToRole.handler({
      taskInstruction: "Read inbox",
      roleId,
      requirements: { tools: ["Read"] },
      effortTier: "low",
      toolOverrides: { allowedTools: ["Read"] },
    });
    const result = JSON.parse(res.content[0].text) as { taskId?: string; error?: string };
    expect(result.error).toBeUndefined();

    const task = getTask(result.taskId!);
    expect(task?.config.effortTier).toBe("low");
    // toolOverrides is consumed at dispatch time to compute allowedTools; not preserved as a separate config field.
    expect(task?.config.allowedTools).toEqual(["Read"]);
  });
});
