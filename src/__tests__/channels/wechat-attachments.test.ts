import { describe, expect, it } from "vitest";
import { WeChatAdapter } from "../../channels/adapters/wechat/wechat.js";

describe("WeChat attachment capability metadata", () => {
  it("declares one attachment per outbound message", () => {
    const adapter = new WeChatAdapter("wechat-test", { baseUrl: "https://fake.example.com" } as never);
    expect(adapter.getCapabilities()).toEqual(expect.objectContaining({
      supportsAttachments: true,
      maxAttachmentsPerMessage: 1,
    }));
  });
});
