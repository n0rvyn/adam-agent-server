/**
 * Mistake Digest Template preset — canonical definition.
 * DP-4.5: cron Sunday 08:00 server-local time.
 * DP-4.8: config.delivery_message_type flows to delivery_log.message_type
 *   via TemplateExecutor context.
 * boundRolePresetId resolves at seed/restore time.
 */
import type { PresetTemplate } from "../types.js";

export const MISTAKE_DIGEST_TEMPLATE: PresetTemplate = {
  presetId: "mistake-digest",
  name: "Mistake Digest (preset)",
  description:
    "Weekly cross-role failure digest. Calls aggregate_mistakes and formats patterns for delivery. Configure deliverTo post-seed to enable channel delivery (left empty at seed since per-user channel target is unknown).",
  trigger: { type: "cron", cron: "0 8 * * 0" },
  steps: [
    {
      id: "digest",
      roleId: "",
      prompt:
        "Call aggregate_mistakes with default parameters (window 14 days, all 3 dimensions, minOccurrences 3, minRoles 2). " +
        "Then format the returned patterns as a markdown digest with '# Mistake Digest' as the heading so it self-identifies. " +
        "If no patterns, return 'No mistake patterns this period.'.",
    },
  ],
  config: {
    delivery_message_type: "mistake_digest",
  },
  boundRolePresetId: "mistake-digester",
};
