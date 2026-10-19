import type { Channel, ChatSession } from "../shared/types.js";
import { getLogger } from "../lib/logger.js";
import { normalizeEmailAddress } from "./adapters/email/address.js";

const log = getLogger("channels");

export function getDefaultChatIdForChannel(channel: Channel, sessions: ChatSession[] = []): string | undefined {
  if (channel.platform === "email") {
    try {
      return normalizeEmailAddress(String(channel.config.address ?? ""));
    } catch (error) {
      log.warn({ channelId: channel.id, error }, "Invalid Mail channel address for target resolution");
      return undefined;
    }
  }

  const session = sessions.find((candidate) =>
    candidate.source.type === "channel" && candidate.source.channelId === channel.id && candidate.source.chatId,
  );
  if (session?.source.chatId) return session.source.chatId;

  const userId = channel.config.userId;
  return typeof userId === "string" && userId.trim().length > 0 ? userId : undefined;
}
