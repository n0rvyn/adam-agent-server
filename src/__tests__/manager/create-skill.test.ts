import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { mkdirSync, rmSync, readFileSync } from "node:fs";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

// Hoist ALL values — vi.hoisted() factory runs in a context where only hoisted
// values are available. `join` and `tmpdir` are top-level imports that haven't been
// initialized when hoisting runs, so we inline the path directly.
const { mockCreateSdkMcpServer, mockTool, TEST_RUNTIME_DIR } = vi.hoisted(() => {
  return {
    mockCreateSdkMcpServer: vi.fn().mockImplementation((config: unknown) => config),
    mockTool: vi.fn().mockImplementation((name: string, description: string, schema: unknown, handler: unknown) => ({
      name,
      description,
      inputSchema: schema,
      handler,
    })),
    // Use a static path to avoid referencing uninitialized imports in the factory
    TEST_RUNTIME_DIR: `/tmp/adam-test-skill-${Date.now()}`,
  };
});

// TEST_RUNTIME_DIR is provided by the hoisted values above
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
  isRestartRequiredPath: vi.fn().mockReturnValue(false),
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
  serverBus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() },
}));

vi.mock("../../sandbox/provider.js", () => ({
  getSandboxProvider: () => ({ platform: "sandbox-exec", isAvailable: async () => true }),
  isSandboxAvailable: vi.fn().mockResolvedValue(true),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: mockCreateSdkMcpServer,
  tool: mockTool,
}));

vi.mock("../../shared/constants.js", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    get RUNTIME_DIR() { return TEST_RUNTIME_DIR; },
  };
});

import { createAdamTools } from "../../manager/adam-tools.js";
import { createRole } from "../../store/roles.js";
import type { Role } from "../../shared/types.js";

afterAll(() => {
  cleanup();
  rmSync(TEST_RUNTIME_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  clearTestDb();
  vi.clearAllMocks();
  mkdirSync(TEST_RUNTIME_DIR, { recursive: true });
});

function makeRole(overrides: Partial<Role> = {}): Role {
  return {
    id: `role-${Math.random().toString(36).slice(2)}`,
    name: `TestRole-${Math.random().toString(36).slice(2)}`,
    cagPrompt: "A test role",
    learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
    memoryStreamId: `ms-${Math.random().toString(36).slice(2)}`,
    status: "active",
    preferences: {},
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("create_skill tool", () => {
  function getCreateSkillTool() {
    createAdamTools();
    const config = mockCreateSdkMcpServer.mock.calls[0][0];
    const tool = config.tools.find((t: { name: string }) => t.name === "create_skill");
    expect(tool).toBeDefined();
    return tool;
  }

  it("creates a SKILL.md file in the Role's workspace", async () => {
    const tool = getCreateSkillTool();
    const role = makeRole();
    createRole(role);

    const result = await tool.handler({
      roleId: role.id,
      skillName: "my_first_skill",
      description: "Does something useful",
      instructions: "Read the file, process it, write the result.",
      parameters: { input: { type: "string", description: "The input file path" } },
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.path).toContain(".claude/skills/my_first_skill/SKILL.md");

    const content = readFileSync(parsed.path, "utf8");
    expect(content).toContain("Does something useful");
    expect(content).toContain("Read the file, process it, write the result.");
    expect(content).toContain("input");
  });

  it("returns error when roleId does not exist", async () => {
    const tool = getCreateSkillTool();

    const result = await tool.handler({
      roleId: "non-existent-role-id",
      skillName: "orphan_skill",
      description: "A skill for nobody",
      instructions: "This should not be written.",
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain("not found");
  });

  it("rejects skillName with path traversal (contains ..)", async () => {
    const tool = getCreateSkillTool();
    const role = makeRole();
    createRole(role);

    // Path traversal: the resolved path escapes .claude/skills/
    const result = await tool.handler({
      roleId: role.id,
      skillName: "../../../etc/passwd",
      description: "Traversal attempt",
      instructions: "Do not write.",
    });

    const parsed = JSON.parse(result.content[0].text);
    // The mock SDK bypasses Zod, so the handler runs. It should detect traversal via the
    // startsWith check and return an error.
    expect(parsed.error).toContain("traversal");
  });

  it("accepts skillName with leading dot (Zod regex allows it; handler writes it)", async () => {
    // Note: the Zod regex /^[a-z0-9_][a-z0-9_-]{0,39}$/ does NOT allow leading dot.
    // However the mock SDK bypasses Zod validation and calls the handler directly.
    // The path traversal check does NOT catch a dot-leading name (it's a valid subdir name),
    // so the mock will succeed. We assert the actual (unmocked-Zod) behavior here.
    const tool = getCreateSkillTool();
    const role = makeRole();
    createRole(role);

    const result = await tool.handler({
      roleId: role.id,
      skillName: ".hidden-skill",
      description: "Dot-leading skill",
      instructions: "A skill starting with dot.",
    });

    const parsed = JSON.parse(result.content[0].text);
    // In production (with real SDK + Zod): Zod would reject this before the handler runs.
    // In the test (mock SDK, no Zod): the handler runs and succeeds (path is valid).
    // We assert the actual behavior of the handler function.
    expect(parsed.ok).toBe(true);
  });

  it("accepts skillName with leading dash (mock SDK bypasses Zod)", async () => {
    const tool = getCreateSkillTool();
    const role = makeRole();
    createRole(role);

    const result = await tool.handler({
      roleId: role.id,
      skillName: "-starts-with-dash",
      description: "Dash-leading skill",
      instructions: "A skill starting with dash.",
    });

    const parsed = JSON.parse(result.content[0].text);
    // Same as above: real SDK + Zod would reject; mock SDK lets it through.
    expect(parsed.ok).toBe(true);
  });

  it("overwrites existing SKILL.md (idempotent update)", async () => {
    const tool = getCreateSkillTool();
    const role = makeRole();
    createRole(role);

    // First write
    await tool.handler({
      roleId: role.id,
      skillName: "overwrite_skill",
      description: "First version",
      instructions: "Version 1",
    });

    // Overwrite with new version
    const result = await tool.handler({
      roleId: role.id,
      skillName: "overwrite_skill",
      description: "Second version",
      instructions: "Version 2 — updated",
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);

    const content = readFileSync(parsed.path, "utf8");
    expect(content).toContain("Second version");
    expect(content).not.toContain("First version");
  });

  it("writes skill without parameters field", async () => {
    const tool = getCreateSkillTool();
    const role = makeRole();
    createRole(role);

    const result = await tool.handler({
      roleId: role.id,
      skillName: "no_params_skill",
      description: "A skill with no inputs",
      instructions: "Simply do the thing.",
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    const content = readFileSync(parsed.path, "utf8");
    expect(content).toContain("Simply do the thing.");
  });
});
