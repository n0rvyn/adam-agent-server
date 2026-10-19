import { getLogger } from "../../../lib/logger.js";
import { listChannels, setRecipientCap } from "../../../store/channels.js";
import { parseSizeLimitFromBounce } from "./bounce-parser.js";
import type { EmailGateway, ParsedInboundEmail } from "./email-gateway.js";

const log = getLogger("channels");

// Module-level idempotency guard. EmailGateway.onInbound is push-only on a handler
// array (email-gateway.ts:146-148) — calling registerBounceHandler twice would
// double-register and learn the cap twice per bounce. ensureEmailGatewayStarted
// runs on both initial start AND restartEmailGatewayFromConfig (REST PATCH
// /channels/:id email gateway updates trigger restart). Guard survives restart.
// NOTE: if getEmailGateway() ever changes to return a new instance per restart,
// this guard would need to be invalidated to re-register on the new instance.
let bounceHandlerRegistered = false;

export function registerBounceHandler(gateway: EmailGateway): void {
  if (bounceHandlerRegistered) {
    log.debug("Bounce handler already registered; skipping duplicate registration");
    return;
  }
  bounceHandlerRegistered = true;
  gateway.onInbound(async (email: ParsedInboundEmail) => {
    const parsed = parseSizeLimitFromBounce(email);
    if (!parsed) {
      // Observability: bounces that look like DSN but parser didn't recognize.
      // Helps us iterate fixtures based on production data.
      const looksLikeBounce =
        /MAILER-DAEMON/i.test(email.from ?? "") ||
        /^no-reply@mailsupport\.aliyun\.com$/i.test(email.from ?? "") ||
        /Mail Delivery|Undeliverable|Returned mail|Delivery Status Notification|退信|无法投递|投递失败/i.test(email.subject ?? "");
      if (looksLikeBounce) {
        log.warn({ from: email.from, subject: email.subject }, "Inbound looks like bounce but parser did not recognize a size-limit cap");
      }
      return;
    }
    const { recipientDomain, capBytes } = parsed;
    log.info({ recipientDomain, capBytes }, "Bounce-learning: detected SMTP size-limit bounce");
    const emailChannels = listChannels().filter((c) => c.platform === "email");
    for (const ch of emailChannels) {
      try {
        setRecipientCap(ch.id, recipientDomain, capBytes);
      } catch (err) {
        log.warn({ channelId: ch.id, recipientDomain, capBytes, err }, "Bounce-learning: setRecipientCap failed (out of range or DB error); skipping");
      }
    }
  });
}

// Test-only reset to clear the module-level guard between vitest cases.
// Mirrors resetEmailRouterForTests pattern at email-router.ts:84.
export function resetBounceHandlerForTests(): void {
  bounceHandlerRegistered = false;
}
