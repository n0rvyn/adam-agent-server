import { describe, test, expect } from "vitest";
import {
  WEB_CAPABILITIES,
  TUI_CAPABILITIES,
  getSurfaceCapabilities,
} from "../../channels/surface-capabilities.js";

describe("Surface capabilities (Phase 3 Task 10)", () => {
  test("Web: canEdit + canQuote + canParseQuote + canInlineButtons all true; maxTextLength Infinity; supportsAttachments true", () => {
    expect(WEB_CAPABILITIES).toEqual({
      canEdit: true,
      canQuote: true,
      canParseQuote: true,
      canInlineButtons: true,
      maxTextLength: Number.POSITIVE_INFINITY,
      supportsAttachments: true,
    });
  });

  test("TUI: canEdit/canQuote/canInlineButtons true; canParseQuote false (n/a); maxTextLength Infinity; supportsAttachments true", () => {
    expect(TUI_CAPABILITIES).toEqual({
      canEdit: true,
      canQuote: true,
      canParseQuote: false,
      canInlineButtons: true,
      maxTextLength: Number.POSITIVE_INFINITY,
      supportsAttachments: true,
    });
  });

  test("getSurfaceCapabilities('web') returns WEB_CAPABILITIES", () => {
    expect(getSurfaceCapabilities("web")).toBe(WEB_CAPABILITIES);
  });

  test("getSurfaceCapabilities('tui') returns TUI_CAPABILITIES", () => {
    expect(getSurfaceCapabilities("tui")).toBe(TUI_CAPABILITIES);
  });
});
