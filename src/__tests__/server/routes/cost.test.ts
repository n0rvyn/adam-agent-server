/**
 * Task 7-tests: GET /cost/summary + /cost/detail route tests.
 *
 * Uses buildApp() to get the auth hook; seeds llm_costs directly.
 * FAILS before Task 7-impl (404 / route absent).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../../helpers/test-db.js";
import type { FastifyInstance } from "fastify";
import { setConfigValue } from "../../../store/config.js";

const { cleanup } = setupTestDb();

vi.mock("../../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

const TEST_API_KEY = "cost-test-api-key-2026";
const NOW = Date.now();
const FROM = NOW - 60_000;
const TO = NOW + 60_000;

// Seed helpers
function seedRow(overrides: {
  id: string;
  callId: string;
  source: string;
  model: string;
  roleId?: string;
  taskId?: string;
  sessionId?: string;
  messageId?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUsd?: number;
  priced?: number;
  estimated?: number;
  sdkTotalCostUsd?: number;
  numTurns?: number;
  createdAt?: number;
}) {
  const db = getTestDb();
  db.prepare(`
    INSERT OR IGNORE INTO llm_costs
      (id, call_id, source, model, role_id, task_id, session_id, message_id,
       input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
       cost_usd, priced, estimated, sdk_total_cost_usd, num_turns, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    overrides.id,
    overrides.callId,
    overrides.source,
    overrides.model,
    overrides.roleId ?? null,
    overrides.taskId ?? null,
    overrides.sessionId ?? null,
    overrides.messageId ?? null,
    overrides.inputTokens ?? 100,
    overrides.outputTokens ?? 50,
    overrides.cacheReadTokens ?? 0,
    overrides.cacheCreationTokens ?? 0,
    overrides.costUsd ?? 0.01,
    overrides.priced ?? 1,
    overrides.estimated ?? 0,
    overrides.sdkTotalCostUsd ?? null,
    overrides.numTurns ?? null,
    overrides.createdAt ?? NOW,
  );
}

let app: FastifyInstance;

beforeAll(async () => {
  const { buildApp } = await import("../../../server/app.js");
  const { costRoutes } = await import("../../../server/routes/cost.js");
  app = buildApp({ port: 0, host: "127.0.0.1", apiKey: TEST_API_KEY } as never, TEST_API_KEY);
  await app.register(costRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  cleanup();
});

beforeEach(() => {
  clearTestDb();
});

describe("GET /cost/summary", () => {
  it("returns grouped sums that match manual row sums (groupBy=model)", async () => {
    seedRow({ id: "r1", callId: "call-a", source: "task", model: "claude-sonnet-4-6", costUsd: 0.10, inputTokens: 100, outputTokens: 50, priced: 1, createdAt: NOW });
    seedRow({ id: "r2", callId: "call-b", source: "task", model: "claude-sonnet-4-6", costUsd: 0.05, inputTokens: 80, outputTokens: 30, priced: 1, createdAt: NOW });
    seedRow({ id: "r3", callId: "call-c", source: "chat", model: "claude-haiku-3", costUsd: 0.02, inputTokens: 60, outputTokens: 20, priced: 1, createdAt: NOW });

    const res = await app.inject({
      method: "GET",
      url: `/cost/summary?from=${FROM}&to=${TO}&groupBy=model&granularity=day`,
      headers: { "x-api-key": TEST_API_KEY },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      totalCostUsd: number;
      callCount: number;
      groups: Array<{ key: string; costUsd: number; callCount: number }>;
      unpricedCallCount: number;
      unpricedTokens: number;
    };

    expect(body.totalCostUsd).toBeCloseTo(0.17, 5);
    expect(body.callCount).toBe(3);

    const sonnetGroup = body.groups.find((g) => g.key === "claude-sonnet-4-6");
    expect(sonnetGroup).toBeDefined();
    expect(sonnetGroup!.costUsd).toBeCloseTo(0.15, 5);
    expect(sonnetGroup!.callCount).toBe(2);

    const haikuGroup = body.groups.find((g) => g.key === "claude-haiku-3");
    expect(haikuGroup).toBeDefined();
    expect(haikuGroup!.costUsd).toBeCloseTo(0.02, 5);
  });

  it("exposes unpricedCallCount and unpricedTokens (not hidden)", async () => {
    seedRow({ id: "p1", callId: "call-priced", source: "task", model: "claude-sonnet-4-6", costUsd: 0.05, priced: 1, createdAt: NOW });
    seedRow({ id: "u1", callId: "call-unpriced", source: "task", model: "unknown-model", costUsd: 0.00, priced: 0, inputTokens: 200, outputTokens: 100, createdAt: NOW });

    const res = await app.inject({
      method: "GET",
      url: `/cost/summary?from=${FROM}&to=${TO}&groupBy=model&granularity=day`,
      headers: { "x-api-key": TEST_API_KEY },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { unpricedCallCount: number; unpricedTokens: number };
    expect(body.unpricedCallCount).toBe(1);
    expect(body.unpricedTokens).toBeGreaterThan(0);
  });

  it("groupBy=source omits orchestrator (no rows for it)", async () => {
    seedRow({ id: "s1", callId: "call-task", source: "task", model: "claude-sonnet-4-6", costUsd: 0.05, priced: 1, createdAt: NOW });
    seedRow({ id: "s2", callId: "call-chat", source: "chat", model: "claude-sonnet-4-6", costUsd: 0.03, priced: 1, createdAt: NOW });

    const res = await app.inject({
      method: "GET",
      url: `/cost/summary?from=${FROM}&to=${TO}&groupBy=source&granularity=day`,
      headers: { "x-api-key": TEST_API_KEY },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { groups: Array<{ key: string }> };
    const keys = body.groups.map((g) => g.key);
    expect(keys).not.toContain("orchestrator");
    expect(keys).toContain("task");
    expect(keys).toContain("chat");
  });

  it("groupBy=role maps NULL role_id to 'system'", async () => {
    seedRow({ id: "role1", callId: "call-no-role", source: "eval", model: "claude-sonnet-4-6", roleId: undefined, costUsd: 0.01, priced: 1, createdAt: NOW });

    const res = await app.inject({
      method: "GET",
      url: `/cost/summary?from=${FROM}&to=${TO}&groupBy=role&granularity=day`,
      headers: { "x-api-key": TEST_API_KEY },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { groups: Array<{ key: string }> };
    const keys = body.groups.map((g) => g.key);
    expect(keys).toContain("system");
  });

  it("returns 401 without x-api-key", async () => {
    const res = await app.inject({ method: "GET", url: `/cost/summary?from=${FROM}&to=${TO}&groupBy=model&granularity=day` });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("echoes thresholdUsd from config (cost.dailyThresholdUsd)", async () => {
    setConfigValue("cost.dailyThresholdUsd", 3.0);
    seedRow({ id: "thresh1", callId: "call-thresh", source: "task", model: "claude-sonnet-4-6", costUsd: 0.05, priced: 1, createdAt: NOW });

    const res = await app.inject({
      method: "GET",
      url: `/cost/summary?from=${FROM}&to=${TO}&groupBy=model&granularity=day`,
      headers: { "x-api-key": TEST_API_KEY },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { thresholdUsd: number; totalCostUsd: number };
    expect(body.thresholdUsd).toBe(3.0);
    // existing fields still present
    expect(typeof body.totalCostUsd).toBe("number");
  });
});

describe("GET /cost/detail", () => {
  it("returns per-call rows for the given groupKey", async () => {
    seedRow({ id: "d1", callId: "call-detail-1", source: "task", model: "claude-sonnet-4-6", costUsd: 0.08, inputTokens: 120, outputTokens: 60, priced: 1, createdAt: NOW });
    seedRow({ id: "d2", callId: "call-detail-2", source: "task", model: "claude-sonnet-4-6", costUsd: 0.04, inputTokens: 80, outputTokens: 40, priced: 1, createdAt: NOW });
    seedRow({ id: "d3", callId: "call-other", source: "chat", model: "claude-haiku-3", costUsd: 0.01, priced: 1, createdAt: NOW });

    const res = await app.inject({
      method: "GET",
      url: `/cost/detail?groupBy=model&groupKey=claude-sonnet-4-6&from=${FROM}&to=${TO}`,
      headers: { "x-api-key": TEST_API_KEY },
    });

    expect(res.statusCode).toBe(200);
    const calls = res.json() as Array<{ callId: string; model: string; costUsd: number }>;
    expect(calls.length).toBe(2);
    expect(calls.every((c) => c.model === "claude-sonnet-4-6")).toBe(true);
    const callIds = calls.map((c) => c.callId);
    expect(callIds).toContain("call-detail-1");
    expect(callIds).toContain("call-detail-2");
  });

  it("returns 401 without x-api-key", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/cost/detail?groupBy=model&groupKey=claude-sonnet-4-6&from=${FROM}&to=${TO}`,
    });
    expect(res.statusCode).toBe(401);
  });
});
