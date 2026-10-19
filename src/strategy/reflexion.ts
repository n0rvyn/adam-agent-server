import type { Strategy } from "../shared/types.js";
import { StrategyEngine } from "./engine.js";

/**
 * Reflexion - single-task retry with self-reflection.
 * Crystal ref: D-009 (Reflexion retry layer)
 *
 * When a task fails or produces poor results, analyze the failure
 * and generate a retry prompt variant that addresses the issues.
 */
export class Reflexion {
  static analyzeFailure(
    strategy: Strategy,
    _taskPrompt: string,
    error?: string,
    partialResult?: string,
  ): string {
    const reflections: string[] = [];

    if (error) {
      reflections.push(`**Error encountered:** ${error}`);
    }

    if (partialResult) {
      reflections.push(`**Partial result:** ${partialResult.slice(0, 200)}...`);
    }

    const templateIssues = this.analyzeTemplate(strategy.promptTemplate);
    if (templateIssues.length > 0) {
      reflections.push(`**Strategy analysis:** ${templateIssues.join(" ")}`);
    }

    return reflections.join("\n\n");
  }

  static generateRetryPrompt(
    originalPrompt: string,
    reflection: string,
    previousAttempts: number,
  ): string {
    return [
      "**Retry Guidance:**",
      `This is attempt #${previousAttempts + 1}.`,
      "The previous attempt had the following issues:",
      reflection,
      "",
      "**Instructions:**",
      "1. Carefully review the issues above",
      "2. Adjust your approach to address them",
      "3. Pay special attention to areas that failed previously",
      "",
      "**Original Task:**",
      originalPrompt,
    ].join("\n");
  }

  static shouldRetry(reward: number, threshold = 0.5): boolean {
    return reward < threshold;
  }

  /**
   * Calculate adjusted reward for retry consideration.
   * Diminishing returns for later attempts.
   */
  static calculateRetryReward(
    originalReward: number,
    attemptCount: number,
    maxAttempts = 3,
  ): number {
    const attemptPenalty = (attemptCount - 1) / maxAttempts;
    return originalReward * (1 - attemptPenalty * 0.3);
  }

  private static analyzeTemplate(template: string): string[] {
    const issues: string[] = [];
    const lower = template.toLowerCase();

    if (!lower.includes("verify")) {
      issues.push("Strategy may lack verification steps.");
    }
    if (!lower.includes("error") && !lower.includes("fail")) {
      issues.push("Strategy may not handle errors explicitly.");
    }
    if (!lower.includes("test")) {
      issues.push("Strategy may lack testing considerations.");
    }

    return issues;
  }

  static recordRetryAttempt(
    strategyId: string,
    goalId: string,
    taskId: string,
    originalReward: number,
    retryReward: number,
    reflection: string,
  ): void {
    StrategyEngine.recordTrial(
      strategyId,
      goalId,
      taskId,
      retryReward,
      undefined,
      undefined,
      `Retry attempt. Original reward: ${originalReward.toFixed(2)}, Reflection: ${reflection}`,
    );
  }
}
