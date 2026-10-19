import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Channel } from "../../shared/types.js";

const sendMock = vi.fn(async () => ({ success: true }));
let channels: Channel[] = [];

vi.mock("../../store/channels.js", () => ({
  listChannels: () => channels,
}));

vi.mock("../../chat/session-manager.js", () => ({
  listSessions: () => [],
}));

vi.mock("../../delivery/outbound-gateway.js", () => ({
  getOutboundGateway: () => ({ send: sendMock , redeliverExecutionTo: vi.fn().mockResolvedValue(undefined) }),
}));

vi.mock("../../config/runtime.js", () => ({
  getRuntimeConfig: () => ({ defaults: {}, server: { port: 7100 } }),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: (config: unknown) => config,
  tool: (name: string, description: string, inputSchema: unknown, handler: unknown) => ({ name, description, inputSchema, handler }),
}));

const { resolveDeliveryTargets, createAdamTools } = await import("../../manager/adam-tools.js");

describe("adam-tools email targets", () => {
  beforeEach(() => {
    sendMock.mockClear();
    channels = [channel({ id: "mail-1", name: "Client Mail", platform: "email", config: { address: "Test1@Test.com" } })];
  });

  it("resolves Mail channels without prior session", async () => {
    const result = await resolveDeliveryTargets([{ type: "channel", channelName: "Client Mail" }]);

    expect(result).toEqual([{ type: "channel", channelId: "mail-1", chatId: "test1@test.com" }]);
  });

  it("send_to_channel sends to the Mail channel address without prior session", async () => {
    const server = createAdamTools() as unknown as { tools: Array<{ name: string; handler: (args: Record<string, unknown>) => Promise<unknown> }> };
    const sendTool = server.tools.find((tool) => tool.name === "send_to_channel");
    if (!sendTool) throw new Error("send_to_channel not registered");

    await sendTool.handler({ channelName: "Client Mail", message: "hello" });

    expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({
      channelId: "mail-1",
      chatId: "test1@test.com",
      content: "hello",
    }));
  });

  it("list_channels exposes the Mail channel address as chatId", async () => {
    const server = createAdamTools() as unknown as { tools: Array<{ name: string; handler: (args: Record<string, unknown>) => Promise<unknown> }> };
    const listTool = server.tools.find((tool) => tool.name === "list_channels");
    if (!listTool) throw new Error("list_channels not registered");

    const result = await listTool.handler({});
    const payload = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);

    expect(payload.channels[0]).toMatchObject({
      id: "mail-1",
      name: "Client Mail",
      platform: "email",
      chatId: "test1@test.com",
    });
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
