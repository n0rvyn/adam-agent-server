import type { ChatConfig, DefaultsConfig } from "../shared/types.js";
import { getRuntimeConfig } from "./runtime.js";
import { DEFAULT_CONFIG } from "./defaults.js";

export { loadConfig, loadDefaultConfig } from "./loader.js";
export { DEFAULT_CONFIG } from "./defaults.js";

export function getDefaults(): DefaultsConfig {
  try {
    return getRuntimeConfig().defaults;
  } catch {
    // Runtime config not yet initialized — fall back to defaults
    return DEFAULT_CONFIG.defaults;
  }
}

export function getChatConfig(): ChatConfig {
  try {
    return getRuntimeConfig().chat ?? DEFAULT_CONFIG.chat!;
  } catch {
    return DEFAULT_CONFIG.chat!;
  }
}
