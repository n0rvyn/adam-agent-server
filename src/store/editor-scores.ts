import { randomUUID } from "node:crypto";
import { getDb } from "./db.js";

/**
 * editor_scores — one row per scored podcast candidate in a parallel-N run.
 *
 * Written by the template-executor when a step flagged `recordEditorScores` completes
 * (the 钱钟书 review-editor merge step). Consumed by the Phase 2 retrospective query:
 * AVG(scores) GROUP BY brief perturbation reveals which brief variation yields the
 * highest insight density, feeding back into the podcast-prep SKILL.md.
 *
 * `template_run_id` is a plain column (no FK CASCADE) so retrospective data outlives
 * run-record pruning — see the schema v77 migration comment in db.ts.
 */
export interface EditorScoreRow {
  id: string;
  template_run_id: string;
  candidate_id: string;
  /** JSON string — { 洞察, 命名, 跨域, 思考问句, total, self_past_dialectic_present? } */
  scores: string;
  selected: number; // 0 | 1
  editor_notes: string | null;
  /** JSON string describing this candidate's brief perturbation (cross_domain_bucket, contrarian_source, ...). */
  brief_diff: string | null;
  created_at: number;
}

/**
 * One scored candidate. `brief_diff` is NOT parsed from the LLM's output — the
 * template-executor fills it from the template's canonical candidateId →
 * briefPerturbation map so the retrospective groups on a trusted value.
 */
export interface EditorScoreCandidate {
  candidate_id: string;
  scores: Record<string, unknown>;
  selected: boolean;
  editor_notes?: string;
  brief_diff?: Record<string, unknown>;
}

/**
 * Parse a 钱钟书 review-editor scoring step result into editor_scores candidates.
 * Tolerates a single surrounding ```json code fence. Throws on malformed JSON or
 * a shape that is not `{ candidates: [{ candidate_id, scores, ... }] }`.
 * Pure function — no DB access; lives here so callers and tests share one parser.
 *
 * `brief_diff` is deliberately NOT read from the LLM output even if present: the
 * retrospective groups on it, so it must come from the template author, not the LLM.
 */
export function parseEditorScoreCandidates(raw: string): EditorScoreCandidate[] {
  let text = raw.trim();
  const fence = text.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/);
  if (fence) text = fence[1].trim();
  let decoded: unknown = JSON.parse(text);
  // The agent commonly publishes the scoring JSON as a string-valued artifact, so the
  // step output is a JSON-encoded string wrapping the real JSON. Unwrap one such layer.
  if (typeof decoded === "string") {
    decoded = JSON.parse(decoded);
  }
  const parsed = decoded as { candidates?: unknown };
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.candidates)) {
    throw new Error("expected { candidates: [...] }");
  }
  const out: EditorScoreCandidate[] = [];
  for (const c of parsed.candidates as Array<Record<string, unknown>>) {
    if (!c || typeof c.candidate_id !== "string" || !c.candidate_id.trim()) {
      throw new Error("candidate missing candidate_id");
    }
    if (!c.scores || typeof c.scores !== "object") {
      throw new Error(`candidate ${c.candidate_id} missing scores object`);
    }
    out.push({
      candidate_id: c.candidate_id,
      scores: c.scores as Record<string, unknown>,
      selected: c.selected === true,
      editor_notes: typeof c.editor_notes === "string" ? c.editor_notes : undefined,
      // brief_diff intentionally omitted — the executor fills it from the template's
      // canonical candidateId → briefPerturbation map (not LLM-trusted).
    });
  }
  return out;
}

/**
 * Deterministically mark the winning candidate, overriding the review-editor
 * LLM's `selected` flag. The 钱钟书 step has been observed to set `selected` on
 * a candidate that is not its own highest-scored one (e.g. selected 稿-A at
 * total 17 while 稿-C scored 18) — selection must be a pure function of the
 * recorded scores, not LLM discretion.
 *
 * Winner = highest `scores.total`; ties broken by higher `scores.洞察`, then by
 * array order. Mutates `candidates` in place. No-op (LLM flags left untouched)
 * when no candidate carries a numeric `scores.total`.
 */
export function markSelectedByScore(candidates: EditorScoreCandidate[]): void {
  const num = (v: unknown): number =>
    typeof v === "number" && Number.isFinite(v) ? v : Number.NEGATIVE_INFINITY;
  if (candidates.length === 0) return;
  if (!candidates.some((c) => num(c.scores?.total) > Number.NEGATIVE_INFINITY)) return;

  let best = 0;
  for (let i = 1; i < candidates.length; i++) {
    const t = num(candidates[i].scores?.total);
    const bt = num(candidates[best].scores?.total);
    if (t > bt) {
      best = i;
    } else if (t === bt && num(candidates[i].scores?.["洞察"]) > num(candidates[best].scores?.["洞察"])) {
      best = i;
    }
  }
  candidates.forEach((c, i) => {
    c.selected = i === best;
  });
}

/**
 * Persist all scored candidates of one template run. Runs in a single transaction.
 * No-op when `candidates` is empty.
 */
export function insertEditorScores(templateRunId: string, candidates: EditorScoreCandidate[]): void {
  if (candidates.length === 0) return;

  const db = getDb();
  const stmt = db.prepare(
    "INSERT INTO editor_scores (id, template_run_id, candidate_id, scores, selected, editor_notes, brief_diff, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const now = Date.now();

  db.transaction(() => {
    for (const c of candidates) {
      stmt.run(
        randomUUID(),
        templateRunId,
        c.candidate_id,
        JSON.stringify(c.scores ?? {}),
        c.selected ? 1 : 0,
        c.editor_notes ?? null,
        c.brief_diff ? JSON.stringify(c.brief_diff) : null,
        now,
      );
    }
  })();
}

/** All scored candidates of one template run, ordered by candidate_id. */
export function getEditorScoresByRun(templateRunId: string): EditorScoreRow[] {
  const db = getDb();
  return db
    .prepare("SELECT * FROM editor_scores WHERE template_run_id = ? ORDER BY candidate_id")
    .all(templateRunId) as EditorScoreRow[];
}

/** One aggregated row of the Phase 2 retrospective. */
export interface EditorScoreRetrospectiveRow {
  /** brief_diff.cross_domain_bucket — the perturbation dimension being grouped on. */
  cross_domain_bucket: string | null;
  candidate_count: number;
  avg_insight: number | null;
  avg_total: number | null;
  selected_count: number;
}

/**
 * Phase 2 retrospective: average scores grouped by the cross-domain bucket each
 * candidate's brief was perturbed with. Reveals which perturbation produces the
 * highest insight density across all recorded runs.
 */
export function getEditorScoreRetrospective(): EditorScoreRetrospectiveRow[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT
         json_extract(brief_diff, '$.cross_domain_bucket') AS cross_domain_bucket,
         COUNT(*) AS candidate_count,
         AVG(json_extract(scores, '$.洞察')) AS avg_insight,
         AVG(json_extract(scores, '$.total')) AS avg_total,
         SUM(selected) AS selected_count
       FROM editor_scores
       GROUP BY cross_domain_bucket
       ORDER BY avg_insight DESC`,
    )
    .all() as EditorScoreRetrospectiveRow[];
}
