import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setupTestDb, getTestDb } from "../helpers/test-db.js";
import type { MistakePattern } from "../../shared/types.js";

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

describe("audit/mistake-aggregator", () => {
  let cleanup: () => void;

  beforeEach(() => {
    const { cleanup: c, db } = setupTestDb();
    cleanup = c;
    // Disable FK enforcement for aggregator tests — we seed supporting rows
    // (tasks, delivery_rules) purely to satisfy FK constraints; the FK values
    // themselves are not what we're testing.
    db.pragma("foreign_keys = OFF");
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup!();
  });

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  function insertEvolutionAudit(params: {
    id: string;
    roleId: string;
    source: string;
    timestamp?: number;
  }) {
    const db = getTestDb();
    db.prepare(`
      INSERT INTO evolution_audit (id, role_id, source, timestamp)
      VALUES (?, ?, ?, ?)
    `).run(params.id, params.roleId, params.source, params.timestamp ?? Date.now());
  }

  function insertRoleScore(params: {
    id: string;
    roleId: string;
    taskId: string;
    emaScore: number;
    scoreJson?: string;
    createdAt?: number;
  }) {
    const db = getTestDb();
    // FK enforcement is OFF in beforeEach; use explicit INSERT INTO with all required columns
    db.prepare(`
      INSERT INTO tasks (id, role_id, status, prompt, config, created_at)
      VALUES (?, ?, 'completed', '', '{}', ?)
    `).run(params.taskId, params.roleId, params.createdAt ?? Date.now());
    db.prepare(`
      INSERT INTO role_scores (id, role_id, task_id, score_json, ema_score, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      params.id,
      params.roleId,
      params.taskId,
      params.scoreJson ?? JSON.stringify({ weighted: 0.5 }),
      params.emaScore,
      params.createdAt ?? Date.now(),
    );
  }

  function insertSandboxViolation(params: {
    id: string;
    taskId: string;
    roleId: string;
    error: string;
    createdAt?: number;
  }) {
    const db = getTestDb();
    // FK enforcement is OFF (beforeEach), so use explicit INSERT INTO with all required columns
    db.prepare(`
      INSERT INTO tasks (id, role_id, status, prompt, config, created_at)
      VALUES (?, ?, 'completed', '', '{}', ?)
    `).run(params.taskId, params.roleId, params.createdAt ?? Date.now());
    db.prepare(`INSERT OR REPLACE INTO delivery_rules (id, match_criteria, event_type, enabled, target, created_at) VALUES ('rule-test', '{}', '*', 1, '{}', ?)`)
      .run(params.createdAt ?? Date.now());
    db.prepare(`
      INSERT INTO delivery_log (id, rule_id, task_id, status, target, content, attempts, error, created_at, expires_at, source, message_type)
      VALUES (?, 'rule-test', ?, 'delivered', 'test-target', 'violation', 1, ?, ?, ?, 'audit', 'sandbox_violation')
    `).run(params.id, params.taskId, params.error, params.createdAt ?? Date.now(), params.createdAt ?? Date.now());
  }

  async function listPatterns(): Promise<MistakePattern[]> {
    const { listMistakePatterns } = await import("../../store/mistake-patterns.js");
    return listMistakePatterns();
  }

  async function runAggregator(opts?: Parameters<typeof import("../../audit/mistake-aggregator.js")["aggregateMistakes"]>[0]) {
    const { aggregateMistakes } = await import("../../audit/mistake-aggregator.js");
    return aggregateMistakes(opts);
  }

  // -------------------------------------------------------------------------
  // Test 1: evolution_audit → pattern across 2 roles
  // -------------------------------------------------------------------------

  it("Test 1: 3 evolution_audit rows across 2 roles emits 1 pattern (count=3, roleIds.length=2)", async () => {
    const now = Date.now();
    insertEvolutionAudit({ id: "ev1", roleId: "role-a", source: "audit", timestamp: now });
    insertEvolutionAudit({ id: "ev2", roleId: "role-b", source: "audit", timestamp: now + 1000 });
    insertEvolutionAudit({ id: "ev3", roleId: "role-a", source: "audit", timestamp: now + 2000 });

    const result = await runAggregator({ windowDays: 14, minOccurrences: 3, minRoles: 2 });

    expect(result.patternsUpserted).toBe(1);
    expect(result.totalEventsScanned).toBe(3);

    const patterns = await listPatterns();
    expect(patterns).toHaveLength(1);
    expect(patterns[0]!.dimensionType).toBe("event_type");
    expect(patterns[0]!.dimensionValue).toBe("audit");
    expect(patterns[0]!.count).toBe(1); // first upsert = count 1
    expect(patterns[0]!.roleIds).toContain("role-a");
    expect(patterns[0]!.roleIds).toContain("role-b");
  });

  // -------------------------------------------------------------------------
  // Test 2: reflection source is excluded
  // -------------------------------------------------------------------------

  it("Test 2: source=reflection emits 0 patterns (reflection excluded from allowlist)", async () => {
    const now = Date.now();
    insertEvolutionAudit({ id: "ev1", roleId: "role-a", source: "reflection", timestamp: now });
    insertEvolutionAudit({ id: "ev2", roleId: "role-b", source: "reflection", timestamp: now + 1000 });
    insertEvolutionAudit({ id: "ev3", roleId: "role-a", source: "reflection", timestamp: now + 2000 });

    const result = await runAggregator({ windowDays: 14, minOccurrences: 3, minRoles: 2 });

    expect(result.patternsUpserted).toBe(0);
    expect(result.totalEventsScanned).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Test 3: below minOccurrences threshold
  // -------------------------------------------------------------------------

  it("Test 3: 2 rows below minOccurrences=3 emits 0 patterns", async () => {
    const now = Date.now();
    insertEvolutionAudit({ id: "ev1", roleId: "role-a", source: "audit", timestamp: now });
    insertEvolutionAudit({ id: "ev2", roleId: "role-b", source: "audit", timestamp: now + 1000 });

    const result = await runAggregator({ windowDays: 14, minOccurrences: 3, minRoles: 2 });

    expect(result.patternsUpserted).toBe(0);
    expect(result.totalEventsScanned).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Test 4: below minRoles threshold (same role only)
  // -------------------------------------------------------------------------

  it("Test 4: 3 rows for same role_id below minRoles=2 emits 0 patterns", async () => {
    const now = Date.now();
    insertEvolutionAudit({ id: "ev1", roleId: "role-a", source: "audit", timestamp: now });
    insertEvolutionAudit({ id: "ev2", roleId: "role-a", source: "audit", timestamp: now + 1000 });
    insertEvolutionAudit({ id: "ev3", roleId: "role-a", source: "audit", timestamp: now + 2000 });

    const result = await runAggregator({ windowDays: 14, minOccurrences: 3, minRoles: 2 });

    expect(result.patternsUpserted).toBe(0);
    expect(result.totalEventsScanned).toBe(3);
  });

  // -------------------------------------------------------------------------
  // Test 5: score_degradation dimension with low_ema across 2 roles
  // -------------------------------------------------------------------------

  it("Test 5: 2 role_scores rows with ema=0.3 across 2 roles emits pattern with dimension_type=score_degradation, dim_value=low_ema", async () => {
    const now = Date.now();
    insertRoleScore({ id: "rs1", roleId: "role-a", taskId: "task-a", emaScore: 0.3, createdAt: now });
    insertRoleScore({ id: "rs2", roleId: "role-b", taskId: "task-b", emaScore: 0.3, createdAt: now + 1000 });

    const result = await runAggregator({
      windowDays: 14,
      minOccurrences: 2,
      minRoles: 2,
      scoreThresholdEma: 0.5,
      scoreThresholdTask: 0.3,
    });

    expect(result.patternsUpserted).toBe(1);
    expect(result.dimensionCounts["score_degradation"]).toBe(1);

    const patterns = await listPatterns();
    expect(patterns).toHaveLength(1);
    expect(patterns[0]!.dimensionType).toBe("score_degradation");
    expect(patterns[0]!.dimensionValue).toBe("low_ema");
    expect(patterns[0]!.roleIds).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // Test 6: mixed low_ema + low_task events produce separate buckets
  // -------------------------------------------------------------------------

  it("Test 6: low_ema + low_task events produce separate score_degradation buckets", async () => {
    const now = Date.now();
    insertRoleScore({ id: "rs1", roleId: "role-a", taskId: "task-a", emaScore: 0.3, scoreJson: JSON.stringify({ weighted: 0.8 }), createdAt: now });
    insertRoleScore({ id: "rs2", roleId: "role-b", taskId: "task-b", emaScore: 0.7, scoreJson: JSON.stringify({ weighted: 0.2 }), createdAt: now + 1000 });

    const result = await runAggregator({
      windowDays: 14,
      minOccurrences: 1,
      minRoles: 1,
      scoreThresholdEma: 0.5,
      scoreThresholdTask: 0.3,
    });

    const patterns = await listPatterns();
    expect(patterns).toHaveLength(2);
    const dimValues = patterns.map((p) => p.dimensionValue).sort();
    expect(dimValues).toContain("low_ema");
    expect(dimValues).toContain("low_task");
  });

  // -------------------------------------------------------------------------
  // Test 7: delivery_log sandbox_violation dimension
  // -------------------------------------------------------------------------

  it("Test 7: 2 sandbox_violation rows across 2 roles with same error prefix creates tool_call_pattern bucket", async () => {
    const now = Date.now();
    const ts = now - 1000;
    insertSandboxViolation({ id: "dl1", taskId: "task-a", roleId: "role-a", error: "file-read on /etc/passwd", createdAt: ts });
    insertSandboxViolation({ id: "dl2", taskId: "task-b", roleId: "role-b", error: "file-read on /etc/passwd", createdAt: ts + 1000 });

    const result = await runAggregator({ windowDays: 14, minOccurrences: 2, minRoles: 2 });

    const patterns = await listPatterns();
    const fileReadPatterns = patterns.filter(
      (p) => p.dimensionType === "tool_call_pattern" && p.dimensionValue.includes("file-read"),
    );
    expect(fileReadPatterns).toHaveLength(1);
    expect(fileReadPatterns[0]!.count).toBe(1);
    expect(fileReadPatterns[0]!.roleIds).toContain("role-a");
    expect(fileReadPatterns[0]!.roleIds).toContain("role-b");
  });

  // -------------------------------------------------------------------------
  // Test 8: re-run increments count and dedupes role_ids
  // -------------------------------------------------------------------------

  it("Test 8: re-run aggregator increments existing pattern count, does not duplicate role_ids", async () => {
    const now = Date.now();
    insertEvolutionAudit({ id: "ev1", roleId: "role-a", source: "audit", timestamp: now });
    insertEvolutionAudit({ id: "ev2", roleId: "role-b", source: "audit", timestamp: now + 1000 });
    insertEvolutionAudit({ id: "ev3", roleId: "role-a", source: "audit", timestamp: now + 2000 });

    const r1 = await runAggregator({ windowDays: 14, minOccurrences: 3, minRoles: 2 });
    expect(r1.patternsUpserted).toBe(1);

    const p1 = (await listPatterns())[0]!;
    expect(p1.count).toBe(1);
    expect(p1.roleIds).toHaveLength(2);
    expect(p1.roleIds).toContain("role-a");
    expect(p1.roleIds).toContain("role-b");

    // Second run: add 2 more events for role-a and role-b
    insertEvolutionAudit({ id: "ev4", roleId: "role-a", source: "audit", timestamp: now + 3000 });
    insertEvolutionAudit({ id: "ev5", roleId: "role-b", source: "audit", timestamp: now + 4000 });

    const r2 = await runAggregator({ windowDays: 14, minOccurrences: 3, minRoles: 2 });
    expect(r2.patternsUpserted).toBe(1);

    const p2 = (await listPatterns())[0]!;
    expect(p2.count).toBe(2);
    expect(p2.roleIds).toHaveLength(2); // still 2, no duplicates
  });

  // -------------------------------------------------------------------------
  // Test 9: sampleEvidenceIds caps at 10
  // -------------------------------------------------------------------------

  it("Test 9: inserting 15 events keeps only the 10 most-recent evidence IDs", async () => {
    const now = Date.now();
    for (let i = 1; i <= 15; i++) {
      const roleId = i % 2 === 0 ? "role-a" : "role-b";
      insertEvolutionAudit({ id: `ev${i}`, roleId, source: "audit", timestamp: now + i * 1000 });
    }

    await runAggregator({ windowDays: 14, minOccurrences: 3, minRoles: 2 });

    const patterns = await listPatterns();
    expect(patterns).toHaveLength(1);
    // Evidence capped at 10
    expect(patterns[0]!.sampleEvidenceIds).toHaveLength(10);
    // Most recent 10: ev6 through ev15
    const ids = patterns[0]!.sampleEvidenceIds.map((e) => e.id).sort();
    expect(ids).toContain("ev6");
    expect(ids).toContain("ev15");
    expect(ids).not.toContain("ev1");
    expect(ids).not.toContain("ev5");
  });

  // -------------------------------------------------------------------------
  // Test 10: transaction rollback — mid-iteration failure leaves no partial rows
  // -------------------------------------------------------------------------

  it("Test 10: mid-iteration failure rolls back completely — no partial rows written", async () => {
    vi.resetModules();
    vi.doMock("../../store/db.js", () => ({
      getDb: () => getTestDb(),
      closeDb: () => {},
    }));

    // Seed 2 qualifying buckets: audit (3 roles) and monitor (3 roles)
    const db = getTestDb();
    const now = Date.now();
    db.prepare(`INSERT INTO evolution_audit (id, role_id, source, timestamp) VALUES (?, ?, ?, ?)`).run("ev1", "role-a", "audit", now);
    db.prepare(`INSERT INTO evolution_audit (id, role_id, source, timestamp) VALUES (?, ?, ?, ?)`).run("ev2", "role-b", "audit", now + 1000);
    db.prepare(`INSERT INTO evolution_audit (id, role_id, source, timestamp) VALUES (?, ?, ?, ?)`).run("ev3", "role-c", "audit", now + 2000);
    db.prepare(`INSERT INTO evolution_audit (id, role_id, source, timestamp) VALUES (?, ?, ?, ?)`).run("ev4", "role-a", "monitor", now);
    db.prepare(`INSERT INTO evolution_audit (id, role_id, source, timestamp) VALUES (?, ?, ?, ?)`).run("ev5", "role-b", "monitor", now + 1000);
    db.prepare(`INSERT INTO evolution_audit (id, role_id, source, timestamp) VALUES (?, ?, ?, ?)`).run("ev6", "role-c", "monitor", now + 2000);

    // Spy on upsertMistakePattern to fail on the 2nd call
    const { upsertMistakePattern: realUpsert } = await import("../../store/mistake-patterns.js");
    let callCount = 0;
    vi.spyOn(await import("../../store/mistake-patterns.js"), "upsertMistakePattern")
      .mockImplementation((bucket) => {
        callCount++;
        if (callCount >= 2) throw new Error("injected failure on bucket 2");
        return realUpsert(bucket);
      });

    const { aggregateMistakes } = await import("../../audit/mistake-aggregator.js");

    // aggregateMistakes wraps upsert in a transaction — the throw should propagate
    expect(() => aggregateMistakes({ windowDays: 14, minOccurrences: 3, minRoles: 2 })).toThrow();

    // After rollback, mistake_patterns must be empty
    const { listMistakePatterns } = await import("../../store/mistake-patterns.js");
    const patterns = listMistakePatterns();
    expect(patterns).toHaveLength(0);
  });
});
