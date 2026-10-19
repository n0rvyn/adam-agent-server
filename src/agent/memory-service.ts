import {
  searchHybrid,
  DEFAULT_HYBRID_CONFIG,
  calculateSmallvilleScore,
  getRoleScoringWeights,
  DEFAULT_SCORING_WEIGHTS,
  updateMemoryRetrievalCount,
  type HybridSearchConfig,
} from "../store/memories.js";
import { generateEmbedding, EMBEDDING_DIMENSION } from "../lib/embedding.js";
import type { MemoryNode } from "../shared/types.js";
import { selectInjectionBeliefs, formatInjectionContext } from "./belief-injection.js";

export interface QueryMemoryOptions {
  topK?: number;
  hybridConfig?: HybridSearchConfig;
}

export interface ScoredMemory extends MemoryNode {
  score: number;
}

/**
 * Query agent's memory stream with hybrid search + Smallville scoring.
 *
 * Flow:
 * 1. Generate embedding for query
 * 2. Hybrid search — returns candidates with combinedRelevance already
 *    carrying magnitude-preserving cosine + BM25 signal (GAP-10)
 * 3. Apply Smallville scoring (relevance × recency × importance) + retrieval bonus
 * 4. Return top-K sorted by combined score
 */
export async function queryMemory(
  roleId: string | undefined,
  prompt: string,
  options: QueryMemoryOptions = {},
): Promise<ScoredMemory[]> {
  const topK = options.topK ?? 10;
  const hybridConfig = options.hybridConfig ?? DEFAULT_HYBRID_CONFIG;

  let queryEmbedding: Float32Array | undefined;
  try {
    queryEmbedding = await generateEmbedding(prompt);
  } catch {
    // Embedding unavailable; fall through to BM25-only search
  }

  // Hybrid search: vector + BM25 (roleId undefined = cross-role)
  // When embedding is unavailable, pass zero vector — searchHybrid will still run BM25
  // excludeSuperseded: true to filter out memories superseded by newer reflections
  const fallbackEmbedding = queryEmbedding ?? new Float32Array(EMBEDDING_DIMENSION);
  const candidates = searchHybrid(
    roleId,
    fallbackEmbedding,
    prompt,
    topK * 2,
    hybridConfig,
    { excludeSuperseded: true },
  );

  // Get per-role scoring weights (use defaults for cross-role)
  const weights = roleId ? getRoleScoringWeights(roleId) : DEFAULT_SCORING_WEIGHTS;

  // Apply Smallville scoring + retrieval frequency bonus (GAP-10, GAP-12).
  // Use combinedRelevance from searchHybrid directly — it already merges
  // cosine + BM25 magnitudes, so no second cosine pass is needed.
  const scored: ScoredMemory[] = candidates.map(({ node, combinedRelevance }) => {
    // Add retrieval frequency bonus (frequently accessed = proven useful)
    const retrievalBonus = Math.min(0.3, (node.retrievedCount ?? 0) * 0.05);

    const score = calculateSmallvilleScore(
      node.createdAt,
      combinedRelevance,
      node.importance,
      weights,
    ) + retrievalBonus;

    return { ...node, score };
  });

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // Take top-K and update retrieval counts
  const results = scored.slice(0, topK);
  for (const mem of results) {
    updateMemoryRetrievalCount(mem.id);
  }

  return results;
}

/**
 * Get relevant memory context formatted for prompt injection (belief-based).
 * Thin wrapper over selectInjectionBeliefs + formatInjectionContext.
 * Preserves the existing string-return signature for backward compatibility.
 */
export async function getRelevantMemoryContext(
  prompt: string,
  roleId?: string,
  _topK: number = 5,
  _maxTokens?: number,
): Promise<string> {
  if (!roleId) return "";
  try {
    let embedding: Float32Array | undefined;
    try {
      embedding = await generateEmbedding(prompt);
    } catch {
      // Embedding unavailable — fall through to recency-based selection
    }
    const beliefs = await selectInjectionBeliefs(roleId, undefined, embedding);
    return formatInjectionContext(beliefs, "initial");
  } catch {
    return "";
  }
}

/**
 * Query memories filtered by tier. Used for proactive injection (semantic only)
 * vs on-demand retrieval (all tiers via search_memories tool).
 */
export async function queryMemoryByTier(
  roleId: string | undefined,
  prompt: string,
  tiers: string[],
  options: QueryMemoryOptions = {},
): Promise<ScoredMemory[]> {
  const all = await queryMemory(roleId, prompt, options);
  return all.filter((m) => tiers.includes(m.tier ?? "episodic"));
}

