/** Verb families that signal completion of a prior action. */
export type VerbFamily =
  | "create" | "delete" | "update" | "send"
  | "schedule" | "cancel" | "bind" | "unbind"
  | "enable" | "disable" | "start";

export interface CompletionMatch {
  verbFamily: VerbFamily;
  evidenceSpan: string;
  locale: "zh" | "en";
}

export interface CompletionLanguageResult {
  detected: boolean;
  matches: CompletionMatch[];
}

/** Returns true if text contains both CJK and ASCII letters. */
function hasMixedScript(text: string): boolean {
  let hasCJK = false;
  let hasASCII = false;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    // CJK Unified Ideographs + common CJK symbols
    if ((cp >= 0x4E00 && cp <= 0x9FFF) || (cp >= 0x3000 && cp <= 0x303F)) {
      hasCJK = true;
    }
    if ((cp >= 0x41 && cp <= 0x5A) || (cp >= 0x61 && cp <= 0x7A)) {
      hasASCII = true;
    }
    if (hasCJK && hasASCII) return true;
  }
  return false;
}

/** Infer locale from CJK ratio: >30% CJK → zh, else en. */
function inferLocale(text: string): "zh" | "en" {
  let cjkCount = 0;
  let total = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if ((cp >= 0x4E00 && cp <= 0x9FFF) || (cp >= 0x3000 && cp <= 0x303F)) {
      cjkCount++;
    }
    total++;
  }
  return total > 0 && cjkCount / total > 0.3 ? "zh" : "en";
}

type LexiconEntry = { zh: string[]; en: RegExp[] };

const LEXICON: Record<VerbFamily, LexiconEntry> = {
  create: {
    zh: ["已创建", "已新建", "已记录", "新建完成", "创建完成"],
    en: [/\b(created|recorded|added|new(?:ly)? created)\b/i],
  },
  delete: {
    zh: ["已删除", "已移除", "删除完成"],
    en: [/\b(deleted|removed)\b/i],
  },
  update: {
    zh: ["已更新", "已修改", "已配置", "已变更", "更新完成"],
    en: [/\b(updated|modified|changed|configured)\b/i],
  },
  send: {
    zh: ["已发送", "已发", "已送达", "已补发", "发送完成", "已下发", "已投递", "已成功投递", "投递完成", "已派发"],
    en: [/\b(sent|delivered|redelivered|dispatched)\b/i],
  },
  schedule: {
    zh: ["已安排", "下次", "已排期", "已计划"],
    en: [/\b(scheduled|planned|queued)\b/i],
  },
  cancel: {
    zh: ["已取消", "取消完成"],
    en: [/\b(cancelled|canceled)\b/i],
  },
  bind: {
    zh: ["已绑定", "已关联"],
    en: [/\b(bound|attached|linked)\b/i],
  },
  unbind: {
    zh: ["已解绑", "已解除"],
    en: [/\b(unbound|detached|unlinked)\b/i],
  },
  enable: {
    zh: ["已启用", "已开启"],
    en: [/\b(enabled|activated|turned on)\b/i],
  },
  disable: {
    zh: ["已禁用", "已关闭"],
    en: [/\b(disabled|deactivated|turned off)\b/i],
  },
  start: {
    zh: ["已开始执行", "已开始", "已启动", "开始运行"],
    en: [/\b(started|began|launched)\b/i],
  },
};

// ZH negation patterns — check chars immediately before the match
const ZH_NEGATION = /(?:不|没有|尚未|未|没|未曾)$/;
// EN negation patterns — check up to 16 chars before the match
const EN_NEGATION = /\b(?:not|haven['’]?t|hasn['’]?t|didn['’]?t|did\s+not|no|never)\s*$/i;

/**
 * Detects completion-language patterns in assistant text.
 *
 * Algorithm:
 * 1. NFC-normalize input; cap at 100_000 chars.
 * 2. Infer locale from CJK ratio (>30% → zh, else en).
 * 3. For each verb family, scan ZH phrases (indexOf) or EN regex (.exec()).
 * 4. Reject matches preceded by a negation pattern.
 * 5. Return one CompletionMatch per family (first-match deduplication).
 *
 * All regexes are linear (no nested quantifiers) — non-backtracking by construction.
 */
// ─── Delivery-quantitative-claim detector (L2 pre-flight gate) ─────────────────

export type DeliveryClaimPattern =
  | "all-quantifier"
  | "numeric-count"
  | "implicit-completion";

export interface DeliveryQuantitativeClaimMatch {
  pattern: DeliveryClaimPattern;
  evidenceSpan: string;
  locale: "zh" | "en";
}

export interface DeliveryQuantitativeClaimResult {
  detected: boolean;
  matches: DeliveryQuantitativeClaimMatch[];
}

/** ZH: "全部送达" / "都已发完" within bounded gap of delivery verb. */
const ZH_ALL_PATTERN =
  /(?:全部|都已?|每个?|全)[^。！？\n]{0,12}(?:送达|发完|发出|收到|投递|下发|派发|发送)/g;
/** ZH: numeric-or-CJK-digit + 个 + channel-like noun within bounded gap of delivery verb. */
const ZH_NUMERIC_PATTERN =
  /(?:(?:\d+|[一二三四五六七八九十]+)[个]?(?:channel|频道|邮箱|群|目标|渠道|接收端))[^\n。！？]{0,20}(?:送达|发完|发出|投递|下发|派发|发送)/gi;
/** ZH: informal completion phrases with 未-guard in same sentence. */
const ZH_IMPLICIT_DELIVERY =
  /(?:(?:搞定了|已下发|已派发)[^。！？\n]*)(?<!未)/g;
/** EN: "all/every/each" within 30 chars of delivery verb. */
const EN_ALL_PATTERN =
  /\b(?:all|every|each)\b.{0,30}\b(?:delivered|sent|dispatched|reached)\b/gi;
/** EN: \d+ + channel/recipient/target within 30 chars of delivery verb. */
const EN_NUMERIC_PATTERN =
  /\b(?:\d+)\s+(?:channels?|recipients?|targets?|destinations?)\b.{0,30}\b(?:delivered|sent|dispatched|reached)\b/gi;

/**
 * Detects quantitative delivery-completion claims in assistant text.
 * Used by the L2 pre-flight gate (Path β) to block responses that assert
 * delivery completion without a preceding `query_delivery_history` / `query_execution_status` call.
 *
 * All patterns are linear (no nested quantifiers) — safe from ReDoS.
 * Guard: NFC-normalize + cap at 100_000 chars before any regex scan.
 */
export function detectDeliveryQuantitativeClaim(
  text: string,
): DeliveryQuantitativeClaimResult {
  if (!text || typeof text !== "string") {
    return { detected: false, matches: [] };
  }

  const normalized = text.normalize("NFC");
  const capped = normalized.slice(0, 100_000);
  const matches: DeliveryQuantitativeClaimMatch[] = [];

  for (const _m of capped.match(ZH_ALL_PATTERN) ?? []) {
    matches.push({ pattern: "all-quantifier", evidenceSpan: _m, locale: "zh" });
  }
  for (const _m of capped.match(ZH_NUMERIC_PATTERN) ?? []) {
    matches.push({ pattern: "numeric-count", evidenceSpan: _m, locale: "zh" });
  }
  for (const _m of capped.match(ZH_IMPLICIT_DELIVERY) ?? []) {
    matches.push({ pattern: "implicit-completion", evidenceSpan: _m, locale: "zh" });
  }
  for (const _m of capped.match(EN_ALL_PATTERN) ?? []) {
    matches.push({ pattern: "all-quantifier", evidenceSpan: _m, locale: "en" });
  }
  for (const _m of capped.match(EN_NUMERIC_PATTERN) ?? []) {
    matches.push({ pattern: "numeric-count", evidenceSpan: _m, locale: "en" });
  }

  return { detected: matches.length > 0, matches };
}

export function detectCompletionLanguage(
  text: string,
  locale?: "zh" | "en",
): CompletionLanguageResult {
  if (!text || typeof text !== "string") {
    return { detected: false, matches: [] };
  }

  // NFC normalize + length cap
  const normalized = text.normalize("NFC");
  const capped = normalized.slice(0, 100_000);

  // Determine effective locale
  const effectiveLocale = locale ?? (hasMixedScript(capped) ? "zh" : inferLocale(capped));

  const matches: CompletionMatch[] = [];
  const seen: Set<VerbFamily> = new Set();

  for (const [verbFamily, entry] of Object.entries(LEXICON) as [VerbFamily, LexiconEntry][]) {
    if (seen.has(verbFamily)) continue;

    let found = false;

    if (effectiveLocale === "zh" || hasMixedScript(capped)) {
      for (const phrase of entry.zh) {
        const idx = capped.indexOf(phrase);
        if (idx === -1) continue;
        // Check negation in the 6 chars before the match
        const before = capped.slice(Math.max(0, idx - 6), idx);
        if (ZH_NEGATION.test(before)) continue;
        matches.push({ verbFamily, evidenceSpan: phrase, locale: "zh" });
        seen.add(verbFamily);
        found = true;
        break;
      }
    }

    if (!found && (effectiveLocale === "en" || hasMixedScript(capped))) {
      for (const regex of entry.en) {
        const match = regex.exec(capped);
        if (!match) continue;
        const idx = match.index;
        // Check negation in the 16 chars before the match
        const before = capped.slice(Math.max(0, idx - 16), idx);
        if (EN_NEGATION.test(before)) continue;
        matches.push({ verbFamily, evidenceSpan: match[0], locale: "en" });
        seen.add(verbFamily);
        found = true;
        break;
      }
    }
  }

  return { detected: matches.length > 0, matches };
}
