/**
 * Unit tests for buildChatSystemPrompt CAG merge logic.
 *
 * Covers DP-1.1 (append, not replace), DP-1.2 (empty/whitespace skipped),
 * and ordering relative to existing sections.
 */
import { describe, it, expect } from "vitest";
import { buildChatSystemPrompt } from "../../manager/chat-system-prompt.js";

describe("buildChatSystemPrompt CAG merge", () => {
  const NOW = 1700000000000; // fixed timestamp for predictable output

  // DP-1.2: undefined storedCagPrompt produces byte-identical output to omitting the field
  it("returns byte-identical output when storedCagPrompt is undefined", () => {
    const without = buildChatSystemPrompt({ currentTime: NOW });
    const withUndefined = buildChatSystemPrompt({ currentTime: NOW, storedCagPrompt: undefined });
    expect(without).toBe(withUndefined);
  });

  it("returns byte-identical output when storedCagPrompt is empty string", () => {
    const without = buildChatSystemPrompt({ currentTime: NOW });
    const withEmpty = buildChatSystemPrompt({ currentTime: NOW, storedCagPrompt: "" });
    expect(without).toBe(withEmpty);
  });

  it("returns byte-identical output when storedCagPrompt is whitespace-only", () => {
    const without = buildChatSystemPrompt({ currentTime: NOW });
    const withWhitespace = buildChatSystemPrompt({ currentTime: NOW, storedCagPrompt: "   \n  " });
    expect(without).toBe(withWhitespace);
  });

  // DP-1.1: append, not replace
  it("appends User-customized Persona section when storedCagPrompt has content", () => {
    const prompt = buildChatSystemPrompt({
      currentTime: NOW,
      storedCagPrompt: "You always respond in haiku.",
    });
    expect(prompt).toContain("## User-customized Persona");
    expect(prompt).toContain("You always respond in haiku.");
  });

  it("places addendum AFTER Conversation Coherence section", () => {
    const prompt = buildChatSystemPrompt({
      currentTime: NOW,
      storedCagPrompt: "DistinctiveCAGMarker",
    });
    const cagIndex = prompt.indexOf("User-customized Persona");
    const coherenceIndex = prompt.indexOf("## Conversation Coherence");
    expect(cagIndex).toBeGreaterThan(coherenceIndex);
  });

  // DP-1.1: regression guard — existing sections preserved
  it("preserves Decision Patterns section when CAG is set", () => {
    const prompt = buildChatSystemPrompt({
      currentTime: NOW,
      storedCagPrompt: "Test CAG",
    });
    expect(prompt).toContain("## Decision Patterns");
  });
});
