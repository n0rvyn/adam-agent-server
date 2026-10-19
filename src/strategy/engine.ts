import { v4 as uuidv4 } from "uuid";
import type { Strategy } from "../shared/types.js";
import {
  createStrategy,
  getStrategy,
  listStrategiesByTaskType,
  betaUpdate,
} from "../store/strategies.js";
import { createTrial } from "../store/trials.js";
import { ThompsonSampler } from "./sampler.js";
import { calculateReward } from "./evaluator/reward.js";

const MIN_STRATEGIES = 5;
const MAX_STRATEGIES = 20;
const JEFFREYS_PRIOR = 0.5;

/**
 * Strategy Engine - manages strategy population per (roleId, task_type).
 * Crystal ref: D-010
 *
 * - Select strategy via Thompson Sampling
 * - Maintain population bounds (5-20 per roleId/task_type)
 * - Update Beta distribution after trial
 * - Trigger evolution when population needs new variants
 */
export class StrategyEngine {
  static selectStrategy(roleId: string, taskType: string): Strategy | null {
    const strategies = listStrategiesByTaskType(roleId, taskType);
    return ThompsonSampler.sample(strategies);
  }

  /**
   * Record a trial result and update Beta distribution.
   * alpha += reward, beta += (1 - reward)
   */
  static recordTrial(
    strategyId: string,
    goalId: string,
    taskId: string | undefined,
    reward: number,
    metricL2Score?: number,
    metricL3Score?: number,
    context?: string,
  ): void {
    betaUpdate(strategyId, reward);

    createTrial({
      id: uuidv4(),
      strategyId,
      goalId,
      taskId,
      reward,
      metricL2Score,
      metricL3Score,
      context,
      completedAt: Date.now(),
    });
  }

  static getStrategies(roleId: string, taskType: string): Strategy[] {
    return listStrategiesByTaskType(roleId, taskType);
  }

  static getStrategyById(id: string): Strategy | undefined {
    return getStrategy(id);
  }

  static getPopulationStats(roleId: string, taskType: string): {
    count: number;
    avgTrials: number;
    avgReward: number;
    minTrials: number;
    maxTrials: number;
  } {
    const strategies = listStrategiesByTaskType(roleId, taskType);

    if (strategies.length === 0) {
      return { count: 0, avgTrials: 0, avgReward: 0, minTrials: 0, maxTrials: 0 };
    }

    const totalTrials = strategies.reduce((sum, s) => sum + s.totalTrials, 0);
    const avgTrials = totalTrials / strategies.length;

    const rewards = strategies.filter((s) => s.avgReward !== undefined).map((s) => s.avgReward!);
    const avgReward = rewards.length > 0
      ? rewards.reduce((a, b) => a + b, 0) / rewards.length
      : 0;

    return {
      count: strategies.length,
      avgTrials,
      avgReward,
      minTrials: Math.min(...strategies.map((s) => s.totalTrials)),
      maxTrials: Math.max(...strategies.map((s) => s.totalTrials)),
    };
  }

  static shouldEvolve(roleId: string, taskType: string): boolean {
    const stats = this.getPopulationStats(roleId, taskType);

    if (stats.count < MIN_STRATEGIES) {
      return true;
    }

    return stats.count < MAX_STRATEGIES && stats.maxTrials > 0;
  }

  /**
   * Add a new strategy to the population.
   * Enforces MAX_STRATEGIES ceiling (crystal D-010).
   * Uses Jeffreys prior (DP-002).
   */
  static addStrategy(
    roleId: string,
    taskType: string,
    name: string,
    promptTemplate: string,
  ): Strategy {
    const existing = listStrategiesByTaskType(roleId, taskType);
    if (existing.length >= MAX_STRATEGIES) {
      throw new Error(`Strategy population at maximum (${MAX_STRATEGIES}) for ${roleId}/${taskType}`);
    }

    const strategy: Strategy = {
      id: `strat-${uuidv4().slice(0, 8)}`,
      roleId,
      taskType,
      name,
      promptTemplate,
      alpha: JEFFREYS_PRIOR,
      beta: JEFFREYS_PRIOR,
      totalTrials: 0,
      createdAt: Date.now(),
    };

    createStrategy(strategy);
    return strategy;
  }

  /**
   * Get top-K performing strategies by average reward.
   */
  static getTopStrategies(roleId: string, taskType: string, k = 3): Strategy[] {
    const strategies = listStrategiesByTaskType(roleId, taskType);
    const tried = strategies.filter((s) => s.totalTrials > 0);
    tried.sort((a, b) => (b.avgReward ?? 0) - (a.avgReward ?? 0));
    return tried.slice(0, k);
  }

  static getSamplingProbabilities(roleId: string, taskType: string): Map<string, number> {
    const strategies = listStrategiesByTaskType(roleId, taskType);
    return ThompsonSampler.getProbabilities(strategies);
  }

  /**
   * Evaluate a task using the Evaluator and record the trial.
   * Does NOT modify recordTrial — existing callers (Reflexion) continue to pass explicit reward.
   */
  static evaluateAndRecord(
    strategyId: string,
    goalId: string,
    taskId: string | undefined,
    metricL2Score?: number,
    metricL3Score?: number,
    context?: string,
  ): number {
    const result = calculateReward(goalId, taskId);
    this.recordTrial(strategyId, goalId, taskId, result.reward, metricL2Score, metricL3Score, context);
    return result.reward;
  }
}
