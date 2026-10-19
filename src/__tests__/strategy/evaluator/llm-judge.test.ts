import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../../helpers/test-db.js";

const { cleanup } = setupTestDb();
vi.mock("../../../store/db.js", () => ({ getDb: () => getTestDb(), closeDb: () => {} }));

// Mock the shared llm-eval utility (path: src/__tests__/strategy/evaluator/ -> src/lib/llm-eval.js)
const { mockCallClaude } = vi.hoisted(() => ({ mockCallClaude: vi.fn() }));
vi.mock("../../../lib/llm-eval.js", () => ({
  callClaudeForEvaluation: mockCallClaude,
}));

import { LLMJudge } from "../../../strategy/evaluator/collectors/llm-judge.js";
import { createTask } from "../../../store/tasks.js";
import type { Task } from "../../../shared/types.js";

afterAll(() => cleanup());
beforeEach(() => { clearTestDb(); LLMJudge.clearCache(); mockCallClaude.mockClear(); });

function seedTask(overrides: Partial<Task> = {}): void {
  createTask({
    id: "task-1", status: "completed", prompt: "test",
    config: { timeout: 600, approvalRequired: [], approvalTimeout: 300 },
    createdAt: Date.now(), result: "Task completed successfully",
    costUsd: 0.5, numTurns: 10, ...overrides,
  } as any);
}

describe("LLMJudge", () => {
  it("returns score and confidence from mocked LLM API", async () => {
    mockCallClaude.mockResolvedValueOnce(
      JSON.stringify({ score: 0.85, confidence: 0.9, reasoning: "Task completed well" }),
    );
    seedTask();
    const result = await LLMJudge.evaluate("task-1", "code_quality");
    expect(result.score).toBe(0.85);
    expect(result.confidence).toBe(0.9);
    expect(result.reasoning).toBe("Task completed well");
    expect(mockCallClaude).toHaveBeenCalled();
  });

  it("falls back to heuristic when callClaudeForEvaluation throws", async () => {
    mockCallClaude.mockRejectedValueOnce(new Error("API unavailable"));
    seedTask();
    const result = await LLMJudge.evaluate("task-1", "quality");
    expect(result.score).toBeLessThanOrEqual(0.7);
    expect(result.reasoning).toContain("heuristic fallback");
  });

  it("returns low score for failed task via heuristic fallback", async () => {
    mockCallClaude.mockRejectedValueOnce(new Error("API unavailable"));
    seedTask({ id: "task-1", status: "failed", error: "compilation error" });
    const result = await LLMJudge.evaluate("task-1", "code_quality");
    expect(result.score).toBeLessThanOrEqual(0.1);
    expect(result.reasoning).toContain("Task failed");
  });

  it("caches results", async () => {
    mockCallClaude.mockResolvedValueOnce(
      JSON.stringify({ score: 0.75, confidence: 0.8, reasoning: "Cached" }),
    );
    seedTask();
    const r1 = await LLMJudge.evaluate("task-1", "quality");
    const r2 = await LLMJudge.evaluate("task-1", "quality");
    expect(r1.evaluatedAt).toBe(r2.evaluatedAt);
    expect(mockCallClaude).toHaveBeenCalledTimes(1);
  });

  it("shouldUseObjective returns true for complete task with cost", () => {
    seedTask();
    expect(LLMJudge.shouldUseObjective("task-1")).toBe(true);
  });

  it("shouldUseObjective returns false for non-existent task", () => {
    expect(LLMJudge.shouldUseObjective("nonexistent")).toBe(false);
  });

  it("generates prompt template", () => {
    const prompt = LLMJudge.getPromptTemplate("Do X", "Result Y", "quality");
    expect(prompt).toContain("Do X");
    expect(prompt).toContain("Result Y");
    expect(prompt).toContain("quality");
  });
});
