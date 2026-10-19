import { L3Collector } from "./collectors/l3-collector.js";
import { L0Collector } from "./collectors/l0-collector.js";
import { LLMJudge } from "./collectors/llm-judge.js";
import { MetricTree } from "./metric-tree.js";
import type { MetricLevel } from "../../shared/types.js";
import { getLogger } from "../../lib/logger.js";

const log = getLogger("agent");

export interface RewardResult {
  goalId: string;
  taskId?: string;
  reward: number;
  breakdown: Record<MetricLevel, number> & { llmJudge?: number };
  calibrationFactors: Record<MetricLevel, number>;
  source: "objective" | "llm_judge" | "external_api" | "fallback";
  confidence: number;
  computedAt: number;
}

/**
 * Calculate reward for a task within a goal context.
 * Uses MetricTree with calibration factors (D-013).
 * DP-005: Hybrid — objective if available, LLM-as-Judge fallback.
 * D-014: Objective > External API (stubbed) > LLM-as-Judge.
 */
export function calculateReward(goalId: string, taskId?: string): RewardResult {
  const now = Date.now();

  // Build MetricTree to respect calibration factors
  const tree = MetricTree.buildFromGoal(goalId);
  const scores = new Map<string, number>();

  // Collect L0 always
  const l0 = L0Collector.collect(goalId);
  for (const node of tree.queryPath("L0")) {
    scores.set(node.id, l0.rawScore);
  }

  // Extract calibration factors from tree nodes
  const calibrationFactors = extractCalibrationFactors(tree);

  // Try objective L3 first
  if (taskId) {
    const l3 = L3Collector.collect(taskId, goalId);
    if (l3.isComplete) {
      for (const node of tree.queryPath("L3")) {
        scores.set(node.id, l3.rawScore);
      }

      const reward = tree.getNodeCount() > 0
        ? tree.getWeightedScore(scores)
        : Math.max(0, Math.min(1, l3.rawScore * 0.65 + l0.rawScore * 0.35));

      return {
        goalId,
        taskId,
        reward,
        breakdown: { L0: l0.rawScore, L1: 0, L2: 0, L3: l3.rawScore },
        calibrationFactors,
        source: "objective",
        confidence: 0.9,
        computedAt: now,
      };
    }
  }

  // External API tier wired in async evaluate() below (requires await)
  // Fallback to LLM-as-Judge (D-014 tier 3)
  if (taskId) {
    const shouldUseObjective = LLMJudge.shouldUseObjective(taskId);
    if (!shouldUseObjective) {
      // Use LLM Judge placeholder (heuristic in Phase 4, real LLM in Phase 5)
      const llmResult = LLMJudge.evaluate(taskId, "general_quality");

      // LLMJudge.evaluate returns a Promise but is sync in Phase 4 placeholder
      // Use L0 as baseline, blend with LLM confidence-weighted score
      const reward = l0.rawScore * 0.5 + 0.5 * 0.5; // conservative fallback

      return {
        goalId,
        taskId,
        reward: l0.rawScore,
        breakdown: { L0: l0.rawScore, L1: 0, L2: 0, L3: 0, llmJudge: 0.5 },
        calibrationFactors,
        source: "llm_judge",
        confidence: 0.4,
        computedAt: now,
      };
    }
  }

  // No task or pure goal-level evaluation
  const reward = tree.getNodeCount() > 0
    ? tree.getWeightedScore(scores)
    : l0.rawScore;

  return {
    goalId,
    reward,
    breakdown: { L0: l0.rawScore, L1: 0, L2: 0, L3: 0 },
    calibrationFactors,
    source: "fallback",
    confidence: 0.3,
    computedAt: now,
  };
}

/**
 * Calculate full multi-level reward using MetricTree.
 * Used for periodic evaluation with all levels populated.
 */
export function calculateFullReward(
  goalId: string,
  scores: Map<string, number>,
): RewardResult {
  const tree = MetricTree.buildFromGoal(goalId);
  const reward = tree.getWeightedScore(scores);

  const breakdown: Record<MetricLevel, number> = {
    L0: tree.aggregateScores("L0", scores),
    L1: tree.aggregateScores("L1", scores),
    L2: tree.aggregateScores("L2", scores),
    L3: tree.aggregateScores("L3", scores),
  };

  const calibrationFactors = extractCalibrationFactors(tree);

  return {
    goalId,
    reward,
    breakdown,
    calibrationFactors,
    source: "objective",
    confidence: 0.85,
    computedAt: Date.now(),
  };
}

/**
 * Async evaluate function implementing the hybrid cascade (D-014).
 * Objective > External API (stubbed) > LLM-as-Judge.
 */
export async function evaluate(taskId: string, goalId: string, criteria?: string): Promise<RewardResult> {
  const now = Date.now();
  const tree = MetricTree.buildFromGoal(goalId);
  const calibrationFactors = extractCalibrationFactors(tree);

  // 1. Try objective L3
  const l3 = L3Collector.collect(taskId, goalId);
  const l0 = L0Collector.collect(goalId);

  if (l3.isComplete) {
    const scores = new Map<string, number>();
    for (const node of tree.queryPath("L0")) scores.set(node.id, l0.rawScore);
    for (const node of tree.queryPath("L3")) scores.set(node.id, l3.rawScore);

    const reward = tree.getNodeCount() > 0 ? tree.getWeightedScore(scores) : l3.rawScore * 0.65 + l0.rawScore * 0.35;

    return {
      goalId, taskId, reward,
      breakdown: { L0: l0.rawScore, L1: 0, L2: 0, L3: l3.rawScore },
      calibrationFactors, source: "objective", confidence: 0.9, computedAt: now,
    };
  }

  // 2. External API tier (D-014 tier 2)
  try {
    const { collectExternalApiScores } = await import("./collectors/external-api.js");
    const externalResult = await collectExternalApiScores(goalId);
    if (externalResult.scores.length > 0) {
      const avgExternal = externalResult.scores.reduce((sum, s) => sum + s.score, 0) / externalResult.scores.length;
      const reward = Math.max(0, Math.min(1, l0.rawScore * 0.4 + avgExternal * 0.6));
      return {
        goalId, taskId, reward,
        breakdown: { L0: l0.rawScore, L1: 0, L2: avgExternal, L3: 0 },
        calibrationFactors, source: "external_api", confidence: 0.85, computedAt: now,
      };
    }
    if (externalResult.errors.length > 0) {
      log.warn({ goalId, errors: externalResult.errors }, "External API errors, falling through to LLM Judge");
    }
  } catch (err) {
    log.warn({ goalId, error: err }, "External API failed, falling through to LLM Judge");
  }

  // 3. LLM-as-Judge fallback
  const llmResult = await LLMJudge.evaluate(taskId, criteria ?? "general_quality");
  const reward = llmResult.score * llmResult.confidence + l0.rawScore * (1 - llmResult.confidence);

  return {
    goalId, taskId, reward,
    breakdown: { L0: l0.rawScore, L1: 0, L2: 0, L3: 0, llmJudge: llmResult.score },
    calibrationFactors, source: "llm_judge", confidence: llmResult.confidence, computedAt: now,
  };
}

function extractCalibrationFactors(tree: MetricTree): Record<MetricLevel, number> {
  const factors: Record<MetricLevel, number> = { L0: 1.0, L1: 1.0, L2: 1.0, L3: 1.0 };
  for (const level of ["L0", "L1", "L2", "L3"] as MetricLevel[]) {
    const nodes = tree.queryPath(level);
    if (nodes.length > 0) {
      factors[level] = nodes[0].calibrationFactor;
    }
  }
  return factors;
}
