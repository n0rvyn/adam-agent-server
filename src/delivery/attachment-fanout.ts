import type {
  ChannelCapabilities,
  DeliveryCommitmentEvidenceItem,
  NotifyTarget,
  OutboundAttachment,
} from "../shared/types.js";
import type { MessageType, OutboundGateway } from "./outbound-gateway.js";

export interface CommittedAttachmentFanoutArgs {
  gateway: OutboundGateway;
  taskId: string;
  commitmentId: string;
  target: NotifyTarget;
  content: string;
  messageType: MessageType | (string & {});
  attachments: OutboundAttachment[];
  capabilities?: ChannelCapabilities | null;
}

export interface CommittedAttachmentFanoutResult {
  success: boolean;
  evidence: DeliveryCommitmentEvidenceItem[];
  failureReason?: string;
}

interface FanoutMessage {
  attachments: OutboundAttachment[];
  discriminator: string;
  attachmentIndexes: number[];
}

export function buildAttachmentFanoutMessages(args: {
  commitmentId: string;
  attachments: OutboundAttachment[];
  capabilities?: ChannelCapabilities | null;
}): FanoutMessage[] {
  const { commitmentId, attachments } = args;
  const capabilities = args.capabilities ?? undefined;
  if (attachments.length === 0) return [];
  if (capabilities && capabilities.supportsAttachments === false) {
    return [];
  }

  const maxPerMessage = normalizeMaxAttachments(capabilities);
  if (maxPerMessage >= attachments.length) {
    return [{
      attachments,
      attachmentIndexes: attachments.map((_, index) => index),
      discriminator: `${commitmentId}:bundle:${attachments.map(attachmentIdentity).join(",")}`,
    }];
  }

  const messages: FanoutMessage[] = [];
  for (let index = 0; index < attachments.length; index += maxPerMessage) {
    const chunk = attachments.slice(index, index + maxPerMessage);
    const indexes = chunk.map((_, offset) => index + offset);
    messages.push({
      attachments: chunk,
      attachmentIndexes: indexes,
      discriminator: chunk.length === 1
        ? `${commitmentId}:${indexes[0]}:${attachmentIdentity(chunk[0])}`
        : `${commitmentId}:${indexes[0]}-${indexes.at(-1)}:${chunk.map(attachmentIdentity).join(",")}`,
    });
  }
  return messages;
}

export async function sendCommittedAttachmentFanout(
  args: CommittedAttachmentFanoutArgs,
): Promise<CommittedAttachmentFanoutResult> {
  if (args.target.type !== "channel" || !args.target.channelId || !args.target.chatId) {
    return {
      success: false,
      failureReason: "unsupported_commitment_target",
      evidence: args.attachments.map((attachment, index) => evidenceForAttachment({
        attachment,
        index,
        target: args.target,
        status: "failed",
        error: "unsupported_commitment_target",
      })),
    };
  }

  const messages = buildAttachmentFanoutMessages({
    commitmentId: args.commitmentId,
    attachments: args.attachments,
    capabilities: args.capabilities,
  });
  if (messages.length === 0) {
    return {
      success: false,
      failureReason: "attachments_not_supported",
      evidence: args.attachments.map((attachment, index) => evidenceForAttachment({
        attachment,
        index,
        target: args.target,
        status: "failed",
        error: "attachments_not_supported",
      })),
    };
  }

  const evidence: DeliveryCommitmentEvidenceItem[] = [];
  for (const message of messages) {
    const result = await args.gateway.send({
      taskId: args.taskId,
      channelId: args.target.channelId,
      chatId: args.target.chatId,
      content: args.content,
      messageType: args.messageType,
      attachments: message.attachments,
      dedupDiscriminator: message.discriminator,
    });

    for (let offset = 0; offset < message.attachments.length; offset++) {
      const attachment = message.attachments[offset];
      evidence.push(evidenceForAttachment({
        attachment,
        index: message.attachmentIndexes[offset],
        target: args.target,
        status: result.success ? "delivered" : "failed",
        deliveryLogId: result.logEntryId,
        error: result.error,
      }));
    }
  }

  const failed = evidence.find((item) => item.status === "failed");
  return {
    success: !failed,
    evidence,
    failureReason: failed?.error ?? (failed ? "attachment_delivery_failed" : undefined),
  };
}

function normalizeMaxAttachments(capabilities?: ChannelCapabilities | null): number {
  const declared = capabilities?.maxAttachmentsPerMessage;
  if (!declared || !Number.isFinite(declared) || declared < 1) return Number.POSITIVE_INFINITY;
  return Math.floor(declared);
}

function attachmentIdentity(attachment: OutboundAttachment): string {
  return attachment.artifactId ?? attachment.contentHash ?? attachment.filename ?? attachment.path;
}

function evidenceForAttachment(args: {
  attachment: OutboundAttachment;
  index: number;
  target: NotifyTarget;
  status: "delivered" | "failed";
  deliveryLogId?: string;
  error?: string;
}): DeliveryCommitmentEvidenceItem {
  return {
    attachmentIndex: args.index,
    artifactId: args.attachment.artifactId,
    filename: args.attachment.filename,
    mimeType: args.attachment.mimeType ?? args.attachment.contentType,
    target: args.target,
    deliveryLogId: args.deliveryLogId,
    status: args.status,
    error: args.error,
    deliveredAt: args.status === "delivered" ? Date.now() : undefined,
  };
}
