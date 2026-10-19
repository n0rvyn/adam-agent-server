import type { Channel, ChannelAdapter, ChannelStatus, InboundMessage, OutboundMessage } from "../../../shared/types.js";
import type { EmailGateway, EmailGatewayStatusValue, ParsedInboundEmail } from "./email-gateway.js";
import { formatEmailFromAddress, getNormalizedMailChannelAddress, normalizeEmailAddress } from "./address.js";
import { buildEmailAttachments } from "./email-attachments.js";
import { buildEmailSubject, renderEmailContent } from "./email-renderer.js";

export type EmailOutboundIdentity = {
  from?: string;
  displayName?: string;
  subjectPrefix?: string;
};

export class EmailVirtualAdapter implements ChannelAdapter {
  readonly platform = "email" as const;
  readonly id: string;
  private readonly channel: Channel;
  private readonly gateway: EmailGateway;
  private handler: ((msg: InboundMessage) => void) | undefined;
  private inboundDispatchHandler: ((msg: InboundMessage) => Promise<void>) | undefined;
  private status: ChannelStatus = "disconnected";
  private readonly identity: EmailOutboundIdentity;

  constructor(channel: Channel, gateway: EmailGateway, identity: EmailOutboundIdentity = {}) {
    this.channel = channel;
    this.gateway = gateway;
    this.id = channel.id;
    this.identity = identity;
  }

  async connect(): Promise<void> {
    const gatewayStatus = this.gateway.getStatus();
    this.status = mapGatewayStatusToChannelStatus(gatewayStatus.status);
  }

  async disconnect(): Promise<void> {
    this.status = "disconnected";
  }

  getStatus(): ChannelStatus {
    return this.status;
  }

  getCapabilities(): import("../../../shared/types.js").ChannelCapabilities {
    return {
      canEdit: false,
      canQuote: false,             // Reply-To header is not quote semantics
      canParseQuote: false,
      canInlineButtons: false,
      maxTextLength: Number.POSITIVE_INFINITY,
      supportsAttachments: true,
    };
  }

  async sendMessage(chatId: string, message: OutboundMessage): Promise<string> {
    const recipient = normalizeEmailAddress(chatId);
    const configuredAddress = getNormalizedMailChannelAddress(this.channel);
    if (recipient !== configuredAddress) {
      throw new Error("Email channel recipient does not match configured address");
    }

    const rendered = renderEmailContent(message.content);
    return this.gateway.send({
      from: this.identity.from
        ? formatEmailFromAddress(this.identity.from, this.identity.displayName)
        : undefined,
      to: recipient,
      subject: buildEmailSubject({ prefix: this.identity.subjectPrefix ?? "Adam", messageType: message.messageType ?? "reply" }),
      text: rendered.text,
      html: rendered.html,
      attachments: buildEmailAttachments(message),
    });
  }

  onMessage(handler: (msg: InboundMessage) => void): void {
    this.handler = handler;
  }

  onInboundDispatch(handler: (msg: InboundMessage) => Promise<void>): void {
    this.inboundDispatchHandler = handler;
  }

  syncGatewayStatus(): void {
    this.status = mapGatewayStatusToChannelStatus(this.gateway.getStatus().status);
  }

  async acceptInbound(email: ParsedInboundEmail): Promise<void> {
    const normalizedFrom = normalizeEmailAddress(email.from);
    const inbound: InboundMessage = {
      channelId: this.channel.id,
      platform: "email",
      chatId: normalizedFrom,
      senderId: normalizedFrom,
      senderName: email.from,
      content: email.text,
      replyToMessageId: email.messageId,
      isGroup: false,
      timestamp: email.date ?? Date.now(),
      raw: {
        messageId: email.messageId,
        subject: email.subject,
        attachmentCount: email.attachmentCount,
        headers: email.rawHeaders,
      },
    };
    this.handler?.(inbound);
    if (this.inboundDispatchHandler) {
      await this.inboundDispatchHandler(inbound);
    }
  }
}

export function mapGatewayStatusToChannelStatus(status: EmailGatewayStatusValue): ChannelStatus {
  switch (status) {
    case "connected":
      return "connected";
    case "starting":
      return "connecting";
    case "degraded":
    case "error":
      return "degraded";
    case "stopped":
      return "disconnected";
    default:
      return "disconnected";
  }
}
