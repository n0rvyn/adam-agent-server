import { getGoal } from "../../../store/goals.js";
import { listTrialsByGoal } from "../../../store/trials.js";
import { getTask } from "../../../store/tasks.js";
import type { Goal } from "../../../shared/types.js";

export interface L0Metrics {
  goalId: string;
  metricType: string;
  targetValue: number;
  currentValue: number;
  progressPct: number;
  deadlineRemainingDays: number;
  budgetRemainingPct: number;
  expectedCompletionPct: number;
  rawScore: number;
}

/**
 * L0 Collector - goal-level metrics.
 * Crystal ref: D-012 (L0 = goal metric, monthly)
 */
export class L0Collector {
  static collect(goalId: string): L0Metrics {
    const goal = getGoal(goalId);
    if (!goal) {
      return this.emptyMetrics(goalId);
    }

    const now = Date.now();
    const progressPct = goal.targetValue > 0
      ? Math.min(goal.currentValue / goal.targetValue, 1)
      : 0;

    const deadlineRemainingDays = Math.max(0, (goal.deadline - now) / (1000 * 60 * 60 * 24));

    // Calculate actual budget spent from trials' associated tasks
    const totalSpent = this.calculateBudgetSpent(goalId);
    const budgetRemainingPct = goal.budgetUsd > 0
      ? Math.max(0, 1 - totalSpent / goal.budgetUsd)
      : 1;

    const expectedCompletionPct = this.calculateExpectedCompletion(goal);

    const metrics: L0Metrics = {
      goalId,
      metricType: goal.metricType,
      targetValue: goal.targetValue,
      currentValue: goal.currentValue,
      progressPct,
      deadlineRemainingDays,
      budgetRemainingPct,
      expectedCompletionPct,
      rawScore: 0,
    };

    metrics.rawScore = this.computeRawScore(metrics);
    return metrics;
  }

  /**
   * Compute normalized 0-1 score.
   * 0.5*progressPct + 0.3*expectedCompletionPct + 0.2*budgetRemainingPct
   */
  static computeRawScore(m: L0Metrics): number {
    const progressScore = Math.min(m.progressPct, 1);

    // Expected completion: 1.0 if ahead, 0.5 if on track, 0-0.5 if behind
    let completionScore: number;
    if (m.expectedCompletionPct >= 1.0) {
      completionScore = 1.0;
    } else if (m.expectedCompletionPct >= 0.8) {
      completionScore = 0.5 + (m.expectedCompletionPct - 0.8) * 2.5;
    } else {
      completionScore = m.expectedCompletionPct * 0.625;
    }

    const budgetScore = m.budgetRemainingPct;

    return (
      0.50 * progressScore +
      0.30 * completionScore +
      0.20 * budgetScore
    );
  }

  /**
   * Calculate expected completion ratio: progress% / time%.
   * >1.0 = ahead of schedule, 1.0 = on track, <1.0 = behind.
   */
  static calculateExpectedCompletion(goal: Goal): number {
    const now = Date.now();
    const totalTime = goal.deadline - goal.createdAt;
    const elapsedTime = now - goal.createdAt;

    if (totalTime <= 0) return 0;

    const timePct = elapsedTime / totalTime;

    if (timePct < 0.1) return 0.5; // insufficient data

    const progressPct = goal.targetValue > 0
      ? goal.currentValue / goal.targetValue
      : 0;

    return timePct > 0 ? progressPct / timePct : 0;
  }

  /**
   * Sum costUsd from tasks associated with this goal via trials table.
   */
  private static calculateBudgetSpent(goalId: string): number {
    const trials = listTrialsByGoal(goalId, 1000);
    let totalSpent = 0;
    const seenTasks = new Set<string>();

    for (const trial of trials) {
      if (trial.taskId && !seenTasks.has(trial.taskId)) {
        seenTasks.add(trial.taskId);
        const task = getTask(trial.taskId);
        if (task?.costUsd) {
          totalSpent += task.costUsd;
        }
      }
    }

    return totalSpent;
  }

  private static emptyMetrics(goalId: string): L0Metrics {
    return {
      goalId,
      metricType: "",
      targetValue: 0,
      currentValue: 0,
      progressPct: 0,
      deadlineRemainingDays: 0,
      budgetRemainingPct: 0,
      expectedCompletionPct: 0,
      rawScore: 0,
    };
  }
}
