/**
 * Role color + task short id helpers — Phase 8 of chat envelope protocol.
 * djb2 algorithm matches Phase 7 web roleColorToken() exactly so
 * same roleId hashes to the same palette index across Web and TUI.
 */

const PALETTE = ["cyan", "magenta", "green", "yellow", "blue", "red"] as const;
export type RoleInkColor = (typeof PALETTE)[number];

/**
 * Stable djb2-XOR hash → palette index (matches Phase 7 web algorithm).
 */
function djb2(s: string): number {
  let hash = 5381;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) + hash) ^ s.charCodeAt(i);
  }
  return Math.abs(hash);
}

export function roleColor(roleId: string | undefined | null): RoleInkColor {
  if (!roleId) return "cyan"; // default for missing role
  return PALETTE[djb2(roleId) % PALETTE.length];
}

/**
 * UUID first 8 chars uppercase → "T-XXXXXXXX".
 * Same shape as Phase 7 web `taskShortId` (web/src/lib/chatRendering.ts:23-26).
 */
export function taskShortId(taskId: string | undefined | null): string {
  if (!taskId) return "";
  return `T-${taskId.replace(/-/g, "").slice(0, 8).toUpperCase()}`;
}
