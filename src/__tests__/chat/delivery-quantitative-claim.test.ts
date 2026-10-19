import { describe, it, expect } from "vitest";
import { detectDeliveryQuantitativeClaim } from "../../chat/completion-language-detector.js";
import { detectCompletionLanguage } from "../../chat/completion-language-detector.js";

function detect(text: string) {
  return detectDeliveryQuantitativeClaim(text);
}

describe("detectDeliveryQuantitativeClaim", () => {
  // ===== df074446 failure phrases (canonical 6 from dev-guide line 214) =====
  const df074446_phrases = [
    "全部送达，没有遗漏",
    "都收到了",
    "都已发完",
    "搞定了",
    "6 个 channel 全部送达",
    "已下发",
  ];

  for (const phrase of df074446_phrases) {
    it(`df074446: "${phrase}" → detected`, () => {
      const r = detect(phrase);
      expect(r.detected).toBe(true);
      expect(r.matches.length).toBeGreaterThan(0);
    });
  }

  // ===== English numeric pattern =====
  it("EN: '3 recipients received the message' → NOT detected (received not in EN_NUMERIC verb set)", () => {
    // EN_NUMERIC_PATTERN only covers: delivered, sent, dispatched, reached
    const r = detect("3 recipients received the message");
    expect(r.detected).toBe(false);
  });

  it("EN: 'All 6 channels delivered successfully' → detected", () => {
    const r = detect("All 6 channels delivered successfully");
    expect(r.detected).toBe(true);
  });

  // ===== Neutral descriptions (should NOT trigger) =====
  it("neutral ZH: '投递状态查询中' → not detected", () => {
    const r = detect("投递状态查询中");
    expect(r.detected).toBe(false);
  });

  it("neutral ZH: '正在发往 channel' → not detected", () => {
    const r = detect("正在发往 channel");
    expect(r.detected).toBe(false);
  });

  it("neutral EN: 'Sending to 3 channels...' → not detected", () => {
    const r = detect("Sending to 3 channels...");
    expect(r.detected).toBe(false);
  });

  it("neutral EN: 'Checking delivery status' → not detected", () => {
    const r = detect("Checking delivery status");
    expect(r.detected).toBe(false);
  });

  // ===== Explicit negation =====
  it("ZH: '还有 2 个 channel 未送达' → NOT detected (未 negation)", () => {
    const r = detect("还有 2 个 channel 未送达");
    // 未 in same sentence guards; the bounded gap between numeric and verb
    // may not catch this inverted pattern
    expect(r.detected).toBe(false);
  });

  it("EN: 'Not all channels were delivered' → detected (no EN negation guard — advisory trade-off)", () => {
    // Plan advisory 2: EN_ALL_PATTERN lacks negation guard. Worst case: extra retry on
    // rare negative quantifier patterns. This test documents the current behavior.
    const r = detect("Not all channels were delivered");
    expect(r.detected).toBe(true);
  });

  // ===== Edge cases =====
  it("empty string → not detected, no throw", () => {
    expect(() => detect("")).not.toThrow();
    expect(detect("").detected).toBe(false);
  });

  it("null/undefined → not detected, no throw", () => {
    expect(() => detect(null as unknown as string)).not.toThrow();
    expect(detect(null as unknown as string).detected).toBe(false);
  });

  it("100k-char cap boundary: trigger at char 100_000 IS detected (cap is inclusive)", () => {
    // cap = .slice(0, 100_000) — includes chars 0 through 99,999 = 100k total.
    // A 100k-char string where the trigger occupies the last 4 chars IS within the cap.
    const prefix = "x".repeat(100_000 - "全部送达".length);
    const long = prefix + "全部送达";
    expect(long.length).toBe(100_000);
    const r = detect(long);
    expect(r.detected).toBe(true);
  });

  it("100k-char cap: trigger at char 100_001 is NOT detected (past cap)", () => {
    // Push the trigger one char past the cap: total 100_001, capped to 100_000, trigger excluded
    const prefix = "x".repeat(100_000 - "全部送达".length + 1);
    const long = prefix + "全部送达";
    expect(long.length).toBe(100_001);
    const r = detect(long);
    expect(r.detected).toBe(false);
  });

  it("trigger phrase at exactly 100k boundary → detected", () => {
    const prefix = "x".repeat(100_000 - "全部送达".length);
    const text = prefix + "全部送达";
    expect(text.length).toBe(100_000);
    const r = detect(text);
    expect(r.detected).toBe(true);
  });

  // ===== Regression: existing detectCompletionLanguage still works =====
  it("regression: detectCompletionLanguage still detects '已发送' and '已删除'", () => {
    const r1 = detectCompletionLanguage("已发送");
    expect(r1.detected).toBe(true);
    expect(r1.matches.some((m) => m.verbFamily === "send")).toBe(true);

    const r2 = detectCompletionLanguage("已删除");
    expect(r2.detected).toBe(true);
    expect(r2.matches.some((m) => m.verbFamily === "delete")).toBe(true);
  });

  it("regression: detectCompletionLanguage NOT impacted by new export", () => {
    // Ensure the new function does not alter the existing API
    const r = detectCompletionLanguage("Role 已创建");
    expect(r.detected).toBe(true);
    expect(r.matches[0]?.verbFamily).toBe("create");
  });
});
