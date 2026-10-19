/**
 * Surface capabilities — capability declarations for non-channel surfaces (Web UI / TUI).
 *
 * Web (chat-stream WebSocket + React) and TUI (in-process Ink renderer) are not ChannelAdapter instances;
 * they don't register with ChannelManager. But the envelope protocol's cross-channel sync logic
 * (Phase 5) needs to know each surface's capability to decide between editMessage and broadcast
 * system_note fallback.
 *
 * This module exposes static capability constants. Phase 5 dispatches by target type:
 *   - channel target → ChannelManager.getCapabilities(channelId)
 *   - session target with sourceType 'web' or 'tui' → getSurfaceCapabilities(sourceType)
 */
import type { ChannelCapabilities } from "../shared/types.js";

/** Web UI surface (chat-stream WebSocket + React).
 *  canEdit: WebSocket can push DOM-replace events for any message id.
 *  canQuote / canParseQuote: native React reply UI.
 *  canInlineButtons: native button components in approval card.
 *  maxTextLength: unbounded (no platform limit).
 *  supportsAttachments: yes (chip rendering + download). */
export const WEB_CAPABILITIES: ChannelCapabilities = {
  canEdit: true,
  canQuote: true,
  canParseQuote: true,
  canInlineButtons: true,
  maxTextLength: Number.POSITIVE_INFINITY,
  supportsAttachments: true,
};

/** TUI surface (Ink in-process).
 *  canEdit: Ink rerender replaces any line by id.
 *  canQuote: rendering quote box in Ink Box.
 *  canParseQuote: TUI has no inbound quote parsing (n/a — user types into prompt directly).
 *  canInlineButtons: ink-select-input.
 *  maxTextLength: unbounded.
 *  supportsAttachments: partial — file paths rendered, not preview. */
export const TUI_CAPABILITIES: ChannelCapabilities = {
  canEdit: true,
  canQuote: true,
  canParseQuote: false,  // n/a represented as false
  canInlineButtons: true,
  maxTextLength: Number.POSITIVE_INFINITY,
  supportsAttachments: true,
};

export type Surface = "web" | "tui";

/** Lookup surface capabilities by surface type. */
export function getSurfaceCapabilities(surface: Surface): ChannelCapabilities {
  if (surface === "web") return WEB_CAPABILITIES;
  if (surface === "tui") return TUI_CAPABILITIES;
  // Exhaustiveness check; should never fall through with typed callers
  const _exhaustive: never = surface;
  throw new Error(`Unknown surface: ${String(_exhaustive)}`);
}
