import { DEFAULT_CONFIG } from "../config/defaults.js";
import { getRuntimeConfig } from "../config/runtime.js";
import { getChannel } from "../store/channels.js";
import { getSession } from "../store/sessions.js";
import { recordAuditDiagnostic } from "../store/audit-diagnostics.js";
import type { ChatSource, NotifyTarget, ViewerKey } from "../shared/types.js";
import { getLogger } from "../lib/logger.js";

const log = getLogger("message-handler");

export function getOwnerViewerKey(): ViewerKey {
  try {
    const configured = getRuntimeConfig().identity?.ownerViewerKey;
    if (typeof configured === "string" && configured.trim().length > 0) {
      return configured;
    }
  } catch {
    // Runtime config is not initialized in some focused tests.
  }
  return DEFAULT_CONFIG.identity?.ownerViewerKey ?? "local-owner";
}

export function resolveViewerKeyForSource(source: ChatSource): ViewerKey | undefined {
  if (source.type === "web" || source.type === "tui" || source.type === "api") {
    return getOwnerViewerKey();
  }

  if (source.type !== "channel" || !source.channelId) {
    log.warn({ source }, "Viewer identity unavailable for chat source");
    safeRecordViewerDiagnostic("chat source has no resolvable viewer identity", undefined);
    return undefined;
  }

  const channel = getChannel(source.channelId);
  const viewerKey = channel?.viewerKey;
  if (typeof viewerKey === "string" && viewerKey.trim().length > 0) {
    return viewerKey;
  }

  log.warn({ channelId: source.channelId }, "Channel viewerKey missing; recent delivery context disabled");
  safeRecordViewerDiagnostic("channel viewerKey missing; recent delivery context disabled", source.channelId);
  return undefined;
}

export function resolveViewerKeyForDeliveryTarget(target: NotifyTarget): ViewerKey | undefined {
  if (target.type === "channel") {
    const channel = getChannel(target.channelId);
    const viewerKey = channel?.viewerKey;
    if (typeof viewerKey === "string" && viewerKey.trim().length > 0) {
      return viewerKey;
    }
    log.warn({ channelId: target.channelId }, "Channel viewerKey missing; ledger recording skipped");
    safeRecordViewerDiagnostic("channel viewerKey missing; ledger recording skipped", target.channelId);
    return undefined;
  }

  const session = getSession(target.sessionId);
  if (!session) {
    log.warn({ sessionId: target.sessionId }, "Session target missing; ledger recording skipped");
    safeRecordViewerDiagnostic("session target missing; ledger recording skipped", target.sessionId);
    return undefined;
  }
  return resolveViewerKeyForSource(session.source);
}

function safeRecordViewerDiagnostic(message: string, sourceId: string | undefined): void {
  try {
    recordAuditDiagnostic({
      source: "viewer_identity",
      severity: "warning",
      sourceId,
      message,
    });
  } catch {
    // Diagnostics must not change runtime behavior.
  }
}
