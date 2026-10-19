import { BUILT_IN_TOOLS } from "./constants.js";

export function getKnownToolNames(): string[] {
  return [...BUILT_IN_TOOLS];
}
