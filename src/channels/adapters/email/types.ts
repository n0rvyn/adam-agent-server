import type { Channel } from "../../../shared/types.js";

export interface MailChannelConfig {
  address: string;
}

export function isEmailPlatform(channel: Pick<Channel, "platform">): boolean {
  return channel.platform === "email";
}
