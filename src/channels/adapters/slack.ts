import type { ChannelAdapter, ChannelStatus, InboundMessage, OutboundMessage } from "../adapter.js";
import { getLogger } from "../../lib/logger.js";

const log = getLogger("channels");

interface SlackConfig {
  botToken: string;
  signingSecret: string;
  appToken?: string; // for Socket Mode
  port?: number;
}

type MessageHandler = (msg: InboundMessage) => void;

export class SlackAdapter implements ChannelAdapter {
  readonly platform = "slack" as const;
  readonly id: string;

  private config: SlackConfig;
  private status: ChannelStatus = "disconnected";
  private messageHandler: MessageHandler | null = null;
  private app: unknown = null; // Bolt App instance

  constructor(id: string, config: SlackConfig) {
    this.id = id;
    if (!config.botToken) throw new Error("Slack adapter requires botToken");
    if (!config.signingSecret) throw new Error("Slack adapter requires signingSecret");
    this.config = config;
  }

  async connect(): Promise<void> {
    this.status = "connecting";
    try {
      const { App } = await import("@slack/bolt");
      const appConfig: Record<string, unknown> = {
        token: this.config.botToken,
        signingSecret: this.config.signingSecret,
      };

      if (this.config.appToken) {
        appConfig.socketMode = true;
        appConfig.appToken = this.config.appToken;
      }

      this.app = new App(appConfig as ConstructorParameters<typeof App>[0]);
      const app = this.app as InstanceType<typeof App>;

      // Listen for messages
      app.message(async ({ message, say }) => {
        if (!this.messageHandler) return;
        if (!("text" in message) || message.subtype) return;

        // ENHANCEMENT-SLACK-REPLY: Slack threading is more nuanced than thread_ts alone — there's also
        // ts (this message's own ID) and parent_user_id. Envelope protocol uses thread_ts as the
        // "parent platform message ID". For broadcast replies (reply_broadcast: true), thread_ts is
        // still set even though the message is also sent to the channel root.
        const threadTs = ("thread_ts" in message) ? (message.thread_ts as string | undefined) : undefined;

        const msg: InboundMessage = {
          channelId: this.id,
          platform: "slack",
          chatId: message.channel,
          senderId: message.user ?? "unknown",
          content: message.text ?? "",
          isGroup: message.channel_type !== "im",
          // D-A3 dual-write: keep legacy replyToMessageId AND add new quotedPlatformMessageId
          ...(threadTs ? { replyToMessageId: threadTs, quotedPlatformMessageId: threadTs } : {}),
          timestamp: parseFloat(message.ts) * 1000,
          raw: message,
        };
        this.messageHandler(msg);
      });

      // ENHANCEMENT-SLACK-REPLY: action handler matches all action_id values via regex /.*/.
      // Phase 5 message-handler routes by buttonPayload.promptId. Future scope items:
      //   - Scope by block_id prefix for app-level partitioning (e.g. block_id starts with "approval:" vs "menu:").
      //   - Slack action body shapes vary: today we handle `block_actions` only; future envelope protocol may
      //     need to handle `view_submission` (modal submit) or `shortcut` payload shapes when modal-based
      //     prompts are introduced. Each variant has different `body.{user, channel, view, ...}` paths.
      (app as any).action(/.*/, async ({ ack, body, action }: { ack: () => Promise<void>; body: any; action: any }) => {
        await ack();
        if (!this.messageHandler) return;
        if (body.type !== "block_actions") return;

        // Slack action payload variants: button uses .value, static_select uses .selected_option.value
        const actionAny = action as { value?: string; selected_option?: { value?: string }; action_id?: string };
        const value = actionAny.value ?? actionAny.selected_option?.value ?? "";
        const channel = (body as { channel?: { id?: string } }).channel?.id;
        const user = body.user?.id;
        if (!channel || !user) return;

        // Routing (D-A2): v1: prefix → new envelope buttonPayload.
        // Same tightening as Telegram (Task 6): require EXACTLY 7 chars to refuse silent truncation.
        if (value.startsWith("v1:")) {
          if (value.length !== 7) {
            log.warn({ channelId: this.id, valueLen: value.length }, "Slack action v1: payload length != 7, ignoring");
            return;
          }
          const promptId = value.slice(3, 7);
          const msg: InboundMessage = {
            channelId: this.id,
            platform: "slack",
            chatId: channel,
            senderId: user,
            content: "",
            isGroup: true,  // Block Kit interactions are always in a channel context
            timestamp: Date.now(),
            raw: body,
            buttonPayload: { promptId, rawValue: value },
          };
          this.messageHandler(msg);
          return;
        }

        // Legacy approval-handler path (yes <shortId> / no <shortId> via callback value)
        try {
          const { handleInboundForApproval } = await import("../approval-handler.js");
          await handleInboundForApproval(this.id, channel, "", value);
        } catch (err) {
          log.warn({ channelId: this.id, error: err }, "Failed to route Slack action to approval-handler");
        }
      });

      await app.start(this.config.port ?? 0);
      this.status = "connected";
      log.info({ channelId: this.id }, "Slack bot connected");
    } catch (err) {
      this.status = "error";
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    if (this.app) {
      const app = this.app as import("@slack/bolt").App;
      await app.stop();
    }
    this.app = null;
    this.status = "disconnected";
  }

  getStatus(): ChannelStatus {
    return this.status;
  }

  getCapabilities(): import("../../shared/types.js").ChannelCapabilities {
    return {
      canEdit: true,            // chat.update wiring in Phase 3
      canQuote: true,           // thread_ts
      canParseQuote: true,
      canInlineButtons: true,   // Block Kit actions in Phase 3
      maxTextLength: 40000,
      supportsAttachments: true,
    };
  }

  async sendMessage(chatId: string, message: OutboundMessage): Promise<string> {
    if (!this.app) throw new Error("Slack app not connected");
    const app = this.app as import("@slack/bolt").App;

    // ENHANCEMENT-SLACK-REPLY: Block Kit also supports input blocks, modals (views.open), and
    // shortcuts. Envelope protocol currently uses only sections + actions blocks for approval_prompt.
    const args: Parameters<typeof app.client.chat.postMessage>[0] = {
      channel: chatId,
      text: message.content,
      thread_ts: message.replyToMessageId,
    };
    // OutboundMessage.replyMarkup is Telegram-shaped; Slack doesn't share that field.
    // Block Kit blocks are passed through OutboundMessage.attachments? — NO; blocks are top-level
    // in Slack API. We accept blocks via a Slack-specific extension on OutboundMessage.replyMarkup
    // when its inlineKeyboard is omitted but a `blocks` field exists.
    const slackBlocks = (message.replyMarkup as { blocks?: unknown[] } | undefined)?.blocks;
    if (Array.isArray(slackBlocks)) {
      (args as { blocks?: unknown[] }).blocks = slackBlocks;
    }
    const result = await app.client.chat.postMessage(args);
    return result.ts ?? "";
  }

  /**
   * Edit a previously-sent message via Slack chat.update.
   * ENHANCEMENT-SLACK-REPLY: chat.update preserves blocks if not passed; full envelope sync may
   * want to replace blocks too. Current implementation only replaces text body.
   */
  async editMessage(chatId: string, messageId: string, content: string): Promise<void> {
    if (!this.app) throw new Error("Slack app not connected");
    const app = this.app as import("@slack/bolt").App;
    await app.client.chat.update({
      channel: chatId,
      ts: messageId,
      text: content,
    });
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  async sendTypingIndicator(chatId: string): Promise<void> {
    if (!this.app) return;
    const app = this.app as import("@slack/bolt").App;
    // Slack doesn't have a direct "typing" API for bots; this is a no-op placeholder.
    // Bot typing indicators are not supported by the Slack API for bot users.
    void app;
    void chatId;
  }
}
