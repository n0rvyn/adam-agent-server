/**
 * Task 3-tests: getCostSummary + getCostDetail aggregation query tests.
 *
 * Pre-impl: all tests FAIL because getCostSummary / getCostDetail do not exist yet.
 * Post-impl (Task 3-impl): all tests pass.
 *
 * Seeds known llm_costs rows and asserts:
 *   1. groupBy=model sums == manual sums
 *   2. groupBy=source omits sources with no rows
 *   3. groupBy=role maps NULL role_id → 'system'
 *   4. Top-level totals: totalCostUsd, callCount, unpricedCallCount, unpricedTokens
 *   5. getCostDetail returns per-call rows for a given group key
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { vi } from "vitest";
import { setupTestDb, getTestDb } from "../helpers/test-db.js";

// ─── Test DB setup ────────────────────────────────────────────────────────────

setupTestDb();

vi.mock(import("../../store/db.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, getDb: () => getTestDb(), closeDb: () => {} };
});

// ─── Lazy import — module functions do not exist until Task 3-impl ────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let getCostSummary: (params: any) => any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let getCostDetail: (params: any) => any;

beforeAll(async () => {
  try {
    const mod = await import("../../store/llm-costs.js");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getCostSummary = (mod as any).getCostSummary;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getCostDetail = (mod as any).getCostDetail;
    if (typeof getCostSummary !== "function" || typeof getCostDetail !== "function") {
      throw new Error("getCostSummary or getCostDetail is not a function — not yet implemented");
    }
  } catch {
    getCostSummary = () => { throw new Error("getCostSummary not implemented"); };
    getCostDetail = () => { throw new Error("getCostDetail not implemented"); };
  }
});

afterAll(() => { /* cleanup handled by setupTestDb */ });

// ─── Seed helper ─────────────────────────────────────────────────────────────

interface SeedRow {
  id: string;
  callId: string;
  source: string;
  model: string;
  roleId?: string;
  taskId?: string;
  sessionId?: string;
  messageId?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUsd: number;
  priced: number;
  estimated?: number;
  createdAt: number;
}

function seedRows(db: ReturnType<typeof getTestDb>, rows: SeedRow[]): void {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO llm_costs
      (id, call_id, source, model, role_id, task_id, session_id, message_id,
       input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
       cost_usd, priced, estimated, sdk_total_cost_usd, num_turns, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
  `);
  for (const r of rows) {
    stmt.run(
      r.id, r.callId, r.source, r.model,
      r.roleId ?? null, r.taskId ?? null, r.sessionId ?? null, r.messageId ?? null,
      r.inputTokens, r.outputTokens,
      r.cacheReadTokens ?? 0, r.cacheCreationTokens ?? 0,
      r.costUsd, r.priced, r.estimated ?? 0,
      r.createdAt,
    );
  }
}

// Known data for assertions
const BASE_TS = Date.now() - 1000 * 60 * 60; // 1 hour ago

const TEST_ROWS: SeedRow[] = [
  // call-1: two models (sonnet priced, haiku unpriced), source=task
  {
    id: "row-1a", callId: "call-1", source: "task", model: "claude-sonnet-4-6",
    taskId: "task-agg-1", inputTokens: 100, outputTokens: 50,
    costUsd: 0.01, priced: 1, createdAt: BASE_TS,
  },
  {
    id: "row-1b", callId: "call-1", source: "task", model: "claude-haiku-3",
    taskId: "task-agg-1", inputTokens: 200, outputTokens: 80,
    costUsd: 0, priced: 0, createdAt: BASE_TS,
  },
  // call-2: one model (sonnet priced), source=chat, no role_id
  {
    id: "row-2a", callId: "call-2", source: "chat", model: "claude-sonnet-4-6",
    sessionId: "sess-agg-1", inputTokens: 300, outputTokens: 120,
    costUsd: 0.03, priced: 1, createdAt: BASE_TS + 1000,
  },
];

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("getCostSummary — groupBy=model", () => {
  const from = BASE_TS - 1000;
  const to = Date.now() + 1000;

  beforeAll(() => {
    seedRows(getTestDb(), TEST_ROWS);
  });

  it("returns grouped sums that match manual per-row sums", async () => {
    const summary = await getCostSummary({ from, to, groupBy: "model", granularity: "day" });

    expect(summary).toBeDefined();
    expect(summary.groups).toBeDefined();
    expect(Array.isArray(summary.groups)).toBe(true);

    // Manual sums for claude-sonnet-4-6: 0.01 + 0.03 = 0.04
    const sonnet = summary.groups.find((g: { key: string }) => g.key === "claude-sonnet-4-6");
    expect(sonnet).toBeDefined();
    expect(sonnet.costUsd).toBeCloseTo(0.04, 6);

    // Manual sums for claude-haiku-3: 0 (unpriced)
    const haiku = summary.groups.find((g: { key: string }) => g.key === "claude-haiku-3");
    expect(haiku).toBeDefined();
    expect(haiku.costUsd).toBeCloseTo(0, 6);
  });

  it("totalCostUsd == sum of all groups costUsd", async () => {
    const summary = await getCostSummary({ from, to, groupBy: "model", granularity: "day" });
    const groupSum = summary.groups.reduce((s: number, g: { costUsd: number }) => s + g.costUsd, 0);
    expect(summary.totalCostUsd).toBeCloseTo(groupSum, 6);
  });

  it("callCount == COUNT(DISTINCT call_id) in window", async () => {
    const summary = await getCostSummary({ from, to, groupBy: "model", granularity: "day" });
    // call-1 and call-2 are in window
    expect(summary.callCount).toBeGreaterThanOrEqual(2);
  });

  it("unpricedCallCount includes calls that have at least one priced=0 row", async () => {
    const summary = await getCostSummary({ from, to, groupBy: "model", granularity: "day" });
    // call-1 has a haiku row with priced=0 → unpricedCallCount >= 1
    expect(summary.unpricedCallCount).toBeGreaterThanOrEqual(1);
  });

  it("unpricedTokens is a non-negative number", async () => {
    const summary = await getCostSummary({ from, to, groupBy: "model", granularity: "day" });
    expect(typeof summary.unpricedTokens).toBe("number");
    expect(summary.unpricedTokens).toBeGreaterThanOrEqual(0);
  });
});

describe("getCostSummary — groupBy=source", () => {
  const from = BASE_TS - 1000;
  const to = Date.now() + 1000;

  it("only returns sources that have rows (no $0 orchestrator row)", async () => {
    const summary = await getCostSummary({ from, to, groupBy: "source", granularity: "day" });
    const keys = summary.groups.map((g: { key: string }) => g.key);
    // orchestrator has no rows — must not appear
    expect(keys).not.toContain("orchestrator");
    // task and chat have rows — must appear
    expect(keys).toContain("task");
    expect(keys).toContain("chat");
  });
});

describe("getCostSummary — groupBy=role", () => {
  const from = BASE_TS - 1000;
  const to = Date.now() + 1000;

  it("maps NULL role_id to 'system' key", async () => {
    const summary = await getCostSummary({ from, to, groupBy: "role", granularity: "day" });
    const keys = summary.groups.map((g: { key: string }) => g.key);
    // All test rows have role_id=NULL → should map to 'system'
    expect(keys).toContain("system");
  });
});

describe("getCostDetail", () => {
  const from = BASE_TS - 1000;
  const to = Date.now() + 1000;

  it("returns per-call rows for a given model group key", async () => {
    const detail = await getCostDetail({
      groupBy: "model",
      groupKey: "claude-sonnet-4-6",
      from,
      to,
    });

    expect(detail).toBeDefined();
    expect(Array.isArray(detail)).toBe(true);
    expect(detail.length).toBeGreaterThanOrEqual(1);

    // Each detail entry should have a callId and cost info
    const first = detail[0];
    expect(first).toHaveProperty("callId");
    expect(first).toHaveProperty("costUsd");
  });

  it("returns empty array for a model key with no rows", async () => {
    const detail = await getCostDetail({
      groupBy: "model",
      groupKey: "nonexistent-model-xyz",
      from,
      to,
    });

    expect(Array.isArray(detail)).toBe(true);
    expect(detail).toHaveLength(0);
  });
});

describe("getCostSummary — invalid params rejected", () => {
  it("throws or returns error for invalid groupBy value", async () => {
    await expect(
      getCostSummary({ from: 0, to: Date.now(), groupBy: "invalid_field", granularity: "day" })
    ).rejects.toThrow();
  });

  it("throws or returns error for invalid granularity value", async () => {
    await expect(
      getCostSummary({ from: 0, to: Date.now(), groupBy: "model", granularity: "hour" })
    ).rejects.toThrow();
  });

  it("throws for invalid trendStackBy value", async () => {
    await expect(
      getCostSummary({ from: 0, to: Date.now(), groupBy: "model", granularity: "day", trendStackBy: "role" })
    ).rejects.toThrow();
  });
});

// Deviation #4 fix: stacked trend by source/model
describe("getCostSummary — trendStackBy (stacked trend)", () => {
  const from = BASE_TS - 1000;
  const to = Date.now() + 1000;

  it("returns no trendStacked when trendStackBy is unset", async () => {
    const summary = await getCostSummary({ from, to, groupBy: "model", granularity: "day" });
    expect(summary.trendStacked).toBeUndefined();
    expect(summary.trendStackKeys).toBeUndefined();
    expect(Array.isArray(summary.trend)).toBe(true);
  });

  it("returns per-bucket cost split by source when trendStackBy='source'", async () => {
    const summary = await getCostSummary({ from, to, groupBy: "model", granularity: "day", trendStackBy: "source" });
    expect(Array.isArray(summary.trendStacked)).toBe(true);
    expect(summary.trendStackKeys).toEqual(expect.arrayContaining(["task", "chat"]));
    // Sum of all stacked source costs across buckets == totalCostUsd (0.01 + 0.03)
    let stackedTotal = 0;
    for (const row of summary.trendStacked as Array<Record<string, number | string>>) {
      for (const key of summary.trendStackKeys as string[]) {
        if (typeof row[key] === "number") stackedTotal += row[key] as number;
      }
    }
    expect(stackedTotal).toBeCloseTo(summary.totalCostUsd, 6);
  });
});

// Deviation #3 fix: local-midnight bucketing via tzOffsetMinutes
describe("getCostSummary — tzOffsetMinutes (local-day bucketing)", () => {
  // 2026-01-01T20:00:00Z — UTC date is 2026-01-01; UTC+8 local date is 2026-01-02.
  const TS = Date.UTC(2026, 0, 1, 20, 0, 0);
  const from = TS - 1000;
  const to = TS + 1000;

  beforeAll(() => {
    seedRows(getTestDb(), [{
      id: "row-tz-1", callId: "call-tz-1", source: "task", model: "claude-sonnet-4-6",
      taskId: "task-tz-1", inputTokens: 10, outputTokens: 5,
      costUsd: 0.005, priced: 1, createdAt: TS,
    }]);
  });

  it("buckets by UTC day when tzOffsetMinutes=0", async () => {
    const summary = await getCostSummary({ from, to, groupBy: "date", granularity: "day", tzOffsetMinutes: 0 });
    const keys = summary.groups.map((g: { key: string }) => g.key);
    expect(keys).toContain("2026-01-01");
  });

  it("buckets by LOCAL day when tzOffsetMinutes=480 (UTC+8)", async () => {
    const summary = await getCostSummary({ from, to, groupBy: "date", granularity: "day", tzOffsetMinutes: 480 });
    const keys = summary.groups.map((g: { key: string }) => g.key);
    // 20:00 UTC + 8h = 04:00 next day → 2026-01-02
    expect(keys).toContain("2026-01-02");
    expect(keys).not.toContain("2026-01-01");
  });
});
