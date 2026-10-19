import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";
import { memoryGcTick } from "../../agent/memory-gc.js";

const { cleanup } = setupTestDb();
vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

afterAll(() => cleanup());
beforeEach(() => clearTestDb());

function seedMemory(id: string, ageMs: number, kind = "observation"): void {
  const db = getTestDb();
  const createdAt = Date.now() - ageMs;
  db.prepare(
    "INSERT INTO memories (id, role_id, type, content, importance, source_type, created_at, last_accessed, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, "r1", "event", `memory-${id}`, 3, "test", createdAt, createdAt, kind);
}

function seedBelief(
  id: string,
  ageMs: number,
  isAnti = false,
): void {
  const db = getTestDb();
  const ts = Date.now() - ageMs;
  db.prepare(
    "INSERT INTO beliefs (id, role_id, content, is_anti, created_at, last_used_at, last_validated_at, status, inject_count) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 0)",
  ).run(id, "r1", `belief-${id}`, isAnti ? 1 : 0, ts, ts, ts);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("memoryGcTick", () => {
  it("deletes observations older than TTL", () => {
    // 1 fresh (1h old), 2 aged (15d old)
    seedMemory("m-fresh", 60 * 60 * 1000);
    seedMemory("m-old-a", 15 * 24 * 60 * 60 * 1000);
    seedMemory("m-old-b", 20 * 24 * 60 * 60 * 1000);

    const report = memoryGcTick({ observationTtlDays: 14 });

    expect(report.observationsDeleted).toBe(2);
    const db = getTestDb();
    const remaining = db.prepare("SELECT id FROM memories WHERE kind = 'observation'").all() as { id: string }[];
    expect(remaining.map((r) => r.id)).toEqual(["m-fresh"]);
  });

  it("preserves anti-pattern beliefs regardless of age (v3: archive sweep skips is_anti=1)", () => {
    seedBelief("b-anti", 365 * 24 * 60 * 60 * 1000, true);

    const report = memoryGcTick({ observationTtlDays: 14 });

    expect(report.beliefsArchived).toBe(0);
    const db = getTestDb();
    const anti = db.prepare("SELECT id FROM beliefs WHERE is_anti = 1").all() as { id: string }[];
    expect(anti.map((r) => r.id)).toContain("b-anti");
  });

  it("updates server_state.last_memory_gc_at", () => {
    const db = getTestDb();
    db.prepare("DELETE FROM server_state WHERE id = 1").run();
    db.prepare("INSERT INTO server_state (id, schema_version, created_at) VALUES (1, 68, ?)").run(Date.now());
    const before = Date.now();
    memoryGcTick({ observationTtlDays: 14 });
    const row = db.prepare("SELECT last_memory_gc_at FROM server_state WHERE id = 1").get() as { last_memory_gc_at: number };
    expect(row.last_memory_gc_at).toBeGreaterThanOrEqual(before);
  });
});
