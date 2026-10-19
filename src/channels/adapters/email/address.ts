import type { Channel } from "../../../shared/types.js";
import type { MailChannelConfig } from "./types.js";
export { isEmailPlatform } from "./types.js";

const SINGLE_ADDRESS_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

export function normalizeEmailAddress(input: string): string {
  if (typeof input !== "string") {
    throw new Error("Email address must be a string");
  }

  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Email address is required");
  }
  if (trimmed.includes(",") || /[<>]/.test(trimmed) || /\s/.test(trimmed)) {
    throw new Error("Email address must contain exactly one mailbox address");
  }
  if (!SINGLE_ADDRESS_RE.test(trimmed)) {
    throw new Error("Email address is invalid");
  }

  const at = trimmed.lastIndexOf("@");
  const local = trimmed.slice(0, at).toLowerCase();
  const domain = trimmed.slice(at + 1).toLowerCase();
  return `${local}@${domain}`;
}

export function parseMailChannelConfig(config: Record<string, unknown>): MailChannelConfig {
  const keys = Object.keys(config);
  if (keys.length !== 1 || !Object.prototype.hasOwnProperty.call(config, "address")) {
    throw new Error("Mail channel config must contain only address");
  }
  const address = config.address;
  if (typeof address !== "string") {
    throw new Error("Mail channel config address must be a string");
  }
  return { address: normalizeEmailAddress(address) };
}

export function getNormalizedMailChannelAddress(channel: Pick<Channel, "config">): string {
  const config = channel.config && typeof channel.config === "object"
    ? channel.config as Record<string, unknown>
    : {};
  return parseMailChannelConfig(config).address;
}

export function formatEmailFromAddress(address: string, displayName?: string): string {
  const normalized = normalizeEmailAddress(address);
  const sanitizedName = (displayName ?? "").replace(/[\r\n]+/g, " ").replace(/"/g, '\\"').trim();
  if (!sanitizedName) return normalized;
  return `"${sanitizedName}" <${normalized}>`;
}
