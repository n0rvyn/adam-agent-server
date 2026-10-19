/**
 * reflection.ts — Phase 1 rewrite + Phase 5 cleanup
 *
 * The legacy export surface (getImportanceCounter, setImportanceCounter,
 * decrementImportanceCounter, runReflection, onMemoryCreated) was removed in Phase 5.
 *
 * Active pipeline: runReflectionForRole()
 *   - Reads recent high-importance observations
 *   - Calls Haiku to propose structured belief candidates
 *   - Resolves conflicts against existing beliefs via conflict-resolver
 *   - Writes new beliefs to the beliefs table
 */

import { getLogger } from "../lib/logger.js";
import { listMemoriesByRole } from "../store/memories.js";
import { createBelief, listBeliefsByRole, markBeliefSuperseded, searchBeliefsByVector } from "../store/beliefs.js";
import { generateEmbedding } from "../lib/embedding.js";
import { callClaudeForEvaluation } from "../lib/llm-eval.js";
import { getRuntimeConfig } from "../config/runtime.js";
import { createEvolutionAudit } from "../store/evolution-audit.js";
import { getCurrentTraceId } from "../lib/trace-context.js";
import { v4 as uuidv4 } from "uuid";
import { resolveBeliefConflict } from "./conflict-resolver.js";
import { resolveReflectionBudgetUsd } from "./reflection-budget.js";
import { serverBus } from "../server/events/server-bus.js";
import { getRoleTaskSeq } from "../store/roles.js";
import { getDb } from "../store/db.js";
import type { Belief, MemoryNode } from "../shared/types.js";

const log = getLogger("manager");

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface BeliefCandidate {
  content: string;
  evidence_indices: number[];
}

// ---------------------------------------------------------------------------
// parseCandidates — exported for unit testing
// ---------------------------------------------------------------------------

export function parseCandidates(raw: string): BeliefCandidate[] {
  let s = raw.trim();
  // Strip code fences
  const fenceMatch = s.match(/^```(\w*)\s*/);
  if (fenceMatch) s = s.slice(fenceMatch[0].length);
  if (s.endsWith("```")) s = s.slice(0, s.length - 3);
  s = s.trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(s);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) return [];

  return (parsed as unknown[])
    .filter((item): item is Record<string, unknown> =>
      item !== null && typeof item === "object"
    )
    .map((item) => {
      const content = typeof item.content === "string" ? item.content.trim() : "";
      if (!content) return null;

      const evidence_indices = Array.isArray(item.evidence_indices)
        ? (item.evidence_indices as unknown[]).filter((v) => Number.isInteger(v)).map(Number)
        : [];

      return { content, evidence_indices };
    })
    .filter((item): item is BeliefCandidate => item !== null && item.content.length > 0);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function proposeBeliefCandidates(
  roleId: string,
  recent: MemoryNode[],
): Promise<BeliefCandidate[]> {
  const cfg = getRuntimeConfig();
  const haikuModel = cfg.anthropic?.defaultHaikuModel || "claude-haiku-4-5";

  const observations = recent.slice(0, 30);
  const obsBlock = observations
    .map((m, i) => `${i}. (importance:${m.importance}) ${m.content}`)
    .join("\n");

  const prompt = `Below are recent observations from agent ${roleId}. Extract 1 to 4 structured beliefs a future task would benefit from knowing. Each belief should be a single concrete actionable sentence, NOT a count or summary statistic. Cite which observation indices support each belief. Return ONLY a JSON array on one line. Each item: {"content": "<belief>", "evidence_indices": [<int>, ...]}. Example: [{"content":"TTS audio must pass an audibility check before delivery","evidence_indices":[2,5]}]

Observations:
${obsBlock}`;

  try {
    const result = await callClaudeForEvaluation(prompt, {
      systemPrompt: "You output exactly one JSON array of belief candidates. No prose. No code fences.",
      model: haikuModel,
      maxBudgetUsd: resolveReflectionBudgetUsd(),
      maxTurns: 10,
    });
    const candidates = parseCandidates(result);
    log.info(
      {
        roleId,
        rawLen: result.length,
        rawHead: result.slice(0, 400),
        rawTail: result.length > 400 ? result.slice(-200) : "",
        parsedCount: candidates.length,
      },
      "reflection_haiku_result",
    );
    return candidates;
  } catch (err) {
    log.warn({ err, roleId }, "reflection_haiku_failed");
    serverBus.emit({
      type: "log_event",
      timestamp: Date.now(),
      level: "warn",
      component: "reflection",
      msg: "reflection_haiku_failed",
      metadata: { roleId, err: String(err) },
    });
    return [];
  }
}

// ---------------------------------------------------------------------------
// runReflectionForRole — new active pipeline
// ---------------------------------------------------------------------------

export async function runReflectionForRole(roleId: string): Promise<{ written: number }> {
  // v90: early-exit for prediction-only owners (e.g. show-level owner like
  // 'podcast-show'). Predictions are the belief-ledger's job; they have no
  // observations, so reflection would write 0 anyway. Skip the Haiku call
  // entirely and leave prediction rows untouched.
  const anyPredictionRow = getDb()
    .prepare("SELECT 1 as one FROM beliefs WHERE role_id = ? AND kind = 'prediction' LIMIT 1")
    .get(roleId);
  const hasBehaviorRow = getDb()
    .prepare("SELECT 1 as one FROM beliefs WHERE role_id = ? AND kind = 'behavior' LIMIT 1")
    .get(roleId);
  if (anyPredictionRow && !hasBehaviorRow) {
    log.info({ roleId, reason: "prediction_only_owner" }, "reflection_skipped");
    try {
      createEvolutionAudit({
        timestamp: Date.now(),
        oldRules: "",
        newRules: `reflection: skipped (prediction-only owner)`,
        diff: `written=0,reason=prediction_only_owner`,
        roleId,
        source: "reflection",
      });
    } catch {
      // audit failure is non-fatal
    }
    return { written: 0 };
  }

  // Throttle gate (Task 5): skip reflection when active belief pool is saturated.
  // Pool max defaults to 100 — hot-reloadable via memory.scope.reflectionPoolMax.
  const poolMax = (getRuntimeConfig().memory?.scope as { reflectionPoolMax?: number } | undefined)?.reflectionPoolMax ?? 100;
  const activeCount = listBeliefsByRole(roleId, { onlyActive: true }).length;
  if (activeCount > poolMax) {
    log.info({ roleId, activeCount, poolMax, reason: "pool_throttled" }, "reflection_skipped");
    try {
      createEvolutionAudit({
        timestamp: Date.now(),
        oldRules: "",
        newRules: `reflection: skipped (pool ${activeCount} > ${poolMax})`,
        diff: `written=0,reason=pool_throttled`,
        roleId,
        source: "reflection",
      });
    } catch {
      // audit failure is non-fatal
    }
    return { written: 0 };
  }

  // Fetch a wide window then filter by importance. The downstream slice in
  // proposeBeliefCandidates caps the actual Haiku prompt at 30 observations,
  // so the only cost of a larger window is one extra SQLite scan per cycle.
  // 50 was too narrow: roles whose recent activity skews low-importance (e.g.
  // routine tool-call observations) ended up sending ≤ 1 observation to Haiku,
  // which then correctly returned [] for lack of pattern.
  const RECENT_OBS_LIMIT = 500;
  const MIN_IMPORTANCE_FOR_REFLECTION = 3;
  const NEIGHBOR_TOPK = 5;

  const recent = listMemoriesByRole(roleId, RECENT_OBS_LIMIT, 0)
    .filter((m) => m.importance >= MIN_IMPORTANCE_FOR_REFLECTION);

  if (recent.length === 0) {
    log.info({ roleId, written: 0, reason: "no_recent_observations" }, "reflection_completed");
    return { written: 0 };
  }

  const candidates = await proposeBeliefCandidates(roleId, recent);
  if (candidates.length === 0) {
    log.info(
      { roleId, written: 0, recentCount: recent.length, reason: "no_candidates_parsed" },
      "reflection_completed",
    );
    return { written: 0 };
  }

  // v81: all reflection candidates go into the role-level pool as 'active' status (no TTL, no expires_at)
  // Bug #3 fix: use undefined scope so beliefs are role-wide (not pinned to ::pool niche).
  // v82 normalized all legacy ::pool data; injection filter is single-path (null only).
  const candidateScopeKey: string | undefined = undefined;

  let written = 0;
  let skippedNoEvidence = 0;

  for (const candidate of candidates) {
    // Bug #2 fix: read task_seq per-candidate so a concurrent task completion doesn't leave
    // beliefs written later in this loop with a stale clock.
    const roleTaskSeq = getRoleTaskSeq(roleId);
    // Resolve evidence indices back to memory IDs
    const resolvedIds = candidate.evidence_indices
      .filter((idx) => idx >= 0 && idx < recent.length)
      .map((idx) => recent[idx].id);

    if (resolvedIds.length === 0) {
      skippedNoEvidence++;
      log.debug(
        {
          roleId,
          content: candidate.content.slice(0, 120),
          evidenceIndices: candidate.evidence_indices,
          recentRange: [0, recent.length - 1],
        },
        "reflection_candidate_skipped_empty_evidence",
      );
      continue;
    }

    // Generate embedding (optional)
    let embedding: Float32Array | undefined;
    try {
      embedding = await generateEmbedding(candidate.content);
    } catch (err) {
      log.debug({ roleId, err: (err as Error).message }, "reflection_embedding_failed");
    }

    // Find neighboring beliefs for conflict resolution
    let neighbors: Belief[] = [];
    if (embedding) {
      neighbors = searchBeliefsByVector(roleId, embedding, NEIGHBOR_TOPK).map((r) => r.node);
    } else {
      neighbors = listBeliefsByRole(roleId).slice(0, NEIGHBOR_TOPK);
    }

    const verdict = await resolveBeliefConflict({ content: candidate.content }, neighbors);
    const now = Date.now();

    if (verdict.action === "coexist") {
      createBelief({
        id: uuidv4(),
        roleId,
        content: candidate.content,
        isAnti: false,
        evidenceObsIds: resolvedIds,
        embedding,
        createdAt: now,
        lastUsedAt: roleTaskSeq, // Bug #2 fix: use task_seq (not ms timestamp)
        lastValidatedAt: now,
        scopeKey: candidateScopeKey,
        status: "active",
        injectCount: 0,
      });
      written++;
    } else if (verdict.action === "merge") {
      const target = neighbors.find((n) => n.id === verdict.intoBeliefId);
      if (!target) {
        skippedNoEvidence++;
        continue;
      }
      const mergedId = uuidv4();
      // v82 normalized all ::pool scope_key to NULL; merged beliefs always write role-wide (undefined).
      createBelief({
        id: mergedId,
        roleId,
        content: verdict.mergedContent,
        isAnti: false,
        evidenceObsIds: [...target.evidenceObsIds, ...resolvedIds],
        embedding,
        createdAt: now,
        lastUsedAt: roleTaskSeq, // Bug #2 fix: use task_seq (not ms timestamp)
        lastValidatedAt: now,
        scopeKey: undefined,
        status: "active",
        injectCount: 0,
      });
      markBeliefSuperseded(target.id, mergedId);
      written++;
    } else if (verdict.action === "supersede") {
      const target = neighbors.find((n) => n.id === verdict.oldBeliefId);
      if (!target) {
        skippedNoEvidence++;
        continue;
      }
      const newId = uuidv4();
      createBelief({
        id: newId,
        roleId,
        content: candidate.content,
        isAnti: false,
        evidenceObsIds: resolvedIds,
        embedding,
        createdAt: now,
        lastUsedAt: roleTaskSeq, // Bug #2 fix: use task_seq (not ms timestamp)
        lastValidatedAt: now,
        scopeKey: candidateScopeKey,
        status: "active",
        injectCount: 0,
      });
      markBeliefSuperseded(target.id, newId);
      written++;
    }
  }

  // Record in evolution_audit (best-effort)
  try {
    createEvolutionAudit({
      timestamp: Date.now(),
      oldRules: "",
      newRules: `reflection: wrote ${written} belief(s) for role ${roleId}`,
      diff: `written=${written}`,
      roleId,
      source: "reflection",
      traceId: getCurrentTraceId(),
    });
  } catch {
    // Audit failure is non-fatal
  }

  log.info(
    {
      roleId,
      written,
      observed: recent.length,
      candidatesCount: candidates.length,
      skippedNoEvidence,
    },
    "reflection_completed",
  );
  return { written };
}
