import { getRuntimeConfig } from "../config/runtime.js";
import { DEFAULT_CONFIG } from "../config/defaults.js";
import { getLogger } from "../lib/logger.js";
import type { DeliveryArtifactExpectation, DeliveryArtifactKind } from "../shared/types.js";

const log = getLogger("chat-manager");

export type CommitmentDetectionType =
  | "future_delivery"
  | "delivery_success_claim"
  | "delivery_failure_claim";

export type CommitmentLocale = "zh" | "en";

export interface CommitmentDetection {
  type: CommitmentDetectionType;
  text: string;
  span: { start: number; end: number };
  targetHint?: { channel?: string };
  artifactExpectation?: DeliveryArtifactExpectation;
  hasCount: boolean;
  /** Which language regex matched this detection. */
  locale: CommitmentLocale;
}

// =================== ZH patterns (existing, unchanged semantics) ===================

const ZH_FUTURE_PATTERNS = [
  /(?:完成后|完成了|生成完|做好后|处理完|结束后)(?:我会)?(?:发|发送|传|交付)(?:到|给)?(?:你|您)?(?:的)?(?:\s*)?(?:微信|WeChat|iPhone 微信)?/giu,
  /(?:生成后|导出后)(?:我会)?(?:发|发送|传|交付)(?:到|给)?(?:你|您)?(?:的)?(?:\s*)?(?:微信|WeChat|iPhone 微信)?/giu,
  /(?:稍后|等会儿|待会儿)(?:我会)?(?:发|发送|传|交付)(?:到|给)?(?:你|您)?(?:的)?(?:\s*)?(?:微信|WeChat|iPhone 微信)?/giu,
];

const ZH_SUCCESS_PATTERNS = [
  /(?:已|已经)(?:全部)?(?:发|发送|传|交付)(?:到|给)?(?:你|您)?(?:的)?(?:\s*)?(?:微信|WeChat|iPhone 微信)?/giu,
  /(?:已|已经)(?:全部)?(?:发出|送达)/giu,
];

const ZH_FAILURE_PATTERNS = [
  /(?:发送|发|传|交付)(?:失败|不出去|失败了)/giu,
  /(?:发不出去|没发出去)/giu,
];

const ZH_STATUS_PROMISE = /告诉你结果|通知你|更新进展|汇报|回复你/u;
const ZH_ARTIFACT_NOUN = /(图|图片|照片|文件|音频|视频|报告|结果文件|附件)/u;
const ZH_CHANNEL_HINT = /微信|wechat/i;

// =================== EN patterns (new) ===================

// Future: "I'll send / I will send / will deliver / about to send" with optional target
const EN_FUTURE_PATTERNS = [
  /\b(?:I'?ll|I will|going to|about to)\s+(?:send|deliver|share|push|forward)\b[^.!?\n]{0,80}/gi,
  /\bonce\s+(?:done|finished|complete)d?\b[^.!?\n]{0,80}?(?:send|deliver|share)\b[^.!?\n]{0,40}/gi,
  /\b(?:after|when)\s+(?:it|that|this)\s+(?:is\s+)?(?:done|ready|finished)\b[^.!?\n]{0,80}?(?:send|deliver|share)\b[^.!?\n]{0,40}/gi,
];

// Success: "I've sent / sent / delivered / shared"
const EN_SUCCESS_PATTERNS = [
  /\b(?:I'?ve|I have)\s+(?:already\s+)?(?:sent|delivered|shared|forwarded|pushed)\b[^.!?\n]{0,80}/gi,
  /\b(?:successfully\s+)?(?:sent|delivered|shared|forwarded)\b\s+(?:to|the|all|\d)/gi,
];

// Failure: "failed to send / could not send / send failed"
const EN_FAILURE_PATTERNS = [
  /\b(?:failed to|couldn'?t|could not|wasn'?t able to|unable to)\s+(?:send|deliver|share|forward)\b[^.!?\n]{0,60}/gi,
  /\b(?:send|delivery)\s+(?:failed|errored|did not go through)\b[^.!?\n]{0,40}/gi,
];

const EN_STATUS_PROMISE = /\b(?:I'?ll|I will)\s+(?:let you know|tell you|update you|notify you|report back)\b/i;
const EN_ARTIFACT_NOUN = /\b(?:image|images|picture|photo|file|audio|video|report|attachment|pdf|document)s?\b/i;
const EN_CHANNEL_HINT = /\b(?:wechat|telegram|slack|discord|email)\b/i;

// =================== Locale selection ===================

function getActiveLocales(): CommitmentLocale[] {
  try {
    const v = getRuntimeConfig().chat?.commitmentDetection?.locales;
    if (Array.isArray(v) && v.length > 0) {
      return v.filter((x): x is CommitmentLocale => x === "zh" || x === "en");
    }
  } catch {
    // ignore
  }
  return (DEFAULT_CONFIG.chat?.commitmentDetection?.locales as CommitmentLocale[]) ?? ["zh", "en"];
}

// =================== Public API (signatures unchanged) ===================

export function detectDeliveryCommitments(text: string): CommitmentDetection[] {
  const locales = getActiveLocales();
  const detections: CommitmentDetection[] = [];

  if (locales.includes("zh")) {
    detections.push(...detectByPatterns(text, "future_delivery", ZH_FUTURE_PATTERNS, "zh"));
    detections.push(...detectByPatterns(text, "delivery_success_claim", ZH_SUCCESS_PATTERNS, "zh"));
    detections.push(...detectByPatterns(text, "delivery_failure_claim", ZH_FAILURE_PATTERNS, "zh"));
  }
  if (locales.includes("en")) {
    // Defensive CJK ratio guard (not in plan spec; added during execution as
    // safety net mirroring `inferLocale` in commitment-auditor.ts). Skips EN
    // pattern run when text is >30% CJK to prevent short Latin substrings
    // ("all"/"to") matching inside Chinese context. If user explicitly sets
    // `locales: ["en"]` and feeds CJK text, EN detection is auto-muted —
    // accepted trade-off: misses are safer than false-positive rewrites.
    const cjkCount = (text.match(/[一-鿿]/g) ?? []).length;
    const isCjkText = text.length > 0 && cjkCount / text.length > 0.3;
    if (!isCjkText) {
      detections.push(...detectByPatterns(text, "future_delivery", EN_FUTURE_PATTERNS, "en"));
      detections.push(...detectByPatterns(text, "delivery_success_claim", EN_SUCCESS_PATTERNS, "en"));
      detections.push(...detectByPatterns(text, "delivery_failure_claim", EN_FAILURE_PATTERNS, "en"));
    }
  }

  return dedupeDetections(detections).sort((a, b) => a.span.start - b.span.start);
}

export function detectFutureDeliveryCommitments(text: string): CommitmentDetection[] {
  return detectDeliveryCommitments(text).filter((item) => item.type === "future_delivery");
}

export function detectTerminalDeliveryClaims(text: string): CommitmentDetection[] {
  return detectDeliveryCommitments(text).filter((item) => item.type !== "future_delivery");
}

// =================== Implementation ===================

function detectByPatterns(
  fullText: string,
  type: CommitmentDetectionType,
  patterns: RegExp[],
  locale: CommitmentLocale,
): CommitmentDetection[] {
  const results: CommitmentDetection[] = [];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    try {
      for (const match of fullText.matchAll(pattern)) {
        if (match.index === undefined) continue;
        const start = match.index;
        const end = start + match[0].length;
        const context = contextWindow(fullText, start, end);
        if (type === "future_delivery" && isNonArtifactStatusPromise(context, locale)) continue;
        const artifactExpectation = extractArtifactExpectation(context, locale);
        results.push({
          type,
          text: match[0],
          span: { start, end },
          targetHint: extractTargetHint(context, locale),
          artifactExpectation,
          hasCount: hasCountPattern(context, locale),
          locale,
        });
      }
    } catch (err) {
      // ReDoS guard: regex execution failure (catastrophic backtrack abort) — log and skip this pattern.
      log.warn({ error: err instanceof Error ? err.message : String(err), locale, type }, "commitment-detector pattern execution failed; skipping");
    }
  }
  return results;
}

function contextWindow(text: string, start: number, end: number): string {
  return text.slice(Math.max(0, start - 24), Math.min(text.length, end + 24));
}

function isNonArtifactStatusPromise(context: string, locale: CommitmentLocale): boolean {
  if (locale === "zh") {
    return ZH_STATUS_PROMISE.test(context) && !ZH_ARTIFACT_NOUN.test(context);
  }
  return EN_STATUS_PROMISE.test(context) && !EN_ARTIFACT_NOUN.test(context);
}

function extractTargetHint(context: string, locale: CommitmentLocale): CommitmentDetection["targetHint"] {
  const hint = locale === "zh" ? ZH_CHANNEL_HINT : EN_CHANNEL_HINT;
  const match = context.match(hint);
  if (!match) return undefined;
  const raw = match[0].toLowerCase();
  // Normalize CJK "微信" to ASCII "wechat"
  if (raw === "微信") return { channel: "wechat" };
  return { channel: raw };
}

function extractArtifactExpectation(context: string, locale: CommitmentLocale): DeliveryArtifactExpectation | undefined {
  const kind = extractArtifactKind(context, locale);
  if (!kind) return undefined;
  const count = extractCount(context, locale);
  return count ? { kind, count } : { kind };
}

function extractArtifactKind(context: string, locale: CommitmentLocale): DeliveryArtifactKind | undefined {
  if (locale === "zh") {
    if (/(图|图片|照片|png|jpg|jpeg|webp)/iu.test(context)) return "image";
    if (/(音频|mp3|wav|m4a)/iu.test(context)) return "audio";
    if (/(视频|mp4|mov)/iu.test(context)) return "video";
    if (/(报告|report)/iu.test(context)) return "report";
    if (/(文件|附件|pdf|docx|xlsx|csv|zip)/iu.test(context)) return "file";
    if (/(结果|成果)/iu.test(context)) return "result";
    return undefined;
  }
  // en
  if (/\b(?:image|images|picture|pictures|photo|photos|png|jpe?g|webp)\b/i.test(context)) return "image";
  if (/\b(?:audio|mp3|wav|m4a)\b/i.test(context)) return "audio";
  if (/\b(?:video|videos|mp4|mov)\b/i.test(context)) return "video";
  if (/\breport\b/i.test(context)) return "report";
  if (/\b(?:file|files|attachment|attachments|pdf|docx?|xlsx?|csv|zip)\b/i.test(context)) return "file";
  if (/\bresults?\b/i.test(context)) return "result";
  return undefined;
}

function extractCount(context: string, locale: CommitmentLocale): number | undefined {
  if (locale === "zh") {
    const digit = context.match(/(\d+)\s*(张|个|份|条|件)/u);
    if (digit) return Number(digit[1]);
    const chinese = context.match(/([一二三四五六七八九十])\s*(张|个|份|条|件)/u);
    if (!chinese) return undefined;
    return chineseNumber(chinese[1]);
  }
  // en: digit followed by an artifact noun (within ±10 chars)
  const m = context.match(/\b(\d+)\s+(?:image|images|picture|pictures|photo|photos|file|files|report|reports|attachment|attachments|video|videos|audio)s?\b/i);
  if (m) return Number(m[1]);
  return undefined;
}

function hasCountPattern(context: string, locale: CommitmentLocale): boolean {
  if (locale === "zh") {
    return /\d+\s*(张|个|份|条|件)|[一二三四五六七八九十]\s*(张|个|份|条|件)/u.test(context);
  }
  return /\b\d+\s+(?:image|picture|photo|file|report|attachment|video|audio)s?\b/i.test(context);
}

function chineseNumber(value: string): number | undefined {
  const map: Record<string, number> = {
    一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
  };
  return map[value];
}

function dedupeDetections(detections: CommitmentDetection[]): CommitmentDetection[] {
  const seen = new Set<string>();
  const result: CommitmentDetection[] = [];
  for (const detection of detections) {
    const key = `${detection.type}:${detection.span.start}:${detection.span.end}:${detection.locale}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(detection);
  }
  return result;
}
