/**
 * Strategy Engine - Thompson Sampling based strategy selection and evolution.
 *
 * Crystal refs: D-008, D-009, D-010
 * DP-002: Jeffreys prior α=0.5, β=0.5
 */

export { ThompsonSampler } from "./sampler.js";
export { StrategyEngine } from "./engine.js";
export { StrategyGenerator } from "./generator.js";
export { Reflexion } from "./reflexion.js";

// Evaluator (Phase 4)
export {
  MetricTree,
  L3Collector, L2Collector, L1Collector, L0Collector,
  LLMJudge, CalibrationEngine,
  calculateReward, calculateFullReward, evaluate,
} from "./evaluator/index.js";
export type {
  L3Metrics, L2Metrics, L1Metrics, L0Metrics,
  LLMJudgeResult, CalibrationResult, RewardResult,
} from "./evaluator/index.js";
