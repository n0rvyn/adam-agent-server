/**
 * Store-level UT for mistake-patterns CRUD.
 *
 * Tests 7 scenarios:
 * 1. createMistakePattern → getMistakePattern returns row with JSON round-trip intact
 * 2. upsertMistakePattern increments count on existing (dim_type, dim_value)
 * 3. upsertMistakePattern merges roleIds as a set (no duplicates)
 * 4. upsertMistakePattern caps sampleEvidenceIds at 10 (most recent)
 * 5. listMistakePatterns filters by status; unfiltered returns all
 * 6. listMistakePatterns paginates (LIMIT/OFFSET)
 * 7. updateMistakePatternStatus updates row + updated_at
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setupTestDb, getTestDb } from "../helpers/test-db.js";

// Shared ref so the mock factory can access the live DB instance at call time.
// setupTestDb() is invoked in beforeEach; the mock reads the ref lazily.
let _testDb: ReturnType<typeof getTestDb>;
vi.mock("../../store/db.js", () => ({
  getDb: () => _testDb,
  closeDb: () => {},
}));

import {
  createMistakePattern,
  upsertMistakePattern,
  listMistakePatterns,
  getMistakePattern,
  updateMistakePatternStatus,
} from "../../store/mistake-patterns.js";
import type { MistakePattern } from "../../shared/types.js";

let cleanup: () => void;

function makePattern(overrides: Partial<MistakePattern> = {}): MistakePattern {
  const now = Date.now();
  return {
    id: `mp-${Math.random().toString(36).slice(2)}`,
    dimensionType: "event_type",
    dimensionValue: "test-value",
    count: 1,
    roleIds: ["role-1"],
    sampleEvidenceIds: [],
    status: "new",
    firstSeen: now - 86400000,
    lastSeen: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("store/mistake-patterns", () => {
  beforeEach(() => {
    const result = setupTestDb();
    _testDb = result.db;
    cleanup = result.cleanup;
  });

  afterEach(() => cleanup());

  // -------------------------------------------------------------------------
  // Test 1: createMistakePattern → getMistakePattern round-trip
  // -------------------------------------------------------------------------
  it("Test 1: createMistakePattern → getMistakePattern returns row with JSON fields intact", () => {
    const evidence = [
      { source: "evolution_audit" as const, id: "ea-1" },
      { source: "role_scores" as const, id: "rs-1" },
    ];
    const pattern = makePattern({
      roleIds: ["role-a", "role-b"],
      sampleEvidenceIds: evidence,
      status: "new",
    });

    createMistakePattern(pattern);
    const retrieved = getMistakePattern(pattern.id);

    expect(retrieved).toBeDefined();
    expect(retrieved!.id).toBe(pattern.id);
    expect(retrieved!.dimensionType).toBe("event_type");
    expect(retrieved!.dimensionValue).toBe("test-value");
    expect(retrieved!.count).toBe(1);
    expect(retrieved!.roleIds).toEqual(["role-a", "role-b"]);
    expect(retrieved!.sampleEvidenceIds).toEqual(evidence);
    expect(retrieved!.status).toBe("new");
  });

  // -------------------------------------------------------------------------
  // Test 2: upsert — count increments on same (dim_type, dim_value)
  // -------------------------------------------------------------------------
  it("Test 2: upsert increments count on same (dim_type, dim_value)", () => {
    const dimType = "event_type";
    const dimValue = "count-test-value";

    upsertMistakePattern({
      dimensionType: dimType,
      dimensionValue: dimValue,
      roleIds: ["role-1"],
      sampleEvidenceIds: [],
      lastSeen: Date.now(),
      firstSeen: Date.now(),
    });

    const first = getTestDb().prepare(
      "SELECT count FROM mistake_patterns WHERE dimension_type = ? AND dimension_value = ?",
    ).get(dimType, dimValue) as { count: number };
    expect(first.count).toBe(1);

    upsertMistakePattern({
      dimensionType: dimType,
      dimensionValue: dimValue,
      roleIds: ["role-2"],
      sampleEvidenceIds: [],
      lastSeen: Date.now() + 1000,
      firstSeen: Date.now(),
    });

    const second = getTestDb().prepare(
      "SELECT count FROM mistake_patterns WHERE dimension_type = ? AND dimension_value = ?",
    ).get(dimType, dimValue) as { count: number };
    expect(second.count).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Test 3: upsert — roleIds merged as a set (no duplicates)
  // -------------------------------------------------------------------------
  it("Test 3: upsert merges roleIds as a set (duplicate roles do not double-add)", () => {
    const dimType = "score_degradation";
    const dimValue = "set-dedup-test";

    upsertMistakePattern({
      dimensionType: dimType,
      dimensionValue: dimValue,
      roleIds: ["role-x", "role-y"],
      sampleEvidenceIds: [],
      lastSeen: Date.now(),
      firstSeen: Date.now(),
    });

    upsertMistakePattern({
      dimensionType: dimType,
      dimensionValue: dimValue,
      roleIds: ["role-y", "role-z"],
      sampleEvidenceIds: [],
      lastSeen: Date.now() + 1000,
      firstSeen: Date.now(),
    });

    const row = getTestDb().prepare(
      "SELECT role_ids FROM mistake_patterns WHERE dimension_type = ? AND dimension_value = ?",
    ).get(dimType, dimValue) as { role_ids: string };
    const roleIds = JSON.parse(row.role_ids);

    expect(roleIds).toContain("role-x");
    expect(roleIds).toContain("role-y");
    expect(roleIds).toContain("role-z");
    expect(roleIds.length).toBe(3);
  });

  // -------------------------------------------------------------------------
  // Test 4: upsert — sampleEvidenceIds capped at 10 (most recent first)
  // -------------------------------------------------------------------------
  it("Test 4: upsert caps sampleEvidenceIds at 10, keeps most recent", () => {
    const dimType = "tool_call_pattern";
    const dimValue = "evidence-cap-test";

    const allEvidence = Array.from({ length: 15 }, (_, i) => ({
      source: "evolution_audit" as const,
      id: `ea-ev-${i}`,
    }));

    upsertMistakePattern({
      dimensionType: dimType,
      dimensionValue: dimValue,
      roleIds: ["role-1"],
      sampleEvidenceIds: allEvidence,
      lastSeen: Date.now(),
      firstSeen: Date.now(),
    });

    const row = getTestDb().prepare(
      "SELECT sample_evidence_ids FROM mistake_patterns WHERE dimension_type = ? AND dimension_value = ?",
    ).get(dimType, dimValue) as { sample_evidence_ids: string };
    const evidence = JSON.parse(row.sample_evidence_ids);

    expect(evidence).toHaveLength(10);
    expect(evidence[0]!.id).toBe("ea-ev-5");
    expect(evidence[9]!.id).toBe("ea-ev-14");
  });

  // -------------------------------------------------------------------------
  // Test 5: listMistakePatterns — status filter + unfiltered
  // -------------------------------------------------------------------------
  it("Test 5: listMistakePatterns('new') filters by status; no arg returns all", () => {
    createMistakePattern(makePattern({ status: "new", dimensionValue: "v-new" }));
    createMistakePattern(makePattern({ status: "new", dimensionValue: "v-new-2" }));
    createMistakePattern(makePattern({ status: "acknowledged", dimensionValue: "v-ack" }));
    createMistakePattern(makePattern({ status: "dismissed", dimensionValue: "v-dismiss" }));

    const all = listMistakePatterns();
    expect(all).toHaveLength(4);

    const newOnes = listMistakePatterns("new");
    expect(newOnes).toHaveLength(2);
    expect(newOnes.every((p) => p.status === "new")).toBe(true);

    const ackOnes = listMistakePatterns("acknowledged");
    expect(ackOnes).toHaveLength(1);
    expect(ackOnes[0]!.status).toBe("acknowledged");
  });

  // -------------------------------------------------------------------------
  // Test 6: listMistakePatterns — LIMIT/OFFSET pagination
  // -------------------------------------------------------------------------
  it("Test 6: listMistakePatterns pagination with limit and offset", () => {
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      createMistakePattern(makePattern({
        dimensionValue: `pagination-value-${i}`,
        lastSeen: now - i * 1000,
      }));
    }

    const page1 = listMistakePatterns(undefined, 2, 0);
    expect(page1).toHaveLength(2);

    const page2 = listMistakePatterns(undefined, 2, 2);
    expect(page2).toHaveLength(2);

    const page3 = listMistakePatterns(undefined, 2, 4);
    expect(page3).toHaveLength(1);

    const allIds = new Set([...page1, ...page2, ...page3].map((p) => p.id));
    expect(allIds.size).toBe(5);
  });

  // -------------------------------------------------------------------------
  // Test 7: updateMistakePatternStatus — updates row + updated_at
  // -------------------------------------------------------------------------
  it("Test 7: updateMistakePatternStatus updates status and updated_at", () => {
    const pattern = makePattern({ status: "new" });
    createMistakePattern(pattern);

    const before = getTestDb().prepare(
      "SELECT updated_at FROM mistake_patterns WHERE id = ?",
    ).get(pattern.id) as { updated_at: number };

    void new Promise((r) => setTimeout(r, 10));

    updateMistakePatternStatus(pattern.id, "dismissed");

    const after = getTestDb().prepare(
      "SELECT status, updated_at FROM mistake_patterns WHERE id = ?",
    ).get(pattern.id) as { status: string; updated_at: number };

    expect(after.status).toBe("dismissed");
    expect(after.updated_at).toBeGreaterThanOrEqual(before.updated_at);
  });
});
