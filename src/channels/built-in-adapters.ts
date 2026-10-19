import type { Channel } from "../shared/types.js";
import { getRuntimeConfig } from "../config/runtime.js";
import { getLogger } from "../lib/logger.js";
import { listChannels, updateChannelStatus } from "../store/channels.js";
import { DiscordAdapter } from "./adapters/discord.js";
import { getEmailGateway, startEmailGatewayFromConfig } from "./adapters/email/email-gateway.js";
import { registerBounceHandler } from "./adapters/email/bounce-handler.js";
import { getEmailRouter } from "./adapters/email/email-router.js";
import { EmailVirtualAdapter } from "./adapters/email/email-virtual-adapter.js";
import { getNormalizedMailChannelAddress } from "./adapters/email/address.js";
import { WeChatAdapter, type WeChatConfig } from "./adapters/wechat/wechat.js";
import type { ChannelManager } from "./manager.js";

const log = getLogger("channels");
const emailAdapters = new Map<string, EmailVirtualAdapter>();

export async function registerBuiltInAdapter(channelManager: ChannelManager, channel: Channel): Promise<boolean> {
  if (channelManager.hasAdapter(channel.id)) return true;

  if (channel.platform === "wechat") {
    const config = channel.config as unknown as WeChatConfig;
    if (!config.botToken) return false;
    await channelManager.addChannel(channel, new WeChatAdapter(channel.id, config));
    return true;
  }

  if (channel.platform === "discord") {
    const config = channel.config as unknown as { botToken?: string };
    if (!config.botToken) return false;
    await channelManager.addChannel(channel, new DiscordAdapter(channel.id, { botToken: config.botToken }));
    return true;
  }

  if (channel.platform === "email") {
    getNormalizedMailChannelAddress(channel);
    const gateway = getEmailGateway();
    const emailConfig = getRuntimeConfig().emailGateway;
    const adapter = new EmailVirtualAdapter(channel, gateway, {
      from: emailConfig?.smtp?.from || emailConfig?.address,
      displayName: emailConfig?.displayName,
      subjectPrefix: emailConfig?.subjectPrefix ?? "Adam",
    });
    emailAdapters.set(channel.id, adapter);
    getEmailRouter(gateway).registerAdapter(channel, adapter);
    try {
      await ensureEmailGatewayStarted();
      await channelManager.addChannel(channel, adapter);
    } catch (error) {
      await cleanupBuiltInAdapterRuntime(channelManager, channel);
      throw error;
    }
    return true;
  }

  return false;
}

export async function registerEnabledBuiltInAdapters(channelManager: ChannelManager): Promise<void> {
  for (const channel of listChannels(true)) {
    try {
      await registerBuiltInAdapter(channelManager, channel);
    } catch (error) {
      updateChannelStatus(channel.id, "error");
      log.warn({ channelId: channel.id, platform: channel.platform, error }, "Failed to register built-in channel adapter");
    }
  }
}

export async function refreshBuiltInAdapter(channelManager: ChannelManager, channel: Channel): Promise<void> {
  if (channel.platform !== "email") return;
  await cleanupBuiltInAdapterRuntime(channelManager, channel);
  if (channel.enabled) {
    await registerBuiltInAdapter(channelManager, channel);
  }
}

export async function unregisterBuiltInAdapter(channelManager: ChannelManager, channel: Channel): Promise<void> {
  await cleanupBuiltInAdapterRuntime(channelManager, channel);
}

export async function cleanupBuiltInAdapterRuntime(channelManager: ChannelManager | undefined, channel: Channel): Promise<void> {
  if (channel.platform !== "email") return;
  getEmailRouter(getEmailGateway()).unregisterAdapter(channel.id);
  emailAdapters.delete(channel.id);
  if (channelManager?.hasAdapter(channel.id)) {
    await channelManager.removeChannel(channel.id);
  }
}

export function refreshEmailAdapterStatuses(channelManager: ChannelManager): void {
  for (const [channelId, adapter] of emailAdapters.entries()) {
    adapter.syncGatewayStatus();
    updateChannelStatus(channelId, adapter.getStatus());
  }
}

export function getRegisteredEmailAdapterCountForTests(): number {
  return emailAdapters.size;
}

async function ensureEmailGatewayStarted(): Promise<void> {
  const config = getRuntimeConfig().emailGateway;
  if (!config?.enabled) return;
  const status = getEmailGateway().getStatus().status;
  if (status !== "stopped" && status !== "error") return;
  try {
    await startEmailGatewayFromConfig(config);
    registerBounceHandler(getEmailGateway());
  } catch (error) {
    log.warn({ error: sanitizeErrorMessage(error) }, "EmailGateway start failed during built-in adapter registration");
  }
}

function sanitizeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.replace(/pass(word)?=[^\s]+/gi, "password=****");
  return "Email gateway operation failed";
}
