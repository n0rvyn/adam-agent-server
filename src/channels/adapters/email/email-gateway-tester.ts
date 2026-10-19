import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import type { EmailGatewayConfig } from "../../../shared/types.js";
import { normalizeEmailAddress } from "./address.js";
import { normalizeMessageId, recordSentMessageIdInState } from "./email-state.js";
import { parseInboundEmail } from "./mail-normalizer.js";

export type EmailGatewayTestStage = "imap" | "smtp" | "roundtrip";
export type EmailGatewayTestCode =
  | "ok"
  | "timeout"
  | "auth_failed"
  | "network_error"
  | "tls_error"
  | "mailbox_error"
  | "send_failed"
  | "parse_error"
  | "unknown_error";

export interface EmailGatewayTestResult {
  ok: boolean;
  stage: EmailGatewayTestStage;
  code?: EmailGatewayTestCode;
  message: string;
  details?: Record<string, unknown>;
}

const IMAP_TIMEOUT_MS = 10_000;
const SMTP_TIMEOUT_MS = 10_000;
const ROUNDTRIP_TIMEOUT_MS = 30_000;

export async function testImapConnection(config: EmailGatewayConfig): Promise<EmailGatewayTestResult> {
  return withTimeout("imap", IMAP_TIMEOUT_MS, async () => {
    const client = new ImapFlow({
      host: config.imap.host,
      port: config.imap.port,
      secure: config.imap.secure,
      auth: {
        user: config.imap.auth.user,
        pass: config.imap.auth.pass,
      },
    });

    try {
      await client.connect();
      await client.mailboxOpen(config.imap.mailbox);
      return ok("imap", "IMAP connection succeeded", {
        host: config.imap.host,
        port: config.imap.port,
        mailbox: config.imap.mailbox,
      });
    } finally {
      await client.logout().catch(() => undefined);
    }
  });
}

export async function testSmtpConnection(config: EmailGatewayConfig): Promise<EmailGatewayTestResult> {
  return withTimeout("smtp", SMTP_TIMEOUT_MS, async () => {
    const transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: {
        user: config.smtp.auth.user,
        pass: config.smtp.auth.pass,
      },
    });

    try {
      await transporter.verify();
      return ok("smtp", "SMTP connection succeeded", {
        host: config.smtp.host,
        port: config.smtp.port,
      });
    } finally {
      closeTransport(transporter);
    }
  });
}

export async function sendRoundtripProbe(config: EmailGatewayConfig): Promise<EmailGatewayTestResult> {
  return withTimeout("roundtrip", ROUNDTRIP_TIMEOUT_MS, async () => {
    const to = normalizeEmailAddress(config.address);
    const from = normalizeEmailAddress(config.smtp.from || config.address);
    const probeId = `adam-probe-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const subject = `[Adam Probe] ${probeId}`;
    const transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: {
        user: config.smtp.auth.user,
        pass: config.smtp.auth.pass,
      },
    });
    const client = new ImapFlow({
      host: config.imap.host,
      port: config.imap.port,
      secure: config.imap.secure,
      auth: {
        user: config.imap.auth.user,
        pass: config.imap.auth.pass,
      },
    });

    try {
      let messageId: string | undefined;
      try {
        const result = await transporter.sendMail({
          from,
          to,
          subject,
          text: `Adam Email Gateway probe ${probeId}`,
          headers: {
            "X-Adam-Probe-Id": probeId,
          },
        });
        messageId = normalizeMessageId((result as { messageId?: string }).messageId);
        recordSentMessageIdInState(messageId);
      } catch (error) {
        return {
          ok: false,
          stage: "roundtrip",
          code: "send_failed",
          message: "SMTP send failed",
          details: { probeId, timeoutMs: ROUNDTRIP_TIMEOUT_MS },
        };
      }

      await client.connect();
      await client.mailboxOpen(config.imap.mailbox);
      const deadline = Date.now() + ROUNDTRIP_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const observed = await findProbeMessage(client, { probeId, messageId, subject });
        if (observed.match) {
          return ok("roundtrip", "Roundtrip probe succeeded", {
            probeId,
            messageId,
            observedUid: observed.uid,
            timeoutMs: ROUNDTRIP_TIMEOUT_MS,
          });
        }
        await sleep(1_000);
      }
      return {
        ok: false,
        stage: "roundtrip",
        code: "timeout",
        message: "Roundtrip probe was not observed before timeout",
        details: { probeId, messageId, timeoutMs: ROUNDTRIP_TIMEOUT_MS },
      };
    } finally {
      await client.logout().catch(() => undefined);
      closeTransport(transporter);
    }
  });
}

async function findProbeMessage(
  client: Pick<ImapFlow, "fetch">,
  probe: { probeId: string; messageId?: string; subject: string },
): Promise<{ match: boolean; uid?: number }> {
  const fetcher = client.fetch("1:*", { uid: true, source: true }, { uid: true });

  for await (const item of fetcher) {
    if (!item.source) continue;
    let parsed;
    try {
      parsed = await parseInboundEmail(item.source);
    } catch {
      return Promise.reject(new ProbeParseError());
    }
    const parsedMessageId = normalizeMessageId(parsed.messageId);
    if (
      parsed.rawHeaders["x-adam-probe-id"] === probe.probeId
      || (probe.messageId && parsedMessageId === probe.messageId)
      || parsed.subject === probe.subject
    ) {
      return { match: true, uid: Number(item.uid) };
    }
  }
  return { match: false };
}

async function withTimeout(
  stage: EmailGatewayTestStage,
  timeoutMs: number,
  operation: () => Promise<EmailGatewayTestResult>,
): Promise<EmailGatewayTestResult> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<EmailGatewayTestResult>((resolve) => {
        timer = setTimeout(() => {
          resolve({
            ok: false,
            stage,
            code: "timeout",
            message: `${stage.toUpperCase()} check timed out after ${timeoutMs}ms`,
            details: { timeoutMs },
          });
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    if (error instanceof ProbeParseError) {
      return {
        ok: false,
        stage,
        code: "parse_error",
        message: "IMAP probe message parse failed",
      };
    }
    return classifyError(stage, error);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

class ProbeParseError extends Error {}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ok(stage: EmailGatewayTestStage, message: string, details?: Record<string, unknown>): EmailGatewayTestResult {
  return { ok: true, stage, code: "ok", message, details };
}

function classifyError(stage: EmailGatewayTestStage, error: unknown): EmailGatewayTestResult {
  const err = error as { code?: string; command?: string; responseCode?: number; message?: string };
  const code = classifyCode(stage, err);
  return {
    ok: false,
    stage,
    code,
    message: codeMessage(stage, code),
    details: {
      code: err.code,
      responseCode: err.responseCode,
      command: err.command,
    },
  };
}

function classifyCode(stage: EmailGatewayTestStage, error: { code?: string; responseCode?: number; message?: string }): EmailGatewayTestCode {
  const raw = `${error.code ?? ""} ${error.message ?? ""}`.toLowerCase();
  if (error.responseCode === 535 || raw.includes("auth")) return "auth_failed";
  if (raw.includes("tls") || raw.includes("certificate")) return "tls_error";
  if (stage === "imap" && (raw.includes("mailbox") || raw.includes("select"))) return "mailbox_error";
  if (stage === "smtp" && raw.includes("send")) return "send_failed";
  if (["ENOTFOUND", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT"].includes(error.code ?? "")) return "network_error";
  return "unknown_error";
}

function codeMessage(stage: EmailGatewayTestStage, code: EmailGatewayTestCode): string {
  const label = stage.toUpperCase();
  switch (code) {
    case "auth_failed":
      return `${label} authentication failed`;
    case "network_error":
      return `${label} network connection failed`;
    case "tls_error":
      return `${label} TLS negotiation failed`;
    case "mailbox_error":
      return "IMAP mailbox selection failed";
    case "send_failed":
      return "SMTP send failed";
    default:
      return `${label} check failed`;
  }
}

function closeTransport(transporter: unknown): void {
  const maybeClose = transporter as { close?: () => void };
  maybeClose.close?.();
}
