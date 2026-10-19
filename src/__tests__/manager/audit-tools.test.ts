import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setupTestDb, getTestDb } from "../helpers/test-db.js";

// Capture the raw handler registered via tool()
let rawHandler: ((args: unknown) => Promise<unknown>) | null = null;

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: vi.fn((config: { name?: string; tools: unknown[] }) => {
    const tools = config.tools as Array<{ name: string; handler: (args: unknown) => Promise<unknown> }>;
    rawHandler = tools[0]?.handler ?? null;
    return {
      instance: {},
      type: "sdk",
      name: config.name,
      config: { tools },
    };
  }),
  tool: vi.fn((name: string, _desc: string, _schema: unknown, handler: (args: unknown) => Promise<unknown>) => {
    return { name, handler };
  }),
}));

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  setupTestDb();
  rawHandler = null;
});

afterEach(() => {
  vi.resetModules();
});

describe("manager/audit-tools", () => {
  it("Test 1: createAuditTools invokes createSdkMcpServer with name audit-tools and 1 tool", async () => {
    const { createAuditTools } = await import("../../manager/audit-tools.js");
    const server = createAuditTools();

    expect(server).toBeDefined();
    const extended = server as unknown as { config?: { tools: unknown[] } };
    expect(extended.config).toHaveProperty("tools");
    const tools = extended.config!.tools as unknown[];
    expect(tools).toHaveLength(1);
    const toolName = (tools[0] as { name: string }).name;
    expect(toolName).toMatch(/aggregate_mistakes$/);
  });

  it("Test 2: invoking the tool handler with valid args calls aggregateMistakes and returns ok:true", async () => {
    const { createAuditTools } = await import("../../manager/audit-tools.js");
    createAuditTools();
    expect(rawHandler).not.toBeNull();

    const result = await rawHandler!({ windowDays: 14, minOccurrences: 3, minRoles: 2 });

    const resultObj = result as { content: Array<{ type: string; text: string }> };
    const parsed = JSON.parse(resultObj.content[0]!.text);
    expect(parsed.ok).toBe(true);
    expect(parsed).toHaveProperty("patternsUpserted");
    expect(parsed).toHaveProperty("totalEventsScanned");
    expect(parsed).toHaveProperty("dimensionCounts");
  });

  it("Test 3: invalid windowDays (999) returns ok:false with validation error", async () => {
    const { createAuditTools } = await import("../../manager/audit-tools.js");
    createAuditTools();
    expect(rawHandler).not.toBeNull();

    const result = await rawHandler!({ windowDays: 999 });

    const resultObj = result as { content: Array<{ type: string; text: string }> };
    const parsed = JSON.parse(resultObj.content[0]!.text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBeDefined();
  });

  it("Test 4: dimensions: [] (empty array) returns ok:false with validation error", async () => {
    const { createAuditTools } = await import("../../manager/audit-tools.js");
    createAuditTools();
    expect(rawHandler).not.toBeNull();

    // Empty dimensions array violates min(1) constraint
    const result = await rawHandler!({ dimensions: [] });

    const resultObj = result as { content: Array<{ type: string; text: string }> };
    const parsed = JSON.parse(resultObj.content[0]!.text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBeDefined();
  });

  it("Test 5: aggregator throws → handler catch branch returns ok:false with error (plan Task 4 Test 4 intent)", async () => {
    // Exercise the tool-wrapper's try/catch branch at audit-tools.ts:81-85.
    // Per implementation-reviewer T-4.4 finding: Test 4 above covers the zod validation path;
    // this test covers the distinct path where aggregateMistakes itself throws post-validation.
    vi.doMock("../../audit/mistake-aggregator.js", () => ({
      aggregateMistakes: vi.fn(() => {
        throw new Error("simulated aggregator crash");
      }),
      MISTAKE_EMA_THRESHOLD: 0.5,
      MISTAKE_TASK_THRESHOLD: 0.3,
    }));

    const { createAuditTools } = await import("../../manager/audit-tools.js");
    createAuditTools();
    expect(rawHandler).not.toBeNull();

    // Valid args → passes zod → reaches aggregateMistakes which throws
    const result = await rawHandler!({ windowDays: 14, minOccurrences: 3, minRoles: 2 });

    const resultObj = result as { content: Array<{ type: string; text: string }> };
    const parsed = JSON.parse(resultObj.content[0]!.text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("simulated aggregator crash");

    vi.doUnmock("../../audit/mistake-aggregator.js");
  });
});
