import type { Channel } from "../shared/types.js";

/**
 * Channel config secret-redaction boundary (issue #181).
 *
 * `Channel.config` is an open `Record<string, unknown>` bag whose shape varies per
 * platform (WeChat botToken, Slack signingSecret/appToken, Discord/Telegram botToken,
 * openclaw token, …). Several internal consumers — channel adapters, the delivery
 * engine, viewer-identity resolution — legitimately need the raw secret values, so the
 * store getters (`getChannel`/`listChannels`) MUST keep returning raw config.
 *
 * Redaction therefore lives at the API serialization boundary, not in the store: every
 * REST route that returns a channel to a client wraps it in `toPublicChannel`.
 *
 * ⚠️ SECURITY INVARIANT — single source of truth for "what is a secret":
 * `SECRET_KEY_PATTERN` below is the ONLY thing that decides whether a config key is
 * masked. Any NEW credential-bearing config key (on any platform, present or future)
 * MUST match this pattern, or it will leak in plaintext through `GET /channels`.
 * When adding a platform with a differently-named secret (e.g. a connection string /
 * dsn carrying inline auth), extend this pattern in the same change.
 */

/** Placeholder returned in place of a secret config value at API read boundaries. */
export const REDACTED_SECRET = "__redacted__";

/**
 * Matches config keys that carry credentials. Case-insensitive substring match so it
 * catches camelCase and snake_case variants: botToken, signingSecret, appToken, token,
 * apiKey, api_key, password, accessKey, clientSecret, webhookSecret, privateKey, …
 * Deliberately does NOT match identifiers that are not secrets: accountId, userId,
 * baseUrl, smtpHost, address, routeTag, cdnBaseUrl.
 */
const SECRET_KEY_PATTERN = /token|secret|password|passwd|api[-_]?key|credential|private[-_]?key|access[-_]?key/i;

/** True when a config key name indicates it holds a credential that must not be exposed. */
export function isSecretConfigKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

/**
 * Returns a copy of `config` with secret values replaced by {@link REDACTED_SECRET}.
 * Only non-empty string secrets are masked: an empty/absent value is left as-is so the
 * UI can still show "not configured" rather than a false "configured" placeholder.
 */
export function redactChannelConfig(
  config: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!config) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (isSecretConfigKey(key) && typeof value === "string" && value.length > 0) {
      out[key] = REDACTED_SECRET;
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Returns a copy of `channel` safe to send to an API/UI client (secrets redacted). */
export function toPublicChannel(channel: Channel): Channel {
  return { ...channel, config: redactChannelConfig(channel.config) };
}

/**
 * Reconciles an incoming config update (e.g. from a PATCH whose edit form was populated
 * from a redacted GET) against the currently-stored config:
 *   - a value equal to {@link REDACTED_SECRET} means "unchanged" → restore the real
 *     stored value so the secret is not clobbered by the placeholder;
 *   - if no prior value exists for that key, drop the placeholder rather than persist it;
 *   - any other value is a genuine user edit and is kept as-is.
 */
export function mergeRedactedConfig(
  incoming: Record<string, unknown>,
  existing: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...incoming };
  for (const [key, value] of Object.entries(incoming)) {
    if (value === REDACTED_SECRET) {
      if (existing && key in existing) {
        out[key] = existing[key];
      } else {
        delete out[key];
      }
    }
  }
  return out;
}
