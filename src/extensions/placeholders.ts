/**
 * Placeholder substitution for .mcpb extension config values.
 *
 * Supported tokens (Phase 1 — static only):
 *   ${HOME}              — replaced with ctx.HOME
 *   ${__dirname}         — replaced with ctx.__dirname
 *   ${user_config.KEY}   — replaced with ctx.user_config[KEY] (throws if missing)
 *
 * Unrecognised tokens (e.g. ${UNRECOGNIZED}) are left verbatim.
 */

export class UnresolvedPlaceholderError extends Error {
  constructor(public readonly key: string) {
    super(`Unresolved placeholder: \${user_config.${key}}`);
    this.name = "UnresolvedPlaceholderError";
  }
}

export interface PlaceholderContext {
  HOME?: string;
  __dirname?: string;
  user_config?: Record<string, string | number | boolean>;
}

const PLACEHOLDER_RE = /\$\{(HOME|__dirname|user_config\.([a-zA-Z_][a-zA-Z0-9_]*))\}/g;

/**
 * Replace placeholder tokens in a single string value.
 * Throws UnresolvedPlaceholderError if a user_config key is referenced but not present in ctx.
 */
export function substitutePlaceholders(input: string, ctx: PlaceholderContext): string {
  return input.replace(PLACEHOLDER_RE, (_match, token: string, userConfigKey?: string) => {
    if (token === "HOME") {
      return ctx.HOME ?? _match;
    }
    if (token === "__dirname") {
      return ctx.__dirname ?? _match;
    }
    // user_config.KEY
    if (userConfigKey !== undefined) {
      const configMap = ctx.user_config ?? {};
      if (!(userConfigKey in configMap)) {
        throw new UnresolvedPlaceholderError(userConfigKey);
      }
      return String(configMap[userConfigKey]);
    }
    return _match;
  });
}

/**
 * Walk the string leaves of an env-record object, applying substitutePlaceholders to each value.
 */
export function substitutePlaceholdersDeep(
  obj: Record<string, string>,
  ctx: PlaceholderContext,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj)) {
    result[key] = substitutePlaceholders(value, ctx);
  }
  return result;
}
