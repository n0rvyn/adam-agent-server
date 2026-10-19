import type { ChannelAdapter, ChannelStatus, InboundMessage, OutboundMessage } from "../adapter.js";
import { getLogger } from "../../lib/logger.js";

const log = getLogger("channels");

interface DiscordConfig {
  botToken: string;
  allowedGuildIds?: string[];
}

type MessageHandler = (msg: InboundMessage) => void;

export class DiscordAdapter implements ChannelAdapter {
  readonly platform = "discord" as const;
  readonly id: string;

  private config: DiscordConfig;
  private status: ChannelStatus = "disconnected";
  private messageHandler: MessageHandler | null = null;
  private client: unknown = null; // discord.js Client instance

  constructor(id: string, config: DiscordConfig) {
    this.id = id;
    if (!config.botToken) throw new Error("Discord adapter requires botToken");
    this.config = config;
  }

  async connect(): Promise<void> {
    this.status = "connecting";
    try {
      const { Client, GatewayIntentBits } = await import("discord.js");
      this.client = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.MessageContent,
          GatewayIntentBits.DirectMessages,
        ],
      });
      const client = this.client as import("discord.js").Client;

      client.on("messageCreate", (message) => {
        if (!this.messageHandler) return;
        if (message.author.bot) return;

        // Check allowed guilds
        if (this.config.allowedGuildIds?.length && message.guildId) {
          if (!this.config.allowedGuildIds.includes(message.guildId)) return;
        }

        const msg: InboundMessage = {
          channelId: this.id,
          platform: "discord",
          chatId: message.channelId,
          senderId: message.author.id,
          senderName: message.author.displayName ?? message.author.username,
          content: message.content,
          isGroup: !!message.guildId,
          timestamp: message.createdTimestamp,
          raw: message,
        };
        this.messageHandler(msg);
      });

      await client.login(this.config.botToken);
      this.status = "connected";
      log.info({ channelId: this.id }, "Discord bot connected");
    } catch (err) {
      this.status = "error";
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      const client = this.client as import("discord.js").Client;
      await client.destroy();
    }
    this.client = null;
    this.status = "disconnected";
  }

  getStatus(): ChannelStatus {
    return this.status;
  }

  getCapabilities(): import("../../shared/types.js").ChannelCapabilities {
    return {
      canEdit: true,            // discord.js Message.edit() native support
      canQuote: true,           // reply via messageReference (used in sendMessage)
      canParseQuote: true,
      canInlineButtons: true,   // discord.js supports MessageActionRow + button
      maxTextLength: 2000,
      supportsAttachments: true,
    };
  }

  async sendMessage(chatId: string, message: OutboundMessage): Promise<string> {
    if (!this.client) throw new Error("Discord client not connected");
    const client = this.client as import("discord.js").Client;
    const channel = await client.channels.fetch(chatId);
    if (!channel || !("send" in channel)) throw new Error(`Channel ${chatId} not found or not text channel`);
    const textChannel = channel as import("discord.js").TextChannel;
    const result = await textChannel.send({
      content: message.content,
      reply: message.replyToMessageId ? { messageReference: message.replyToMessageId } as unknown as import("discord.js").ReplyOptions : undefined,
    });
    return result.id;
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  async sendTypingIndicator(chatId: string): Promise<void> {
    if (!this.client) return;
    const client = this.client as import("discord.js").Client;
    const channel = await client.channels.fetch(chatId);
    if (channel && "sendTyping" in channel) {
      await (channel as import("discord.js").TextChannel).sendTyping();
    }
  }
}
