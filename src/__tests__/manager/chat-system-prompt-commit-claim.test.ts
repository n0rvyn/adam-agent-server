import { describe, it, expect } from "vitest";
import { buildChatSystemPrompt } from "../../manager/chat-system-prompt.js";

describe("chat-system-prompt commit_claim section", () => {
  // Phase 6: the section is renamed from "CRITICAL" to "Optional Strengthening"
  it("contains 'Commit Claim — Optional Strengthening' section (not CRITICAL)", () => {
    const prompt = buildChatSystemPrompt({ currentTime: 0 });
    expect(prompt).toContain("Commit Claim — Optional Strengthening");
    expect(prompt).not.toContain("CRITICAL: Commit Claim Before Confirming");
  });

  it("mentions commit_claim at least 3 times (Phase 6 optional, fewer mentions)", () => {
    const prompt = buildChatSystemPrompt({ currentTime: 0 });
    const matches = prompt.match(/commit_claim/g);
    expect((matches ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it("contains 'does NOT need to call' (Phase 6 optional framing)", () => {
    const prompt = buildChatSystemPrompt({ currentTime: 0 });
    expect(prompt).toMatch(/does NOT need to call|do not need to call/i);
  });

  it("contains 'Routine confirmation example'", () => {
    const prompt = buildChatSystemPrompt({ currentTime: 0 });
    expect(prompt).toContain("Routine confirmation example");
  });

  it("contains 'Quantitative strengthening example'", () => {
    const prompt = buildChatSystemPrompt({ currentTime: 0 });
    expect(prompt).toContain("Quantitative strengthening example");
  });

  it("no longer uses hard 必须 wording for commit_claim (Phase 6 softened)", () => {
    const prompt = buildChatSystemPrompt({ currentTime: 0 });
    const criticalSectionMatch = prompt.match(/## Commit Claim — Optional Strengthening\n([\s\S]*?)(?=\n## |\n#|$)/);
    expect(criticalSectionMatch).not.toBeNull();
    const sectionText = criticalSectionMatch![1];
    expect(sectionText).not.toContain("必须");
  });
});
