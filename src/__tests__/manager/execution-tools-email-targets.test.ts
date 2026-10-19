import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Channel } from "../../shared/types.js";

const sendMock = vi.fn(async () => ({ success: true }));
let channels: Channel[] = [];
let tasks: Record<string, unknown> = {};

vi.mock("../../store/channels.js", () => ({
  listChannels: () => channels,
}));

vi.mock("../../chat/session-manager.js", () => ({
  listSessions: () => [],
}));

vi.mock("../../store/roles.js", () => ({
  getRole: () => undefined,
}));

vi.mock("../../store/tasks.js", () => ({
  getTask: (id: string) => tasks[id],
  updateTask: vi.fn(),
}));

vi.mock("../../delivery/outbound-gateway.js", () => ({
  getOutboundGateway: () => ({ send: sendMock , redeliverExecutionTo: vi.fn().mockResolvedValue(undefined) }),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: (config: unknown) => config,
  tool: (name: string, description: string, inputSchema: unknown, handler: unknown) => ({ name, description, inputSchema, handler }),
}));

const { createExecutionTools } = await import("../../manager/execution-tools.js");

describe("execution-tools email targets", () => {
  beforeEach(() => {
    sendMock.mockClear();
    channels = [channel({ id: "mail-1", name: "Client Mail", platform: "email", config: { address: "Test1@Test.com" } })];
  });

  it("send_to_channel sends to a Mail channel without prior session", async () => {
    const server = createExecutionTools("role-1") as unknown as { tools: Array<{ name: string; handler: (args: Record<string, unknown>) => Promise<unknown> }> };
    const sendTool = server.tools.find((tool) => tool.name === "send_to_channel");
    if (!sendTool) throw new Error("send_to_channel not registered");

    await sendTool.handler({ channelName: "Client Mail", message: "hello" });

    expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({
      channelId: "mail-1",
      chatId: "test1@test.com",
      content: "hello",
    }));
  });

  it("omits channel sending tools for TemplateExecution step tasks", async () => {
    tasks = {
      "task-step": {
        id: "task-step",
        parentId: "exec-1",
        templateId: "tmpl-1",
        stepId: "step-a",
      },
    };

    const server = createExecutionTools("role-1", "task-step") as unknown as { tools: Array<{ name: string }> };
    const names = server.tools.map((tool) => tool.name);

    expect(names).not.toContain("send_to_channel");
    expect(names).not.toContain("list_channels");
    expect(names).toContain("report_blocked");
  });
});

function channel(overrides: Partial<Channel>): Channel {
  return {
    id: "ch-1",
    name: "Channel",
    platform: "telegram",
    enabled: true,
    status: "connected",
    config: {},
    createdAt: Date.now(),
    messageCount: 0,
    ...overrides,
  };
}
