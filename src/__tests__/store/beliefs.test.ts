import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";
import {
  createBelief,
  getBelief,
  listBeliefsByRole,
  searchBeliefsByVector,
  markBeliefSuperseded,
  setBeliefSuccessEmaAndSeq,
  bumpInjectCount,
} from "../../store/beliefs.js";
import type { Belief } from "../../shared/types.js";

const { cleanup } = setupTestDb();
vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

afterAll(() => cleanup());
beforeEach(() => clearTestDb());

function seedRole(id = "r1"): void {
  getTestDb().prepare(
    "INSERT INTO roles (id, name, cag_prompt, memory_stream_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(id, id, "", "stream-" + id, "active", Date.now());
}

function seedBelief(overrides?: Partial<Belief>): Belief {
  const now = Date.now();
  const b: Belief = {
    id: "b-" + Math.random().toString(36).slice(2),
    roleId: "r1",
    content: "be careful when decoding base64 audio",
    isAnti: false,
    evidenceObsIds: ["m1"],
    embedding: new Float32Array([0.1, 0.2, 0.3]),
    supersededBy: undefined,
    createdAt: now,
    lastUsedAt: now,
    lastValidatedAt: now,
    status: "active",
    injectCount: 0,
    ...overrides,
  };
  createBelief(b);
  return b;
}

describe("beliefs CRUD", () => {
  it("round-trips a single belief with embedding", () => {
    seedRole();
    const created = seedBelief();

    const fetched = getBelief(created.id);
    expect(fetched).toBeDefined();
    expect(fetched!.content).toBe(created.content);
    expect(fetched!.injectCount).toBe(0);
    expect(fetched!.evidenceObsIds).toEqual(["m1"]);
    expect(fetched!.embedding).toBeInstanceOf(Float32Array);
  });

  it("listBeliefsByRole filters by role and excludes superseded by default", () => {
    seedRole();
    const b1 = seedBelief({ id: "b1", content: "alpha" });
    const b2 = seedBelief({ id: "b2", content: "beta" });
    seedRole("r2");
    const b3 = seedBelief({ id: "b3", roleId: "r2", content: "gamma" });

    markBeliefSuperseded(b1.id, "other");

    const r1 = listBeliefsByRole("r1");
    expect(r1.map((b) => b.id)).toEqual(["b2"]); // b1 is superseded, b3 is r2

    const r1with = listBeliefsByRole("r1", { includeSuperseded: true });
    expect(r1with.map((b) => b.id).sort()).toEqual(["b1", "b2"].sort());
  });

  it("searchBeliefsByVector returns descending cosine", () => {
    seedRole();
    seedBelief({ id: "b1", embedding: new Float32Array([1, 0, 0]) });
    seedBelief({ id: "b2", embedding: new Float32Array([0.9, 0.1, 0]) });
    seedBelief({ id: "b3", embedding: new Float32Array([0, 1, 0]) });

    const results = searchBeliefsByVector("r1", new Float32Array([1, 0, 0]), 3);
    expect(results.map((r) => r.node.id)).toEqual(["b1", "b2", "b3"]);
    expect(results[0].cosine).toBeGreaterThanOrEqual(results[1].cosine);
    expect(results[1].cosine).toBeGreaterThanOrEqual(results[2].cosine);
  });

  it("listBeliefsByRole with onlyActive=true filters out archived rows", () => {
    seedRole();
    // 5 active + 5 archived
    for (let i = 0; i < 5; i++) {
      seedBelief({ id: `active-${i}`, status: "active" });
    }
    for (let i = 0; i < 5; i++) {
      seedBelief({ id: `archived-${i}`, status: "archived" });
    }

    const result = listBeliefsByRole("r1", { onlyActive: true });
    expect(result.length).toBe(5);
    expect(result.every((b) => b.status === "active")).toBe(true);
  });

  it("searchBeliefsByVector excludes archived beliefs", () => {
    seedRole();
    // 3 active + 2 archived, all with embeddings
    for (let i = 0; i < 3; i++) {
      seedBelief({ id: `sv-active-${i}`, status: "active", embedding: new Float32Array([1, 0, 0]) });
    }
    for (let i = 0; i < 2; i++) {
      seedBelief({ id: `sv-archived-${i}`, status: "archived", embedding: new Float32Array([1, 0, 0]) });
    }

    const results = searchBeliefsByVector("r1", new Float32Array([1, 0, 0]), 10);
    expect(results.length).toBe(3);
    expect(results.every((r) => r.node.status === "active")).toBe(true);
  });

  it("setBeliefSuccessEmaAndSeq updates EMA + last_used_at but never inject_count (DP-002 B)", () => {
    seedRole();
    seedBelief({ id: "b-ema-test", successEma: 0.4, lastUsedAt: 0, injectCount: 7 });

    setBeliefSuccessEmaAndSeq("b-ema-test", 0.85, 100);

    const after = getBelief("b-ema-test")!;
    expect(after.successEma).toBeCloseTo(0.85, 6);
    expect(after.lastUsedAt).toBe(100);
    expect(after.injectCount).toBe(7); // unchanged
  });

  it("setBeliefSuccessEmaAndSeq and bumpInjectCount mutate independent columns", () => {
    seedRole();
    seedBelief({ id: "b-iso", successEma: 0.5, lastUsedAt: 0, injectCount: 0 });

    bumpInjectCount("b-iso");
    bumpInjectCount("b-iso");
    setBeliefSuccessEmaAndSeq("b-iso", 0.7, 50);

    const after = getBelief("b-iso")!;
    expect(after.successEma).toBeCloseTo(0.7, 6);
    expect(after.lastUsedAt).toBe(50);
    expect(after.injectCount).toBe(2);
  });

});

