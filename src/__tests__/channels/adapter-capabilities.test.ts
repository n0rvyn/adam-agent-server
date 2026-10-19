import { describe, test, expect } from "vitest";
import { TelegramAdapter } from "../../channels/adapters/telegram.js";
import { SlackAdapter } from "../../channels/adapters/slack.js";
import { DiscordAdapter } from "../../channels/adapters/discord.js";
import { OpenClawAdapter } from "../../channels/adapters/openclaw.js";
import { WeChatAdapter } from "../../channels/adapters/wechat/wechat.js";
import { EmailVirtualAdapter } from "../../channels/adapters/email/email-virtual-adapter.js";

describe("Channel adapter capability declarations (envelope protocol Phase 2)", () => {
  test("Telegram: canEdit + canQuote + canParseQuote + canInlineButtons + maxTextLength=4096", () => {
    const a = new TelegramAdapter("ch-t", { botToken: "fake" });
    expect(a.getCapabilities()).toEqual({
      canEdit: true,
      canQuote: true,
      canParseQuote: true,
      canInlineButtons: true,
      maxTextLength: 4096,
      supportsAttachments: true,
    });
  });

  test("Slack: canEdit + canQuote + canParseQuote + canInlineButtons + maxTextLength=40000", () => {
    const a = new SlackAdapter("ch-s", { botToken: "x", signingSecret: "y" });
    expect(a.getCapabilities()).toEqual({
      canEdit: true,
      canQuote: true,
      canParseQuote: true,
      canInlineButtons: true,
      maxTextLength: 40000,
      supportsAttachments: true,
    });
  });

  test("Discord: canEdit + canQuote + canParseQuote + canInlineButtons + maxTextLength=2000", () => {
    const a = new DiscordAdapter("ch-d", { botToken: "fake" });
    expect(a.getCapabilities()).toEqual({
      canEdit: true,
      canQuote: true,
      canParseQuote: true,
      canInlineButtons: true,
      maxTextLength: 2000,
      supportsAttachments: true,
    });
  });

  test("WeChat: canEdit=false + canQuote=true + maxTextLength=4000", () => {
    // WeChatAdapter constructor requires baseUrl — provide minimal valid config cast as never
    const a = new WeChatAdapter("ch-w", { baseUrl: "https://fake.example.com" } as never);
    expect(a.getCapabilities()).toEqual({
      canEdit: false,
      canQuote: true,
      canParseQuote: true,
      canInlineButtons: false,
      maxTextLength: 4000,
      supportsAttachments: true,
      maxAttachmentsPerMessage: 1,
    });
  });

  test("OpenClaw: matches WeChat capability profile", () => {
    const a = new OpenClawAdapter("ch-o", {} as never);
    expect(a.getCapabilities()).toEqual({
      canEdit: false,
      canQuote: true,
      canParseQuote: true,
      canInlineButtons: false,
      maxTextLength: 4000,
      supportsAttachments: true,
    });
  });

  test("EmailVirtualAdapter: all capability=false except supportsAttachments + maxTextLength=Infinity", () => {
    // Constructor signature: new EmailVirtualAdapter(channel: Channel, gateway: EmailGateway, identity?: EmailOutboundIdentity)
    // Both `channel` and `gateway` are required positional args; pass minimal stubs cast as never since
    // getCapabilities() is a pure field-return method (no gateway/channel dereference).
    const fakeChannel = { id: "ch-e", platform: "email" } as never;
    const fakeGateway = {} as never;
    const a = new EmailVirtualAdapter(fakeChannel, fakeGateway);
    expect(a.getCapabilities()).toEqual({
      canEdit: false,
      canQuote: false,
      canParseQuote: false,
      canInlineButtons: false,
      maxTextLength: Number.POSITIVE_INFINITY,
      supportsAttachments: true,
    });
  });
});
