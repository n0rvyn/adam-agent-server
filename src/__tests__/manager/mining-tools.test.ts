import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setupTestDb, getTestDb } from "../helpers/test-db.js";
import { listFeatureRequests } from "../../store/feature-requests.js";

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
  rawHandler = null;
  vi.clearAllMocks();
});

describe("manager/mining-tools", () => {
  let cleanup: () => void;

  beforeEach(() => {
    const { cleanup: c } = setupTestDb();
    cleanup = c;
  });

  afterEach(() => {
    cleanup!();
  });

  it("createMiningTools returns MCP server with exactly 1 tool named record_feature_request", async () => {
    const { createMiningTools } = await import("../../manager/mining-tools.js");
    const server = createMiningTools("role-test");
    expect(server).toBeDefined();
    // Cast to access our mock's extended shape (which includes config.tools)
    const extended = server as unknown as { config?: { tools: unknown[] } };
    expect(extended.config).toHaveProperty("tools");
    const tools = extended.config!.tools as unknown[];
    expect(tools).toHaveLength(1);
    const toolName = (tools[0] as { name: string }).name;
    expect(toolName).toMatch(/record_feature_request$/);
  });

  it("raw handler validates content max length — rejects > 5000 chars", async () => {
    const { createMiningTools } = await import("../../manager/mining-tools.js");
    createMiningTools("role-test");
    expect(rawHandler).not.toBeNull();

    const tooLong = "x".repeat(5001);
    const result = await rawHandler!({ content: tooLong, summary: "test" }) as { content: Array<{ type: string; text: string }> };
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBeDefined();
  });

  it("raw handler validates tags max count — rejects > 10 tags", async () => {
    const { createMiningTools } = await import("../../manager/mining-tools.js");
    createMiningTools("role-test");
    expect(rawHandler).not.toBeNull();

    const tags = Array.from({ length: 11 }, (_, i) => `tag${i}`);
    const result = await rawHandler!({ content: "test", tags }) as { content: Array<{ type: string; text: string }> };
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBeDefined();
  });

  it("raw handler writes to feature_requests table on valid input", async () => {
    const { createMiningTools } = await import("../../manager/mining-tools.js");
    createMiningTools("role-test");
    expect(rawHandler).not.toBeNull();

    const result = await rawHandler!({
      content: "Adam should support Notion integration",
      summary: "Notion integration",
      tags: ["integration", "notion"],
      evidenceQuote: "I wish Adam could sync with Notion",
    });

    const resultObj = result as { content: Array<{ type: string; text: string }> };
    expect(resultObj.content).toBeDefined();
    const parsed = JSON.parse(resultObj.content[0]!.text);
    expect(parsed.success).toBe(true);
    expect(parsed.featureRequestId).toBeDefined();

    // Verify the row was actually written
    const all = listFeatureRequests();
    const found = all.find((r) => r.id === parsed.featureRequestId);
    expect(found).toBeDefined();
    expect(found!.content).toBe("Adam should support Notion integration");
    expect(found!.summary).toBe("Notion integration");
    expect(found!.status).toBe("new");
    // T-2: extractedByRoleId propagation — roleId passed to createMiningTools must reach the row
    expect(found!.extractedByRoleId).toBe("role-test");
  });

  it("extractedByRoleId reflects the roleId passed to createMiningTools", async () => {
    const { createMiningTools } = await import("../../manager/mining-tools.js");
    createMiningTools("role-feature-miner-42");
    expect(rawHandler).not.toBeNull();

    const result = await rawHandler!({ content: "test request" });
    const resultObj = result as { content: Array<{ type: string; text: string }> };
    const parsed = JSON.parse(resultObj.content[0]!.text);
    const all = listFeatureRequests();
    const found = all.find((r) => r.id === parsed.featureRequestId);
    expect(found!.extractedByRoleId).toBe("role-feature-miner-42");
  });

  it("raw handler does not crash on valid call (returns structured result)", async () => {
    const { createMiningTools } = await import("../../manager/mining-tools.js");
    createMiningTools("role-test");
    expect(rawHandler).not.toBeNull();

    // Should return a structured result, not throw
    const result = await rawHandler!({ content: "valid content" }) as { content?: Array<{text: string}> };
    expect(result).toBeDefined();
    expect(result.content).toBeDefined();
  });
});
