/**
 * Light assertion test for the import-guidance section in buildChatSystemPrompt.
 *
 * Per Phase 2 plan §Task 9: the section is added semantically (no literal
 * tool names per CLAUDE.md Principle #2). The test asserts only that the
 * rendered prompt contains the heading. Full behavior verification is via
 * the live ChatManager E2E (AC#6) in run-phase Step 6.5.
 */
import { describe, it, expect } from "vitest";
import { buildChatSystemPrompt } from "../../manager/chat-system-prompt.js";

describe("buildChatSystemPrompt — import guidance section", () => {
  const NOW = 1700000000000;

  it("contains the 'Importing a config document' heading", () => {
    const prompt = buildChatSystemPrompt({ currentTime: NOW });
    expect(prompt).toContain("## Importing a config document");
  });

  it("contains the 8 numbered flow steps (semantic, no literal tool names)", () => {
    const prompt = buildChatSystemPrompt({ currentTime: NOW });
    // 1. HARD refusal on missing deps
    expect(prompt).toMatch(/HARD refusal/i);
    // 2. Read structured, never verbatim prose
    expect(prompt).toMatch(/structured.*never.*verbatim|Read structured/i);
    // 3. Bind placeholders interactively
    expect(prompt).toMatch(/Bind placeholders interactively|interactively/i);
    // 4. Same-name roles: ASK, default skip
    expect(prompt).toMatch(/default is "reuse \/ skip"|default.*skip/i);
    // 5. Create roles first; build the role-id map
    expect(prompt).toMatch(/role-id map|role id map/i);
    // 6. Create the template, wiring each step to the remapped role ids
    expect(prompt).toMatch(/remapped role ids|remapped role identities/i);
    // 7. Run structural verification before reporting success
    expect(prompt).toMatch(/structural verification/i);
    // 8. Re-run after interruption is safe
    expect(prompt).toMatch(/Re-run after interruption/i);
  });

  it("places the import-guidance section AFTER Template Config Changes and BEFORE the user-customized persona block", () => {
    const prompt = buildChatSystemPrompt({
      currentTime: NOW,
      storedCagPrompt: "CustomCAGMarker-XYZ",
    });
    const importIdx = prompt.indexOf("## Importing a config document");
    const configChangesIdx = prompt.indexOf("## Template Config Changes");
    const personaIdx = prompt.indexOf("## User-customized Persona");
    expect(importIdx).toBeGreaterThan(configChangesIdx);
    expect(personaIdx).toBeGreaterThan(importIdx);
  });

  it("section is present regardless of storedCagPrompt (additive, not conditional)", () => {
    const withCag = buildChatSystemPrompt({ currentTime: NOW, storedCagPrompt: "X" });
    const withoutCag = buildChatSystemPrompt({ currentTime: NOW });
    expect(withCag).toContain("## Importing a config document");
    expect(withoutCag).toContain("## Importing a config document");
  });
});
