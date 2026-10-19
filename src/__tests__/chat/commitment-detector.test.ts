import { describe, expect, it, beforeEach } from "vitest";
import {
  detectDeliveryCommitments,
  detectFutureDeliveryCommitments,
  detectTerminalDeliveryClaims,
} from "../../chat/commitment-detector.js";
import { initRuntimeConfig } from "../../config/runtime.js";
import { DEFAULT_CONFIG } from "../../config/defaults.js";
import type { ServerConfig } from "../../shared/types.js";

describe("chat/commitment-detector", () => {
  beforeEach(() => {
    initRuntimeConfig(JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as ServerConfig);
  });

  it("detects future delivery promise", () => {
    const detections = detectFutureDeliveryCommitments("已派毕加索生成 3 张商品图，完成后发你。");
    expect(detections).toHaveLength(1);
    expect(detections[0]).toEqual(expect.objectContaining({
      type: "future_delivery",
      artifactExpectation: { kind: "image", count: 3 },
      hasCount: true,
      locale: "zh",
    }));
  });

  it("detects future delivery promise with channel target hint", () => {
    const detections = detectFutureDeliveryCommitments("生成完发到你微信");
    expect(detections).toEqual([expect.objectContaining({
      type: "future_delivery",
      targetHint: { channel: "wechat" },
      locale: "zh",
    })]);
  });

  it("detects delivery success claims", () => {
    const detections = detectTerminalDeliveryClaims("3 张图已全部发到你 iPhone 微信了");
    expect(detections).toEqual([expect.objectContaining({
      type: "delivery_success_claim",
      artifactExpectation: { kind: "image", count: 3 },
      targetHint: { channel: "wechat" },
      hasCount: true,
      locale: "zh",
    })]);
  });

  it("detects delivery failure claims", () => {
    const detections = detectTerminalDeliveryClaims("图片已生成，但发送失败");
    expect(detections).toEqual([expect.objectContaining({
      type: "delivery_failure_claim",
      artifactExpectation: { kind: "image" },
      locale: "zh",
    })]);
  });

  it("does not treat generic completion updates as artifact delivery commitments", () => {
    expect(detectDeliveryCommitments("任务已提交，完成后我会告诉你结果")).toEqual([]);
  });

  it("extracts common artifact kinds conservatively", () => {
    expect(detectDeliveryCommitments("报告生成后发你")[0].artifactExpectation).toEqual({ kind: "report" });
    expect(detectDeliveryCommitments("视频处理完发你")[0].artifactExpectation).toEqual({ kind: "video" });
    expect(detectDeliveryCommitments("音频导出完成后发你")[0].artifactExpectation).toEqual({ kind: "audio" });
    expect(detectDeliveryCommitments("文件处理完发你")[0].artifactExpectation).toEqual({ kind: "file" });
  });
});

describe("chat/commitment-detector — EN (Task 4)", () => {
  beforeEach(() => {
    initRuntimeConfig(JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as ServerConfig);
  });

  it("detects EN future delivery promise", () => {
    const r = detectDeliveryCommitments("I'll send you the 3 images once done.");
    expect(r.some(d => d.type === "future_delivery" && d.locale === "en")).toBe(true);
    expect(r.find(d => d.type === "future_delivery")?.artifactExpectation).toEqual({ kind: "image", count: 3 });
  });

  it("detects EN success claim", () => {
    const r = detectDeliveryCommitments("I've sent all 3 images to your WeChat.");
    expect(r.some(d => d.type === "delivery_success_claim" && d.locale === "en")).toBe(true);
  });

  it("detects EN failure claim", () => {
    const r = detectDeliveryCommitments("Failed to send the report.");
    expect(r.some(d => d.type === "delivery_failure_claim" && d.locale === "en")).toBe(true);
  });

  it("does not flag pure status updates without artifact nouns", () => {
    const r = detectDeliveryCommitments("I'll let you know when it's done.");
    expect(r).toEqual([]);
  });

  it("extracts EN channel target hint", () => {
    const r = detectDeliveryCommitments("I'll send the file to your Telegram later.");
    expect(r[0]?.targetHint).toEqual({ channel: "telegram" });
  });

  it("respects locales: ['zh'] config — skips EN detection", () => {
    // Override locales to ["zh"] only via initRuntimeConfig (not mutation)
    const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as ServerConfig;
    cfg.chat = cfg.chat ?? { sessionTimeoutMinutes: 30, maxSessionTurns: 20, autoTitle: true, archiveExtractMemory: true, contextBudgetTokens: 20000 };
    cfg.chat.commitmentDetection = { locales: ["zh"], blockedText: { zh: "任务已提交，完成后我会更新结果。", en: "Task dispatched; I will update you when it completes." }, unsupportedSuccessText: { zh: "图片已生成，发送状态还没有完成验证。", en: "Result is ready; delivery status is not yet verified." }, unsupportedFailureText: { zh: "图片已生成，但还没有执行发送。", en: "Result is ready, but delivery has not been attempted." }, unsupportedMutationText: { zh: "我没有完成这次记录，不能说已记录。需要先更新对应模板或配置后再确认。", en: "I did not actually record this. The template or config has not been updated yet." } };
    cfg.chat.commitmentDetection.locales = ["zh"];
    initRuntimeConfig(cfg);

    const r = detectDeliveryCommitments("I'll send you 3 images later.");
    expect(r).toEqual([]);
  });
});
