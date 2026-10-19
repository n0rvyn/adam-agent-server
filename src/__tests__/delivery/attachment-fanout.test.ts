import { describe, expect, it, vi } from "vitest";
import { buildAttachmentFanoutMessages, sendCommittedAttachmentFanout } from "../../delivery/attachment-fanout.js";
import type { OutboundAttachment } from "../../shared/types.js";

function attachments(count: number): OutboundAttachment[] {
  return Array.from({ length: count }, (_, index) => ({
    path: `/tmp/${index + 1}.png`,
    filename: `${index + 1}.png`,
    contentType: "image/png",
    mediaType: "image",
    artifactId: `artifact-${index + 1}`,
  }));
}

describe("attachment fanout", () => {
  it("fans out one attachment per message when channel maxAttachmentsPerMessage is 1", () => {
    const messages = buildAttachmentFanoutMessages({
      commitmentId: "commit-1",
      attachments: attachments(3),
      capabilities: {
        canEdit: false,
        canQuote: true,
        canParseQuote: true,
        canInlineButtons: false,
        maxTextLength: 4000,
        supportsAttachments: true,
        maxAttachmentsPerMessage: 1,
      },
    });

    expect(messages).toHaveLength(3);
    expect(messages.map((item) => item.discriminator)).toEqual([
      "commit-1:0:artifact-1",
      "commit-1:1:artifact-2",
      "commit-1:2:artifact-3",
    ]);
  });

  it("bundles attachments for channels without a per-message attachment limit", () => {
    const messages = buildAttachmentFanoutMessages({
      commitmentId: "commit-2",
      attachments: attachments(3),
      capabilities: {
        canEdit: true,
        canQuote: true,
        canParseQuote: true,
        canInlineButtons: true,
        maxTextLength: 4096,
        supportsAttachments: true,
      },
    });

    expect(messages).toHaveLength(1);
    expect(messages[0].attachments).toHaveLength(3);
    expect(messages[0].discriminator).toBe("commit-2:bundle:artifact-1,artifact-2,artifact-3");
  });

  it("returns failed per-file evidence when the channel cannot carry attachments", async () => {
    const gateway = { send: vi.fn() };
    const result = await sendCommittedAttachmentFanout({
      gateway: gateway as never,
      taskId: "task-1",
      commitmentId: "commit-3",
      target: { type: "channel", channelId: "wechat-1", chatId: "chat-1" },
      content: "images",
      messageType: "result_delivery",
      attachments: attachments(2),
      capabilities: {
        canEdit: false,
        canQuote: false,
        canParseQuote: false,
        canInlineButtons: false,
        maxTextLength: 1000,
        supportsAttachments: false,
      },
    });

    expect(result.success).toBe(false);
    expect(result.failureReason).toBe("attachments_not_supported");
    expect(result.evidence).toHaveLength(2);
    expect(result.evidence.every((item) => item.status === "failed")).toBe(true);
    expect(gateway.send).not.toHaveBeenCalled();
  });
});
