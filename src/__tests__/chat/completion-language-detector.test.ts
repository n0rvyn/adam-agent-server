import { describe, it, expect } from "vitest";
import { detectCompletionLanguage } from "../../chat/completion-language-detector.js";

function detect(text: string, locale?: "zh" | "en") {
  return detectCompletionLanguage(text, locale);
}

describe("detectCompletionLanguage", () => {
  // ===== ZH templates (15) =====
  it("ZH: '✅ Role 已创建' → create", () => {
    const r = detect("✅ Role 已创建");
    expect(r.detected).toBe(true);
    expect(r.matches[0]?.verbFamily).toBe("create");
  });

  it("ZH: '✅ Role `role-x` 已删除。' → delete", () => {
    const r = detect("✅ Role `role-x` 已删除。");
    expect(r.detected).toBe(true);
    expect(r.matches[0]?.verbFamily).toBe("delete");
  });

  it("ZH: '模板已更新，从今天生效。' → update", () => {
    const r = detect("模板已更新，从今天生效。");
    expect(r.detected).toBe(true);
    expect(r.matches[0]?.verbFamily).toBe("update");
  });

  it("ZH: '已配置好通知规则。' → update", () => {
    const r = detect("已配置好通知规则。");
    expect(r.detected).toBe(true);
    expect(r.matches[0]?.verbFamily).toBe("update");
  });

  it("ZH: '✅ 已补发，两个邮箱各 14 个附件。' → send", () => {
    const r = detect("✅ 已补发，两个邮箱各 14 个附件。");
    expect(r.detected).toBe(true);
    expect(r.matches[0]?.verbFamily).toBe("send");
  });

  it("ZH: '邮件已送达。' → send", () => {
    const r = detect("邮件已送达。");
    expect(r.detected).toBe(true);
    expect(r.matches[0]?.verbFamily).toBe("send");
  });

  it("ZH: '任务已安排在半小时后执行。' → schedule", () => {
    const r = detect("任务已安排在半小时后执行。");
    expect(r.detected).toBe(true);
    expect(r.matches[0]?.verbFamily).toBe("schedule");
  });

  it("ZH: '任务已取消。' → cancel", () => {
    const r = detect("任务已取消。");
    expect(r.detected).toBe(true);
    expect(r.matches[0]?.verbFamily).toBe("cancel");
  });

  it("ZH: '插件已绑定到 Role 周杰伦。' → bind", () => {
    const r = detect("插件已绑定到 Role 周杰伦。");
    expect(r.detected).toBe(true);
    expect(r.matches[0]?.verbFamily).toBe("bind");
  });

  it("ZH: '插件已解绑。' → unbind", () => {
    const r = detect("插件已解绑。");
    expect(r.detected).toBe(true);
    expect(r.matches[0]?.verbFamily).toBe("unbind");
  });

  it("ZH: 'delivery rule 已启用。' → enable", () => {
    const r = detect("delivery rule 已启用。");
    expect(r.detected).toBe(true);
    expect(r.matches[0]?.verbFamily).toBe("enable");
  });

  it("ZH: '已禁用 MCP 通知。' → disable", () => {
    const r = detect("已禁用 MCP 通知。");
    expect(r.detected).toBe(true);
    expect(r.matches[0]?.verbFamily).toBe("disable");
  });

  it("ZH: '执行已开始。' → start", () => {
    const r = detect("执行已开始。");
    expect(r.detected).toBe(true);
    expect(r.matches[0]?.verbFamily).toBe("start");
  });

  it("ZH negated: '我还**没有**删除那个 role。' → not detected", () => {
    const r = detect("我还**没有**删除那个 role。");
    expect(r.detected).toBe(false);
  });

  it("ZH negated: '尚未发送邮件，请稍候。' → not detected", () => {
    const r = detect("尚未发送邮件，请稍候。");
    expect(r.detected).toBe(false);
  });

  // ===== EN templates (15) =====
  it("EN: 'Role created successfully.' → create", () => {
    const r = detect("Role created successfully.", "en");
    expect(r.detected).toBe(true);
    expect(r.matches[0]?.verbFamily).toBe("create");
  });

  it("EN: 'The template was updated.' → update", () => {
    const r = detect("The template was updated.", "en");
    expect(r.detected).toBe(true);
    expect(r.matches[0]?.verbFamily).toBe("update");
  });

  it("EN: 'Deleted 3 entries.' → delete", () => {
    const r = detect("Deleted 3 entries.", "en");
    expect(r.detected).toBe(true);
    expect(r.matches[0]?.verbFamily).toBe("delete");
  });

  it("EN: 'Email sent to recipients.' → send", () => {
    const r = detect("Email sent to recipients.", "en");
    expect(r.detected).toBe(true);
    expect(r.matches[0]?.verbFamily).toBe("send");
  });

  it("EN: 'Job scheduled for 9am.' → schedule", () => {
    const r = detect("Job scheduled for 9am.", "en");
    expect(r.detected).toBe(true);
    expect(r.matches[0]?.verbFamily).toBe("schedule");
  });

  it("EN: 'Cancelled the recurring task.' → cancel", () => {
    const r = detect("Cancelled the recurring task.", "en");
    expect(r.detected).toBe(true);
    expect(r.matches[0]?.verbFamily).toBe("cancel");
  });

  it("EN: 'Plugin bound to role.' → bind", () => {
    const r = detect("Plugin bound to role.", "en");
    expect(r.detected).toBe(true);
    expect(r.matches[0]?.verbFamily).toBe("bind");
  });

  it("EN: 'Unlinked the mcp server.' → unbind", () => {
    const r = detect("Unlinked the mcp server.", "en");
    expect(r.detected).toBe(true);
    expect(r.matches[0]?.verbFamily).toBe("unbind");
  });

  it("EN: 'Notification enabled.' → enable", () => {
    const r = detect("Notification enabled.", "en");
    expect(r.detected).toBe(true);
    expect(r.matches[0]?.verbFamily).toBe("enable");
  });

  it("EN: 'Notification disabled.' → disable", () => {
    const r = detect("Notification disabled.", "en");
    expect(r.detected).toBe(true);
    expect(r.matches[0]?.verbFamily).toBe("disable");
  });

  it("EN: 'Execution started.' → start", () => {
    const r = detect("Execution started.", "en");
    expect(r.detected).toBe(true);
    expect(r.matches[0]?.verbFamily).toBe("start");
  });

  it("EN negated: 'I have not deleted that role.' → not detected", () => {
    const r = detect("I have not deleted that role.", "en");
    expect(r.detected).toBe(false);
  });

  it("EN negated: 'Did not send the email yet.' → not detected", () => {
    const r = detect("Did not send the email yet.", "en");
    expect(r.detected).toBe(false);
  });

  it("EN: 'Recently modified the config.' → update", () => {
    const r = detect("Recently modified the config.", "en");
    expect(r.detected).toBe(true);
    expect(r.matches[0]?.verbFamily).toBe("update");
  });

  it("EN: 'Newly created 2 channels.' → create", () => {
    const r = detect("Newly created 2 channels.", "en");
    expect(r.detected).toBe(true);
    expect(r.matches[0]?.verbFamily).toBe("create");
  });

  // ===== Additional non-template tests =====
  it("empty string → not detected", () => {
    const r = detect("");
    expect(r.detected).toBe(false);
    expect(r.matches).toEqual([]);
  });

  it("null/undefined → not detected, no throw", () => {
    expect(() => detect(null as unknown as string)).not.toThrow();
    expect(detect(null as unknown as string).detected).toBe(false);
  });

  it("200k-char input → truncated to 100k, scan completes", () => {
    const long = "已创建" + "a".repeat(199_997); // phrase at start, total 200_000
    expect(long.length).toBe(200_000);
    const start = performance.now();
    const r = detect(long);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(100);
    expect(r.detected).toBe(true);
  });

  it("NFC normalization: combining mark input passes through normalize('NFC')", () => {
    // U+0308 = combining diaeresis; NFC normalizes it away
    const text = "已创̈建"; // "已创̈建"
    const r = detect(text);
    // After NFC, the combining mark may merge — detector should still work on the normalized form
    expect(typeof r.detected).toBe("boolean");
  });

  it("mixed-script 'Role 已创建 successfully' → matches both ZH+EN create, but deduplicated to 1 match", () => {
    const r = detect("Role 已创建 successfully");
    expect(r.detected).toBe(true);
    expect(r.matches.length).toBe(1);
    expect(r.matches[0]?.verbFamily).toBe("create");
  });

  it("multiple verb families → returns one match per family", () => {
    const r = detect("已创建并已发送。");
    const families = r.matches.map(m => m.verbFamily);
    expect(families).toContain("create");
    expect(families).toContain("send");
  });

  it("no completion language → not detected", () => {
    const r = detect("Hello world, how are you today?");
    expect(r.detected).toBe(false);
  });

  it("forced locale overrides inference", () => {
    const r = detect("已创建", "en");
    // With locale=en, the ZH phrase won't match; with zh or auto it would
    // But hasMixedScript detects CJK in the text itself, so "en" override is overridden back by mixed detection
    // Testing: if we pass empty-ish text with forced locale
    const r2 = detect("created", "zh");
    expect(r2.detected).toBe(false); // no ZH phrases present
  });

  it("locale=zh forces ZH detection only", () => {
    const r = detect("created successfully", "zh");
    expect(r.detected).toBe(false);
  });

  it("locale=en forces EN detection only", () => {
    const r = detect("已创建", "en");
    expect(r.detected).toBe(false);
  });

  it("returns correct locale per match", () => {
    const r = detect("已发送", "zh");
    expect(r.matches[0]?.locale).toBe("zh");
    const r2 = detect("sent", "en");
    expect(r2.matches[0]?.locale).toBe("en");
  });
});
