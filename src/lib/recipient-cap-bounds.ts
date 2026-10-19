export const MIN_REASONABLE_CAP_BYTES = 1_048_576;       // 1 MB
export const MAX_REASONABLE_CAP_BYTES = 209_715_200;     // 200 MB
export const DEFAULT_EMAIL_CAP_BYTES = 20_971_520;       // 20 MB conservative default
export const RECIPIENT_DOMAIN_REGEX = /^[a-z0-9.-]+$/;   // lowercase + digits + dot/hyphen only; blocks JSON-path injection from forged bounces
