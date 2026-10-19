/**
 * Task 2-tests: recordLlmCost write-path + mirror tests.
 *
 * Pre-impl: all tests FAIL because the module does not exist.
 * Post-impl (Task 2-impl): all tests pass.
 *
 * 5 test cases:
 *   TC1 — task source, 2 per-model rows, mirror to tasks
 *   TC2 — chat source, mirror to chat_messages
 *   TC3 — eval source, no mirror
 *   TC4 — empty perModel (pricingStatus='none'), mirror still fires
 *   TC5 — idempotency: explicit callId passed twice (contract assertion)
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { setupTestDb, getTestDb } from "../helpers/test-db.js";
import type BetterSqlite3 from "better-sqlite3";

// ─── Test DB setup — must call setupTestDb() BEFORE vi.mock factory runs ──────

setupTestDb();

vi.mock(import("../../store/db.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, getDb: () => getTestDb(), closeDb: () => {} };
});

let db: BetterSqlite3.Database;
let cleanup: () => void;

beforeAll(() => {
  db = getTestDb();
  cleanup = () => { /* cleanup handled by setupTestDb internals */ };
});

afterAll(() => {
  cleanup();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function seedTask(id: string, costUsd = 0): void {
  db.prepare(
    `INSERT OR IGNORE INTO tasks (id, status, prompt, config, created_at, retry_count, cost_usd)
     VALUES (?, 'running', 'test', '{}', ?, 0, ?)`
  ).run(id, Date.now(), costUsd);
}

function seedSession(id: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO chat_sessions (id, status, source_type, created_at, last_active_at)
     VALUES (?, 'active', 'cli', ?, ?)`
  ).run(id, Date.now(), Date.now());
}

function seedMessage(id: string, sessionId: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO chat_messages (id, session_id, role, content, source_type, created_at)
     VALUES (?, ?, 'assistant', 'hello', 'cli', ?)`
  ).run(id, sessionId, Date.now());
}

function makeTwoPricedModels() {
  return {
    costUsd: 0.015,
    perModel: [
      {
        model: "claude-sonnet-4-6",
        priced: true,
        estimated: false,
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 10,
        cacheCreationTokens: 5,
        costUsd: 0.01,
      },
      {
        model: "claude-haiku-3",
        priced: false,
        estimated: false,
        inputTokens: 200,
        outputTokens: 80,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0.005,
      },
    ],
    pricingStatus: "partial" as const,
    unknownModels: ["claude-haiku-3"],
    sdkTotalCostUsd: 0.015,
  };
}

// ─── Lazy import: module does not exist before Task 2-impl ────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let recordLlmCost: (input: any) => Promise<{ callId: string; rowsInserted: number }>;

beforeAll(async () => {
  // Dynamic import so the test file itself doesn't fail at parse time when the module is absent.
  // The describe/it blocks below will fail properly if the import throws.
  try {
    const mod = await import("../../lib/record-llm-cost.js");
    recordLlmCost = mod.recordLlmCost;
  } catch {
    // module absent pre-impl: individual tests will throw/fail when calling recordLlmCost
    recordLlmCost = async () => { throw new Error("recordLlmCost is not a function — module absent"); };
  }
});

// ─── TC1: task source, 2 per-model rows, mirror to tasks ─────────────────────

describe("TC1 — task source with 2 models", () => {
  it("inserts 2 llm_costs rows sharing the same call_id", async () => {
    const taskId = "tc1-task-" + Date.now();
    seedTask(taskId, 0);

    const recompute = makeTwoPricedModels();
    const result = await recordLlmCost({
      source: "task",
      taskId,
      recompute,
      mirror: true,
    });

    expect(result.rowsInserted).toBe(2);

    const rows = db.prepare(
      "SELECT * FROM llm_costs WHERE task_id = ? ORDER BY model"
    ).all(taskId) as Array<{
      call_id: string; source: string; model: string;
      cost_usd: number; priced: number; estimated: number;
      input_tokens: number; output_tokens: number;
    }>;

    expect(rows).toHaveLength(2);
    // All rows share the same call_id
    const callIds = new Set(rows.map(r => r.call_id));
    expect(callIds.size).toBe(1);
    expect(callIds.has(result.callId)).toBe(true);

    // Check per-model mapping
    const sonnet = rows.find(r => r.model === "claude-sonnet-4-6")!;
    expect(sonnet).toBeDefined();
    expect(sonnet.source).toBe("task");
    expect(sonnet.priced).toBe(1);
    expect(sonnet.estimated).toBe(0);
    expect(sonnet.input_tokens).toBe(100);
    expect(sonnet.output_tokens).toBe(50);
    expect(sonnet.cost_usd).toBeCloseTo(0.01, 6);

    const haiku = rows.find(r => r.model === "claude-haiku-3")!;
    expect(haiku.priced).toBe(0); // unpriced
  });

  it("COUNT(DISTINCT call_id) = 1 for the task", async () => {
    const taskId = "tc1b-task-" + Date.now();
    seedTask(taskId, 0);

    const recompute = makeTwoPricedModels();
    await recordLlmCost({ source: "task", taskId, recompute, mirror: true });

    const row = db.prepare(
      "SELECT COUNT(DISTINCT call_id) AS cnt FROM llm_costs WHERE task_id = ?"
    ).get(taskId) as { cnt: number };
    expect(row.cnt).toBe(1);
  });

  it("mirrors cost_usd to tasks row", async () => {
    const taskId = "tc1c-task-" + Date.now();
    seedTask(taskId, 0);

    const recompute = makeTwoPricedModels();
    await recordLlmCost({ source: "task", taskId, recompute, mirror: true });

    const task = db.prepare(
      "SELECT cost_usd FROM tasks WHERE id = ?"
    ).get(taskId) as { cost_usd: number };
    expect(task.cost_usd).toBeCloseTo(recompute.costUsd, 6);
  });

  it("tasks.cost_usd == SUM of llm_costs.cost_usd for that call", async () => {
    const taskId = "tc1d-task-" + Date.now();
    seedTask(taskId, 0);

    const recompute = makeTwoPricedModels();
    const result = await recordLlmCost({ source: "task", taskId, recompute, mirror: true });

    const sumRow = db.prepare(
      "SELECT SUM(cost_usd) AS total FROM llm_costs WHERE call_id = ?"
    ).get(result.callId) as { total: number };

    const taskRow = db.prepare(
      "SELECT cost_usd FROM tasks WHERE id = ?"
    ).get(taskId) as { cost_usd: number };

    expect(taskRow.cost_usd).toBeCloseTo(sumRow.total, 6);
  });
});

// ─── TC2: chat source, mirror to chat_messages ───────────────────────────────

describe("TC2 — chat source, mirror to chat_messages", () => {
  it("inserts llm_costs row with source='chat' and session_id/message_id set", async () => {
    const sessionId = "tc2-sess-" + Date.now();
    const messageId = "tc2-msg-" + Date.now();
    seedSession(sessionId);
    seedMessage(messageId, sessionId);

    const recompute = makeTwoPricedModels();
    const result = await recordLlmCost({
      source: "chat",
      sessionId,
      messageId,
      recompute,
      mirror: true,
    });

    expect(result.rowsInserted).toBeGreaterThanOrEqual(1);

    const rows = db.prepare(
      "SELECT source, session_id, message_id, role_id FROM llm_costs WHERE call_id = ?"
    ).all(result.callId) as Array<{
      source: string; session_id: string | null;
      message_id: string | null; role_id: string | null;
    }>;

    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].source).toBe("chat");
    expect(rows[0].session_id).toBe(sessionId);
    expect(rows[0].message_id).toBe(messageId);
    expect(rows[0].role_id).toBeNull();
  });

  it("mirrors cost_usd/model/token_usage to chat_messages row", async () => {
    const sessionId = "tc2b-sess-" + Date.now();
    const messageId = "tc2b-msg-" + Date.now();
    seedSession(sessionId);
    seedMessage(messageId, sessionId);

    const recompute = makeTwoPricedModels();
    await recordLlmCost({
      source: "chat",
      sessionId,
      messageId,
      recompute,
      mirror: true,
    });

    const msg = db.prepare(
      "SELECT cost_usd, model, token_usage FROM chat_messages WHERE id = ?"
    ).get(messageId) as { cost_usd: number | null; model: string | null; token_usage: string | null };

    expect(msg.cost_usd).not.toBeNull();
    expect(msg.cost_usd).toBeCloseTo(recompute.costUsd, 6);
    expect(msg.model).not.toBeNull();
    expect(msg.token_usage).not.toBeNull();
  });
});

// ─── TC3: eval source, no mirror ─────────────────────────────────────────────

describe("TC3 — eval source, no mirror", () => {
  it("inserts llm_costs row with source='eval' and null task/session/message", async () => {
    const recompute = {
      costUsd: 0.001,
      perModel: [
        {
          model: "claude-haiku-3",
          priced: true,
          estimated: false,
          inputTokens: 50,
          outputTokens: 20,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costUsd: 0.001,
        },
      ],
      pricingStatus: "priced" as const,
      unknownModels: [],
      sdkTotalCostUsd: 0.001,
    };

    const result = await recordLlmCost({
      source: "eval",
      recompute,
      mirror: false,
    });

    expect(result.rowsInserted).toBe(1);

    const row = db.prepare(
      "SELECT source, role_id, task_id, session_id, message_id FROM llm_costs WHERE call_id = ?"
    ).get(result.callId) as {
      source: string; role_id: string | null; task_id: string | null;
      session_id: string | null; message_id: string | null;
    };

    expect(row.source).toBe("eval");
    expect(row.role_id).toBeNull();
    expect(row.task_id).toBeNull();
    expect(row.session_id).toBeNull();
    expect(row.message_id).toBeNull();
  });
});

// ─── TC4: empty perModel (pricingStatus='none'), mirror still fires ───────────

describe("TC4 — empty perModel, mirror still writes tasks.cost_usd", () => {
  it("returns rowsInserted=0 but tasks.cost_usd is still written (must-revise #2 guard)", async () => {
    const taskId = "tc4-task-" + Date.now();
    seedTask(taskId, 99); // non-null existing cost to prove it gets overwritten

    const recompute = {
      costUsd: 0,
      perModel: [],
      pricingStatus: "none" as const,
      unknownModels: [],
    };

    const result = await recordLlmCost({
      source: "task",
      taskId,
      recompute,
      mirror: true,
    });

    // No llm_costs rows inserted (no perModel entries)
    expect(result.rowsInserted).toBe(0);

    // Mirror still ran: tasks.cost_usd written
    const task = db.prepare(
      "SELECT cost_usd FROM tasks WHERE id = ?"
    ).get(taskId) as { cost_usd: number | null };

    // The mirror should have written the recompute.costUsd (0) — not left as the old 99
    expect(task.cost_usd).not.toBeNull();
    expect(task.cost_usd).toBeCloseTo(0, 6);
  });
});

// ─── TC5: idempotency — explicit callId passed twice ─────────────────────────

describe("TC5 — explicit callId idempotency", () => {
  it("calling twice with the same explicit callId does not double-insert", async () => {
    const taskId = "tc5-task-" + Date.now();
    seedTask(taskId, 0);

    const recompute = {
      costUsd: 0.005,
      perModel: [
        {
          model: "claude-sonnet-4-6",
          priced: true,
          estimated: false,
          inputTokens: 50,
          outputTokens: 25,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costUsd: 0.005,
        },
      ],
      pricingStatus: "priced" as const,
      unknownModels: [],
      sdkTotalCostUsd: 0.005,
    };

    const callId = "explicit-call-id-" + Date.now();

    // First call
    const r1 = await recordLlmCost({ source: "task", taskId, recompute, callId, mirror: true });
    expect(r1.callId).toBe(callId);

    const countAfterFirst = (db.prepare(
      "SELECT COUNT(*) AS cnt FROM llm_costs WHERE call_id = ?"
    ).get(callId) as { cnt: number }).cnt;

    // Second call with same callId — row already exists, should not double-insert
    await recordLlmCost({ source: "task", taskId, recompute, callId, mirror: true });

    const countAfterSecond = (db.prepare(
      "SELECT COUNT(*) AS cnt FROM llm_costs WHERE call_id = ?"
    ).get(callId) as { cnt: number }).cnt;

    // Either INSERT OR IGNORE semantics (no double-insert) OR the API
    // explicitly documents that callers pass unique callIds — either way,
    // the count must not grow on re-call with same callId.
    expect(countAfterSecond).toBe(countAfterFirst);
  });
});
