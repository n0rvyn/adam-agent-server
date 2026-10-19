import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const {
  mockGetRuntimeConfig,
  mockAuditLogger,
} = vi.hoisted(() => ({
  mockGetRuntimeConfig: vi.fn(() => ({
    server: { timezone: "system" },
  })),
  mockAuditLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock all dependencies BEFORE importing the module under test
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

vi.mock("../../store/messages.js", () => ({
  findMessageByTaskId: vi.fn(),
  getMessagesBySession: vi.fn(),
}));

vi.mock("../../store/tasks.js", () => ({
  getTask: vi.fn(),
}));

vi.mock("../../store/roles.js", () => ({
  getRole: vi.fn(),
}));

vi.mock("../../store/config.js", () => ({
  getConfigValue: vi.fn(),
}));

vi.mock("../../config/runtime.js", () => ({
  getRuntimeConfig: mockGetRuntimeConfig,
}));

vi.mock("../../lib/logger.js", () => ({
  getLogger: vi.fn(() => mockAuditLogger),
}));

vi.mock("../../lib/llm-eval.js", () => ({
  callClaudeForEvaluation: vi.fn(),
}));

import {
  evaluateIntentFulfillment,
  getIntentEvalStats,
  resetIntentEvalStatsForTests,
} from "../../audit/intent-eval.js";
import { getTask } from "../../store/tasks.js";
import { getRole } from "../../store/roles.js";
import { findMessageByTaskId } from "../../store/messages.js";
import { getConfigValue } from "../../store/config.js";
import { callClaudeForEvaluation } from "../../lib/llm-eval.js";

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  mockGetRuntimeConfig.mockReturnValue({
    server: { timezone: "system" },
  });
  resetIntentEvalStatsForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

function seedHappyPath(configValues: Record<string, unknown> = {}): void {
  (getTask as ReturnType<typeof vi.fn>).mockReturnValue({ id: "t1", result: "the result", prompt: "fallback prompt" });
  (getRole as ReturnType<typeof vi.fn>).mockReturnValue({ id: "r1", name: "TestRole", cagPrompt: "CAG prompt" });
  (findMessageByTaskId as ReturnType<typeof vi.fn>).mockReturnValue(null);
  (getConfigValue as ReturnType<typeof vi.fn>).mockImplementation((key: string) => configValues[key]);
}

describe("audit/intent-eval", () => {
  it("uses fallback defaults when runtime config and persisted config are unset", async () => {
    seedHappyPath();
    mockGetRuntimeConfig.mockReturnValue({ server: { timezone: "system" } });
    (callClaudeForEvaluation as ReturnType<typeof vi.fn>).mockResolvedValue('{"score": 0.8, "reason": "good"}');

    const p = evaluateIntentFulfillment("t1", "r1");
    await vi.advanceTimersByTimeAsync(100);
    const result = await p;

    expect(result).toEqual({ score: 0.8, reason: "good", failed: false });
    expect(callClaudeForEvaluation).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        model: "claude-haiku-4-5-20251001",
        maxBudgetUsd: 1.0,
        maxTurns: 10,
      }),
    );
  });

  it("uses updated persisted budget on the next evaluation without restart", async () => {
    const configValues: Record<string, unknown> = {};
    seedHappyPath(configValues);
    (callClaudeForEvaluation as ReturnType<typeof vi.fn>).mockResolvedValue('{"score": 0.9}');

    const first = evaluateIntentFulfillment("t1", "r1");
    await vi.advanceTimersByTimeAsync(100);
    await first;

    configValues["audit.intentEval.maxBudgetUsd"] = 2.5;
    configValues["audit.intentEval.timeoutMs"] = 45_000;

    const second = evaluateIntentFulfillment("t1", "r1");
    await vi.advanceTimersByTimeAsync(100);
    await second;

    expect(callClaudeForEvaluation).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      expect.objectContaining({
        maxBudgetUsd: 2.5,
      }),
    );
  });

  it("ignores invalid persisted and runtime intent-eval config values", async () => {
    seedHappyPath({
      "audit.intentEval.maxBudgetUsd": "oops",
      "audit.intentEval.timeoutMs": -1,
    });
    mockGetRuntimeConfig.mockReturnValue({
      server: { timezone: "system" },
      audit: {
        intentEval: {
          maxBudgetUsd: 0,
          timeoutMs: 0,
        },
      },
    } as any);
    (callClaudeForEvaluation as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise(() => {}));

    const p = evaluateIntentFulfillment("t1", "r1");

    expect(callClaudeForEvaluation).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        maxBudgetUsd: 1.0,
      }),
    );

    await vi.advanceTimersByTimeAsync(30_001);
    const result = await p;

    expect(result.reason).toBe("eval timeout after 30000ms");
  });

  it("increments degraded counter and logs at error with degraded=true", async () => {
    seedHappyPath();
    (callClaudeForEvaluation as ReturnType<typeof vi.fn>).mockResolvedValue("not json at all");

    const p = evaluateIntentFulfillment("t1", "r1");
    await vi.advanceTimersByTimeAsync(100);
    const result = await p;

    expect(result.score).toBeNull();
    expect(result.failed).toBe(true);
    expect(getIntentEvalStats()).toMatchObject({
      intentEvalDegradedToday: 1,
      intentEvalBudgetUsd: 1.0,
    });
    expect(mockAuditLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "t1",
        roleId: "r1",
        degraded: true,
        err: expect.any(String),
      }),
      "Intent eval failed; degrading to neutral",
    );
  });

  it("resets degraded counter at the same configured timezone boundary used by /stats", async () => {
    seedHappyPath();
    mockGetRuntimeConfig.mockReturnValue({
      server: { timezone: "Asia/Shanghai" },
    });
    (callClaudeForEvaluation as ReturnType<typeof vi.fn>).mockResolvedValue("not json at all");

    vi.setSystemTime(new Date("2026-04-22T15:59:00.000Z"));
    resetIntentEvalStatsForTests();

    const first = evaluateIntentFulfillment("t1", "r1");
    await vi.advanceTimersByTimeAsync(100);
    await first;
    expect(getIntentEvalStats().intentEvalDegradedToday).toBe(1);

    vi.setSystemTime(new Date("2026-04-22T16:01:00.000Z"));
    expect(getIntentEvalStats().intentEvalDegradedToday).toBe(0);

    const second = evaluateIntentFulfillment("t1", "r1");
    await vi.advanceTimersByTimeAsync(100);
    await second;
    expect(getIntentEvalStats().intentEvalDegradedToday).toBe(1);
  });

  it("times out using the resolved runtime timeout", async () => {
    seedHappyPath({
      "audit.intentEval.timeoutMs": 5000,
    });
    (callClaudeForEvaluation as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise(() => {}));

    const p = evaluateIntentFulfillment("t1", "r1");
    await vi.advanceTimersByTimeAsync(5001);
    const result = await p;

    expect(result.score).toBeNull();
    expect(result.failed).toBe(true);
    expect(result.reason).toBe("eval timeout after 5000ms");
  });

  it("does not call the evaluation model when the task is missing", async () => {
    (getTask as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

    const result = await evaluateIntentFulfillment("nonexistent", "r1");

    expect(result.score).toBeNull();
    expect(result.failed).toBe(true);
    expect(callClaudeForEvaluation).not.toHaveBeenCalled();
  });
});
