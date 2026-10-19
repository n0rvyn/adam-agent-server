import { v4 as uuidv4 } from "uuid";
import { getDb } from "../store/db.js";
import { listRuntimeEffectsByTrace } from "../store/runtime-effects.js";
import { getUnsupportedMutationText } from "../chat/commitment-replacement-text.js";
import type { AssistantCommitmentAuditResult, RuntimeEffect } from "../shared/types.js";
import type { CommitmentLocale } from "../chat/commitment-detector.js";

interface CommitmentClaim {
  claimType: string;
  claimText: string;
  requiredCategories: string[];
  locale: CommitmentLocale;
}

export interface AuditAssistantCommitmentArgs {
  text: string;
  traceId?: string;
  sessionId?: string;
  messageId?: string;
}

export function auditAssistantCommitment(args: AuditAssistantCommitmentArgs): AssistantCommitmentAuditResult {
  const claims = detectCommitmentClaims(args.text);
  if (claims.length === 0) {
    return { status: "passed" };
  }

  const effects = args.traceId ? listRuntimeEffectsByTrace(args.traceId) : [];
  const evidenceIds = new Set<string>();
  const missing: string[] = [];

  for (const claim of claims) {
    const evidence = effects.find((effect) => effectMatchesClaim(effect, claim));
    if (evidence) {
      evidenceIds.add(evidence.id);
    } else {
      missing.push(`${claim.claimType}:${claim.requiredCategories.join("|")}`);
    }
  }

  const status = missing.length === 0 ? "passed" : "blocked";
  const claimText = claims.map((claim) => claim.claimText).join("\n");
  const claimType = claims.map((claim) => claim.claimType).join(",");
  const reason = status === "blocked"
    ? `Missing trace-scoped runtime effect evidence for ${missing.join(", ")}`
    : undefined;
  const evidenceEffectIds = [...evidenceIds];

  recordAssistantCommitmentAudit({
    traceId: args.traceId,
    sessionId: args.sessionId,
    messageId: args.messageId,
    status,
    claimType,
    claimText,
    evidenceEffectIds,
    reason,
  });

  return {
    status,
    claimType,
    claimText,
    evidenceEffectIds,
    reason,
    replacementText: status === "blocked" ? getUnsupportedMutationText(claims[0].locale) : undefined,
  };
}

export function detectCommitmentClaims(text: string): CommitmentClaim[] {
  const locale = inferLocale(text);
  const normalized = text.toLowerCase();
  const hasCommittedVerb =
    /已(记录|更新|修改|保存|安排|取消|开始执行)/.test(text)
    || /(changed|updated|recorded|saved|scheduled|cancelled|canceled|started)/i.test(text)
    || text.includes("下次")
    || text.includes("以后默认");

  if (!hasCommittedVerb) return [];

  const claims: CommitmentClaim[] = [];
  const add = (claimType: string, requiredCategories: string[]) => {
    claims.push({ claimType, claimText: text, requiredCategories, locale });
  };

  if (/已取消|cancelled|canceled/.test(normalized) || text.includes("已取消")) {
    add("task_cancelled", ["task_cancelled"]);
  }
  if (/已安排|scheduled/.test(normalized) || text.includes("下次") || text.includes("半小时后")) {
    add("task_scheduled", ["task_scheduled"]);
  }
  if (/已开始执行|started/.test(normalized)) {
    add("template_execution_started", ["template_execution_started"]);
  }
  if (/以后默认|默认|config|配置/.test(normalized)) {
    add("config_update", ["config_update"]);
  }
  if (/背景音乐|音量|template|模板|step|步骤/.test(normalized)) {
    add("template_update", ["template_update", "config_update"]);
  }
  if (/goal|目标/.test(normalized)) {
    add("goal_update", ["goal_update"]);
  }
  if (/role|角色/.test(normalized)) {
    add("role_update", ["role_update"]);
  }
  if (/delivery rule|投递规则|通知规则/.test(normalized)) {
    add("delivery_rule_update", ["delivery_rule_update"]);
  }

  if (claims.length === 0) {
    add("generic_mutation", ["template_update", "config_update", "goal_update", "role_update", "delivery_rule_update"]);
  }

  return claims;
}

function inferLocale(text: string): CommitmentLocale {
  const cjkCount = (text.match(/[一-鿿]/g) ?? []).length;
  return cjkCount / Math.max(text.length, 1) > 0.3 ? "zh" : "en";
}

function effectMatchesClaim(effect: RuntimeEffect, claim: CommitmentClaim): boolean {
  return claim.requiredCategories.includes(effect.effectCategory);
}

function recordAssistantCommitmentAudit(args: {
  traceId?: string;
  sessionId?: string;
  messageId?: string;
  status: "passed" | "blocked";
  claimType: string;
  claimText: string;
  evidenceEffectIds: string[];
  reason?: string;
}): void {
  getDb().prepare(`
    INSERT INTO assistant_commitment_audits (
      id, trace_id, session_id, message_id, status, claim_type,
      claim_text, evidence_effect_ids, created_at, reason
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    uuidv4(),
    args.traceId ?? null,
    args.sessionId ?? null,
    args.messageId ?? null,
    args.status,
    args.claimType,
    args.claimText,
    JSON.stringify(args.evidenceEffectIds),
    Date.now(),
    args.reason ?? null,
  );
}

export function listAssistantCommitmentAudits(traceId?: string) {
  const rows = traceId
    ? getDb().prepare("SELECT * FROM assistant_commitment_audits WHERE trace_id = ? ORDER BY created_at ASC").all(traceId)
    : getDb().prepare("SELECT * FROM assistant_commitment_audits ORDER BY created_at ASC").all();
  return rows as Array<Record<string, unknown>>;
}
