/**
 * Feature Mining Template preset — canonical definition.
 * DP-3.4 trigger + DP-V.2 last-since-last-run via Template config.
 *
 * {{CHAT_DATA}} and {{LAST_RUN_AT_HUMAN}} are substituted by template-dispatch.ts
 * before TemplateExecution dispatch. Placeholders are literal strings; no other template engine.
 * Substitution applies to step.prompt only.
 */
import type { PresetTemplate } from "../types.js";

export const FEATURE_MINING_TEMPLATE: PresetTemplate = {
  presetId: "feature-mining",
  name: "Feature Mining (preset)",
  description:
    "Scans recent chat sessions for unmet user needs and records them as feature_requests.",
  trigger: { type: "manual" },
  steps: [
    {
      id: "mine",
      prompt:
        "Analyze the chat session excerpts below (pre-fetched from sessions modified after {{LAST_RUN_AT_HUMAN}}). " +
        "Identify unmet feature requests and record each via record_feature_request. Return a summary count.\n\n" +
        "=== CHAT EXCERPTS ===\n" +
        "{{CHAT_DATA}}\n" +
        "=== END EXCERPTS ===",
      roleId: "",
    },
  ],
  config: {
    last_run_at: null,
    max_sessions: 15,
    max_messages_per_session: 30,
    message_char_cap: 500,
  },
  boundRolePresetId: "feature-miner",
};
