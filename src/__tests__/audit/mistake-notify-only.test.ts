/**
 * Notify-only enforcement UT — diff-hash assertion.
 *
 * Crystal ref: [D-S04]
 *
 * Scope: aggregator + audit-tools tool handler path only.
 * The full digest flow (which legitimately writes delivery_log) is out of scope.
 *
 * Verifies: running aggregate_mistakes tool against seeded data produces NO
 * side effects in the 5 "read-only" tables: roles, role_scores, evolution_audit,
 * delivery_rules, delivery_log.
 */

import { createHash } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setupTestDb, getTestDb } from "../helpers/test-db.js";

// ---------------------------------------------------------------------------
// Capture the raw tool handler from the mocked SDK
// ---------------------------------------------------------------------------
let rawHandler: ((args: unknown) => Promise<unknown>) | null = null;

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: vi.fn((config: { name?: string; tools: unknown[] }) => {
    const tools = config.tools as Array<{ name: string; handler: (args: unknown) => Promise<unknown> }>;
    rawHandler = tools[0]?.handler ?? null;
    return {
      instance: {},
      type: "sdk",
      name: config.name,
      config: { tools },
    };
  }),
  tool: vi.fn((_name: string, _desc: string, _schema: unknown, handler: (args: unknown) => Promise<unknown>) => {
    return { name: "aggregate_mistakes", handler };
  }),
}));

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

// ---------------------------------------------------------------------------
// Helper: SHA-256 of all rows in a table (ordered by id)
// ---------------------------------------------------------------------------
function hashTable(db: ReturnType<typeof getTestDb>, table: string): string {
  const rows = db.prepare(`SELECT * FROM ${table} ORDER BY id`).all();
  const text = JSON.stringify(rows);
  return createHash("sha256").update(text).digest("hex");
}

// ---------------------------------------------------------------------------
// Helper: hash all 5 notify-only tables
// ---------------------------------------------------------------------------
function hashAllTables(db: ReturnType<typeof getTestDb>): Record<string, string> {
  return {
    roles: hashTable(db, "roles"),
    role_scores: hashTable(db, "role_scores"),
    evolution_audit: hashTable(db, "evolution_audit"),
    delivery_rules: hashTable(db, "delivery_rules"),
    delivery_log: hashTable(db, "delivery_log"),
  };
}

// ---------------------------------------------------------------------------
// Helper: seed notify-only tables with realistic data
// ---------------------------------------------------------------------------
function seedNotifyOnlyTables(db: ReturnType<typeof getTestDb>): void {
  const now = Date.now();
  const day = 86_400_000;

  // Dummy tasks first (role_scores has FK REFERENCES tasks(id))
  const taskIds = ["task-1", "task-2", "task-3", "task-4"];
  for (const tid of taskIds) {
    db.prepare(`INSERT INTO tasks (id, status, prompt, config, created_at)
      VALUES (?, ?, ?, ?, ?)`).run(tid, "completed", "test prompt", "{}", now);
  }

  // 2 roles
  db.prepare(`INSERT INTO roles (id, name, cag_prompt, memory_stream_id, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run("role-test-1", "Test Role 1", "prompt1", "ms-1", "active", now);
  db.prepare(`INSERT INTO roles (id, name, cag_prompt, memory_stream_id, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run("role-test-2", "Test Role 2", "prompt2", "ms-2", "active", now);

  // ~4 role_scores history rows (with low scores to trip the threshold)
  const scoreRows = [
    { id: "rs-1", role_id: "role-test-1", task_id: "task-1", score_json: '{"weighted":0.2}', ema_score: 0.3, created_at: now - 2 * day },
    { id: "rs-2", role_id: "role-test-2", task_id: "task-2", score_json: '{"weighted":0.25}', ema_score: 0.35, created_at: now - 1 * day },
    { id: "rs-3", role_id: "role-test-1", task_id: "task-3", score_json: '{"weighted":0.22}', ema_score: 0.28, created_at: now - 3 * day },
    { id: "rs-4", role_id: "role-test-2", task_id: "task-4", score_json: '{"weighted":0.19}', ema_score: 0.26, created_at: now - 4 * day },
  ];
  for (const r of scoreRows) {
    db.prepare(`INSERT INTO role_scores (id, role_id, task_id, score_json, ema_score, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(r.id, r.role_id, r.task_id, r.score_json, r.ema_score, r.created_at);
  }

  // ~6 evolution_audit rows spread across both roles
  const auditRows = [
    { id: "ea-1", role_id: "role-test-1", source: "audit", timestamp: now - 1 * day },
    { id: "ea-2", role_id: "role-test-2", source: "audit", timestamp: now - 2 * day },
    { id: "ea-3", role_id: "role-test-1", source: "monitor", timestamp: now - 3 * day },
    { id: "ea-4", role_id: "role-test-2", source: "admin", timestamp: now - 4 * day },
    { id: "ea-5", role_id: "role-test-1", source: "audit", timestamp: now - 5 * day },
    { id: "ea-6", role_id: "role-test-2", source: "audit", timestamp: now - 6 * day },
  ];
  for (const r of auditRows) {
    db.prepare(`INSERT INTO evolution_audit (id, role_id, source, timestamp)
      VALUES (?, ?, ?, ?)`).run(r.id, r.role_id, r.source, r.timestamp);
  }

  // 1 delivery_rule
  db.prepare(`INSERT INTO delivery_rules (id, event_type, match_criteria, target, created_at)
    VALUES (?, ?, ?, ?, ?)`).run("dr-1", "task_complete", '{"taskId":"*"}', '{"type":"webhook","url":"http://x.y"}', now);

  // delivery_log FK references delivery_rules(id) and tasks(id) — task-1 and task-2 already inserted above
  db.prepare(`INSERT INTO delivery_log (id, rule_id, task_id, status, target, content, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run("dl-1", "dr-1", "task-1", "delivered", "http://x.y", "result", now + 86400000, now);
  db.prepare(`INSERT INTO delivery_log (id, rule_id, task_id, status, target, content, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run("dl-2", "dr-1", "task-2", "delivered", "http://x.y", "result", now + 86400000, now);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("audit/mistake-notify-only — D-S04 enforcement", () => {
  beforeEach(() => {
    vi.resetModules();
    setupTestDb();
    rawHandler = null;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("aggregator + audit-tools tool writes only to mistake_patterns; all 5 notify-only tables unchanged", async () => {
    const db = getTestDb();
    seedNotifyOnlyTables(db);

    // Capture pre-run hashes
    const pre = hashAllTables(db);

    // Run the aggregator directly with permissive thresholds (force-write path)
    const { aggregateMistakes } = await import("../../audit/mistake-aggregator.js");
    const result = aggregateMistakes({
      windowDays: 30,
      dimensions: ["event_type", "score_degradation", "tool_call_pattern"],
      minOccurrences: 1,
      minRoles: 1,
      scoreThresholdEma: 0.5,
      scoreThresholdTask: 0.3,
    });

    // Also invoke the tool handler directly (covers the MCP wrapper)
    const { createAuditTools } = await import("../../manager/audit-tools.js");
    createAuditTools();
    expect(rawHandler).not.toBeNull();
    await rawHandler!({ windowDays: 30, minOccurrences: 1, minRoles: 1 });

    // Capture post-run hashes
    const post = hashAllTables(db);

    // Assert: all 5 notify-only tables byte-identical before and after
    expect(post.roles).toBe(pre.roles);
    expect(post.role_scores).toBe(pre.role_scores);
    expect(post.evolution_audit).toBe(pre.evolution_audit);
    expect(post.delivery_rules).toBe(pre.delivery_rules);
    expect(post.delivery_log).toBe(pre.delivery_log);

    // Assert: mistake_patterns strictly increased (aggregator IS allowed to write here)
    const afterCount = db.prepare("SELECT COUNT(*) as c FROM mistake_patterns").get() as { c: number };
    expect(afterCount.c).toBeGreaterThan(0);
    expect(result.patternsUpserted).toBeGreaterThan(0);
  });
});
