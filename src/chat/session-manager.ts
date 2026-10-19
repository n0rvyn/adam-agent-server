import { v4 as uuidv4 } from "uuid";
import type { ChatSession, ChatSessionStatus, ChatSource } from "../shared/types.js";
import * as sessionStore from "../store/sessions.js";
export { updateSessionSdkId } from "../store/sessions.js";
import { deleteMessagesBySession } from "../store/messages.js";
import { serverBus } from "../server/events/server-bus.js";
import { getChatConfig } from "../config/index.js";
import { processSessionArchive } from "../agent/session-memory-extractor.js";

const activeSessions = new Map<string, ChatSession>();
let timeoutInterval: ReturnType<typeof setInterval> | undefined;

function getSourceKey(source: ChatSource): string {
  return `${source.type}:${source.channelId ?? ""}:${source.chatId ?? ""}`;
}

export function warmCache(): void {
  activeSessions.clear();
  const sessions = sessionStore.listSessions("active", 1000);
  for (const session of sessions) {
    activeSessions.set(session.id, session);
  }
}

export function createSession(source: ChatSource, _roleId?: string): ChatSession {
  const now = Date.now();
  const session: ChatSession = {
    id: uuidv4(),
    status: "active",
    source,
    createdAt: now,
    lastActiveAt: now,
    messageCount: 0,
  };

  sessionStore.createSession(session);
  activeSessions.set(session.id, session);
  serverBus.emit({ type: "session_created", session });
  return session;
}

export function getActiveSession(source: ChatSource): ChatSession | undefined {
  // Check cache first
  for (const session of activeSessions.values()) {
    if (getSourceKey(session.source) === getSourceKey(source)) {
      return session;
    }
  }
  // Fallback to DB
  const session = sessionStore.findSessionBySource(source);
  if (session) {
    activeSessions.set(session.id, session);
  }
  return session;
}

export function getSession(id: string): ChatSession | undefined {
  const cached = activeSessions.get(id);
  if (cached) return cached;
  return sessionStore.getSession(id);
}

export function archiveSession(id: string): void {
  const now = Date.now();
  sessionStore.updateSession(id, { status: "archived", archivedAt: now });

  // Extract memories if config flag is enabled
  // Per D-026: chat session memories go under the "chat-manager" role.
  // Pass roleId = undefined so memories use the chat-manager role (set via hooks context).
  const config = getChatConfig();
  if (config.archiveExtractMemory) {
    const session = sessionStore.getSession(id);
    if (session) {
      void processSessionArchive(id, "role-chat-manager").catch(() => {
        // Memory extraction failure is non-fatal
      });
    }
  }

  activeSessions.delete(id);
  serverBus.emit({ type: "session_archived", sessionId: id });
}

export function restoreSession(id: string): ChatSession | undefined {
  sessionStore.updateSession(id, { status: "active", archivedAt: undefined });
  const session = sessionStore.getSession(id);
  if (session) {
    activeSessions.set(session.id, session);
    serverBus.emit({ type: "session_restored", session });
  }
  return session;
}

export function deleteSession(id: string): void {
  deleteMessagesBySession(id);
  sessionStore.deleteSession(id);
  activeSessions.delete(id);
  serverBus.emit({ type: "session_deleted", sessionId: id });
}

export function touchSession(id: string): void {
  const now = Date.now();
  sessionStore.updateSession(id, { lastActiveAt: now });
  const cached = activeSessions.get(id);
  if (cached) {
    cached.lastActiveAt = now;
  }
}

export function incrementMessageCount(id: string): void {
  const session = getSession(id);
  if (session) {
    const newCount = session.messageCount + 1;
    sessionStore.updateSession(id, { messageCount: newCount });
    const cached = activeSessions.get(id);
    if (cached) {
      cached.messageCount = newCount;
    }
  }
}

export function listSessions(status?: ChatSessionStatus): ChatSession[] {
  return sessionStore.listSessions(status);
}

// Timeout poller

function checkTimeouts(): void {
  const config = getChatConfig();
  const timeoutMs = config.sessionTimeoutMinutes * 60 * 1000;
  const now = Date.now();

  for (const session of activeSessions.values()) {
    if (now - session.lastActiveAt > timeoutMs) {
      try {
        archiveSession(session.id);
      } catch {
        // Prevent one failed archive from stopping the poller
      }
    }
  }
}

export function startTimeoutPoller(intervalMs = 60_000): void {
  stopTimeoutPoller();
  timeoutInterval = setInterval(checkTimeouts, intervalMs);
}

export function stopTimeoutPoller(): void {
  if (timeoutInterval) {
    clearInterval(timeoutInterval);
    timeoutInterval = undefined;
  }
}

export function getTimeoutPollerInterval(): ReturnType<typeof setInterval> | undefined {
  return timeoutInterval;
}

// Initialization and shutdown

export function initSessionManager(): void {
  warmCache();
  startTimeoutPoller();
}

export function shutdownSessionManager(): void {
  stopTimeoutPoller();
  activeSessions.clear();
}

// For testing: reset internal state
export function _resetForTest(): void {
  stopTimeoutPoller();
  activeSessions.clear();
}
