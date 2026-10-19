/**
 * WeChat ChannelAdapter for Adam.
 * Uses iLink Bot API for message send/receive.
 * QR scan authentication for login.
 *
 * iLink platform limits (per chatId):
 *   - 24h session window: bot can only sendMessage within 24h of the user's last inbound message
 *   - 10-message quota: max 10 outbound messages per 24h window (resets on user message)
 *   - ret=-2: quota exhausted or session degraded
 */
import fs from "node:fs";
import * as fsAsync from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import type { ChannelAdapter, ChannelStatus, InboundMessage, OutboundMessage } from "../../adapter.js";
import { getUpdates, sendMessage as apiSendMessage, sendTyping as apiSendTyping } from "./api.js";
import type { WeixinMessage } from "./types.js";
import { MessageItemType, MessageType, MessageState, TypingStatus } from "./types.js";
import {
  isSessionPaused,
  getRemainingPauseMs,
  clearSessionPause,
  pauseSession,
  SESSION_EXPIRED_ERRCODE,
  SESSION_PAUSE_DURATION_MS,
} from "./session-guard.js";
import { downloadMediaFromItem } from "./media/media-download.js";
import { sendWeixinMediaFile } from "./messaging/send-media.js";
import { getExtensionFromMime } from "./media/mime.js";
import { getLogger } from "../../../lib/logger.js";

const log = getLogger("channels");

/** Default CDN base URL, matching @tencent-weixin/openclaw-weixin upstream. */
const DEFAULT_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";

export interface WeChatConfig {
  baseUrl: string;
  botToken?: string;
  accountId?: string;
  userId?: string;
  routeTag?: string;
  /** CDN base URL for media upload/download. Defaults to openclaw upstream CDN when not set. */
  cdnBaseUrl?: string;
  [key: string]: unknown;
}

// In-memory context tokens: `${channelId}:${userId}` -> contextToken
const contextTokens = new Map<string, string>();

// ---- Context token persistence ----

function getContextTokenFilePath(channelId: string): string {
  return path.join(homedir(), ".adam", "wechat", `${channelId}.context-tokens.json`);
}

function loadContextTokens(channelId: string): void {
  const filePath = getContextTokenFilePath(channelId);
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const tokens = JSON.parse(raw) as Record<string, string>;
    for (const [userId, token] of Object.entries(tokens)) {
      if (typeof token === "string" && token) {
        contextTokens.set(`${channelId}:${userId}`, token);
      }
    }
    log.debug({ channelId, count: Object.keys(tokens).length }, "Restored context tokens from disk");
  } catch { /* file doesn't exist yet */ }
}

function persistContextToken(channelId: string, userId: string, token: string): void {
  const filePath = getContextTokenFilePath(channelId);
  try {
    // Load existing tokens, merge, write back
    let tokens: Record<string, string> = {};
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      tokens = JSON.parse(raw) as Record<string, string>;
    } catch { /* start fresh */ }
    tokens[userId] = token;
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(tokens), "utf-8");
  } catch (err) {
    log.warn({ channelId, userId }, `Failed to persist context token: ${String(err)}`);
  }
}

function setContextToken(channelId: string, userId: string, token: string): void {
  contextTokens.set(`${channelId}:${userId}`, token);
  persistContextToken(channelId, userId, token);
}

function getContextToken(channelId: string, userId: string): string | undefined {
  return contextTokens.get(`${channelId}:${userId}`);
}

// ---- Sync buf persistence ----
function getSyncFilePath(channelId: string): string {
  return path.join(homedir(), ".adam", "wechat", `${channelId}.sync`);
}

function loadSyncBuf(channelId: string): string {
  try {
    return fs.readFileSync(getSyncFilePath(channelId), "utf-8");
  } catch { return ""; }
}

function saveSyncBuf(channelId: string, buf: string): void {
  const filePath = getSyncFilePath(channelId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, buf, "utf-8");
}

// ---- Session & quota tracking ----

/** 24h session window — bot can only send within this window after user's last message. */
const SESSION_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Max outbound messages per session window (iLink platform limit). */
const QUOTA_MAX = 10;
/** Max queued messages per chatId. */
const MAX_QUEUE_PER_CHAT = 20;
/** TTL for queued messages — discard after 24h. */
const QUEUE_MSG_TTL_MS = 24 * 60 * 60 * 1000;
/** Remind user when session has ≤2h remaining. */
const REMINDER_TIME_THRESHOLD_MS = 22 * 60 * 60 * 1000;
/** Remind user when ≤1 message quota remaining. */
const REMINDER_QUOTA_THRESHOLD = 1;
/** Cooldown between reminders per chatId: 2h. */
const REMINDER_COOLDOWN_MS = 2 * 60 * 60 * 1000;

export interface ChatSession {
  lastUserMessageAt: number;
  quotaRemaining: number;
}

function getSessionFilePath(channelId: string): string {
  return path.join(homedir(), ".adam", "wechat", `${channelId}.session.json`);
}

function loadSessions(channelId: string): Map<string, ChatSession> {
  const sessions = new Map<string, ChatSession>();
  const filePath = getSessionFilePath(channelId);
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw) as Record<string, ChatSession>;
    for (const [chatId, session] of Object.entries(data)) {
      if (session && typeof session.lastUserMessageAt === "number") {
        sessions.set(chatId, session);
      }
    }
    log.debug({ channelId, count: sessions.size }, "Restored sessions from disk");
  } catch { /* file doesn't exist yet */ }
  return sessions;
}

function persistSessions(channelId: string, sessions: Map<string, ChatSession>): void {
  const filePath = getSessionFilePath(channelId);
  try {
    const data: Record<string, ChatSession> = {};
    for (const [chatId, session] of sessions) {
      data[chatId] = session;
    }
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data), "utf-8");
  } catch (err) {
    log.warn({ channelId }, `Failed to persist sessions: ${String(err)}`);
  }
}

// Generate a unique client_id for outbound messages
let msgCounter = 0;
function generateClientId(): string {
  return `adam-wechat-${Date.now()}-${++msgCounter}`;
}

type MessageHandler = (msg: InboundMessage) => void;

export class WeChatAdapter implements ChannelAdapter {
  readonly platform = "wechat" as const;
  readonly id: string;

  private config: WeChatConfig;
  private status: ChannelStatus = "disconnected";
  private messageHandler: MessageHandler | null = null;
  private pollAbort: AbortController | null = null;
  private getUpdatesBuf = "";

  // Session & quota state
  private sessions = new Map<string, ChatSession>();
  private pendingQueue = new Map<string, Array<{ message: OutboundMessage; queuedAt: number }>>();
  private lastReminderAt = new Map<string, number>();

  constructor(id: string, config: WeChatConfig) {
    this.id = id;
    if (!config.baseUrl) throw new Error("WeChat adapter requires baseUrl");
    this.config = config;
  }

  async connect(): Promise<void> {
    if (!this.config.botToken) {
      throw new Error("WeChat adapter requires botToken. Complete QR login first.");
    }
    this.status = "connecting";
    this.getUpdatesBuf = loadSyncBuf(this.id);
    loadContextTokens(this.id);
    this.sessions = loadSessions(this.id);
    this.pollAbort = new AbortController();
    this.status = "connected";
    log.info({ channelId: this.id }, "WeChat adapter connected, starting long-poll");
    void this.startLongPoll();
  }

  async disconnect(): Promise<void> {
    if (this.pollAbort) {
      this.pollAbort.abort();
      this.pollAbort = null;
    }
    this.status = "disconnected";
    log.info({ channelId: this.id }, "WeChat adapter disconnected");
  }

  getStatus(): ChannelStatus {
    if (this.status === "connected" && isSessionPaused(this.id)) {
      return "error";
    }
    if (this.status === "connected") {
      // Only active sessions (within 24h) with quota=0 trigger "degraded".
      // Expired sessions are simply inactive, not degraded.
      for (const [, session] of this.sessions) {
        if (this.isSessionActive(session) && session.quotaRemaining <= 0) {
          return "degraded";
        }
      }
    }
    return this.status;
  }

  getCapabilities(): import("../../../shared/types.js").ChannelCapabilities {
    return {
      canEdit: false,
      canQuote: true,           // ref_msg outbound wiring in Phase 3
      canParseQuote: true,      // ref_msg inbound parsing in Phase 3
      canInlineButtons: false,
      maxTextLength: 4000,
      supportsAttachments: true,
      maxAttachmentsPerMessage: 1,
    };
  }

  async sendMessage(chatId: string, message: OutboundMessage): Promise<string> {
    if (isSessionPaused(this.id)) {
      const remainMin = Math.ceil(getRemainingPauseMs(this.id) / 60_000);
      throw new Error(`WeChat session paused, ${remainMin} min remaining. Re-scan QR to reconnect.`);
    }

    // ---- Session & quota gate ----
    const session = this.getOrCreateSession(chatId);
    const remainingMs = this.getSessionRemainingMs(session);
    const remainingHours = remainingMs / 3_600_000;

    if (!this.isSessionActive(session)) {
      log.warn({
        channelId: this.id,
        chatId: chatId.slice(0, 12),
        lastUserMessageAt: session.lastUserMessageAt,
        sessionExpired: true,
      }, "iLink session expired (>24h), message queued");
      this.enqueueMessage(chatId, message);
      return `queued-${generateClientId()}`;
    }

    if (session.quotaRemaining <= 0) {
      log.warn({
        channelId: this.id,
        chatId: chatId.slice(0, 12),
        quotaRemaining: 0,
        remainingHours: remainingHours.toFixed(1),
      }, "iLink quota exhausted, message queued");
      this.enqueueMessage(chatId, message);
      return `queued-${generateClientId()}`;
    }

    // ---- Actual send ----
    const clientId = generateClientId();
    const ctxToken = getContextToken(this.id, chatId);
    const cdnBaseUrl = this.config.cdnBaseUrl ?? DEFAULT_CDN_BASE_URL;

    try {
      // Handle media: local file path or remote URL → upload via CDN
      // ENHANCEMENT-WECHAT-REPLY: media path (sendWeixinMediaFile) does NOT yet inject ref_msg.
      // To support quoted media in future, extend send-media.ts to accept ref_msg in the SendMessageReq body
      // and add the same buildItemList logic there. See docs/06-plans/2026-05-05-chat-envelope-protocol-design.md.
      const richAttachment = message.attachments?.[0];
      const sourcePath = richAttachment?.path ?? message.mediaUrl;
      const mediaContentType = richAttachment?.contentType;
      const userFilename = richAttachment?.filename;
      const mediaType = richAttachment?.mediaType ?? message.mediaType;

      if (sourcePath) {
        const isLocal = !sourcePath.includes("://") || sourcePath.startsWith("file://");
        const tmpDir = path.join(homedir(), ".adam", "wechat", "media", "outbound-tmp");
        await fsAsync.mkdir(tmpDir, { recursive: true });
        const ext = this.getExtensionFromMediaType(mediaType, mediaContentType);
        let tmpPath: string;

        if (isLocal) {
          const localPath = sourcePath.startsWith("file://")
            ? new URL(sourcePath).pathname
            : path.isAbsolute(sourcePath) ? sourcePath : path.resolve(sourcePath);
          const buf = await fsAsync.readFile(localPath);
          tmpPath = path.join(tmpDir, `${Date.now()}-${Math.random().toString(36).slice(2, 7)}${ext}`);
          await fsAsync.writeFile(tmpPath, buf);
        } else {
          const response = await fetch(sourcePath);
          if (!response.ok) throw new Error(`Failed to fetch media: ${response.status}`);
          const buf = Buffer.from(await response.arrayBuffer());
          tmpPath = path.join(tmpDir, `${Date.now()}-${Math.random().toString(36).slice(2, 7)}${ext}`);
          await fsAsync.writeFile(tmpPath, buf);
        }

        // Rename to user-friendly filename if provided, so sendWeixinMediaFile sees it
        let finalPath = tmpPath;
        if (userFilename) {
          const safeName = userFilename
            .replace(/[\\/]/g, "-")
            .replace(/\.\./g, "-")
            .replace(/[\x00-\x1f]/g, "");
          if (safeName.length > 0 && safeName.length < 200) {
            const namedPath = path.join(tmpDir, `${Date.now()}-${safeName}`);
            await fsAsync.copyFile(tmpPath, namedPath);
            await fsAsync.unlink(tmpPath).catch(() => {});
            finalPath = namedPath;
          }
        }

        const result = await sendWeixinMediaFile({
          filePath: finalPath,
          to: chatId,
          text: message.content ?? "",
          opts: {
            baseUrl: this.config.baseUrl,
            token: this.config.botToken,
            routeTag: this.config.routeTag,
            contextToken: ctxToken,
          },
          cdnBaseUrl,
        });

        await fsAsync.unlink(finalPath).catch(() => {});

        // Quota decrement + log
        session.quotaRemaining--;
        persistSessions(this.id, this.sessions);
        log.info({
          channelId: this.id,
          chatId: chatId.slice(0, 12),
          quotaRemaining: session.quotaRemaining,
          sessionRemainingHours: (this.getSessionRemainingMs(session) / 3_600_000).toFixed(1),
        }, "iLink send success: quota decremented");

        // Check if reminder needed
        this.checkAndSendReminder(chatId, session).catch(err => {
          log.warn({ channelId: this.id, chatId: chatId.slice(0, 12) }, `Reminder send failed: ${String(err)}`);
        });

        return result.messageId;
      }

      await apiSendMessage({
        baseUrl: this.config.baseUrl,
        token: this.config.botToken,
        routeTag: this.config.routeTag,
        body: {
          msg: {
            from_user_id: "",
            to_user_id: chatId,
            client_id: clientId,
            message_type: MessageType.BOT,
            message_state: MessageState.FINISH,
            item_list: this.buildItemList(message),
            context_token: ctxToken,
          },
        },
      });

      // Quota decrement + log
      session.quotaRemaining--;
      persistSessions(this.id, this.sessions);
      log.info({
        channelId: this.id,
        chatId: chatId.slice(0, 12),
        quotaRemaining: session.quotaRemaining,
        sessionRemainingHours: (this.getSessionRemainingMs(session) / 3_600_000).toFixed(1),
      }, "iLink send success: quota decremented");

      // Check if reminder needed
      this.checkAndSendReminder(chatId, session).catch(err => {
        log.warn({ channelId: this.id, chatId: chatId.slice(0, 12) }, `Reminder send failed: ${String(err)}`);
      });

      return clientId;
    } catch (sendErr) {
      // If quota exhausted (ret=-2), enqueue instead of propagating
      if (sendErr instanceof Error && sendErr.message.includes("ret=-2")) {
        session.quotaRemaining = 0;
        persistSessions(this.id, this.sessions);
        log.warn({
          channelId: this.id,
          chatId: chatId.slice(0, 12),
          quotaRemaining: 0,
        }, "iLink quota exhausted (ret=-2 confirmed), message queued");
        this.enqueueMessage(chatId, message);
        return `queued-${generateClientId()}`;
      }
      throw sendErr;
    }
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  async sendTypingIndicator(chatId: string): Promise<void> {
    if (isSessionPaused(this.id)) return; // non-fatal, skip silently
    const ctxToken = getContextToken(this.id, chatId);
    try {
      await apiSendTyping({
        baseUrl: this.config.baseUrl,
        token: this.config.botToken,
        routeTag: this.config.routeTag,
        body: {
          ilink_user_id: chatId,
          status: TypingStatus.TYPING,
        },
      });
    } catch {
      // Typing indicator failure is non-fatal
    }
  }

  /** Update config after QR login (called externally by route handler) */
  updateConfig(config: Partial<WeChatConfig>): void {
    Object.assign(this.config, config);
  }

  // ---- Session helpers ----

  /**
   * Build WeChat MessageItem[] from OutboundMessage, injecting ref_msg when a parent platform_message_id is set.
   *
   * ENHANCEMENT-WECHAT-REPLY: iLink ref_msg currently only supports msg_id quote with optional title + text excerpt.
   * If iLink later adds reply chains / threads / reactions, extend here:
   *   - parse incoming reactions and route to pending_prompts as button-equivalent
   *   - support multi-level reply chains for threading visualization
   *   - support media-path ref_msg (today only text path injects; sendWeixinMediaFile bypasses this)
   * See docs/06-plans/2026-05-05-chat-envelope-protocol-design.md §"WeChat Adapter: ref_msg wiring"
   */
  private buildItemList(message: OutboundMessage): import("./types.js").MessageItem[] | undefined {
    if (!message.content) return undefined;
    const item: import("./types.js").MessageItem = {
      type: MessageItemType.TEXT,
      text_item: { text: message.content },
    };
    if (message.replyToMessageId) {
      const excerpt = (message.quoteExcerpt ?? "").slice(0, 80);
      item.ref_msg = {
        message_item: {
          msg_id: message.replyToMessageId,
          text_item: { text: excerpt },
        },
        title: message.quoteTitle,
      };
    }
    return [item];
  }

  private getOrCreateSession(chatId: string): ChatSession {
    let session = this.sessions.get(chatId);
    if (!session) {
      session = { lastUserMessageAt: 0, quotaRemaining: 0 };
      this.sessions.set(chatId, session);
    }
    return session;
  }

  private isSessionActive(session: ChatSession): boolean {
    return session.lastUserMessageAt > 0 && Date.now() - session.lastUserMessageAt <= SESSION_WINDOW_MS;
  }

  private getSessionRemainingMs(session: ChatSession): number {
    if (session.lastUserMessageAt === 0) return 0;
    return Math.max(0, SESSION_WINDOW_MS - (Date.now() - session.lastUserMessageAt));
  }

  // ---- Queue management ----

  private enqueueMessage(chatId: string, message: OutboundMessage): void {
    let queue = this.pendingQueue.get(chatId);
    if (!queue) {
      queue = [];
      this.pendingQueue.set(chatId, queue);
    }
    const now = Date.now();
    queue = queue.filter(m => now - m.queuedAt < QUEUE_MSG_TTL_MS);
    if (queue.length >= MAX_QUEUE_PER_CHAT) {
      queue.shift();
      log.warn({ channelId: this.id, chatId: chatId.slice(0, 12) }, "Queue full, dropping oldest message");
    }
    queue.push({ message, queuedAt: now });
    this.pendingQueue.set(chatId, queue);
    log.info({ channelId: this.id, chatId: chatId.slice(0, 12), queueDepth: queue.length }, "Message enqueued");
  }

  private async flushQueue(chatId: string): Promise<void> {
    const queue = this.pendingQueue.get(chatId);
    if (!queue || queue.length === 0) return;

    const session = this.getOrCreateSession(chatId);
    // Reserve 2 for live conversation, send up to 8
    const maxToSend = Math.min(queue.length, Math.max(0, session.quotaRemaining - 2));
    if (maxToSend <= 0) {
      log.info({ channelId: this.id, chatId: chatId.slice(0, 12), quotaRemaining: session.quotaRemaining }, "Queue flush skipped: insufficient quota (reserving 2 for conversation)");
      return;
    }

    log.info({
      channelId: this.id,
      chatId: chatId.slice(0, 12),
      queueDepth: queue.length,
      sending: maxToSend,
      quotaRemaining: session.quotaRemaining,
    }, "Flushing queued messages");

    let sent = 0;
    while (sent < maxToSend && queue.length > 0) {
      const item = queue[0];
      if (Date.now() - item.queuedAt > QUEUE_MSG_TTL_MS) {
        queue.shift();
        continue;
      }
      try {
        await this.sendMessage(chatId, item.message);
        queue.shift();
        sent++;
        // Stop flushing if quota was exhausted mid-flush (e.g. ret=-2 set quota to 0)
        if (session.quotaRemaining <= 0) break;
      } catch {
        log.warn({ channelId: this.id, chatId: chatId.slice(0, 12) }, "Queue flush: send failed, stopping");
        break;
      }
    }

    if (queue.length === 0) {
      this.pendingQueue.delete(chatId);
    }
    log.info({ channelId: this.id, chatId: chatId.slice(0, 12), sent, remaining: queue.length }, "Queue flush complete");
  }

  // ---- Proactive reminder ----

  private async checkAndSendReminder(chatId: string, session: ChatSession): Promise<void> {
    const now = Date.now();
    const lastReminder = this.lastReminderAt.get(chatId) ?? 0;
    if (now - lastReminder < REMINDER_COOLDOWN_MS) return;

    const remainingMs = this.getSessionRemainingMs(session);
    const elapsed = now - session.lastUserMessageAt;
    const timeExpiring = elapsed >= REMINDER_TIME_THRESHOLD_MS;
    const quotaExpiring = session.quotaRemaining <= REMINDER_QUOTA_THRESHOLD;

    if (!timeExpiring && !quotaExpiring) return;

    const remainingHours = (remainingMs / 3_600_000).toFixed(1);
    let text: string;
    if (timeExpiring && quotaExpiring) {
      text = `[系统提醒] 消息窗口即将关闭（剩余${remainingHours}小时/${session.quotaRemaining}条配额）。请回复任意消息以保持连接。`;
    } else if (timeExpiring) {
      text = `[系统提醒] 消息窗口即将关闭（剩余${remainingHours}小时）。请回复任意消息以保持连接。`;
    } else {
      text = `[系统提醒] 消息配额即将用完（剩余${session.quotaRemaining}条）。请回复任意消息以重置配额。`;
    }

    const ctxToken = getContextToken(this.id, chatId);
    try {
      await apiSendMessage({
        baseUrl: this.config.baseUrl,
        token: this.config.botToken,
        routeTag: this.config.routeTag,
        body: {
          msg: {
            from_user_id: "",
            to_user_id: chatId,
            client_id: generateClientId(),
            message_type: MessageType.BOT,
            message_state: MessageState.FINISH,
            item_list: [{ type: MessageItemType.TEXT, text_item: { text } }],
            context_token: ctxToken,
          },
        },
      });
      session.quotaRemaining--;
      this.lastReminderAt.set(chatId, now);
      persistSessions(this.id, this.sessions);
      log.info({
        channelId: this.id,
        chatId: chatId.slice(0, 12),
        remainingHours,
        quotaRemaining: session.quotaRemaining,
        trigger: timeExpiring ? "time" : "quota",
      }, "iLink session reminder sent");
    } catch (err) {
      log.warn({ channelId: this.id, chatId: chatId.slice(0, 12) }, `Reminder send failed: ${String(err)}`);
    }
  }

  // Long-poll message loop
  private async startLongPoll(): Promise<void> {
    const signal = this.pollAbort?.signal;
    let consecutiveFailures = 0;
    const MAX_FAILURES = 3;
    const BACKOFF_MS = 30_000;
    const RETRY_MS = 2_000;

    while (!signal?.aborted) {
      try {
        const resp = await getUpdates({
          baseUrl: this.config.baseUrl,
          token: this.config.botToken,
          routeTag: this.config.routeTag,
          get_updates_buf: this.getUpdatesBuf,
        });

        // Check for session expiration (errcode=-14)
        if (resp.ret === SESSION_EXPIRED_ERRCODE || resp.errcode === SESSION_EXPIRED_ERRCODE) {
          pauseSession(this.id);
          this.status = "error";
          log.error({ channelId: this.id }, "Session expired (errcode=-14), pausing for 1 hour");
          await this.sleep(SESSION_PAUSE_DURATION_MS, signal);
          clearSessionPause(this.id);
          this.status = "connected";
          continue;
        }

        // Check for other API errors
        const isApiError = (resp.ret !== undefined && resp.ret !== 0) || (resp.errcode !== undefined && resp.errcode !== 0);
        if (isApiError) {
          consecutiveFailures++;
          log.error({ channelId: this.id, ret: resp.ret, errcode: resp.errcode }, "getUpdates API error");
          if (consecutiveFailures >= MAX_FAILURES) {
            consecutiveFailures = 0;
            await this.sleep(BACKOFF_MS, signal);
          } else {
            await this.sleep(RETRY_MS, signal);
          }
          continue;
        }

        consecutiveFailures = 0;

        // Save sync buf
        if (resp.get_updates_buf) {
          this.getUpdatesBuf = resp.get_updates_buf;
          saveSyncBuf(this.id, resp.get_updates_buf);
        }

        // Process messages
        for (const msg of resp.msgs ?? []) {
          await this.processInbound(msg);
        }
      } catch (err) {
        if (signal?.aborted) return;
        consecutiveFailures++;
        log.error({ channelId: this.id, error: err }, "getUpdates error");
        if (consecutiveFailures >= MAX_FAILURES) {
          consecutiveFailures = 0;
          await this.sleep(BACKOFF_MS, signal);
        } else {
          await this.sleep(RETRY_MS, signal);
        }
      }
    }
  }

  private async processInbound(msg: WeixinMessage): Promise<void> {
    if (!this.messageHandler) return;

    // Detect group message: group_id present means this is a group chat
    const isGroup = Boolean(msg.group_id);
    const chatId = isGroup ? msg.group_id! : (msg.from_user_id ?? "");
    const senderId = msg.from_user_id ?? "";

    // Store context token for this chat (group or direct)
    if (msg.context_token && chatId) {
      setContextToken(this.id, chatId, msg.context_token);
    }

    // Reset session quota on user message
    const session = this.getOrCreateSession(chatId);
    const prevQuota = session.quotaRemaining;
    session.lastUserMessageAt = Date.now();
    session.quotaRemaining = QUOTA_MAX;
    persistSessions(this.id, this.sessions);
    log.info({
      channelId: this.id,
      chatId: chatId.slice(0, 12),
      quotaReset: true,
      prevQuota,
      newQuota: QUOTA_MAX,
      sessionWindowMs: SESSION_WINDOW_MS,
    }, "iLink session reset: user message received, quota restored");

    // Flush queued messages after session reset
    void this.flushQueue(chatId);

    // Extract text content and detect media types
    let content = "";
    let mediaType: InboundMessage["mediaType"];
    const mediaItems: typeof msg.item_list = [];
    // ENHANCEMENT-WECHAT-REPLY: only the FIRST ref_msg in item_list is used.
    // iLink protocol allows ref_msg per item; if future use cases need multi-quote (e.g. forward + quote),
    // extend here to collect all ref_msg.message_item.msg_id values.
    let quotedPlatformMessageId: string | undefined;
    for (const item of msg.item_list ?? []) {
      const refMsgId = item.ref_msg?.message_item?.msg_id;
      if (refMsgId) {
        quotedPlatformMessageId = refMsgId;
        break;
      }
    }
    for (const item of msg.item_list ?? []) {
      if (item.type === MessageItemType.TEXT && item.text_item?.text) {
        content += item.text_item.text;
      }
      if (item.type === MessageItemType.IMAGE) { mediaType = "image"; mediaItems.push(item); }
      if (item.type === MessageItemType.VOICE) {
        mediaType = "audio";
        mediaItems.push(item);
        // Use voice-to-text if available
        if (item.voice_item?.text && !content) {
          content = item.voice_item.text;
        }
      }
      if (item.type === MessageItemType.FILE) { mediaType = "file"; mediaItems.push(item); }
      if (item.type === MessageItemType.VIDEO) { mediaType = "video"; mediaItems.push(item); }
    }

    if (!content && !mediaType) return; // skip empty messages

    // Download first media item if present
    let mediaPath: string | undefined;
    if (mediaItems.length > 0) {
      const cdnBaseUrl = this.config.cdnBaseUrl ?? DEFAULT_CDN_BASE_URL;
      try {
        const downloaded = await downloadMediaFromItem(mediaItems[0], {
          cdnBaseUrl,
          channelId: this.id,
        });
        if (downloaded) {
          mediaPath = downloaded.path;
          mediaType = downloaded.type;
        }
      } catch (err) {
        // Download failure does not block message delivery
        log.error({ channelId: this.id }, `Media download failed: ${String(err)}`);
      }
    }

    const inbound: InboundMessage = {
      channelId: this.id,
      platform: "wechat",
      chatId,
      senderId,
      content,
      mediaType,
      mediaPath,
      isGroup,
      timestamp: msg.create_time_ms ?? Date.now(),
      raw: msg,
      ...(quotedPlatformMessageId ? { quotedPlatformMessageId } : {}),
    };

    this.messageHandler(inbound);
  }

  /** Map OutboundMessage mediaType to file extension. */
  /** Map OutboundMessage mediaType (+ optional contentType) to file extension. */
  private getExtensionFromMediaType(mediaType?: string, contentType?: string): string {
    if (contentType) {
      const ext = getExtensionFromMime(contentType);
      if (ext && ext !== ".bin") return ext;
    }
    switch (mediaType) {
      case "image": return ".png";
      case "video": return ".mp4";
      case "audio": return ".mp3";
      default: return ".bin";
    }
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted")); }, { once: true });
    });
  }
}
