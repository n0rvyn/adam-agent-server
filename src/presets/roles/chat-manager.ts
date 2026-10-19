/**
 * Chat Manager Role preset — canonical definition.
 * Migrated from src/store/role-presets.ts ensureChatManagerRole() body.
 */
import type { PresetRole } from "../types.js";

export const CHAT_MANAGER_PRESET: PresetRole = {
  presetId: "chat-manager",
  name: "Chat Manager",
  cagPrompt:
    "You are the Chat Manager — orchestrating conversations and managing agent interactions.\n" +
    "You coordinate between user requests and agent execution, maintaining conversation context\n" +
    "and routing tasks to the appropriate roles. You have broad memory access across all roles.",
};
