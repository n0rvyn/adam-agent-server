import type { Channel } from "../../../shared/types.js";
import { getLogger } from "../../../lib/logger.js";
import type { EmailGateway, ParsedInboundEmail } from "./email-gateway.js";
import { getNormalizedMailChannelAddress, isEmailPlatform, normalizeEmailAddress } from "./address.js";
import type { EmailVirtualAdapter } from "./email-virtual-adapter.js";

const log = getLogger("channels");

export class EmailRouter {
  private adaptersByAddress = new Map<string, EmailVirtualAdapter>();
  private channelAddressById = new Map<string, string>();

  constructor(private readonly gateway: Pick<EmailGateway, "isSentByAdam">) {}

  registerAdapter(channel: Channel, adapter: EmailVirtualAdapter): void {
    if (!isEmailPlatform(channel) || !channel.enabled) return;
    const address = getNormalizedMailChannelAddress(channel);
    this.unregisterAdapter(channel.id);
    this.adaptersByAddress.set(address, adapter);
    this.channelAddressById.set(channel.id, address);
  }

  unregisterAdapter(channelId: string): void {
    const address = this.channelAddressById.get(channelId);
    if (address) {
      this.adaptersByAddress.delete(address);
      this.channelAddressById.delete(channelId);
    }
  }

  refreshFromChannels(channels: Channel[], adapters: Map<string, EmailVirtualAdapter>): void {
    this.adaptersByAddress.clear();
    this.channelAddressById.clear();
    for (const channel of channels) {
      const adapter = adapters.get(channel.id);
      if (!adapter) continue;
      try {
        this.registerAdapter(channel, adapter);
      } catch (error) {
        log.warn({ channelId: channel.id, error }, "Invalid email channel skipped during router refresh");
      }
    }
  }

  async handle(email: ParsedInboundEmail): Promise<void> {
    if (email.messageId && this.gateway.isSentByAdam(email.messageId)) {
      log.debug({ messageId: email.messageId }, "Skipping Adam-sent email");
      return;
    }

    let from: string;
    try {
      from = normalizeEmailAddress(email.from);
    } catch (error) {
      log.warn({ from: email.from, error }, "Skipping email with invalid sender address");
      return;
    }

    const adapter = this.adaptersByAddress.get(from);
    if (!adapter) {
      log.info({ from }, "Skipping unmatched inbound email");
      return;
    }
    await adapter.acceptInbound(email);
  }

  hasAddress(address: string): boolean {
    return this.adaptersByAddress.has(normalizeEmailAddress(address));
  }
}

let singletonRouter: EmailRouter | undefined;
let boundGateway: EmailGateway | undefined;

export function getEmailRouter(gateway: EmailGateway): EmailRouter {
  if (!singletonRouter || boundGateway !== gateway) {
    singletonRouter = new EmailRouter(gateway);
    boundGateway = gateway;
    gateway.onInbound((email) => singletonRouter?.handle(email) ?? Promise.resolve());
  }
  return singletonRouter;
}

export function resetEmailRouterForTests(): void {
  singletonRouter = undefined;
  boundGateway = undefined;
}
