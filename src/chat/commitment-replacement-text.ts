import { getRuntimeConfig } from "../config/runtime.js";
import { DEFAULT_CONFIG } from "../config/defaults.js";
import type { CommitmentLocale, CommitmentDetection } from "./commitment-detector.js";
import type { DeliveryDiagnosticContext } from "../audit/delivery-evidence-resolver.js";

type Slot = "blockedText" | "unsupportedSuccessText" | "unsupportedFailureText" | "unsupportedMutationText";

function readSlot(slot: Slot, locale: CommitmentLocale): string {
  try {
    const v = getRuntimeConfig().chat?.commitmentDetection?.[slot];
    if (v && typeof v[locale] === "string" && v[locale].length > 0) return v[locale];
  } catch {
    // fall through
  }
  const def = DEFAULT_CONFIG.chat?.commitmentDetection?.[slot];
  if (def && typeof def[locale] === "string") return def[locale];
  // Final fallback — should never hit in normal operation.
  return locale === "zh" ? "（无法生成替换文案）" : "(replacement unavailable)";
}

export function getBlockedFutureDeliveryText(locale: CommitmentLocale): string {
  return readSlot("blockedText", locale);
}

export function getUnsupportedSuccessText(locale: CommitmentLocale): string {
  return readSlot("unsupportedSuccessText", locale);
}

export function getUnsupportedFailureText(locale: CommitmentLocale): string {
  return readSlot("unsupportedFailureText", locale);
}

export function getUnsupportedMutationText(locale: CommitmentLocale): string {
  return readSlot("unsupportedMutationText", locale);
}

function formatTime(ts: number, locale: "zh" | "en"): string {
  const d = new Date(ts);
  if (locale === "zh") {
    return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
  return d.toISOString().slice(11, 16);
}

export function buildEnrichedReplacementText(
  claim: CommitmentDetection,
  ctx: DeliveryDiagnosticContext,
): string {
  const locale = claim.locale;
  const artifact = ctx.artifactKindLabel;

  if (!ctx.latestAttempt) {
    return locale === "zh"
      ? `${artifact}已生成，但没有发送动作的记录。`
      : `${artifact} is ready, but no delivery attempt was recorded.`;
  }

  const att = ctx.latestAttempt;

  if (att.status === "delivered") {
    return locale === "zh"
      ? `${artifact}已发送（记录显示送达 ${formatTime(att.deliveredAt ?? att.createdAt, locale)}），但与你这次声明的数量/类型不完全一致，请人工核对。`
      : `${artifact} was delivered at ${formatTime(att.deliveredAt ?? att.createdAt, locale)}, but does not fully match the count/type in this claim. Please verify manually.`;
  }

  if (att.status === "pending") {
    const queue = att.queueDepth !== undefined ? `（队列位置 #${att.queueDepth}）` : "";
    const reset = att.quotaResetHours !== undefined ? `，约 ${att.quotaResetHours.toFixed(1)} 小时后恢复` : "";
    return locale === "zh"
      ? `${artifact}已生成，但渠道当前未送达${queue}${reset}，已排入队列。`
      : `${artifact} is ready, but the channel has not delivered it yet${queue ? ` (queue position #${att.queueDepth})` : ""}${reset ? `, ~${att.quotaResetHours?.toFixed(1)}h until reset` : ""}.`;
  }

  if (att.status === "failed") {
    const reason = att.error ? `（${att.error.slice(0, 120)}）` : "";
    return locale === "zh"
      ? `${artifact}已生成，但发送失败${reason}，已重试到上限。`
      : `${artifact} is ready, but delivery failed${reason}. Retries exhausted.`;
  }

  if (att.status === "expired") {
    return locale === "zh"
      ? `${artifact}已生成，但本次发送已超时（TTL 过期），未送达。`
      : `${artifact} is ready, but delivery expired (TTL) without success.`;
  }

  // Defensive fallback — should not hit.
  return locale === "zh" ? `${artifact}的发送状态无法确定。` : `Delivery status of ${artifact} is unknown.`;
}
