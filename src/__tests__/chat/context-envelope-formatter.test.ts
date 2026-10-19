import { describe, it, expect } from "vitest";
import {
  shortMessageRef,
  formatTime,
  formatSize,
  formatMirrorSuffix,
  formatAttachmentBlock,
  kindLabel,
  formatEnvelopeBracket,
} from "../../chat/context-envelope-formatter.js";
import type { ChatMessage, ChatAttachment } from "../../shared/types.js";

describe("chat/context-envelope-formatter", () => {
  it("shortMessageRef takes last 6 chars", () => {
    expect(shortMessageRef("abcdef-1234567890")).toBe("#M567890");
    expect(shortMessageRef("abc")).toBe("#Mabc");
  });

  it("formatSize covers B/KB/MB", () => {
    expect(formatSize(512)).toBe("512B");
    expect(formatSize(4300)).toBe("4.2KB");
    expect(formatSize(2_000_000)).toBe("1.9MB");
  });

  it("formatMirrorSuffix produces empty when no targets", () => {
    expect(formatMirrorSuffix([], "10:30")).toBe("");
  });

  it("formatMirrorSuffix lists channel:chat targets", () => {
    const result = formatMirrorSuffix(
      [{ type: "channel", channelId: "wechat-bot", chatId: "user-x" }],
      "10:40",
    );
    expect(result).toBe("(also delivered to: wechat-bot:user-x @ 10:40)");
  });

  it("formatAttachmentBlock with excerpt", () => {
    const att: ChatAttachment = {
      artifactId: "a1",
      locator: "local:///tmp/x.md",
      filename: "review.md",
      mimeType: "text/markdown",
      size: 4200,
      purpose: "report",
    };
    const out = formatAttachmentBlock(att, "## Findings\nrace condition");
    expect(out).toBe('    [file: review.md (purpose=report, 4.1KB, mime=text/markdown)]\n      excerpt: "## Findings\\nrace condition"');
  });

  it("formatAttachmentBlock without excerpt (metadata only)", () => {
    const att: ChatAttachment = {
      artifactId: "a1",
      locator: "local:///tmp/x.png",
      filename: "screen.png",
      mimeType: "image/png",
      size: 100_000,
    };
    const out = formatAttachmentBlock(att, undefined);
    expect(out).toBe("    [file: screen.png (purpose=data, 97.7KB, mime=image/png)]");
  });

  it("kindLabel maps each kind", () => {
    expect(kindLabel("user_message", "user")).toBe("user");
    expect(kindLabel("assistant_text", "assistant")).toBe("adam");
    expect(kindLabel("status_report", "assistant")).toBe("status");
    expect(kindLabel("result_delivery", "assistant")).toBe("result");
    expect(kindLabel("approval_prompt", "assistant")).toBe("approval");
    expect(kindLabel("system_note", "assistant")).toBe("system");
    expect(kindLabel(undefined, "user")).toBe("user");
    expect(kindLabel(undefined, "assistant")).toBe("adam");
  });

  it("formatEnvelopeBracket includes prompt+shape for approval", () => {
    const msg: ChatMessage = {
      id: "abc-456789",
      sessionId: "s",
      role: "assistant",
      content: "approve?",
      source: { type: "web" },
      createdAt: 0,
      kind: "approval_prompt",
      promptId: "A2K7",
      approvalShape: "yes_no",
    };
    expect(formatEnvelopeBracket(msg)).toBe("[approval #M456789 prompt=A2K7 shape=yes_no]");
  });

  it("formatEnvelopeBracket plain for status", () => {
    const msg: ChatMessage = {
      id: "abc-789012",
      sessionId: "s",
      role: "assistant",
      content: "running",
      source: { type: "web" },
      createdAt: 0,
      kind: "status_report",
    };
    expect(formatEnvelopeBracket(msg)).toBe("[status #M789012]");
  });

  it("formatEnvelopeBracket includes binding metadata for resolved user_message", () => {
    const msg: ChatMessage = {
      id: "msg-userrr",  // last 6 = userrr
      sessionId: "s",
      role: "user",
      content: "批准",
      source: { type: "web" },
      createdAt: 0,
      kind: "user_message",
      parentMessageId: "msg-promptt",  // last 6 = romptt
      promptId: "A2K7",
    };
    expect(formatEnvelopeBracket(msg, "token")).toBe("[user #Muserrr reply→#Mromptt prompt=A2K7 via=token]");
  });

  it("formatEnvelopeBracket plain for user_message without binding", () => {
    const msg: ChatMessage = {
      id: "msg-plain1",
      sessionId: "s",
      role: "user",
      content: "hi",
      source: { type: "web" },
      createdAt: 0,
      kind: "user_message",
    };
    expect(formatEnvelopeBracket(msg)).toBe("[user #Mplain1]");
  });

  it("formatEnvelopeBracket emits parent without via when resolvedVia not provided", () => {
    const msg: ChatMessage = {
      id: "msg-userid",
      sessionId: "s",
      role: "user",
      content: "批准",
      source: { type: "web" },
      createdAt: 0,
      kind: "user_message",
      parentMessageId: "msg-parent",
      promptId: "B3J9",
    };
    expect(formatEnvelopeBracket(msg)).toBe("[user #Muserid reply→#Mparent prompt=B3J9]");
  });

  it("formatTime returns HH:MM", () => {
    const epoch = new Date(2026, 4, 6, 14, 30, 0).getTime();
    expect(formatTime(epoch)).toBe("14:30");
  });
});
