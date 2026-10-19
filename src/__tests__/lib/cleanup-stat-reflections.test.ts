import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";
import {
  countStatReflections,
  deleteStatReflections,
  STAT_REFLECTION_PATTERNS,
  STAT_REFLECTION_EXACT,
} from "../../lib/cleanup-stat-reflections.js";
import { createMemory } from "../../store/memories.js";
import { createRole } from "../../store/roles.js";
import type { MemoryNode } from "../../shared/types.js";

const { cleanup } = setupTestDb();
vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

afterAll(() => cleanup());
beforeEach(() => clearTestDb());

function seedRole(id = "test-role"): void {
  createRole({
    id,
    name: `Test Role ${id}`,
    cagPrompt: "",
    learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
    memoryStreamId: `stream-${id}`,
    status: "active",
    preferences: {},
    createdAt: Date.now(),
  });
}

function seedStatMemory(roleId: string, id: string, content: string): void {
  const mem: MemoryNode = {
    id,
    roleId,
    type: "reflection",
    content,
    keywords: [],
    importance: 3,
    sourceType: "task_complete",
    sourceTaskId: undefined,
    createdAt: Date.now(),
    lastAccessed: Date.now(),
    retrievedCount: 0,
    tier: "episodic",
  };
  createMemory(mem);
}

function seedAuthenticMemory(roleId: string, id: string, content: string): void {
  const mem: MemoryNode = {
    id,
    roleId,
    type: "event",
    content,
    keywords: [],
    importance: 3,
    sourceType: "task_complete",
    sourceTaskId: undefined,
    createdAt: Date.now(),
    lastAccessed: Date.now(),
    retrievedCount: 0,
    tier: "episodic",
  };
  createMemory(mem);
}

describe("lib/cleanup-stat-reflections", () => {
  describe("countStatReflections", () => {
    it("count_returns_correct_total", () => {
      seedRole();
      // Pattern A: 2 rows
      seedStatMemory("test-role", "m1", "Reflection: Made 3 file modifications in /src/utils");
      seedStatMemory("test-role", "m2", "Reflection: Made 7 file modifications in /lib");
      // Pattern B: 1 row
      seedStatMemory("test-role", "m3", "Reflection: No significant patterns found in recent observations");
      // Exact: 1 row
      seedStatMemory("test-role", "m4", "Reflection: Total 50 significant events observed.");
      // Authentic: 2 rows (must NOT match)
      seedAuthenticMemory("test-role", "m5", "Reflection: I noticed a real signal about user preferences");
      seedAuthenticMemory("test-role", "m6", "Reflection: A pattern emerged — files get modified when tests pass");

      const summary = countStatReflections(getTestDb(), 5);

      expect(summary.total).toBe(4);
      expect(summary.byPattern[STAT_REFLECTION_PATTERNS[0]]).toBe(2);
      expect(summary.byPattern[STAT_REFLECTION_PATTERNS[1]]).toBe(1);
      expect(summary.byPattern[STAT_REFLECTION_EXACT]).toBe(1);
    });

    it("count_sample_size_respects_sampleSize_param", () => {
      seedRole();
      for (let i = 0; i < 6; i++) {
        seedStatMemory("test-role", `s${i}`, `Reflection: Made ${i + 1} file modifications`);
      }

      const summary = countStatReflections(getTestDb(), 3);
      expect(summary.sample.length).toBe(3);
    });

    it("count_returns_empty_on_clean_db", () => {
      seedRole();

      const summary = countStatReflections(getTestDb(), 5);

      expect(summary.total).toBe(0);
      expect(summary.sample.length).toBe(0);
      expect(Object.values(summary.byPattern).every((n) => n === 0)).toBe(true);
    });
  });

  describe("deleteStatReflections", () => {
    it("delete_removes_matching_rows", () => {
      seedRole();
      seedStatMemory("test-role", "m1", "Reflection: Made 3 file modifications");
      seedStatMemory("test-role", "m2", "Reflection: Made 5 file modifications");
      seedStatMemory("test-role", "m3", "Reflection: No significant patterns detected");
      seedStatMemory("test-role", "m4", "Reflection: Total 50 significant events observed.");
      seedAuthenticMemory("test-role", "m5", "Reflection: I noticed a real signal about user preferences");
      seedAuthenticMemory("test-role", "m6", "Real event: build succeeded after refactor");

      const db = getTestDb();
      const before = (db.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number }).n;
      expect(before).toBe(6);

      const deleted = deleteStatReflections(db);

      expect(deleted).toBe(4);
      const after = (db.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number }).n;
      expect(after).toBe(2);
    });

    it("delete_authentic_content_untouched", () => {
      seedRole();
      seedStatMemory("test-role", "s1", "Reflection: Made 3 file modifications");
      seedStatMemory("test-role", "s2", "Reflection: Total 50 significant events observed.");
      seedAuthenticMemory("test-role", "a1", "Reflection: I noticed a real signal about user preferences");
      seedAuthenticMemory("test-role", "a2", "Observation: TTS audio was too quiet for delivery");

      deleteStatReflections(getTestDb());

      const db = getTestDb();
      const a1 = db.prepare("SELECT id FROM memories WHERE id = ?").get("a1");
      const a2 = db.prepare("SELECT id FROM memories WHERE id = ?").get("a2");
      expect(a1).toBeDefined();
      expect(a2).toBeDefined();

      // Verify content is intact
      const a1Row = db.prepare("SELECT content FROM memories WHERE id = ?").get("a1") as { content: string };
      expect(a1Row.content).toBe("Reflection: I noticed a real signal about user preferences");
    });

    it("delete_is_transactional", () => {
      seedRole();
      seedStatMemory("test-role", "t1", "Reflection: Made 1 file modification");
      seedStatMemory("test-role", "t2", "Reflection: Made 2 file modifications");

      // Patch db.prepare for DELETE to throw on the second pattern
      const db = getTestDb();
      const prepare = db.prepare.bind(db);
      let callCount = 0;
      vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
        if (sql.includes("DELETE FROM memories WHERE content LIKE")) {
          callCount++;
          if (callCount >= 2) throw new Error("simulated transaction failure");
        }
        return prepare(sql);
      });

      expect(() => deleteStatReflections(db)).toThrow("simulated transaction failure");

      // All stat rows should remain after rollback
      const remaining = (db.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number }).n;
      expect(remaining).toBe(2);

      vi.restoreAllMocks();
    });
  });
});
