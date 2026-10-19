import { describe, it, expect, vi } from "vitest";

vi.mock("../../../lib/logger.js", () => ({
  getLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

const mockMessage = vi.fn();
const mockStart = vi.fn().mockResolvedValue(undefined);
const mockStop = vi.fn().mockResolvedValue(undefined);
const mockPostMessage = vi.fn().mockResolvedValue({ ts: "1234567890.123456" });

vi.mock("@slack/bolt", () => ({
  App: vi.fn(function () {
    return {
      message: mockMessage,
      start: mockStart,
      stop: mockStop,
      client: { chat: { postMessage: mockPostMessage } },
      action: vi.fn(),
    };
  }),
}));

import { SlackAdapter } from "../../../channels/adapters/slack.js";

describe("SlackAdapter", () => {
  it("creates with correct platform", () => {
    const adapter = new SlackAdapter("sl1", { botToken: "xoxb-test", signingSecret: "secret" });
    expect(adapter.platform).toBe("slack");
    expect(adapter.getStatus()).toBe("disconnected");
  });

  it("connects and starts app", async () => {
    const adapter = new SlackAdapter("sl1", { botToken: "xoxb-test", signingSecret: "secret" });
    await adapter.connect();
    expect(adapter.getStatus()).toBe("connected");
    expect(mockStart).toHaveBeenCalled();
  });

  it("disconnects", async () => {
    const adapter = new SlackAdapter("sl1", { botToken: "xoxb-test", signingSecret: "secret" });
    await adapter.connect();
    await adapter.disconnect();
    expect(adapter.getStatus()).toBe("disconnected");
    expect(mockStop).toHaveBeenCalled();
  });

  it("sends message", async () => {
    const adapter = new SlackAdapter("sl1", { botToken: "xoxb-test", signingSecret: "secret" });
    await adapter.connect();
    const ts = await adapter.sendMessage("C123", { content: "Hello Slack" });
    expect(ts).toBe("1234567890.123456");
    expect(mockPostMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: "C123", text: "Hello Slack" }));
  });

  it("registers message handler", () => {
    const adapter = new SlackAdapter("sl1", { botToken: "xoxb-test", signingSecret: "secret" });
    adapter.onMessage(vi.fn());
  });

  it("throws on empty botToken", () => {
    expect(() => new SlackAdapter("sl1", { botToken: "", signingSecret: "secret" })).toThrow("requires botToken");
  });

  it("throws on empty signingSecret", () => {
    expect(() => new SlackAdapter("sl1", { botToken: "xoxb-test", signingSecret: "" })).toThrow("requires signingSecret");
  });
});
