import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export interface EmailGatewayState {
  uidValidity?: number;
  lastUid: number;
  seenMessageIds: string[];
  sentMessageIds: string[];
  updatedAt: number;
}

const DEFAULT_STATE: EmailGatewayState = {
  lastUid: 0,
  seenMessageIds: [],
  sentMessageIds: [],
  updatedAt: 0,
};

export function getEmailGatewayStatePath(root = process.env.ADAM_TEST_DIR ?? join(homedir(), ".adam")): string {
  return join(root, "email-gateway", "state.json");
}

export function loadEmailGatewayState(path = getEmailGatewayStatePath()): EmailGatewayState {
  if (!existsSync(path)) return { ...DEFAULT_STATE };
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<EmailGatewayState>;
  return {
    uidValidity: parsed.uidValidity,
    lastUid: Number.isInteger(parsed.lastUid) ? parsed.lastUid! : 0,
    seenMessageIds: Array.isArray(parsed.seenMessageIds) ? parsed.seenMessageIds.filter(isString) : [],
    sentMessageIds: Array.isArray(parsed.sentMessageIds) ? parsed.sentMessageIds.filter(isString) : [],
    updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
  };
}

export function saveEmailGatewayState(state: EmailGatewayState, path = getEmailGatewayStatePath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ ...state, updatedAt: Date.now() }, null, 2), "utf-8");
}

export function addSeenMessageId(state: EmailGatewayState, messageId: string | undefined): EmailGatewayState {
  const normalized = normalizeMessageId(messageId);
  if (!normalized) return state;
  return {
    ...state,
    seenMessageIds: state.seenMessageIds.includes(normalized)
      ? state.seenMessageIds
      : [...state.seenMessageIds, normalized],
  };
}

export function addSentMessageId(state: EmailGatewayState, messageId: string | undefined): EmailGatewayState {
  const normalized = normalizeMessageId(messageId);
  if (!normalized) return state;
  return {
    ...state,
    sentMessageIds: state.sentMessageIds.includes(normalized)
      ? state.sentMessageIds
      : [...state.sentMessageIds, normalized],
  };
}

export function recordSeenMessageId(messageId: string, path = getEmailGatewayStatePath()): EmailGatewayState {
  const state = addSeenMessageId(loadEmailGatewayState(path), messageId);
  saveEmailGatewayState(state, path);
  return state;
}

export function recordSentMessageId(messageId: string, path = getEmailGatewayStatePath()): EmailGatewayState {
  const state = recordSentMessageIdInState(messageId, path);
  return state;
}

export function recordSentMessageIdInState(messageId: string | undefined, path = getEmailGatewayStatePath()): EmailGatewayState {
  const state = addSentMessageId(loadEmailGatewayState(path), messageId);
  saveEmailGatewayState(state, path);
  return state;
}

export function normalizeMessageId(messageId: string | undefined): string {
  return typeof messageId === "string" ? messageId.trim() : "";
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}
