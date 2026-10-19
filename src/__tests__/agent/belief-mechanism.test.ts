/**
 * Task 3-tests: Belief mechanism module tests
 *
 * Tests for belief-mechanism.ts functions:
 *   - computeEffectiveEma
 *   - materializeOnTouch
 *   - bumpInjectCount (DP-001/DP-002 B: separate from EMA writes)
 *   - applyFitnessUpdate (does NOT touch inject_count per DP-002 B)
 *   - checkArchiveThreshold
 *   - archiveBelief
 *
 * Pre-impl: ALL tests FAIL with "Cannot find module '../../agent/belief-mechanism.js'".
 * Post-impl (Task 3-impl): tests pass.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";
import type { Belief } from "../../shared/types.js";

// KB postmortem 2026-04-05
vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

const { runtimeConfigMock } = vi.hoisted(() => ({
  runtimeConfigMock: vi.fn(() => ({
    memory: {
      scope: {
        archiveThreshold: 0.2,
        decayBase: 0.995,
        emaAlpha: 0.3,
        reflectionPoolMax: 100,
      },
    },
  })),
}));
vi.mock("../../config/runtime.js", () => ({
  getRuntimeConfig: runtimeConfigMock,
}));

import {
  computeEffectiveEma,
  materializeOnTouch,
  applyFitnessUpdate,
  checkArchiveThreshold,
  archiveBelief,
} from "../../agent/belief-mechanism.js";
import { bumpInjectCount, getBelief } from "../../store/beliefs.js";

const { cleanup } = setupTestDb();
afterAll(() => cleanup());
beforeEach(() => clearTestDb());

/** Helper to insert a minimal belief row and return it as a Belief-like object */
function seedBelief(overrides: {
  id?: string;
  successEma?: number | null;
  lastUsedAt?: number;
  injectCount?: number;
  status?: string;
  isAnti?: number;
} = {}): Belief {
  const db = getTestDb();
  const id = overrides.id ?? "belief-test-1";
  const now = Date.now();

  // Seed role first (FK)
  db.prepare(
    "INSERT OR IGNORE INTO roles (id, name, memory_stream_id, status, created_at) VALUES (?, ?, ?, ?, ?)"
  ).run("role-mech-1", "mech-role", "stream-1", "active", now);

  db.prepare(`
    INSERT INTO beliefs (id, role_id, content, is_anti, created_at, last_used_at, last_validated_at, status, success_ema, inject_count)
    VALUES (?, 'role-mech-1', 'test belief content', ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    overrides.isAnti ?? 0,
    now,
    overrides.lastUsedAt ?? 0,
    now,
    overrides.status ?? "active",
    overrides.successEma ?? null,
    overrides.injectCount ?? 0,
  );

  const row = db.prepare("SELECT * FROM beliefs WHERE id = ?").get(id) as Record<string, unknown>;
  // Map snake_case DB columns to camelCase Belief fields required by belief-mechanism functions
  return {
    id: row.id,
    roleId: row.role_id,
    content: row.content,
    isAnti: row.is_anti === 1,
    evidenceObsIds: [],
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    lastValidatedAt: row.last_validated_at,
    scopeKey: row.scope_key ?? undefined,
    status: row.status,
    successEma: row.success_ema == null ? undefined : (row.success_ema as number),
    injectCount: row.inject_count,
  } as Belief;
}

function readBelief(id: string) {
  return getTestDb().prepare("SELECT * FROM beliefs WHERE id = ?").get(id) as Record<string, unknown>;
}

describe("computeEffectiveEma", () => {
  it("returns success_ema unchanged when last_used_seq === current_seq", () => {
    const b = seedBelief({ successEma: 0.7, lastUsedAt: 5 });
    const result = computeEffectiveEma(b, 5);
    expect(result).toBeCloseTo(0.7, 5);
  });

  it("applies 0.995^n decay over n ticks", () => {
    // success_ema=0.5, last_used_at=0, current=183 => 0.5 * 0.995^183 ≈ 0.2
    const b = seedBelief({ successEma: 0.5, lastUsedAt: 0 });
    const result = computeEffectiveEma(b, 183);
    expect(result).not.toBeNull();
    expect(result!).toBeCloseTo(0.5 * Math.pow(0.995, 183), 3);
    // Sanity: this is approximately 0.2
    expect(result!).toBeGreaterThan(0.19);
    expect(result!).toBeLessThan(0.21);
  });

  it("returns null when success_ema is null", () => {
    const b = seedBelief({ successEma: null, lastUsedAt: 0 });
    const result = computeEffectiveEma(b, 10);
    expect(result).toBeNull();
  });

  it("clamps negative delta to 0 (current_seq < last_used_seq returns unchanged ema)", () => {
    // Defensive: if the clock somehow regresses (e.g. role re-seeded), don't amplify EMA.
    const b = seedBelief({ successEma: 0.5, lastUsedAt: 100 });
    const result = computeEffectiveEma(b, 10);
    expect(result).toBeCloseTo(0.5, 10); // 0.5 * 0.995^max(0, -90) = 0.5 * 0.995^0 = 0.5
  });
});

describe("materializeOnTouch", () => {
  it("writes decayed ema to success_ema and updates last_used_at, does NOT touch inject_count (DP-002 B)", () => {
    const b = seedBelief({ successEma: 0.5, lastUsedAt: 0, injectCount: 0 });
    materializeOnTouch(b, 100);

    const after = readBelief("belief-test-1");
    const expectedEma = 0.5 * Math.pow(0.995, 100); // ≈ 0.302
    expect(Number(after.success_ema)).toBeCloseTo(expectedEma, 3);
    expect(Number(after.last_used_at)).toBe(100);
    // inject_count must NOT be touched by materialize
    expect(Number(after.inject_count)).toBe(0);
  });

  it("is idempotent: calling twice with same seq yields same result, inject_count stays 0", () => {
    const b = seedBelief({ successEma: 0.5, lastUsedAt: 0, injectCount: 0 });
    materializeOnTouch(b, 50);
    // Re-read via getBelief (camelCase Belief object) and call again with same seq
    const b2 = getBelief("belief-test-1")!;
    materializeOnTouch(b2, 50);
    const after = readBelief("belief-test-1");
    // second call: decay delta = 50-50 = 0, so ema unchanged from first call
    const firstEma = 0.5 * Math.pow(0.995, 50);
    expect(Number(after.success_ema)).toBeCloseTo(firstEma, 3);
    expect(Number(after.inject_count)).toBe(0);
  });

  it("materializeOnTouch seeds null success_ema to 0.5 and updates last_used_at (bug #4)", () => {
    // Bug #4 regression: when success_ema is null (never-seeded), materializeOnTouch returned early
    // without updating last_used_at, leaving the belief permanently stuck.
    const b = seedBelief({ id: "belief-null-ema", successEma: null, lastUsedAt: 0 });
    materializeOnTouch(b, 100);
    // Must read from DB via getBelief to verify the actual persisted state
    const after = getBelief("belief-null-ema")!;
    expect(after.successEma).toBeCloseTo(0.5, 5); // seeded to 0.5 on first touch
    expect(after.lastUsedAt).toBe(100);            // last_used_at updated even when EMA was null
  });
});

describe("bumpInjectCount (DP-001 + DP-002 B)", () => {
  it("increments inject_count by exactly 1 per call, does not touch success_ema or last_used_at", () => {
    const b = seedBelief({ successEma: 0.6, lastUsedAt: 10, injectCount: 2 });
    bumpInjectCount("belief-test-1");
    const after1 = readBelief("belief-test-1");
    expect(Number(after1.inject_count)).toBe(3);
    expect(Number(after1.success_ema)).toBeCloseTo(0.6, 5);
    expect(Number(after1.last_used_at)).toBe(10);

    bumpInjectCount("belief-test-1");
    const after2 = readBelief("belief-test-1");
    expect(Number(after2.inject_count)).toBe(4);
  });
});

describe("applyFitnessUpdate", () => {
  it("runs materialize + EMA update but does NOT bump inject_count (DP-002 B)", () => {
    const b = seedBelief({ successEma: 0.5, lastUsedAt: 0, injectCount: 5 });
    applyFitnessUpdate(b, 0.8, 100);

    const after = readBelief("belief-test-1");
    // Bug #1 regression: materializeOnTouch must mutate belief in-place so applyFitnessUpdate
    // uses the post-decay EMA (not the stale pre-decay value).
    // Expected: materialize → success_ema = 0.5 × 0.995^100 ≈ 0.3029
    // then EMA update: (1-0.3) × 0.3029 + 0.3 × 0.8 = 0.4520 (NOT 0.59 from pre-decay 0.5)
    // With bug: applyFitnessUpdate uses stale 0.5 → 0.7 × 0.5 + 0.3 × 0.8 = 0.59
    expect(Number(after.success_ema)).toBeCloseTo(0.4520, 3);
    // in-memory mutation check: b.successEma should also reflect post-decay result
    expect(b.successEma).toBeCloseTo(0.4520, 3);
    // inject_count must remain 5 — applyFitnessUpdate does NOT touch it
    expect(Number(after.inject_count)).toBe(5);
  });
});

describe("checkArchiveThreshold", () => {
  it("returns false when effective_ema === 0.2 (boundary: equal is not below)", () => {
    // success_ema such that 0.995^0 * ema = 0.2 exactly (no decay, last_used_at = current_seq)
    const b = seedBelief({ successEma: 0.2, lastUsedAt: 100 });
    expect(checkArchiveThreshold(b, 100)).toBe(false);
  });

  it("returns true when effective_ema < 0.2", () => {
    const b = seedBelief({ successEma: 0.199, lastUsedAt: 100 });
    expect(checkArchiveThreshold(b, 100)).toBe(true);
  });

  it("returns false when success_ema is null (null never archives)", () => {
    const b = seedBelief({ successEma: null, lastUsedAt: 0 });
    expect(checkArchiveThreshold(b, 0)).toBe(false);
  });
});

describe("archiveBelief", () => {
  it("sets status to archived (soft delete, row preserved)", () => {
    seedBelief({ status: "active" });
    archiveBelief("belief-test-1");
    const after = readBelief("belief-test-1");
    expect(after.status).toBe("archived");
    // Row must still exist (not deleted)
    expect(after.id).toBe("belief-test-1");
  });
});

describe("getMechanismConfig (catch fallback)", () => {
  it("falls back to defaults (0.995/0.2/0.3) when getRuntimeConfig throws", () => {
    runtimeConfigMock.mockImplementationOnce(() => {
      throw new Error("config layer unavailable");
    });
    // computeEffectiveEma reads decayBase via getMechanismConfig — falling back to default 0.995
    // should make 1-tick decay equal 0.5 * 0.995 = 0.4975.
    const b = seedBelief({ successEma: 0.5, lastUsedAt: 0 });
    const result = computeEffectiveEma(b, 1);
    expect(result).toBeCloseTo(0.4975, 5);
  });

  it("uses configured decayBase under normal conditions", () => {
    // Sanity: same input as above with normal mock returns same value (default decay base matches).
    const b = seedBelief({ successEma: 0.5, lastUsedAt: 0 });
    const result = computeEffectiveEma(b, 1);
    expect(result).toBeCloseTo(0.4975, 5);
  });
});
