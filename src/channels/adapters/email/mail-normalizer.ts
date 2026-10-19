import { Readable } from "node:stream";
import { MailParser } from "mailparser";
import { convert } from "html-to-text";
import type { ParsedInboundEmail } from "./email-gateway.js";
import { normalizeEmailAddress } from "./address.js";

interface MailAddress {
  address?: string;
  name?: string;
}

interface MailAddressGroup {
  value?: MailAddress[];
  text?: string;
}

interface MailContentType {
  value?: string;
  params?: Record<string, string>;
}

interface MailData {
  type: "text";
  text?: string;
  html?: string | false;
  textAsHtml?: string;
}

interface AttachmentData {
  type: "attachment";
  release?: () => void;
  content?: NodeJS.ReadableStream;
}

export async function parseInboundEmail(source: Buffer | string): Promise<ParsedInboundEmail> {
  const parser = new MailParser({ skipImageLinks: true, skipTextToHtml: true });
  const rawHeaders: Record<string, string> = {};
  let messageId: string | undefined;
  let from: string | undefined;
  let replyTo: string | undefined;
  let to: string[] = [];
  let subject: string | undefined;
  let text = "";
  let html = "";
  let contentType = "";
  let date: number | undefined;
  let attachmentCount = 0;
  let headerError: Error | undefined;

  await new Promise<void>((resolve, reject) => {
    parser.on("headers", (headers: Map<string, unknown>) => {
      try {
        for (const [key, value] of headers.entries()) {
          rawHeaders[key.toLowerCase()] = headerValueToString(value);
        }
        messageId = stringHeader(headers.get("message-id"));
        subject = stringHeader(headers.get("subject"));
        contentType = contentTypeHeader(headers.get("content-type")) ?? "";
        const parsedDate = headers.get("date");
        if (parsedDate instanceof Date) {
          date = parsedDate.getTime();
        }
        from = extractSingleAddress(headers.get("from"), "from");
        replyTo = extractOptionalSingleAddress(headers.get("reply-to"), "reply-to");
        to = extractAddressList(headers.get("to"));
      } catch (err) {
        headerError = err instanceof Error ? err : new Error(String(err));
      }
    });
    parser.on("data", (data: MailData | AttachmentData) => {
      if (data.type === "attachment") {
        attachmentCount += 1;
        data.release?.();
        data.content?.resume?.();
        return;
      }
      text = data.text ?? "";
      html = typeof data.html === "string" ? data.html : "";
    });
    parser.on("error", reject);
    parser.on("end", resolve);
    Readable.from([source]).pipe(parser);
  });

  if (headerError) {
    throw headerError;
  }

  if (!from) {
    throw new Error("Inbound email must contain exactly one valid From address");
  }

  const isHtmlOnlyMessage = contentType.toLowerCase() === "text/html";
  let normalizedText = text.trim();
  if ((isHtmlOnlyMessage || !normalizedText) && html.trim()) {
    normalizedText = convert(html, {
      wordwrap: false,
      selectors: [
        { selector: "h1", format: "heading", options: { uppercase: false } },
        { selector: "h2", format: "heading", options: { uppercase: false } },
        { selector: "h3", format: "heading", options: { uppercase: false } },
        { selector: "h4", format: "heading", options: { uppercase: false } },
        { selector: "h5", format: "heading", options: { uppercase: false } },
        { selector: "h6", format: "heading", options: { uppercase: false } },
      ],
    }).trim();
  }
  if (!normalizedText && subject) {
    normalizedText = subject.trim();
  }

  return {
    messageId,
    from,
    replyTo,
    to,
    subject,
    text: normalizedText,
    date,
    rawHeaders,
    attachmentCount,
  };
}

function extractSingleAddress(value: unknown, fieldName: string): string | undefined {
  const addresses = extractAddressList(value);
  if (addresses.length !== 1) {
    if (addresses.length === 0) return undefined;
    throw new Error(`Inbound email ${fieldName} must contain exactly one mailbox address`);
  }
  return addresses[0];
}

function extractOptionalSingleAddress(value: unknown, fieldName: string): string | undefined {
  if (!value) return undefined;
  return extractSingleAddress(value, fieldName);
}

function extractAddressList(value: unknown): string[] {
  if (!value) return [];
  if (typeof value === "string") {
    return [normalizeEmailAddress(value)];
  }
  const group = value as MailAddressGroup;
  const addresses = group.value ?? [];
  return addresses
    .map((address) => address.address)
    .filter((address): address is string => typeof address === "string" && address.trim().length > 0)
    .map((address) => normalizeEmailAddress(address));
}

function stringHeader(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(String).join(", ");
  return undefined;
}

function headerValueToString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(String).join(", ");
  const contentType = contentTypeHeader(value);
  if (contentType) return contentType;
  if (value && typeof value === "object" && "text" in value) {
    return String((value as { text?: unknown }).text ?? "");
  }
  return String(value ?? "");
}

function contentTypeHeader(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "value" in value) {
    const contentType = (value as MailContentType).value;
    if (typeof contentType === "string") return contentType;
  }
  return undefined;
}
