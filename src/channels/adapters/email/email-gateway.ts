import { statSync } from "node:fs";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import type { EmailGatewayConfig } from "../../../shared/types.js";
import {
  addSeenMessageId,
  loadEmailGatewayState,
  normalizeMessageId,
  recordSentMessageIdInState,
  saveEmailGatewayState,
  type EmailGatewayState,
} from "./email-state.js";
import { parseInboundEmail } from "./mail-normalizer.js";

export interface ParsedInboundEmail {
  messageId?: string;
  from: string;
  replyTo?: string;
  to: string[];
  subject?: string;
  text: string;
  date?: number;
  rawHeaders: Record<string, string>;
  attachmentCount: number;
}

export interface EmailGatewayInboundHandler {
  (message: ParsedInboundEmail): void | Promise<void>;
}

export type EmailGatewayStatusValue = "stopped" | "starting" | "connected" | "degraded" | "error";

export interface EmailGatewayStatus {
  status: EmailGatewayStatusValue;
  lastError?: string;
  details?: Record<string, unknown>;
  lastStartedAt?: number;
  lastCheckedAt?: number;
}

export interface EmailSendAttachment {
  filename?: string;
  path: string;
  contentType?: string;
}

export interface EmailSendOptions {
  from?: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  attachments?: EmailSendAttachment[];
}

const SEND_BASE_TIMEOUT_MS = 30_000;
const SEND_PER_MB_MS = 5_000;
const SEND_MAX_TIMEOUT_MS = 300_000;
const BASE64_OVERHEAD = 1.33;
const POLL_INTERVAL_MS = 30_000;

export function computeSendTimeoutMs(attachments: EmailSendAttachment[] | undefined): number {
  if (!attachments || attachments.length === 0) return SEND_BASE_TIMEOUT_MS;
  let totalBytes = 0;
  for (const a of attachments) {
    try {
      totalBytes += statSync(a.path).size;
    } catch {
      // file gone between buildAttachments and send — skip; nodemailer will fail on send and surface a clearer error
    }
  }
  const transferMB = (totalBytes * BASE64_OVERHEAD) / (1024 * 1024);
  return Math.min(SEND_MAX_TIMEOUT_MS, SEND_BASE_TIMEOUT_MS + Math.ceil(transferMB * SEND_PER_MB_MS));
}

export class EmailGateway {
  private imapClient: any;
  private smtpTransporter: any;
  private pollTimer: NodeJS.Timeout | undefined;
  private handlers: EmailGatewayInboundHandler[] = [];
  private status: EmailGatewayStatus = { status: "stopped" };
  private state: EmailGatewayState = loadEmailGatewayState();

  async start(config: EmailGatewayConfig): Promise<void> {
    await this.stop();
    if (!config.enabled) {
      this.status = { status: "stopped", details: { reason: "disabled" } };
      return;
    }

    this.status = { status: "starting", lastStartedAt: Date.now() };
    try {
      this.imapClient = new ImapFlow({
        host: config.imap.host,
        port: config.imap.port,
        secure: config.imap.secure,
        auth: {
          user: config.imap.auth.user,
          pass: config.imap.auth.pass,
        },
      });
      await this.imapClient.connect();
      const mailbox = await this.imapClient.mailboxOpen(config.imap.mailbox);
      const mailboxUidValidity = mailbox?.uidValidity ? Number(mailbox.uidValidity) : undefined;
      if (mailboxUidValidity && this.state.uidValidity && mailboxUidValidity !== this.state.uidValidity) {
        this.state = { ...this.state, uidValidity: mailboxUidValidity, lastUid: 0, seenMessageIds: [] };
        saveEmailGatewayState(this.state);
      } else if (mailboxUidValidity) {
        this.state = { ...this.state, uidValidity: mailboxUidValidity };
        saveEmailGatewayState(this.state);
      }

      this.smtpTransporter = nodemailer.createTransport({
        host: config.smtp.host,
        port: config.smtp.port,
        secure: config.smtp.secure,
        auth: {
          user: config.smtp.auth.user,
          pass: config.smtp.auth.pass,
        },
      });
      await this.smtpTransporter.verify();

      this.status = { status: "connected", lastStartedAt: Date.now(), lastCheckedAt: Date.now() };
      this.schedulePoll(config);
    } catch (error) {
      await this.cleanupResources();
      this.status = {
        status: "error",
        lastError: sanitizeErrorMessage(error),
        details: { stage: this.smtpTransporter ? "smtp" : "imap" },
      };
      throw error;
    }
  }

  async stop(): Promise<void> {
    await this.cleanupResources();
    this.status = { status: "stopped" };
  }

  getStatus(): EmailGatewayStatus {
    return { ...this.status };
  }

  onInbound(handler: EmailGatewayInboundHandler): void {
    this.handlers.push(handler);
  }

  async send(options: EmailSendOptions): Promise<string> {
    if (!this.smtpTransporter) {
      throw new Error("EmailGateway SMTP transporter is not started");
    }

    const timeoutMs = computeSendTimeoutMs(options.attachments);
    const result = await withTimeout(
      this.smtpTransporter.sendMail({
        from: options.from,
        to: options.to,
        subject: options.subject,
        text: options.text,
        html: options.html,
        attachments: options.attachments,
      }),
      timeoutMs,
      `SMTP send timed out after ${Math.round(timeoutMs / 1000)}s`,
    );

    const messageId = normalizeMessageId((result as { messageId?: string }).messageId);
    if (!messageId) {
      throw new Error("SMTP send returned no Message-ID");
    }
    this.state = recordSentMessageIdInState(messageId);
    return messageId;
  }

  isSentByAdam(messageId: string): boolean {
    const normalized = normalizeMessageId(messageId);
    return normalized.length > 0 && this.state.sentMessageIds.includes(normalized);
  }

  private schedulePoll(config: EmailGatewayConfig): void {
    this.pollTimer = setInterval(() => {
      void this.poll(config);
    }, POLL_INTERVAL_MS);
  }

  private async poll(_config: EmailGatewayConfig): Promise<void> {
    if (!this.imapClient) return;
    try {
      this.state = loadEmailGatewayState();
      const range = `${this.state.lastUid + 1}:*`;
      const fetcher = this.imapClient.fetch?.(range, {
        uid: true,
        source: true,
        envelope: true,
      }, { uid: true });
      if (!fetcher || !fetcher[Symbol.asyncIterator]) return;
      let pollFailed = false;

      for await (const item of fetcher) {
        const uid = Number(item.uid);
        if (!Number.isInteger(uid) || uid <= this.state.lastUid) {
          continue;
        }

        if (!item.source) {
          this.markDegraded(new Error(`IMAP fetch item ${uid} is missing source`));
          pollFailed = true;
          break;
        }

        let parsed: ParsedInboundEmail;
        try {
          parsed = await parseInboundEmail(item.source);
        } catch (error) {
          this.markDegraded(error);
          pollFailed = true;
          break;
        }

        const probeId = parsed.rawHeaders["x-adam-probe-id"];
        const messageId = normalizeMessageId(parsed.messageId);
        if (probeId?.startsWith("adam-probe-")) {
          this.advanceCursor(uid);
          continue;
        }
        if (messageId && this.state.sentMessageIds.includes(messageId)) {
          this.advanceCursor(uid);
          continue;
        }
        if (messageId && this.state.seenMessageIds.includes(messageId)) {
          this.advanceCursor(uid);
          continue;
        }

        try {
          await Promise.all(this.handlers.map((handler) => handler(parsed)));
        } catch (error) {
          this.markDegraded(error);
          pollFailed = true;
          break;
        }

        this.state = addSeenMessageId(this.state, messageId);
        this.advanceCursor(uid);
      }
      if (!pollFailed) {
        this.status = { ...this.status, status: "connected", lastCheckedAt: Date.now(), lastError: undefined };
      }
    } catch (error) {
      this.markDegraded(error);
    }
  }

  private advanceCursor(uid: number): void {
    this.state = { ...this.state, lastUid: uid };
    saveEmailGatewayState(this.state);
  }

  private markDegraded(error: unknown): void {
    this.status = {
      ...this.status,
      status: "degraded",
      lastError: sanitizeErrorMessage(error),
      lastCheckedAt: Date.now(),
    };
  }

  private async cleanupResources(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    const imap = this.imapClient;
    const smtp = this.smtpTransporter;
    this.imapClient = undefined;
    this.smtpTransporter = undefined;

    if (imap) {
      await ignoreCleanupError(imap.logout?.());
      await ignoreCleanupError(imap.close?.());
    }
    await ignoreCleanupError(smtp?.close?.());
  }
}

let singleton: EmailGateway | undefined;

export function getEmailGateway(): EmailGateway {
  singleton ??= new EmailGateway();
  return singleton;
}

export async function startEmailGatewayFromConfig(config: EmailGatewayConfig): Promise<void> {
  await getEmailGateway().start(config);
}

export async function restartEmailGatewayFromConfig(config: EmailGatewayConfig, _reason: string): Promise<void> {
  await getEmailGateway().stop();
  await getEmailGateway().start(config);
}

export async function stopEmailGateway(_reason: string): Promise<void> {
  await getEmailGateway().stop();
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } catch (error) {
    throw new Error(sanitizeErrorMessage(error));
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function sanitizeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.replace(/pass(word)?=[^\s]+/gi, "password=****");
  return "Email gateway operation failed";
}

async function ignoreCleanupError(value: unknown): Promise<void> {
  if (value && typeof (value as Promise<unknown>).then === "function") {
    await (value as Promise<unknown>).catch(() => undefined);
  }
}
