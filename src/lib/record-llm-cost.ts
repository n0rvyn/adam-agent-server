/**
 * Unified LLM cost write path.
 *
 * This is the ONLY function that writes to the llm_costs table.
 * It expands recompute.perModel[] into per-model rows sharing a call_id,
 * and optionally mirrors the call-level cost to the originating task or
 * chat_messages row.
 *
 * Design: mirror is INDEPENDENT of row insertion (must-revise #2).
 * When mirror !== false, the mirror always runs even when perModel is empty
 * (pricingStatus='none'), so tasks.cost_usd / chat_messages.cost_usd are
 * always kept up-to-date for downstream consumers.
 */

import { randomUUID } from "node:crypto";
import type { CostRecompute } from "./cost-pricing.js";
import { insertLlmCostRows } from "../store/llm-costs.js";
import { updateTask } from "../store/tasks.js";
import { updateMessageCost } from "../store/messages.js";
import { getLogger } from "./logger.js";

export type LlmCostSource = "chat" | "task" | "orchestrator" | "eval";

export interface RecordLlmCostInput {
  source: LlmCostSource;
  recompute: CostRecompute;
  /** Explicit call ID — auto-generated (UUID) when absent. Idempotent via INSERT OR IGNORE. */
  callId?: string;
  roleId?: string;
  taskId?: string;
  sessionId?: string;
  messageId?: string;
  numTurns?: number;
  /** When true (default), mirror call-level cost to the originating task/message row. */
  mirror?: boolean;
}

export interface RecordLlmCostResult {
  callId: string;
  /** Number of llm_costs rows inserted. May be 0 when perModel is empty — mirror still ran. */
  rowsInserted: number;
}

const log = getLogger("store");

/**
 * Record LLM cost into the unified store and optionally mirror to the
 * originating task or chat_messages row.
 *
 * Mirror ordering: mirror runs BEFORE any early return so empty-perModel
 * calls still write the originating row's cost columns (Phase-1 parity).
 */
export async function recordLlmCost(input: RecordLlmCostInput): Promise<RecordLlmCostResult> {
  const {
    source,
    recompute,
    callId: explicitCallId,
    roleId,
    taskId,
    sessionId,
    messageId,
    numTurns,
    mirror = true,
  } = input;

  const callId = explicitCallId ?? randomUUID();
  const now = Date.now();

  // ── Mirror (runs regardless of perModel length) ──────────────────────────
  if (mirror) {
    try {
      if (source === "task" && taskId) {
        // Sum tokens across perModel (0s when empty)
        const inputTokens = recompute.perModel.reduce((s, p) => s + p.inputTokens, 0);
        const outputTokens = recompute.perModel.reduce((s, p) => s + p.outputTokens, 0);
        const cacheReadTokens = recompute.perModel.reduce((s, p) => s + p.cacheReadTokens, 0);
        const cacheCreationTokens = recompute.perModel.reduce((s, p) => s + p.cacheCreationTokens, 0);
        const tokenUsage = {
          input: inputTokens,
          output: outputTokens,
          cacheRead: cacheReadTokens,
          cacheCreation: cacheCreationTokens,
        };
        updateTask(taskId, {
          costUsd: recompute.costUsd,
          tokenUsage,
          ...(numTurns !== undefined ? { numTurns } : {}),
          costBreakdown: recompute,
        });
      } else if (source === "chat" && messageId) {
        const inputTokens = recompute.perModel.reduce((s, p) => s + p.inputTokens, 0);
        const outputTokens = recompute.perModel.reduce((s, p) => s + p.outputTokens, 0);
        const tokenUsage = JSON.stringify({ input: inputTokens, output: outputTokens });
        const model = recompute.perModel[0]?.model ?? "unknown";
        updateMessageCost(messageId, {
          costUsd: recompute.costUsd,
          tokenUsage,
          model,
        });
      }
    } catch (err) {
      log.warn({ err, source, taskId, messageId }, "recordLlmCost mirror write failed");
    }
  }

  // ── Insert per-model rows ─────────────────────────────────────────────────
  if (recompute.perModel.length === 0) {
    return { callId, rowsInserted: 0 };
  }

  const rows = recompute.perModel.map((pm, i) => ({
    id: `${callId}-${i}`,
    callId,
    source,
    model: pm.model,
    roleId,
    taskId,
    sessionId,
    messageId,
    inputTokens: pm.inputTokens,
    outputTokens: pm.outputTokens,
    cacheReadTokens: pm.cacheReadTokens,
    cacheCreationTokens: pm.cacheCreationTokens,
    costUsd: pm.costUsd,
    priced: pm.priced ? 1 : 0,
    estimated: pm.estimated ? 1 : 0,
    sdkTotalCostUsd: recompute.sdkTotalCostUsd,
    numTurns,
    createdAt: now,
  }));

  try {
    insertLlmCostRows(rows);
  } catch (err) {
    log.warn({ err, callId, source }, "recordLlmCost insertLlmCostRows failed");
    return { callId, rowsInserted: 0 };
  }

  return { callId, rowsInserted: rows.length };
}
