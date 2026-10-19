import type { ChannelAdapter, ChannelStatus, InboundMessage, OutboundMessage } from "../adapter.js";
import { getLogger } from "../../lib/logger.js";

const log = getLogger("channels");

interface TelegramConfig {
  botToken: string;
  allowedUserIds?: string[];
}

type MessageHandler = (msg: InboundMessage) => void;

export class TelegramAdapter implements ChannelAdapter {
  readonly platform = "telegram" as const;
  readonly id: string;

  private config: TelegramConfig;
  private status: ChannelStatus = "disconnected";
  private messageHandler: MessageHandler | null = null;
  private bot: unknown = null; // grammY Bot instance (lazy-loaded)
  private pollingActive = false;

  constructor(id: string, config: TelegramConfig) {
    this.id = id;
    if (!config.botToken) throw new Error("Telegram adapter requires botToken");
    this.config = config;
  }

  async connect(): Promise<void> {
    this.status = "connecting";
    try {
      // Dynamic import to avoid requiring grammY at module load time
      const { Bot } = await import("grammy");
      this.bot = new Bot(this.config.botToken);
      const bot = this.bot as import("grammy").Bot;

      // Set up message handler
      bot.on("message:text", (ctx) => {
        if (!this.messageHandler) return;

        // Check allowed users
        if (this.config.allowedUserIds?.length) {
          if (!this.config.allowedUserIds.includes(String(ctx.from.id))) return;
        }

        // ENHANCEMENT-TELEGRAM-REPLY: ctx.message.reply_to_message also has rich content (text, media, etc.)
        // currently we only use its message_id for prompt resolution; future enhancement could surface the
        // quoted text to message-handler for fuzzy matching when message_id mismatches a known prompt.
        const quotedPlatformMessageId = ctx.message.reply_to_message?.message_id
          ? String(ctx.message.reply_to_message.message_id)
          : undefined;

        const msg: InboundMessage = {
          channelId: this.id,
          platform: "telegram",
          chatId: String(ctx.chat.id),
          senderId: String(ctx.from.id),
          senderName: ctx.from.first_name + (ctx.from.last_name ? ` ${ctx.from.last_name}` : ""),
          content: ctx.message.text,
          isGroup: ctx.chat.type !== "private",
          timestamp: ctx.message.date * 1000,
          raw: ctx.message,
          ...(quotedPlatformMessageId ? { quotedPlatformMessageId } : {}),
        };
        this.messageHandler(msg);
      });

      // ENHANCEMENT-TELEGRAM-REPLY: callback_query also carries chat_instance and inline_message_id
      // for inline-mode bots; envelope protocol currently only uses callback_data + chat + from.
      bot.on("callback_query:data", async (ctx) => {
        // grammy requires answerCallbackQuery to dismiss the loading spinner on the user's button
        await ctx.answerCallbackQuery().catch(() => {});
        if (!this.messageHandler) return;
        if (this.config.allowedUserIds?.length) {
          if (!this.config.allowedUserIds.includes(String(ctx.from.id))) return;
        }

        const data = ctx.callbackQuery.data;
        const chatId = String(ctx.chat?.id ?? "");
        if (!chatId) return;

        // Routing (D-A2): v1: prefix → new envelope buttonPayload; else → legacy approval-handler path.
        // Tighten parser: require EXACTLY 7 chars `v1:XXXX` to avoid silently truncating future
        // protocol extensions (e.g. `v1:A2K7:digest` would otherwise drop digest with no warning).
        // Future v2: callers must use a different prefix (`v2:` etc.) to opt into longer payloads.
        if (data.startsWith("v1:")) {
          if (data.length !== 7) {
            log.warn({ channelId: this.id, dataLen: data.length }, "callback_query v1: payload length != 7, ignoring");
            return;
          }
          const promptId = data.slice(3, 7);  // 4-char base32 after "v1:"
          const msg: InboundMessage = {
            channelId: this.id,
            platform: "telegram",
            chatId,
            senderId: String(ctx.from.id),
            senderName: ctx.from.first_name + (ctx.from.last_name ? ` ${ctx.from.last_name}` : ""),
            content: "",  // button click has no text body; resolution by buttonPayload only
            isGroup: ctx.chat?.type !== "private",
            timestamp: Date.now(),
            raw: ctx.callbackQuery,
            buttonPayload: { promptId, rawValue: data },
          };
          this.messageHandler(msg);
          return;
        }

        // Legacy approval-handler path (yes <shortId> / no <shortId>)
        try {
          const { handleInboundForApproval } = await import("../approval-handler.js");
          await handleInboundForApproval(this.id, chatId, "", data);
        } catch (err) {
          log.warn({ channelId: this.id, error: err }, "Failed to route legacy callback_query to approval-handler");
        }
      });

      // Start polling (non-blocking)
      this.pollingActive = true;
      void bot.start({
        onStart: () => {
          log.info({ channelId: this.id }, "Telegram bot started polling");
        },
      });

      this.status = "connected";
    } catch (err) {
      this.status = "error";
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    if (this.bot && this.pollingActive) {
      const bot = this.bot as import("grammy").Bot;
      await bot.stop();
      this.pollingActive = false;
    }
    this.bot = null;
    this.status = "disconnected";
  }

  getStatus(): ChannelStatus {
    return this.status;
  }

  getCapabilities(): import("../../shared/types.js").ChannelCapabilities {
    return {
      canEdit: true,            // editMessageText wiring in Phase 3
      canQuote: true,
      canParseQuote: true,
      canInlineButtons: true,   // inline_keyboard wiring in Phase 3 (callback_data)
      maxTextLength: 4096,
      supportsAttachments: true,
    };
  }

  async sendMessage(chatId: string, message: OutboundMessage): Promise<string> {
    if (!this.bot) throw new Error("Bot not connected");
    const bot = this.bot as import("grammy").Bot;

    // ENHANCEMENT-TELEGRAM-REPLY: grammy supports rich entities (URL buttons, web_app) beyond inline_keyboard.
    // Extend here when envelope protocol introduces new prompt shapes (e.g. file upload prompt).
    const options: Parameters<typeof bot.api.sendMessage>[2] = {
      reply_to_message_id: message.replyToMessageId ? parseInt(message.replyToMessageId) : undefined,
    };
    if (message.replyMarkup?.inlineKeyboard) {
      options.reply_markup = {
        inline_keyboard: message.replyMarkup.inlineKeyboard.map(row =>
          row.map(btn => ({
            text: btn.text,
            ...(btn.callbackData !== undefined ? { callback_data: btn.callbackData } : {}),
            ...(btn.url !== undefined ? { url: btn.url } : {}),
          })),
        ),
      };
    }
    const result = await bot.api.sendMessage(chatId, message.content, options);
    return String(result.message_id);
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  async sendTypingIndicator(chatId: string): Promise<void> {
    if (!this.bot) return;
    const bot = this.bot as import("grammy").Bot;
    await bot.api.sendChatAction(chatId, "typing");
  }

  /**
   * Edit a previously-sent text message.
   * ENHANCEMENT-TELEGRAM-REPLY: grammy also supports editMessageReplyMarkup (button state edit only).
   * For envelope cross-channel sync, full text replacement (this method) is sufficient.
   */
  async editMessage(chatId: string, messageId: string, content: string): Promise<void> {
    if (!this.bot) throw new Error("Bot not connected");
    // Use `as any` to bypass type-check on grammy API surface; grammy itself is not in
    // local node_modules — the available type stub does not include all API methods.
    // Runtime grammy Bot instance always supports editMessageText.
    const bot = this.bot as any;
    await bot.api.editMessageText(chatId, parseInt(messageId), content);
  }
}
