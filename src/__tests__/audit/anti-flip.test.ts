import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type BetterSqlite3 from "better-sqlite3";

vi.mock("../../store/db.js");

vi.mock("../../config/runtime.js", () => ({
  getRuntimeConfig: () => ({
    memory: {
      midTaskInjection: { enabled: false, toolCallThreshold: 10, cooldownMs: 60_000, topK: 3, maxTokens: 1000 },
      globalBudgetTokens: 1500,
      retrievalDecayDays: 30,
      attributionThresholds: { high: 0.7, low: 0.4 },
      antiFlipMinUses: 5,
      antiFlipSuccessEmaThreshold: 0.25,
    },
    anthropic: { defaultHaikuModel: "claude-haiku-4-5" },
  }),
}));

// Stub llm-eval so Haiku is controlled
const mockCallClaude = vi.fn();
vi.mock("../../lib/llm-eval.js", () => ({
  callClaudeForEvaluation: (...args: unknown[]) => mockCallClaude(...args),
}));

let db: BetterSqlite3.Database;
let cleanup: () => void;

beforeAll(async () => {
  const { setupTestDb } = await import("../helpers/test-db.js");
  ({ db, cleanup } = setupTestDb());
});

afterAll(() => cleanup());

beforeEach(() => {
  vi.doMock("../../store/db.js", () => ({ getDb: () => db }));
  db.prepare("DELETE FROM beliefs").run();
  db.prepare("DELETE FROM tasks").run();
  db.prepare("DELETE FROM roles").run();
  db.prepare(
    "INSERT INTO roles (id, name, status, cag_prompt, memory_stream_id, created_at) VALUES ('role-test', 'TestRole', 'active', '', 'mem-1', ?)"
  ).run(Date.now());
  mockCallClaude.mockReset();
  mockCallClaude.mockResolvedValue("");
});

/**
 * Seed a v81-schema belief (no confidence/trialCount/deltaSum/expiresAt columns).
 */
function seedBelief(opts: {
  id: string;
  roleId?: string;
  content?: string;
  isAnti?: number;
  successEma?: number;
  injectCount?: number;
  status?: string;
}): void {
  const {
    id,
    roleId = "role-test",
    content = "original belief content",
    isAnti = 0,
    successEma = 0.5,
    injectCount = 5,
    status = "active",
  } = opts;
  db.prepare(`
    INSERT INTO beliefs (id, role_id, content, is_anti, evidence_obs_ids,
      created_at, last_used_at, last_validated_at, status, success_ema, inject_count)
    VALUES (?, ?, ?, ?, '[]', ?, 0, ?, ?, ?, ?)
  `).run(id, roleId, content, isAnti, Date.now(), Date.now(), status, successEma, injectCount);
}

import type { MemoryConfig } from "../../shared/types.js";

const defaultCfg = {
  midTaskInjection: { enabled: false, toolCallThreshold: 10, cooldownMs: 60_000, topK: 3, maxTokens: 1000 },
  globalBudgetTokens: 1500,
  retrievalDecayDays: 30,
  attributionThresholds: { high: 0.7, low: 0.4 },
  antiFlipMinUses: 5,
  antiFlipSuccessEmaThreshold: 0.25,
  scope: { emaAlpha: 0.3 },
  embeddingModel: "bge-small-zh-v1.5",
} as unknown as MemoryConfig;

describe("anti-flip v3 predicate", () => {
  it("trigger on ema below threshold: calls Haiku when injectCount >= minTouches AND successEma < threshold", async () => {
    // injectCount=5 >= minTouches=5, successEma=0.2 < threshold=0.25 → should trigger
    seedBelief({ id: "b-trigger", successEma: 0.2, injectCount: 5 });
    mockCallClaude.mockResolvedValueOnce("❌ 历史失败模式: 永远不要跳过生产构建的类型检查");

    const { checkAndFlipAntiPattern } = await import("../../audit/anti-flip.js");
    const { getBelief } = await import("../../store/beliefs.js");

    await checkAndFlipAntiPattern(["b-trigger"], defaultCfg);

    const updated = getBelief("b-trigger")!;
    expect(updated.isAnti).toBe(true);
    expect(mockCallClaude).toHaveBeenCalledOnce();
  });

  it("skip when min_touches not met (injectCount < antiFlipMinUses): no Haiku call", async () => {
    // injectCount=4 < minTouches=5 → should skip
    seedBelief({ id: "b-below-min", successEma: 0.1, injectCount: 4 });

    const { checkAndFlipAntiPattern } = await import("../../audit/anti-flip.js");
    const { getBelief } = await import("../../store/beliefs.js");

    await checkAndFlipAntiPattern(["b-below-min"], defaultCfg);

    const updated = getBelief("b-below-min")!;
    expect(updated.isAnti).toBe(false);
    expect(mockCallClaude).not.toHaveBeenCalled();
  });

  it("skip when successEma >= threshold: no Haiku call even if injectCount met", async () => {
    // successEma=0.5 >= threshold=0.25 → not a failing belief → skip
    seedBelief({ id: "b-high-ema", successEma: 0.5, injectCount: 10 });

    const { checkAndFlipAntiPattern } = await import("../../audit/anti-flip.js");
    const { getBelief } = await import("../../store/beliefs.js");

    await checkAndFlipAntiPattern(["b-high-ema"], defaultCfg);

    const updated = getBelief("b-high-ema")!;
    expect(updated.isAnti).toBe(false);
    expect(mockCallClaude).not.toHaveBeenCalled();
  });
});

describe("anti-flip Haiku flow", () => {
  it("belief already isAnti: no-op", async () => {
    seedBelief({ id: "b-already-anti", isAnti: 1, successEma: 0.1, injectCount: 10 });

    const { checkAndFlipAntiPattern } = await import("../../audit/anti-flip.js");
    const { getBelief } = await import("../../store/beliefs.js");

    await checkAndFlipAntiPattern(["b-already-anti"], defaultCfg);

    const updated = getBelief("b-already-anti")!;
    expect(updated.isAnti).toBe(true);
    expect(mockCallClaude).not.toHaveBeenCalled();
  });

  it("Haiku success: is_anti=1 + content rewritten with ❌ prefix", async () => {
    seedBelief({ id: "b-flip-success", successEma: 0.1, injectCount: 5 });
    mockCallClaude.mockResolvedValueOnce("❌ 历史失败模式: 永远不要跳过生产构建的类型检查");

    const { checkAndFlipAntiPattern } = await import("../../audit/anti-flip.js");
    const { getBelief } = await import("../../store/beliefs.js");

    await checkAndFlipAntiPattern(["b-flip-success"], defaultCfg);

    const updated = getBelief("b-flip-success")!;
    expect(updated.isAnti).toBe(true);
    expect(updated.content).toBe("❌ 历史失败模式: 永远不要跳过生产构建的类型检查");
  });

  it("Haiku returns malformed content (no ❌ prefix): defer, belief unchanged, evolution_audit row created", async () => {
    seedBelief({ id: "b-malformed", successEma: 0.1, injectCount: 5 });
    mockCallClaude.mockResolvedValueOnce("This is a rewrite without the warning prefix.");

    const { checkAndFlipAntiPattern } = await import("../../audit/anti-flip.js");
    const { getBelief } = await import("../../store/beliefs.js");
    const { listEvolutionAudit } = await import("../../store/evolution-audit.js");

    await checkAndFlipAntiPattern(["b-malformed"], defaultCfg);

    const updated = getBelief("b-malformed")!;
    expect(updated.isAnti).toBe(false);
    expect(updated.content).toBe("original belief content");

    const audits = listEvolutionAudit(10, 0);
    const flipAudit = audits.find((a) => a.diff.includes("anti_flip_deferred"));
    expect(flipAudit).toBeDefined();
    const diff = JSON.parse(flipAudit!.diff);
    expect(diff.kind).toBe("anti_flip_deferred");
    expect(diff.beliefId).toBe("b-malformed");
    expect(flipAudit!.source).toBe("audit-monitor");
  });

  it("Haiku throws: defer, belief unchanged, evolution_audit row created with error", async () => {
    seedBelief({ id: "b-haiku-error", successEma: 0.1, injectCount: 5 });
    mockCallClaude.mockRejectedValueOnce(new Error("network failure"));

    const { checkAndFlipAntiPattern } = await import("../../audit/anti-flip.js");
    const { getBelief } = await import("../../store/beliefs.js");
    const { listEvolutionAudit } = await import("../../store/evolution-audit.js");

    await checkAndFlipAntiPattern(["b-haiku-error"], defaultCfg);

    const updated = getBelief("b-haiku-error")!;
    expect(updated.isAnti).toBe(false);
    expect(updated.content).toBe("original belief content");

    const audits = listEvolutionAudit(10, 0);
    const flipAudit = audits.find((a) => a.diff.includes("anti_flip_deferred"));
    expect(flipAudit).toBeDefined();
    const diff = JSON.parse(flipAudit!.diff);
    expect(diff.kind).toBe("anti_flip_deferred");
    expect(diff.error).toContain("network failure");
    expect(flipAudit!.source).toBe("audit-monitor");
  });

  it("multiple beliefs: processes each independently", async () => {
    // b1, b2: trigger (successEma=0.1, injectCount=5); b3: skip (injectCount=3)
    seedBelief({ id: "b-multi-1", successEma: 0.1, injectCount: 5 });
    seedBelief({ id: "b-multi-2", successEma: 0.1, injectCount: 5 });
    seedBelief({ id: "b-multi-3", successEma: 0.1, injectCount: 3 }); // below min → skip

    mockCallClaude
      .mockResolvedValueOnce("❌ rewrite for b1")
      .mockResolvedValueOnce("❌ rewrite for b2");

    const { checkAndFlipAntiPattern } = await import("../../audit/anti-flip.js");
    const { getBelief } = await import("../../store/beliefs.js");

    await checkAndFlipAntiPattern(["b-multi-1", "b-multi-2", "b-multi-3"], defaultCfg);

    expect(getBelief("b-multi-1")!.isAnti).toBe(true);
    expect(getBelief("b-multi-2")!.isAnti).toBe(true);
    expect(getBelief("b-multi-3")!.isAnti).toBe(false); // skipped
  });

  it("empty beliefIds array: no-op (no Haiku call)", async () => {
    const { checkAndFlipAntiPattern } = await import("../../audit/anti-flip.js");
    await checkAndFlipAntiPattern([], defaultCfg);
    expect(mockCallClaude).not.toHaveBeenCalled();
  });

  it("nonexistent belief ID: skipped without throw", async () => {
    seedBelief({ id: "b-real-only", successEma: 0.1, injectCount: 5 });
    mockCallClaude.mockResolvedValueOnce("❌ rewrite");

    const { checkAndFlipAntiPattern } = await import("../../audit/anti-flip.js");
    const { getBelief } = await import("../../store/beliefs.js");

    await expect(checkAndFlipAntiPattern(["b-real-only", "b-does-not-exist"], defaultCfg)).resolves.not.toThrow();
    expect(getBelief("b-real-only")!.isAnti).toBe(true);
  });
});
