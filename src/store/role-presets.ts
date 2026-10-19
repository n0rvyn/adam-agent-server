/**
 * Thin re-export shim for backwards compatibility.
 *
 * All canonical Role preset definitions and seed/restore logic have migrated to
 * src/presets/ (Tasks 2-4). This module re-exports the symbols that existing
 * call sites depend on so no caller needs to change its import path.
 *
 * New code should import directly from src/presets/index.ts instead.
 */

export {
  CHAT_MANAGER_ROLE_ID,
  PRESET_ROLE_NAMES,
  isPresetRole,
  initializeDefaultRoles,
  ensureChatManagerRole,
  ensureAdamAutomatorRole,
  ADAM_AUTOMATOR_PRESET,
} from "../presets/index.js";
