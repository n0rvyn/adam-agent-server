import { beforeEach, describe, expect, it, vi } from "vitest";

const runNowMock = vi.fn(async () => "exec-1");
const dispatchTemplateMock = vi.fn(async () => undefined);

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: (config: unknown) => config,
  tool: (name: string, description: string, inputSchema: unknown, handler: unknown) => ({ name, description, inputSchema, handler }),
}));

vi.mock("../../store/task-templates.js", () => ({
  getTaskTemplate: vi.fn(() => ({
    id: "tmpl-1",
    name: "Daily Template",
    trigger: { type: "manual" },
    steps: [],
    enabled: true,
  })),
  updateTaskTemplate: vi.fn(),
  deleteTaskTemplate: vi.fn(),
  createTaskTemplate: vi.fn(),
  disableTaskTemplate: vi.fn(),
  getTaskTemplateDependents: vi.fn(() => ({ executionCount: 0, taskCount: 0 })),
}));

vi.mock("../../scheduler/bree-engine.js", () => ({
  getBreeEngine: vi.fn(() => ({ runNow: runNowMock })),
}));

vi.mock("../../scheduler/template-dispatch.js", () => ({
  dispatchTemplate: dispatchTemplateMock,
}));

vi.mock("../../store/runtime-effects.js", () => ({
  recordRuntimeEffect: vi.fn(),
}));

vi.mock("../../config/runtime.js", () => ({
  getRuntimeConfig: vi.fn(() => ({ defaults: { maxConcurrent: 5, maxTurns: 50 } })),
  updateMutableConfig: vi.fn(),
}));
vi.mock("../../lib/embedding.js", () => ({ generateEmbedding: vi.fn() }));
vi.mock("../../strategy/engine.js", () => ({ StrategyEngine: vi.fn() }));
vi.mock("../../strategy/generator.js", () => ({ StrategyGenerator: vi.fn() }));
vi.mock("../../sandbox/provider.js", () => ({
  getSandboxProvider: vi.fn(),
  isSandboxAvailable: vi.fn(),
}));

import { createAdamTools } from "../../manager/adam-tools.js";

function findRunTemplate(server: unknown) {
  return (server as { tools: Array<{ name: string; handler: (args: { templateId: string }) => Promise<unknown> }> })
    .tools.find((tool) => tool.name === "run_template")!;
}

function parseResult(result: unknown): Record<string, unknown> {
  return JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
}

describe("adam-tools run_template origin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runNowMock.mockResolvedValue("exec-1");
  });

  it("passes channel origin as TemplateExecution reportTo fallback", async () => {
    const server = createAdamTools({
      getActiveChatOrigin: () => ({
        chatSessionId: "session-1",
        source: { type: "channel", channelId: "ch-1", chatId: "chat-1" },
      }),
    });

    const result = parseResult(await findRunTemplate(server).handler({ templateId: "tmpl-1" }));

    expect(result.success).toBe(true);
    expect(runNowMock).toHaveBeenCalledWith("tmpl-1", {
      originReportTo: [{ type: "channel", channelId: "ch-1", chatId: "chat-1" }],
      triggerContext: { source: "adam-tools" },
    });
  });

  it("passes web origin as session reportTo fallback", async () => {
    const server = createAdamTools({
      getActiveChatOrigin: () => ({
        chatSessionId: "session-web",
        source: { type: "web" },
      }),
    });

    await findRunTemplate(server).handler({ templateId: "tmpl-1" });

    expect(runNowMock).toHaveBeenCalledWith("tmpl-1", {
      originReportTo: [{ type: "session", sessionId: "session-web" }],
      triggerContext: { source: "adam-tools" },
    });
  });

  // "tools fingerprint stable" test removed (issue #221 cleanup):
  // getToolsFingerprint was only used for SDK session invalidation guard; that path is gone.
});
