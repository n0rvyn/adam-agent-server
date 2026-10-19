import { getTask } from "../../../store/tasks.js";
import { getLogger } from "../../../lib/logger.js";
import { callClaudeForEvaluation } from "../../../lib/llm-eval.js";

const log = getLogger("agent");

export interface LLMJudgeResult {
  taskId: string;
  criteria: string;
  score: number;
  confidence: number;
  reasoning: string;
  evaluatedAt: number;
}

export interface EvaluationCriteria {
  name: string;
  description: string;
  weight: number;
}

/**
 * LLM-as-Judge Collector.
 * Crystal ref: D-014 (fallback when objective metrics unavailable)
 * DP-005: Hybrid evaluator
 *
 * Uses Claude API for real LLM evaluation with heuristic fallback on API failure.
 */
export class LLMJudge {
  private static cache = new Map<string, LLMJudgeResult>();
  private static CACHE_TTL = 24 * 60 * 60 * 1000; // 24h

  private static async callClaude(prompt: string): Promise<{
    score: number;
    confidence: number;
    reasoning: string;
  }> {
    const systemPrompt = "You are an AI quality evaluator. Respond with JSON: {\"score\": 0-1, \"confidence\": 0-1, \"reasoning\": \"...\"}";
    const result = await callClaudeForEvaluation(prompt, systemPrompt);

    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("Failed to parse LLM Judge response as JSON");
    }

    const parsed = JSON.parse(jsonMatch[0]) as { score: number; confidence: number; reasoning: string };
    return {
      score: Math.max(0, Math.min(1, parsed.score ?? 0)),
      confidence: Math.max(0.3, Math.min(0.95, parsed.confidence ?? 0.5)),
      reasoning: parsed.reasoning ?? "No reasoning provided",
    };
  }

  static async evaluate(taskId: string, criteria: string): Promise<LLMJudgeResult> {
    const cacheKey = `${taskId}:${criteria}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.evaluatedAt < this.CACHE_TTL) {
      return cached;
    }

    const task = getTask(taskId);

    if (!task) {
      const result: LLMJudgeResult = {
        taskId,
        criteria,
        score: 0,
        confidence: 0.3,
        reasoning: "Task not found",
        evaluatedAt: Date.now(),
      };
      this.cache.set(cacheKey, result);
      return result;
    }

    const prompt = this.getPromptTemplate(
      task.prompt ?? "",
      task.result ?? task.error ?? "",
      criteria,
    );

    let score: number;
    let confidence: number;
    let reasoning: string;

    try {
      const llmResult = await this.callClaude(prompt);
      score = llmResult.score;
      confidence = llmResult.confidence;
      reasoning = llmResult.reasoning;
    } catch (err) {
      log.warn({ error: err, taskId }, "LLM Judge Claude API call failed, using heuristic fallback");
      if (task.status === "failed") {
        score = 0.1;
        confidence = 0.6;
        reasoning = `Task failed: ${task.error ?? "unknown error"} (heuristic fallback)`;
      } else if (task.status === "completed" && task.result) {
        score = 0.7;
        confidence = 0.5;
        reasoning = "Task completed with result (heuristic fallback due to API error)";
      } else if (task.status === "completed") {
        score = 0.5;
        confidence = 0.4;
        reasoning = "Task completed without explicit result (heuristic fallback)";
      } else {
        score = 0.3;
        confidence = 0.3;
        reasoning = `Task in status: ${task.status} (heuristic fallback)`;
      }
    }

    const result: LLMJudgeResult = {
      taskId,
      criteria,
      score,
      confidence,
      reasoning,
      evaluatedAt: Date.now(),
    };

    this.cache.set(cacheKey, result);
    return result;
  }

  static shouldUseObjective(taskId: string): boolean {
    const task = getTask(taskId);
    if (!task) return false;

    return (
      task.status === "completed" &&
      task.costUsd !== undefined &&
      task.numTurns !== undefined
    );
  }

  static clearCache(): void {
    this.cache.clear();
  }

  static getPromptTemplate(taskPrompt: string, taskResult: string, criteria: string): string {
    return `You are an expert evaluator. Evaluate the following task result against these criteria:

Task: ${taskPrompt}
Result: ${taskResult}
Criteria: ${criteria}

Provide:
1. Score (0-1): How well did the task meet the criteria?
2. Confidence (0-1): How confident are you in this evaluation?
3. Reasoning: Brief explanation of your scoring

Respond in JSON: {"score": number, "confidence": number, "reasoning": "string"}`;
  }
}
