import { v4 as uuidv4 } from "uuid";
import { serverBus } from "../server/events/server-bus.js";
import { createMessage } from "../store/messages.js";
import type { ChatMessage, ChatEnvelopeKind } from "../shared/types.js";
import * as sessionManager from "./session-manager.js";

export async function deliverAssistantMessageToSession(args: {
  sessionId: string;
  content: string;
  taskId?: string;
  kind?: ChatEnvelopeKind;
}): Promise<boolean> {
  const session = sessionManager.getSession(args.sessionId);
  if (!session) return false;

  const message: ChatMessage = {
    id: uuidv4(),
    sessionId: args.sessionId,
    role: "assistant",
    content: args.content,
    source: session.source,
    taskId: args.taskId,
    kind: args.kind,
    createdAt: Date.now(),
  };
  createMessage(message);
  sessionManager.incrementMessageCount(args.sessionId);
  serverBus.emit({ type: "chat_message", sessionId: args.sessionId, message });
  return true;
}
