import type { Role, TaskConfig, EffortTier } from "../shared/types.js";
import { getRuntimeConfig } from "../config/runtime.js";

export interface ResolvedTierModel {
  model: string | undefined;
  fallbackModel: string | undefined;
}

/**
 * Resolve the effective model and fallback model for a task execution.
 *
 * Resolution order (DP-B1 B):
 *   1. task.config.effortTier (override) → config.anthropic.default{Haiku|Sonnet|Opus}Model
 *   2. role.effortTier → config.anthropic.default{Haiku|Sonnet|Opus}Model
 *   3. role.model (explicit string) → use as-is; no fallback
 *   4. else → undefined (SDK uses its own default)
 *
 * Fallback selection (DP-B6):
 *   high → defaultSonnetModel
 *   medium → defaultHaikuModel
 *   low → undefined (already lowest tier)
 *
 * Returns undefined for empty-string config values so the SDK falls through to its default.
 */
export function resolveTierModel(
  taskConfig: TaskConfig | undefined,
  role: Role | undefined,
): ResolvedTierModel {
  const tier: EffortTier | undefined = taskConfig?.effortTier ?? role?.effortTier;
  if (tier) {
    const cfg = getRuntimeConfig().anthropic ?? {};
    const tierToConfigKey: Record<EffortTier, "defaultHaikuModel" | "defaultSonnetModel" | "defaultOpusModel"> = {
      low: "defaultHaikuModel",
      medium: "defaultSonnetModel",
      high: "defaultOpusModel",
    };
    const tierToFallbackKey: Record<EffortTier, "defaultHaikuModel" | "defaultSonnetModel" | undefined> = {
      low: undefined,
      medium: "defaultHaikuModel",
      high: "defaultSonnetModel",
    };
    const model = nonEmpty(cfg[tierToConfigKey[tier]] as string | undefined);
    const fbKey = tierToFallbackKey[tier];
    const rawFallback = fbKey ? nonEmpty(cfg[fbKey] as string | undefined) : undefined;
    // The SDK rejects a fallbackModel equal to the main model at query().initialize()
    // ("Fallback model cannot be the same as the main model"), which kills the session
    // before any request. When the tier config maps both keys to the same model (e.g. all
    // tiers point at one model), drop the fallback so the session initializes normally.
    const fallbackModel = rawFallback && rawFallback !== model ? rawFallback : undefined;
    return { model, fallbackModel };
  }
  return { model: nonEmpty(role?.model), fallbackModel: undefined };
}

function nonEmpty(v: string | undefined): string | undefined {
  const trimmed = v?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}
