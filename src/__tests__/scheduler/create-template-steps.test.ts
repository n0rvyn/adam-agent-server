/**
 * Regression coverage for ChatManager Template creation with canonical steps[].
 * Replaces the removed dispatch tool regression coverage.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

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

const { createAdamTools } = await import("../../manager/adam-tools.js");
const { getTaskTemplate } = await import("../../store/task-templates.js");

afterAll(() => cleanup());

describe("create_template canonical steps", () => {
  beforeEach(() => {
    clearTestDb();
    mockCreateSdkMcpServer.mockClear();
    mockTool.mockClear();
  });

  function getTool(name: string) {
    createAdamTools();
    const config = mockCreateSdkMcpServer.mock.calls[0][0];
    return config.tools.find((t: { name: string }) => t.name === name);
  }

  it("creates a multi-step Template through the ChatManager tool", async () => {
    const tool = getTool("create_template");

    const result = await tool.handler({
      name: "two-step-template",
      steps: [
        { id: "research", prompt: "Research", autoSelectRole: true, requirements: {} },
        { id: "write", prompt: "Write from {{research.result}}", autoSelectRole: true, requirements: {}, dependsOn: ["research"] },
      ],
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.error).toBeUndefined();
    expect(parsed.stepCount).toBe(2);
    expect(parsed.steps.map((step: { id: string }) => step.id)).toEqual(["research", "write"]);

    const saved = getTaskTemplate(parsed.templateId);
    expect(saved!.trigger.type).toBe("manual");
    expect(saved!.steps[1].dependsOn).toEqual(["research"]);
  });
});
