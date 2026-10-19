/**
 * belief-ledger module tests (Task 2-tests).
 *
 * Pre-impl: tests FAIL because src/agent/belief-ledger.ts does not exist.
 * Post-impl (Task 2-impl): all tests pass.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";
import {
  recordPrediction,
  listUnsettledPredictions,
  findDuePredictions,
  findHitPredictions,
  findRecentOpenPredictions,
  buildOpenQuestionsSection,
  settlePrediction,
  buildSettlementSection,
  settlePredictionsFromArtifactValue,
} from "../../agent/belief-ledger.js";
import { getBelief } from "../../store/beliefs.js";

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

const { cleanup } = setupTestDb();
afterAll(() => cleanup());
beforeEach(() => clearTestDb());

const OWNER = "ledger:test-show";

// Make a deterministic 4-dim embedding for tests
function emb(seed: number): Float32Array {
  const a = new Float32Array(4);
  // Vary along index 0..3; identical seed => identical vector
  a[seed % 4] = 1.0;
  return a;
}

describe("belief-ledger — recordPrediction", () => {
  it("writes kind='prediction', settlement_status='unsettled' and prediction columns", () => {
    const id = recordPrediction(OWNER, {
      claim: "AI agents will be mainstream by 2026-12-31",
      confidence: 0.6,
      falsifyCondition: "if no agent product reaches 1M DAU by 2026-12-31",
      date: "2026-06-04",
    });
    const row = getTestDb()
      .prepare("SELECT * FROM beliefs WHERE id = ?")
      .get(id) as Record<string, unknown>;
    expect(row.kind).toBe("prediction");
    expect(row.settlement_status).toBe("unsettled");
    expect(row.prediction_confidence).toBe(0.6);
    expect(row.falsify_condition).toBe(
      "if no agent product reaches 1M DAU by 2026-12-31",
    );
    expect(row.prediction_date).toBe("2026-06-04");
    expect(row.role_id).toBe(OWNER);
    expect(row.superseded_by).toBeNull();
  });

  it("returns the new belief id", () => {
    const id = recordPrediction(OWNER, {
      claim: "x",
      confidence: 0.5,
      falsifyCondition: "y",
      date: "2026-06-01",
    });
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  it("persists embedding when provided", () => {
    const id = recordPrediction(OWNER, {
      claim: "with embedding",
      confidence: 0.5,
      falsifyCondition: "y",
      date: "2026-06-01",
      embedding: emb(1),
    });
    const fetched = getBelief(id);
    expect(fetched).toBeDefined();
    expect(fetched!.embedding).toBeDefined();
  });
});

describe("belief-ledger — listUnsettledPredictions", () => {
  it("returns only unsettled predictions for the owner", () => {
    recordPrediction(OWNER, {
      claim: "p1",
      confidence: 0.5,
      falsifyCondition: "f1",
      date: "2026-06-01",
    });
    recordPrediction(OWNER, {
      claim: "p2",
      confidence: 0.7,
      falsifyCondition: "f2",
      date: "2026-06-02",
    });
    // A behavior row (kind='behavior') must not show up
    getTestDb()
      .prepare(
        `INSERT INTO beliefs (id, role_id, content, is_anti, evidence_obs_ids,
          embedding, superseded_by, created_at, last_used_at, last_validated_at,
          scope_key, status, success_ema, inject_count, kind)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "b-behavior-1",
        OWNER,
        "i am a behavior",
        0,
        null,
        null,
        null,
        Date.now(),
        Date.now(),
        Date.now(),
        null,
        "active",
        null,
        0,
        "behavior",
      );
    const list = listUnsettledPredictions(OWNER);
    expect(list.length).toBe(2);
    for (const p of list) {
      expect(p.kind).toBe("prediction");
      expect(p.settlementStatus).toBe("unsettled");
    }
  });

  it("does not return predictions from other owners", () => {
    recordPrediction(OWNER, {
      claim: "mine",
      confidence: 0.5,
      falsifyCondition: "f",
      date: "2026-06-01",
    });
    recordPrediction("ledger:other", {
      claim: "theirs",
      confidence: 0.5,
      falsifyCondition: "f",
      date: "2026-06-01",
    });
    const list = listUnsettledPredictions(OWNER);
    expect(list.length).toBe(1);
    expect(list[0].content).toBe("mine");
  });
});

describe("belief-ledger — findDuePredictions", () => {
  it("selects predictions whose date is at least dueDays before today", () => {
    recordPrediction(OWNER, {
      claim: "old-1",
      confidence: 0.5,
      falsifyCondition: "f",
      date: "2026-05-01",
    });
    recordPrediction(OWNER, {
      claim: "old-2",
      confidence: 0.5,
      falsifyCondition: "f",
      date: "2026-06-01",
    });
    recordPrediction(OWNER, {
      claim: "fresh",
      confidence: 0.5,
      falsifyCondition: "f",
      date: "2026-06-10",
    });
    const due = findDuePredictions(OWNER, "2026-06-04", 3);
    const claims = due.map((p) => p.content).sort();
    // Both 2026-05-01 and 2026-06-01 are at least 3 days before 2026-06-04
    // 2026-06-01 is exactly 3 days before, inclusive
    expect(claims).toContain("old-1");
    expect(claims).toContain("old-2");
    expect(claims).not.toContain("fresh");
  });
});

describe("belief-ledger — findHitPredictions (semantic)", () => {
  it("returns predictions with cosine >= threshold to query embedding", () => {
    const idA = recordPrediction(OWNER, {
      claim: "A",
      confidence: 0.5,
      falsifyCondition: "f",
      date: "2026-06-01",
      embedding: emb(0),
    });
    const idB = recordPrediction(OWNER, {
      claim: "B",
      confidence: 0.5,
      falsifyCondition: "f",
      date: "2026-06-01",
      embedding: emb(1),
    });
    const idC = recordPrediction(OWNER, {
      claim: "C",
      confidence: 0.5,
      falsifyCondition: "f",
      date: "2026-06-01",
      embedding: emb(2),
    });
    // Query vector = emb(1) => B should be exact hit (cos=1), A/C cosine=0
    const hits = findHitPredictions(OWNER, emb(1), 0.78);
    const ids = hits.map((p) => p.id);
    expect(ids).toContain(idB);
    expect(ids).not.toContain(idA);
    expect(ids).not.toContain(idC);
  });
});

describe("belief-ledger — settlePrediction (refine + supersede paths)", () => {
  it("refine path: confirmed + newConfidence creates new prediction (still unsettled), old is superseded", () => {
    const oldId = recordPrediction(OWNER, {
      claim: "x will happen",
      confidence: 0.5,
      falsifyCondition: "if y",
      date: "2026-05-01",
    });
    const today = "2026-06-04";
    const newId = settlePrediction(oldId, {
      status: "confirmed",
      outcome: "x happened",
      newConfidence: 0.65,
      today,
    });
    expect(newId).not.toBe(oldId);
    const oldBelief = getBelief(oldId)!;
    expect(oldBelief.settlementStatus).toBe("confirmed");
    expect(oldBelief.settledAt).toBeGreaterThan(0);
    expect(oldBelief.settledOutcome).toBe("x happened");
    expect(oldBelief.supersededBy).toBe(newId);
    const newBelief = getBelief(newId)!;
    expect(newBelief.kind).toBe("prediction");
    expect(newBelief.settlementStatus).toBe("unsettled");
    expect(newBelief.predictionConfidence).toBe(0.65);
    expect(newBelief.content).toBe("x will happen");
    // CRITICAL: new prediction must have a fresh date (today) so findDuePredictions
    // doesn't immediately re-fire on the same prediction
    expect(newBelief.predictionDate).toBe(today);
  });

  it("supersede path: refuted + rewriteClaim creates new prediction with new claim text", () => {
    const oldId = recordPrediction(OWNER, {
      claim: "x will happen",
      confidence: 0.5,
      falsifyCondition: "if y",
      date: "2026-05-01",
    });
    const today = "2026-06-04";
    const newId = settlePrediction(oldId, {
      status: "refuted",
      outcome: "y happened, opposite of x",
      rewriteClaim: "x will NOT happen — opposite framing",
      newConfidence: 0.4,
      today,
    });
    const oldBelief = getBelief(oldId)!;
    expect(oldBelief.settlementStatus).toBe("refuted");
    expect(oldBelief.supersededBy).toBe(newId);
    const newBelief = getBelief(newId)!;
    expect(newBelief.content).toBe("x will NOT happen — opposite framing");
    expect(newBelief.predictionConfidence).toBe(0.4);
    expect(newBelief.predictionDate).toBe(today);
    expect(newBelief.settlementStatus).toBe("unsettled");
  });

  it("history is preserved: old belief still readable after settle", () => {
    const oldId = recordPrediction(OWNER, {
      claim: "history test",
      confidence: 0.5,
      falsifyCondition: "f",
      date: "2026-05-01",
    });
    settlePrediction(oldId, {
      status: "confirmed",
      outcome: "ok",
      newConfidence: 0.55,
      today: "2026-06-04",
    });
    const stillThere = getBelief(oldId);
    expect(stillThere).toBeDefined();
    expect(stillThere!.content).toBe("history test");
    expect(stillThere!.settledOutcome).toBe("ok");
  });
});

describe("belief-ledger — buildSettlementSection", () => {
  it("returns a text block listing each prediction's claim, original confidence, and falsify condition", () => {
    const id = recordPrediction(OWNER, {
      claim: "claim-1",
      confidence: 0.6,
      falsifyCondition: "falsify-1",
      date: "2026-06-01",
    });
    const b = getBelief(id)!;
    const text = buildSettlementSection([b]);
    expect(typeof text).toBe("string");
    expect(text).toContain("claim-1");
    expect(text).toContain("0.6");
    expect(text).toContain("falsify-1");
  });

  it("returns empty string for empty input", () => {
    expect(buildSettlementSection([])).toBe("");
  });

  it("emits each prediction's id as a machine handle (settle step needs it to reference)", () => {
    const id = recordPrediction(OWNER, {
      claim: "claim-handle",
      confidence: 0.5,
      falsifyCondition: "falsify-handle",
      date: "2026-06-01",
    });
    const b = getBelief(id)!;
    const text = buildSettlementSection([b]);
    expect(text).toContain(id);
  });
});

describe("belief-ledger — settlePredictionsFromArtifactValue (settle-consume, Phase 1.5)", () => {
  const TODAY = "2026-06-04";

  function seedDue(owner = OWNER): string {
    return recordPrediction(owner, {
      claim: "端侧小模型一年内承接多数日常 AI 交互",
      confidence: 0.6,
      falsifyCondition: "若 2027 Q1 云端仍占多数",
      date: "2026-05-30",
    });
  }

  it("valid verdict array: settles each prediction (old superseded + settled, new unsettled row dated today)", () => {
    const oldId = seedDue();
    const r = settlePredictionsFromArtifactValue(
      OWNER,
      [
        {
          predictionId: oldId,
          status: "partial",
          outcome: "我低估了云端规模效应,判断推迟",
          newConfidence: 0.5,
        },
      ],
      { today: TODAY },
    );
    expect(r.settled).toBe(1);
    expect(r.skipped).toBe(0);
    expect(r.reason).toBeUndefined();

    const oldRow = getTestDb()
      .prepare("SELECT * FROM beliefs WHERE id = ?")
      .get(oldId) as Record<string, unknown>;
    expect(oldRow.settlement_status).not.toBe("unsettled");
    expect(oldRow.superseded_by).not.toBeNull();

    const newRow = getTestDb()
      .prepare("SELECT * FROM beliefs WHERE id = ?")
      .get(oldRow.superseded_by as string) as Record<string, unknown>;
    expect(newRow.kind).toBe("prediction");
    expect(newRow.settlement_status).toBe("unsettled");
    expect(newRow.prediction_date).toBe(TODAY);
  });

  it("accepts a JSON string payload (round-trip preserved)", () => {
    const oldId = seedDue();
    const r = settlePredictionsFromArtifactValue(
      OWNER,
      JSON.stringify([{ predictionId: oldId, status: "confirmed", outcome: "成立" }]),
      { today: TODAY },
    );
    expect(r.settled).toBe(1);
  });

  it("non-JSON string → reason=not-json, nothing settled, no throw", () => {
    const r = settlePredictionsFromArtifactValue(OWNER, "this is not json", { today: TODAY });
    expect(r.settled).toBe(0);
    expect(r.reason).toBe("not-json");
  });

  it("non-array payload → reason=not-array (guard against {title,body} shape)", () => {
    const r = settlePredictionsFromArtifactValue(
      OWNER,
      { title: "x", body: "y" },
      { today: TODAY },
    );
    expect(r.settled).toBe(0);
    expect(r.reason).toBe("not-array");
  });

  it("malformed entry (missing predictionId/status/outcome) is skipped, not fatal", () => {
    const oldId = seedDue();
    const r = settlePredictionsFromArtifactValue(
      OWNER,
      [
        { status: "confirmed", outcome: "no id" },
        { predictionId: oldId, status: "confirmed", outcome: "valid" },
      ],
      { today: TODAY },
    );
    expect(r.settled).toBe(1);
    expect(r.skipped).toBe(1);
  });

  it("unknown id is skipped (not settled)", () => {
    const r = settlePredictionsFromArtifactValue(
      OWNER,
      [{ predictionId: "does-not-exist", status: "confirmed", outcome: "x" }],
      { today: TODAY },
    );
    expect(r.settled).toBe(0);
    expect(r.skipped).toBe(1);
  });

  it("cross-owner id is skipped (cannot settle another owner's prediction)", () => {
    const otherId = seedDue("ledger:other-show");
    const r = settlePredictionsFromArtifactValue(
      OWNER,
      [{ predictionId: otherId, status: "confirmed", outcome: "x" }],
      { today: TODAY },
    );
    expect(r.settled).toBe(0);
    expect(r.skipped).toBe(1);
    const row = getTestDb()
      .prepare("SELECT settlement_status FROM beliefs WHERE id = ?")
      .get(otherId) as Record<string, unknown>;
    expect(row.settlement_status).toBe("unsettled");
  });

  it("already-settled id is skipped (no double-settle)", () => {
    const oldId = seedDue();
    settlePredictionsFromArtifactValue(
      OWNER,
      [{ predictionId: oldId, status: "confirmed", outcome: "first" }],
      { today: TODAY },
    );
    const r = settlePredictionsFromArtifactValue(
      OWNER,
      [{ predictionId: oldId, status: "confirmed", outcome: "second" }],
      { today: TODAY },
    );
    expect(r.settled).toBe(0);
    expect(r.skipped).toBe(1);
  });
});

// ============================================================================
// Phase 2 — open-questions / recent-open-predictions injection primitive
// (D-012 跨档承接当日注; D-005 晚间开放问题主轴)
// ============================================================================

describe("belief-ledger — findRecentOpenPredictions", () => {
  const OWNER_OQ = "ledger:open-questions-show";
  const TODAY = "2026-06-04";

  function seedRow(
    owner: string,
    opts: {
      claim: string;
      date: string;
      kind?: "prediction" | "behavior";
      settle?: "settle" | "leave";
      forceId?: string;
    },
  ): string {
    const id = opts.forceId ?? `b-${Math.random().toString(36).slice(2, 10)}`;
    if (opts.kind === "behavior") {
      getTestDb()
        .prepare(
          `INSERT INTO beliefs (id, role_id, content, is_anti, evidence_obs_ids,
            embedding, superseded_by, created_at, last_used_at, last_validated_at,
            scope_key, status, success_ema, inject_count, kind)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          owner,
          opts.claim,
          0,
          null,
          null,
          null,
          Date.now(),
          Date.now(),
          Date.now(),
          null,
          "active",
          null,
          0,
          "behavior",
        );
      return id;
    }
    if (opts.settle === "settle") {
      // Bypass the helper: insert a settled (kind='prediction', settlement_status='confirmed')
      // row directly so the test sees a settled row in the DB without a fresh unsettled
      // successor (which settlePrediction() would otherwise create, polluting the unsettled pool).
      getTestDb()
        .prepare(
          `INSERT INTO beliefs (
            id, role_id, content, is_anti, evidence_obs_ids, embedding,
            superseded_by, created_at, last_used_at, last_validated_at,
            scope_key, status, success_ema, inject_count, kind,
            prediction_confidence, falsify_condition, prediction_date, settlement_status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          owner,
          opts.claim,
          0,
          null,
          null,
          null,
          Date.now(),
          Date.now(),
          Date.now(),
          null,
          "active",
          null,
          0,
          "prediction",
          0.6,
          "f",
          opts.date,
          "confirmed",
        );
      return id;
    }
    return recordPrediction(owner, {
      claim: opts.claim,
      confidence: 0.6,
      falsifyCondition: "f",
      date: opts.date,
    });
  }

  it("returns only unsettled predictions within the lookback window (excludes due/settled/other-owner/behavior)", () => {
    // (a) today unsettled
    const a = seedRow(OWNER_OQ, { claim: "today-open", date: TODAY });
    // (b) 1 day old unsettled
    const b = seedRow(OWNER_OQ, { claim: "1d-old-open", date: "2026-06-03" });
    // (c) 3 days old (= dueDays) unsettled — MUST be excluded: age >= dueDays
    seedRow(OWNER_OQ, { claim: "due-age", date: "2026-06-01" });
    // (d) today but already settled
    seedRow(OWNER_OQ, { claim: "today-settled", date: TODAY, settle: "settle" });
    // (e) other owner today unsettled
    seedRow("ledger:other", { claim: "other-owner", date: TODAY });
    // (f) behavior row today
    seedRow(OWNER_OQ, { claim: "behavior-row", date: TODAY, kind: "behavior" });

    const recent = findRecentOpenPredictions(OWNER_OQ, TODAY, 2);
    const claims = recent.map((p) => p.content).sort();

    expect(claims).toContain("today-open");
    expect(claims).toContain("1d-old-open");
    expect(claims).not.toContain("due-age");
    expect(claims).not.toContain("today-settled");
    expect(claims).not.toContain("other-owner");
    expect(claims).not.toContain("behavior-row");
    expect(recent.find((p) => p.id === a)).toBeDefined();
    expect(recent.find((p) => p.id === b)).toBeDefined();
    for (const p of recent) {
      expect(p.kind).toBe("prediction");
      expect(p.settlementStatus).toBe("unsettled");
    }
  });

  it("HARNESS BOUNDARY: lookbackDays >= dueDays is CLAMPED to dueDays-1 so age>=dueDays predictions NEVER appear in both blocks", () => {
    // (c) 3 days old (= dueDays) unsettled
    const dueId = seedRow(OWNER_OQ, { claim: "due-excluded", date: "2026-06-01" });
    // Also seed a today-open and a 2d-old to ensure the clamp doesn't accidentally zero out the result
    seedRow(OWNER_OQ, { claim: "today-open", date: TODAY });
    seedRow(OWNER_OQ, { claim: "2d-old-open", date: "2026-06-02" });

    // Caller passes lookbackDays=5 — but the harness boundary clamps to DUE_DAYS-1=2.
    // The 3-day-old row must NOT appear (age=3, due = age >= dueDays=3).
    const recent = findRecentOpenPredictions(OWNER_OQ, TODAY, 5);
    const ids = recent.map((p) => p.id);
    expect(ids).not.toContain(dueId);
    // Sanity: a 2-day-old row still appears (age=2 < 3 = dueDays, and within clamped lookback 2)
    expect(recent.map((p) => p.content)).toContain("2d-old-open");
    expect(recent.map((p) => p.content)).toContain("today-open");
  });

  it("HARNESS BOUNDARY: lookbackDays=0 is CLAMPED to 1 (min), still includes today", () => {
    const todayId = seedRow(OWNER_OQ, { claim: "today-only", date: TODAY });
    const recent = findRecentOpenPredictions(OWNER_OQ, TODAY, 0);
    expect(recent.map((p) => p.id)).toContain(todayId);
  });

  it("is disjoint from findDuePredictions by age (age >= dueDays goes to settlement, not open questions)", () => {
    seedRow(OWNER_OQ, { claim: "today-open", date: TODAY });
    seedRow(OWNER_OQ, { claim: "1d-old-open", date: "2026-06-03" });
    const dueId = seedRow(OWNER_OQ, { claim: "due-row", date: "2026-06-01" });
    const due = findDuePredictions(OWNER_OQ, TODAY, 3);
    const recent = findRecentOpenPredictions(OWNER_OQ, TODAY, 2);
    const dueIds = new Set(due.map((p) => p.id));
    const recentIds = new Set(recent.map((p) => p.id));
    expect(dueIds.has(dueId)).toBe(true);
    expect(recentIds.has(dueId)).toBe(false);
    // The two sets are disjoint
    for (const id of recentIds) {
      expect(dueIds.has(id)).toBe(false);
    }
  });

  it("returns empty array when no unsettled predictions exist for the owner", () => {
    const recent = findRecentOpenPredictions(OWNER_OQ, TODAY, 2);
    expect(recent).toEqual([]);
  });
});

describe("belief-ledger — buildOpenQuestionsSection", () => {
  const OWNER_OQ = "ledger:open-questions-section";

  it("returns empty string for empty input", () => {
    expect(buildOpenQuestionsSection([])).toBe("");
  });

  it("emits each prediction's id as a machine handle with 预测ID label (mirror settlement)", () => {
    const id = recordPrediction(OWNER_OQ, {
      claim: "open-claim-1",
      confidence: 0.55,
      falsifyCondition: "open-falsify-1",
      date: "2026-06-04",
    });
    const b = getBelief(id)!;
    const text = buildOpenQuestionsSection([b]);
    expect(text).toContain("预测ID");
    expect(text).toContain(id);
  });

  it("includes the 'open question / 承接 / expand' framing AND the '不要念出来' handle note (distinct from settlement)", () => {
    const id = recordPrediction(OWNER_OQ, {
      claim: "open-framing-claim",
      confidence: 0.6,
      falsifyCondition: "f",
      date: "2026-06-04",
    });
    const text = buildOpenQuestionsSection([getBelief(id)!]);
    // Distinct from settlement wording — the section title is the user's primary visual
    // discriminator (settlement header is `## 自我证伪结算（开盘必读）`; this header is
    // `## 开放问题（承接·展开，非结算）`). Asserting the title is the structural guarantee
    // the user can read; body may reference 结算 to make the disjointness explicit.
    expect(text).toMatch(/开放问题|承接|展开/);
    expect(text).not.toMatch(/## 自我证伪结算/);
    expect(text).not.toMatch(/开盘必读/);
    expect(text).not.toMatch(/到期必读/);
    // "Don't read aloud" note for the predictionId handle
    expect(text).toMatch(/不要|念出来|内部/);
  });

  it("includes the claim text, confidence, falsify condition, and prediction date for each row", () => {
    const id = recordPrediction(OWNER_OQ, {
      claim: "row-fields-claim",
      confidence: 0.7,
      falsifyCondition: "row-fields-falsify",
      date: "2026-06-02",
    });
    const text = buildOpenQuestionsSection([getBelief(id)!]);
    expect(text).toContain("row-fields-claim");
    expect(text).toContain("0.70");
    expect(text).toContain("row-fields-falsify");
    expect(text).toContain("2026-06-02");
  });
});
