import type { ChannelAdapter, ChannelStatus, InboundMessage, OutboundMessage } from "./adapter.js";
import type { Channel } from "../shared/types.js";
import { getChannel, updateChannelStatus, listChannels } from "../store/channels.js";
import { handleChatMessage } from "../chat/message-handler.js";
import { serverBus } from "../server/events/server-bus.js";
import { getLogger } from "../lib/logger.js";

const log = getLogger("channels");

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

export class ChannelManager {
  private adapters = new Map<string, ChannelAdapter>();
  private rateLimits = new Map<string, RateLimitEntry>();
  private healthInterval: ReturnType<typeof setInterval> | undefined;
  private rateLimitPerMinute: number;

  constructor(options?: { rateLimitPerMinute?: number }) {
    this.rateLimitPerMinute = options?.rateLimitPerMinute ?? 60;
  }

  async addChannel(channel: Channel, adapter: ChannelAdapter): Promise<void> {
    this.adapters.set(channel.id, adapter);

    const onInboundDispatch = (adapter as {
      onInboundDispatch?: (handler: (msg: InboundMessage) => Promise<void>) => void;
    }).onInboundDispatch;
    if (onInboundDispatch) {
      onInboundDispatch.call(adapter, (msg) => this.routeInboundMessage(channel.id, msg, { rethrowErrors: true }));
    } else {
      // Set up inbound message handler
      adapter.onMessage((msg: InboundMessage) => {
        void this.handleInbound(channel.id, msg);
      });
    }

    if (channel.enabled) {
      await this.connectChannel(channel.id);
    }
  }

  async removeChannel(channelId: string): Promise<void> {
    const adapter = this.adapters.get(channelId);
    if (adapter) {
      try {
        await adapter.disconnect();
      } catch (err) {
        log.error({ channelId, error: err }, "Error disconnecting channel");
      }
      this.adapters.delete(channelId);
      this.rateLimits.delete(channelId);
    }
  }

  async connectChannel(channelId: string): Promise<void> {
    const adapter = this.adapters.get(channelId);
    if (!adapter) {
      throw new Error(`No adapter registered for channel ${channelId}`);
    }

    try {
      updateChannelStatus(channelId, "connecting");
      await adapter.connect();
      const status = adapter.getStatus();
      updateChannelStatus(channelId, status);
      if (status === "connected") {
        log.info({ channelId, platform: adapter.platform, status }, "Channel connected");
      } else {
        log.info({ channelId, platform: adapter.platform, status }, "Channel connect finished");
      }
    } catch (err) {
      updateChannelStatus(channelId, "error");
      log.error({ channelId, error: err }, "Failed to connect channel");
      throw err;
    }
  }

  async disconnectChannel(channelId: string): Promise<void> {
    const adapter = this.adapters.get(channelId);
    if (!adapter) return;

    try {
      await adapter.disconnect();
      updateChannelStatus(channelId, "disconnected");
      log.info({ channelId }, "Channel disconnected");
    } catch (err) {
      log.error({ channelId, error: err }, "Error disconnecting channel");
    }
  }

  getChannelStatus(channelId: string): ChannelStatus {
    const adapter = this.adapters.get(channelId);
    return adapter ? adapter.getStatus() : "disconnected";
  }

  getCapabilities(channelId: string): import("../shared/types.js").ChannelCapabilities | null {
    const adapter = this.adapters.get(channelId);
    return adapter ? adapter.getCapabilities() : null;
  }

  /**
   * Edit a previously-sent message via the channel adapter, if supported.
   * Throws if the channel's adapter does not implement editMessage (capability.canEdit=false).
   * Phase 5 cross-channel sync uses this method; canEdit=false channels fall back to broadcast system_note.
   */
  async editMessage(channelId: string, chatId: string, messageId: string, content: string): Promise<void> {
    const adapter = this.adapters.get(channelId);
    if (!adapter) {
      throw new Error(`No adapter registered for channel ${channelId}`);
    }
    const caps = adapter.getCapabilities();
    if (!caps.canEdit || !adapter.editMessage) {
      throw new Error(`editMessage not supported by ${adapter.platform} adapter (canEdit=${caps.canEdit})`);
    }
    // Apply same rate-limit guard as sendMessage to avoid edit-spam loops.
    if (!this.checkRateLimit(channelId)) {
      log.warn({ channelId }, "Rate limit exceeded, dropping editMessage");
      throw new Error("Rate limit exceeded");
    }
    await adapter.editMessage(chatId, messageId, content);
  }

  getChannelStatuses(): Map<string, ChannelStatus> {
    const statuses = new Map<string, ChannelStatus>();
    for (const [id, adapter] of this.adapters) {
      statuses.set(id, adapter.getStatus());
    }
    return statuses;
  }

  hasAdapter(channelId: string): boolean {
    return this.adapters.has(channelId);
  }

  async sendMessage(channelId: string, chatId: string, message: OutboundMessage): Promise<string | null> {
    const adapter = this.adapters.get(channelId);
    if (!adapter) {
      log.warn({ channelId }, "No adapter for outbound message");
      return null;
    }

    if (!this.checkRateLimit(channelId)) {
      log.warn({ channelId }, "Rate limit exceeded, dropping outbound message");
      return null;
    }

    try {
      return await adapter.sendMessage(chatId, message);
    } catch (err) {
      log.error({ channelId, chatId, error: err }, "Failed to send outbound message");
      return null;
    }
  }

  // Rate limiting (fixed window)

  private checkRateLimit(channelId: string): boolean {
    const now = Date.now();
    const entry = this.rateLimits.get(channelId);

    if (!entry || now - entry.windowStart >= 60_000) {
      this.rateLimits.set(channelId, { count: 1, windowStart: now });
      return true;
    }

    if (entry.count >= this.rateLimitPerMinute) {
      return false;
    }

    entry.count++;
    return true;
  }

  // Inbound message handling

  private async handleInbound(channelId: string, msg: InboundMessage): Promise<void> {
    await this.routeInboundMessage(channelId, msg, { rethrowErrors: false });
  }

  private async routeInboundMessage(channelId: string, msg: InboundMessage, options?: { rethrowErrors?: boolean }): Promise<void> {
    try {
      // Anti-loop: skip messages sent by DeliveryEngine (D-008)
      if (msg.source === "system") {
        log.debug({ channelId }, "Skipping system message (anti-loop)");
        return;
      }
      try {
        const { isRecentlySent } = await import("../delivery/outbound-gateway.js");
        // Check by platform message ID (channelMessageId from InboundMessage.raw)
        const inboundMsgId = (msg as any).channelMessageId ?? (msg.raw as any)?.MsgId ?? "";
        if (inboundMsgId && isRecentlySent(String(inboundMsgId))) {
          log.debug({ channelId, messageId: inboundMsgId }, "Skipping delivery-sent message (anti-loop)");
          return;
        }
      } catch { /* OutboundGateway not initialized yet; skip check */ }

      if (!this.checkRateLimit(channelId)) {
        log.warn({ channelId, senderId: msg.senderId }, "Rate limit exceeded for inbound message");
        return;
      }

      // Check for approval reply BEFORE allowlist check (verifier S1-item1)
      try {
        const { handleInboundForApproval } = await import("./approval-handler.js");
        const approvalConsumed = await handleInboundForApproval(channelId, msg.chatId, msg.content);
        if (approvalConsumed) {
          log.debug({ channelId, chatId: msg.chatId }, "Inbound message consumed as approval reply");
          return;
        }
      } catch { /* approval-handler not loaded yet */ }

      // Check allowlist
      const channel = getChannel(channelId);
      if (channel?.allowedChatIds && !channel.allowedChatIds.includes(msg.chatId)) {
        log.debug({ channelId, chatId: msg.chatId }, "Chat not in allowlist, ignoring");
        return;
      }

      // Route to chat session system
      const result = await handleChatMessage(
        msg.content,
        { type: "channel", channelId, chatId: msg.chatId },
        channel?.linkedRoleId,
      );

      log.info({
        channelId,
        chatId: msg.chatId,
        sessionId: result.sessionId,
      }, "Inbound message routed to session");
    } catch (err) {
      log.error({ channelId, chatId: msg.chatId, error: err }, "Failed to route inbound message");
      if (options?.rethrowErrors) throw err;
    }
  }

  // Health monitoring

  startHealthMonitor(intervalMs = 30_000): void {
    this.stopHealthMonitor();
    this.healthInterval = setInterval(() => {
      this.checkHealth();
    }, intervalMs);
  }

  stopHealthMonitor(): void {
    if (this.healthInterval) {
      clearInterval(this.healthInterval);
      this.healthInterval = undefined;
    }
  }

  private checkHealth(): void {
    for (const [channelId, adapter] of this.adapters) {
      const status = adapter.getStatus();
      try {
        updateChannelStatus(channelId, status);
      } catch {
        // DB update failed; non-fatal
      }
    }
  }

  // Lifecycle

  async startAll(): Promise<void> {
    const channels = listChannels(true); // enabled only
    for (const channel of channels) {
      const adapter = this.adapters.get(channel.id);
      if (adapter && adapter.getStatus() !== "connected") {
        try {
          await this.connectChannel(channel.id);
        } catch {
          // Individual channel failure doesn't block others
        }
      }
    }
    this.startHealthMonitor();
  }

  async stopAll(): Promise<void> {
    this.stopHealthMonitor();
    for (const channelId of this.adapters.keys()) {
      await this.disconnectChannel(channelId);
    }
    this.adapters.clear();
    this.rateLimits.clear();
  }

  // For testing
  _getAdapterCount(): number {
    return this.adapters.size;
  }

  _getRateLimitEntry(channelId: string): RateLimitEntry | undefined {
    return this.rateLimits.get(channelId);
  }
}
