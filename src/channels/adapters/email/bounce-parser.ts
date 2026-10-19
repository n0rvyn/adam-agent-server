import {
  MIN_REASONABLE_CAP_BYTES,
  MAX_REASONABLE_CAP_BYTES,
  RECIPIENT_DOMAIN_REGEX,
} from "../../../lib/recipient-cap-bounds.js";
import type { ParsedInboundEmail } from "./email-gateway.js";

const SMTP_CODE_LINE_REGEX = /\b55[234]\b/;
const SIZE_KEYWORD_REGEX = /(?:size|too large|exceeds|maximum|over.*?limit)/i;
const SIZE_BYTES_REGEX = /\b(\d{6,11})\b/;
const FINAL_RECIPIENT_REGEX = /Final-Recipient:\s*rfc822;\s*([^\s>]+@([^\s>;]+))/i;
const TO_HEADER_FALLBACK_REGEX = /To:[\s<]*([^\s>;]+@([^\s>;]+))/i;

export interface BounceParseResult {
  recipientDomain: string;
  capBytes: number;
}

export function parseSizeLimitFromBounce(email: ParsedInboundEmail): BounceParseResult | null {
  const body = email.text ?? "";
  // Line-scoped match: SIZE_BYTES_REGEX otherwise grabs the first 6-11 digit run in the body,
  // which may be a Message-ID or attachment counter — NOT the SMTP cap. Filter to lines that
  // carry the 55[234] code AND a size keyword, then match digits only within those lines.
  const candidateLines = body.split(/\r?\n/).filter((line) =>
    SMTP_CODE_LINE_REGEX.test(line) && SIZE_KEYWORD_REGEX.test(line),
  );
  if (candidateLines.length === 0) return null;
  // Extract recipient (allowed to live anywhere in body — DSN Final-Recipient is in a separate section)
  const recMatch = body.match(FINAL_RECIPIENT_REGEX) ?? body.match(TO_HEADER_FALLBACK_REGEX);
  if (!recMatch) return null;
  const recipientDomain = recMatch[2].toLowerCase().trim();
  if (!RECIPIENT_DOMAIN_REGEX.test(recipientDomain)) return null;
  // Extract cap bytes ONLY from the candidate lines
  let capBytes: number | null = null;
  for (const line of candidateLines) {
    const m = line.match(SIZE_BYTES_REGEX);
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n >= MIN_REASONABLE_CAP_BYTES && n <= MAX_REASONABLE_CAP_BYTES) {
        capBytes = n;
        break;
      }
    }
  }
  if (capBytes === null) return null;
  return { recipientDomain, capBytes };
}
