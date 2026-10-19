import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();
vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

afterAll(() => cleanup());
beforeEach(() => clearTestDb());

import {
  insertEditorScores,
  getEditorScoresByRun,
  getEditorScoreRetrospective,
  parseEditorScoreCandidates,
  markSelectedByScore,
  type EditorScoreCandidate,
} from "../../store/editor-scores.js";

function candidate(id: string, insight: number, total: number, selected = false, bucket = "认知科学"): EditorScoreCandidate {
  return {
    candidate_id: id,
    scores: { 洞察: insight, 命名: 3, 跨域: 4, 思考问句: 4, total },
    selected,
    editor_notes: `notes for ${id}`,
    brief_diff: { cross_domain_bucket: bucket, contrarian_source: `src-${id}` },
  };
}

describe("insertEditorScores / getEditorScoresByRun", () => {
  it("persists every candidate of a run and reads them back", () => {
    insertEditorScores("run-1", [
      candidate("稿-A", 4, 15, true),
      candidate("稿-B", 3, 13),
      candidate("稿-C", 2, 11),
    ]);
    const rows = getEditorScoresByRun("run-1");
    expect(rows).toHaveLength(3);
    const a = rows.find((r) => r.candidate_id === "稿-A");
    expect(a?.selected).toBe(1);
    expect(rows.find((r) => r.candidate_id === "稿-B")?.selected).toBe(0);
    // scores + brief_diff stored as JSON strings
    expect(JSON.parse(a!.scores).洞察).toBe(4);
    expect(JSON.parse(a!.brief_diff!).cross_domain_bucket).toBe("认知科学");
  });

  it("is a no-op on empty candidate list", () => {
    insertEditorScores("run-empty", []);
    expect(getEditorScoresByRun("run-empty")).toHaveLength(0);
  });

  it("null brief_diff / editor_notes when omitted", () => {
    insertEditorScores("run-2", [
      { candidate_id: "稿-X", scores: { 洞察: 1, total: 4 }, selected: false },
    ]);
    const row = getEditorScoresByRun("run-2")[0];
    expect(row.brief_diff).toBeNull();
    expect(row.editor_notes).toBeNull();
  });
});

describe("getEditorScoreRetrospective", () => {
  it("aggregates avg insight grouped by cross_domain_bucket, descending", () => {
    insertEditorScores("run-a", [
      candidate("a1", 5, 18, true, "认知科学"),
      candidate("a2", 5, 17, false, "认知科学"),
    ]);
    insertEditorScores("run-b", [
      candidate("b1", 2, 10, true, "历史"),
      candidate("b2", 2, 11, false, "历史"),
    ]);
    const retro = getEditorScoreRetrospective();
    expect(retro).toHaveLength(2);
    // 认知科学 has higher avg_insight → comes first
    expect(retro[0].cross_domain_bucket).toBe("认知科学");
    expect(retro[0].avg_insight).toBe(5);
    expect(retro[0].candidate_count).toBe(2);
    expect(retro[0].selected_count).toBe(1);
    expect(retro[1].cross_domain_bucket).toBe("历史");
    expect(retro[1].avg_insight).toBe(2);
  });
});

describe("parseEditorScoreCandidates", () => {
  const payload = {
    candidates: [
      {
        candidate_id: "稿-A",
        scores: { 洞察: 4, 命名: 3, 跨域: 4, 思考问句: 4, total: 15 },
        selected: true,
        editor_notes: "最强是跨域",
        brief_diff: { cross_domain_bucket: "哲学" },
      },
      {
        candidate_id: "稿-B",
        scores: { 洞察: 3, total: 12 },
        selected: false,
      },
    ],
  };

  it("parses plain JSON", () => {
    const out = parseEditorScoreCandidates(JSON.stringify(payload));
    expect(out).toHaveLength(2);
    expect(out[0].candidate_id).toBe("稿-A");
    expect(out[0].selected).toBe(true);
    expect(out[1].selected).toBe(false);
  });

  it("ignores any LLM-supplied brief_diff — executor fills it from the template", () => {
    // payload's 稿-A carries a brief_diff; the parser must drop it (not LLM-trusted).
    const out = parseEditorScoreCandidates(JSON.stringify(payload));
    expect(out[0].brief_diff).toBeUndefined();
    expect(out[1].brief_diff).toBeUndefined();
  });

  it("tolerates a surrounding ```json code fence", () => {
    const fenced = "```json\n" + JSON.stringify(payload, null, 2) + "\n```";
    const out = parseEditorScoreCandidates(fenced);
    expect(out).toHaveLength(2);
    expect(out[0].editor_notes).toBe("最强是跨域");
  });

  it("unwraps a JSON-encoded string layer (agent published scoring JSON as a string artifact)", () => {
    // Real-world: 钱钟书 publishes the JSON as a string-valued artifact; getStepOutput then
    // re-stringifies it, so persistEditorScores receives JSON.stringify(<json text>).
    const inner = JSON.stringify(payload);
    const wrapped = JSON.stringify(inner);
    const out = parseEditorScoreCandidates(wrapped);
    expect(out).toHaveLength(2);
    expect(out[0].candidate_id).toBe("稿-A");
    expect(out[1].candidate_id).toBe("稿-B");
  });

  it("throws on missing candidates array", () => {
    expect(() => parseEditorScoreCandidates('{"foo":1}')).toThrow(/candidates/);
  });

  it("throws on candidate missing candidate_id", () => {
    expect(() =>
      parseEditorScoreCandidates(JSON.stringify({ candidates: [{ scores: {} }] })),
    ).toThrow(/candidate_id/);
  });

  it("throws on candidate missing scores object", () => {
    expect(() =>
      parseEditorScoreCandidates(JSON.stringify({ candidates: [{ candidate_id: "稿-A" }] })),
    ).toThrow(/scores/);
  });

  it("throws on malformed JSON", () => {
    expect(() => parseEditorScoreCandidates("not json at all")).toThrow();
  });
});

describe("markSelectedByScore", () => {
  const selectedId = (cs: EditorScoreCandidate[]) => cs.find((c) => c.selected)?.candidate_id;

  it("selects the highest total, overriding a wrong LLM selected flag", () => {
    // Mirrors the observed bug: LLM marked 稿-A (17) while 稿-C (18) scored higher.
    const cs = [
      candidate("稿-A", 4, 17, true),
      candidate("稿-B", 4, 16, false),
      candidate("稿-C", 5, 18, false),
    ];
    markSelectedByScore(cs);
    expect(selectedId(cs)).toBe("稿-C");
    expect(cs.filter((c) => c.selected)).toHaveLength(1);
  });

  it("breaks a total tie by higher 洞察 score", () => {
    const cs = [
      candidate("稿-A", 3, 18, true),
      candidate("稿-B", 5, 18, false),
      candidate("稿-C", 4, 18, false),
    ];
    markSelectedByScore(cs);
    expect(selectedId(cs)).toBe("稿-B");
  });

  it("leaves LLM flags untouched when no candidate has a numeric total", () => {
    const cs: EditorScoreCandidate[] = [
      { candidate_id: "稿-A", scores: { 洞察: 4 }, selected: true },
      { candidate_id: "稿-B", scores: { 洞察: 5 }, selected: false },
    ];
    markSelectedByScore(cs);
    expect(selectedId(cs)).toBe("稿-A");
  });
});
