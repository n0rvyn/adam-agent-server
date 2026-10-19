/**
 * Task 3-tests: bidirectional kind isolation (predictions never leak into
 * behavior paths: listBeliefsByRole / searchBeliefsByVector / selectInjectionBeliefs
 * / memory-gc / reflection neighbor reads).
 *
 * Pre-impl: tests FAIL (no kind filter at the read path).
 * Post-impl (Task 3-impl): all tests pass.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";
import {
  createBelief,
  getBelief,
  listBeliefsByRole,
  searchBeliefsByVector,
} from "../../store/beliefs.js";
import { recordPrediction } from "../../agent/belief-ledger.js";
import { selectInjectionBeliefs } from "../../agent/belief-injection.js";
import { memoryGcTick } from "../../agent/memory-gc.js";
import { searchBeliefsByVector as reflectionSearchBeliefs } from "../../store/beliefs.js";

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

vi.mock("../../config/runtime.js", () => ({
  getRuntimeConfig: () => ({
    memory: {
      scope: {
        archiveThreshold: 0.2,
        decayBase: 0.995,
        emaAlpha: 0.3,
        reflectionPoolMax: 100,
      },
    },
  }),
}));

const { cleanup } = setupTestDb();
afterAll(() => cleanup());
beforeEach(() => clearTestDb());

const RID = "role-test";
const NOW = Date.now();

function seedRole(id = RID) {
  getTestDb()
    .prepare(
      "INSERT INTO roles (id, name, cag_prompt, memory_stream_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(id, id, "", "stream-" + id, "active", NOW);
}

function makeBehavior(id: string, content: string, opts: { ema?: number; lastUsedAt?: number } = {}) {
  createBelief({
    id,
    roleId: RID,
    content,
    isAnti: false,
    evidenceObsIds: [],
    createdAt: NOW,
    lastUsedAt: opts.lastUsedAt ?? NOW,
    lastValidatedAt: NOW,
    status: "active",
    successEma: opts.ema,
    injectCount: 0,
    // kind defaults to 'behavior'
  });
}

function makePrediction(id: string, content: string, conf = 0.5) {
  createBelief({
    id,
    roleId: RID,
    content,
    isAnti: false,
    evidenceObsIds: [],
    createdAt: NOW,
    lastUsedAt: NOW,
    lastValidatedAt: NOW,
    status: "active",
    successEma: undefined,
    injectCount: 0,
    kind: "prediction",
    predictionConfidence: conf,
    falsifyCondition: "if not",
    predictionDate: "2026-06-01",
    settlementStatus: "unsettled",
  });
}

function emb(seed: number): Float32Array {
  const a = new Float32Array(4);
  a[seed % 4] = 1.0;
  return a;
}

describe("kind isolation — listBeliefsByRole", () => {
  it("default list excludes predictions, only returns behavior", () => {
    seedRole();
    makeBehavior("b1", "behavior-1");
    makeBehavior("b2", "behavior-2");
    makePrediction("p1", "prediction-1");
    makePrediction("p2", "prediction-2");
    const list = listBeliefsByRole(RID);
    const ids = list.map((b) => b.id);
    expect(ids).toContain("b1");
    expect(ids).toContain("b2");
    expect(ids).not.toContain("p1");
    expect(ids).not.toContain("p2");
  });

  it("explicit kind='prediction' returns only predictions", () => {
    seedRole();
    makeBehavior("b1", "behavior-1");
    makePrediction("p1", "prediction-1");
    const list = listBeliefsByRole(RID, { kind: "prediction" } as Parameters<typeof listBeliefsByRole>[1]);
    const ids = list.map((b) => b.id);
    expect(ids).toEqual(["p1"]);
  });
});

describe("kind isolation — searchBeliefsByVector", () => {
  it("default search excludes predictions even when their embedding matches the query", () => {
    seedRole();
    // Give behavior a matching embedding too, so it's not zero-result
    createBelief({
      id: "b-emb",
      roleId: RID,
      content: "behavior with embedding",
      isAnti: false,
      evidenceObsIds: [],
      createdAt: NOW,
      lastUsedAt: NOW,
      lastValidatedAt: NOW,
      status: "active",
      injectCount: 0,
      embedding: emb(0),
    });
    // Prediction with exact same embedding — must not leak
    createBelief({
      id: "p-emb",
      roleId: RID,
      content: "prediction with embedding",
      isAnti: false,
      evidenceObsIds: [],
      createdAt: NOW,
      lastUsedAt: NOW,
      lastValidatedAt: NOW,
      status: "active",
      injectCount: 0,
      kind: "prediction",
      predictionConfidence: 0.5,
      falsifyCondition: "f",
      predictionDate: "2026-06-01",
      settlementStatus: "unsettled",
      embedding: emb(0),
    });
    const hits = searchBeliefsByVector(RID, emb(0), 10);
    const ids = hits.map((h) => h.node.id);
    expect(ids).toContain("b-emb");
    expect(ids).not.toContain("p-emb");
  });
});

describe("kind isolation — selectInjectionBeliefs", () => {
  it("never returns predictions even when both kinds exist with same embedding", async () => {
    seedRole();
    createBelief({
      id: "b-emb",
      roleId: RID,
      content: "behavior with embedding",
      isAnti: false,
      evidenceObsIds: [],
      createdAt: NOW,
      lastUsedAt: NOW,
      lastValidatedAt: NOW,
      status: "active",
      injectCount: 0,
      embedding: emb(0),
      successEma: 0.5,
    });
    createBelief({
      id: "p-emb",
      roleId: RID,
      content: "prediction with embedding",
      isAnti: false,
      evidenceObsIds: [],
      createdAt: NOW,
      lastUsedAt: NOW,
      lastValidatedAt: NOW,
      status: "active",
      injectCount: 0,
      kind: "prediction",
      predictionConfidence: 0.5,
      falsifyCondition: "f",
      predictionDate: "2026-06-01",
      settlementStatus: "unsettled",
      embedding: emb(0),
    });
    const selected = await selectInjectionBeliefs(RID, undefined, emb(0));
    const ids = selected.map((b) => b.id);
    expect(ids).toContain("b-emb");
    expect(ids).not.toContain("p-emb");
  });

  it("does not bump inject_count on predictions (only on behavior)", async () => {
    seedRole();
    makeBehavior("b-inj", "behavior for injection", { ema: 0.5 });
    makePrediction("p-inj", "prediction for injection");
    const before = getTestDb()
      .prepare("SELECT id, inject_count, kind FROM beliefs WHERE id IN (?, ?)")
      .get("b-inj", "p-inj") as { id: string; inject_count: number; kind: string };
    expect(before.inject_count).toBe(0);
    await selectInjectionBeliefs(RID, undefined, undefined);
    const after = getTestDb()
      .prepare("SELECT id, inject_count, kind FROM beliefs WHERE id IN (?, ?)")
      .all("b-inj", "p-inj") as Array<{ id: string; inject_count: number; kind: string }>;
    const afterB = after.find((r) => r.id === "b-inj")!;
    const afterP = after.find((r) => r.id === "p-inj")!;
    // behavior may or may not be selected by top-K=5; the contract is that predictions
    // NEVER get a bump. If behavior was selected, b-inj.inject_count >= 1.
    if (afterB.inject_count > 0) {
      expect(afterP.inject_count).toBe(0);
    } else {
      // If behavior wasn't selected, just confirm the prediction is also at 0
      expect(afterP.inject_count).toBe(0);
    }
  });
});

describe("kind isolation — memory-gc", () => {
  it("does not archive predictions even when their effective_ema is below threshold", () => {
    seedRole();
    // Bump role's task_seq so decay math is well-defined
    getTestDb().prepare("UPDATE roles SET task_seq = 100 WHERE id = ?").run(RID);
    // Behavior with low EMA at last_used_at = 0 (max decay)
    makeBehavior("b-low", "low ema behavior", { ema: 0.05, lastUsedAt: 0 });
    // Prediction with low EMA at last_used_at = 0
    makePrediction("p-low", "low ema prediction");
    getTestDb()
      .prepare("UPDATE beliefs SET success_ema = 0.05, last_used_at = 0 WHERE id = ?")
      .run("p-low");
    memoryGcTick({ observationTtlDays: 365 });
    const after = getTestDb()
      .prepare("SELECT id, status, kind FROM beliefs WHERE id IN (?, ?)")
      .all("b-low", "p-low") as Array<{ id: string; status: string; kind: string }>;
    const bAfter = after.find((r) => r.id === "b-low")!;
    const pAfter = after.find((r) => r.id === "p-low")!;
    // Behavior with low EMA should be archived (this is the existing GC behavior)
    expect(bAfter.status).toBe("archived");
    // Prediction must NOT be archived (predictions are excluded from the GC scan)
    expect(pAfter.status).toBe("active");
  });
});

describe("kind isolation — reflection neighbor reads", () => {
  it("reflection's pool/vector reads via searchBeliefsByVector do not return predictions", () => {
    seedRole();
    // embedding-bearing behavior — vector search requires embedding
    createBelief({
      id: "b-refl",
      roleId: RID,
      content: "reflection behavior",
      isAnti: false,
      evidenceObsIds: [],
      createdAt: NOW,
      lastUsedAt: NOW,
      lastValidatedAt: NOW,
      status: "active",
      injectCount: 0,
      embedding: emb(0),
    });
    makePrediction("p-refl", "reflection prediction");
    // embedding-bearing prediction should be invisible to default reflection search
    createBelief({
      id: "p-refl-emb",
      roleId: RID,
      content: "reflection prediction w emb",
      isAnti: false,
      evidenceObsIds: [],
      createdAt: NOW,
      lastUsedAt: NOW,
      lastValidatedAt: NOW,
      status: "active",
      injectCount: 0,
      kind: "prediction",
      predictionConfidence: 0.5,
      falsifyCondition: "f",
      predictionDate: "2026-06-01",
      settlementStatus: "unsettled",
      embedding: emb(0),
    });
    const hits = reflectionSearchBeliefs(RID, emb(0), 50);
    const ids = hits.map((h) => h.node.id);
    expect(ids).toContain("b-refl");
    expect(ids).not.toContain("p-refl-emb");
  });
});
