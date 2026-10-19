import { getDb } from "../store/db.js";
import { findRecentDeliveryEvidence } from "../store/assistant-delivery-commitments.js";
import { getLatestDeliveryForContext } from "../store/delivery-log.js";
import type { CommitmentDetection } from "../chat/commitment-detector.js";
import type { DeliveryLogEntry, UserVisibleEvent } from "../shared/types.js";
import { maybeBuildLatestAttempt } from "./delivery-evidence-row-builder.js";

export interface DeliveryEvidenceQuery {
  traceId?: string;
  sessionId?: string;
  taskId?: string;
}

export interface NormalizedDeliveryEvidence {
  source: "assistant_delivery_commitments" | "delivery_log" | "user_visible_events";
  target?: unknown;
  taskId?: string;
  messageType?: string;
  attachmentCount: number;
  status: "delivered" | "failed";
  timestamp: number;
}

export function resolveEvidenceForDeliveryClaim(
  claim: CommitmentDetection,
  query: DeliveryEvidenceQuery,
): NormalizedDeliveryEvidence[] {
  const specific = claim.hasCount || !!claim.artifactExpectation?.kind;
  const requiredStatus = claim.type === "delivery_failure_claim" ? "failed" : "delivered";
  const evidence: NormalizedDeliveryEvidence[] = [];

  evidence.push(...commitmentEvidence(query, requiredStatus, claim));
  if (requiredStatus === "delivered") {
    evidence.push(...userVisibleAttachmentEvidence(query, claim));
  }
  if (!specific) {
    evidence.push(...deliveryLogEvidence(query, requiredStatus));
  }

  return evidence.filter((item) => item.status === requiredStatus && evidenceMeetsClaim(item, claim));
}

function commitmentEvidence(
  query: DeliveryEvidenceQuery,
  status: "delivered" | "failed",
  claim: CommitmentDetection,
): NormalizedDeliveryEvidence[] {
  const rows = findRecentDeliveryEvidence({
    traceId: query.traceId,
    sessionId: query.sessionId,
    taskId: query.taskId,
    status: status === "delivered" ? "fulfilled" : "failed",
    limit: 20,
  });
  return rows.map((row) => ({
    source: "assistant_delivery_commitments" as const,
    target: row.target,
    taskId: row.taskId,
    messageType: row.commitmentType,
    attachmentCount: row.evidence?.length ?? row.artifactExpectation?.count ?? 0,
    status,
    timestamp: row.fulfilledAt ?? row.updatedAt,
  })).filter((item) => evidenceMeetsClaim(item, claim));
}

function userVisibleAttachmentEvidence(
  query: DeliveryEvidenceQuery,
  claim: CommitmentDetection,
): NormalizedDeliveryEvidence[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (query.traceId) {
    clauses.push("trace_id = ?");
    params.push(query.traceId);
  }
  if (query.taskId) {
    clauses.push("task_id = ?");
    params.push(query.taskId);
  }
  if (clauses.length === 0) return [];

  const rows = getDb().prepare(`
    SELECT * FROM user_visible_events
    WHERE ${clauses.join(" AND ")}
    ORDER BY last_delivered_at DESC
    LIMIT 20
  `).all(...params) as Array<UserVisibleEvent & {
    attachments_json?: string;
    targets_json?: string;
    last_delivered_at?: number;
    message_type?: string;
    task_id?: string;
  }>;

  return rows.map((row) => ({
    source: "user_visible_events" as const,
    target: parseJsonArray(row.targets_json)[0],
    taskId: row.task_id ?? row.taskId,
    messageType: row.message_type ?? row.messageType,
    attachmentCount: parseJsonArray(row.attachments_json).length,
    status: "delivered" as const,
    timestamp: row.last_delivered_at ?? row.lastDeliveredAt ?? Date.now(),
  })).filter((item) => evidenceMeetsClaim(item, claim));
}

function deliveryLogEvidence(
  query: DeliveryEvidenceQuery,
  status: "delivered" | "failed",
): NormalizedDeliveryEvidence[] {
  const clauses = ["status = ?"];
  const params: unknown[] = [status];
  if (query.traceId) {
    clauses.push("trace_id = ?");
    params.push(query.traceId);
  }
  if (query.taskId) {
    clauses.push("task_id = ?");
    params.push(query.taskId);
  }
  if (!query.traceId && !query.taskId) return [];
  const rows = getDb().prepare(`
    SELECT * FROM delivery_log
    WHERE ${clauses.join(" AND ")}
    ORDER BY created_at DESC
    LIMIT 20
  `).all(...params) as Array<DeliveryLogEntry & {
    target?: string;
    task_id?: string;
    message_type?: string;
    created_at?: number;
    delivered_at?: number;
  }>;
  return rows.map((row) => ({
    source: "delivery_log" as const,
    target: typeof row.target === "string" ? parseJson(row.target) : row.target,
    taskId: row.task_id ?? row.taskId,
    messageType: row.message_type ?? row.messageType,
    attachmentCount: 0,
    status,
    timestamp: row.delivered_at ?? row.deliveredAt ?? row.created_at ?? row.createdAt,
  }));
}

function evidenceMeetsClaim(evidence: NormalizedDeliveryEvidence, claim: CommitmentDetection): boolean {
  const expectedCount = claim.artifactExpectation?.count;
  if (!expectedCount) return true;
  return evidence.attachmentCount >= expectedCount;
}

function parseJson(value: string | undefined): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function parseJsonArray(value: string | undefined): unknown[] {
  const parsed = parseJson(value);
  return Array.isArray(parsed) ? parsed : [];
}

export interface DeliveryDiagnosticContext {
  /** Most recent delivery_log row matching the query, or null if none. */
  latestAttempt: {
    status: "pending" | "delivered" | "failed" | "expired";
    target: { type: "channel"; channelId: string; chatId?: string; platform?: string } | { type: "webhook"; webhookUrl: string } | undefined;
    messageType?: string;
    error?: string;
    /** When the rule queued it. */
    createdAt: number;
    /** When it was actually delivered (only set on delivered). */
    deliveredAt?: number;
    /** Optional queue depth at the channel (for channels with queueing like iLink). */
    queueDepth?: number;
    /** Optional hours until quota resets (for quota-exhausted channels). */
    quotaResetHours?: number;
  } | null;
  /** artifactKind from the detected commitment, normalized to a localized noun. */
  artifactKindLabel: string;
}

const ARTIFACT_KIND_LABELS: Record<string, Record<"zh" | "en", string>> = {
  image: { zh: "图片", en: "image" },
  audio: { zh: "音频", en: "audio" },
  video: { zh: "视频", en: "video" },
  file: { zh: "文件", en: "file" },
  document: { zh: "文件", en: "file" },
};

function resolveArtifactKindLabel(kind: string | undefined, locale: "zh" | "en"): string {
  if (!kind) return locale === "zh" ? "结果" : "result";
  const entry = ARTIFACT_KIND_LABELS[kind];
  return entry ? entry[locale] : locale === "zh" ? "结果" : "result";
}

export function resolveDeliveryDiagnosticContext(
  claim: CommitmentDetection,
  query: DeliveryEvidenceQuery,
): DeliveryDiagnosticContext {
  const latestAttempt = maybeBuildLatestAttempt(
    getLatestDeliveryForContext({ taskId: query.taskId, traceId: query.traceId }),
  );

  return {
    latestAttempt,
    artifactKindLabel: resolveArtifactKindLabel(claim.artifactExpectation?.kind, claim.locale),
  };
}
