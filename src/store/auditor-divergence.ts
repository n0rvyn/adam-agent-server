import { v4 as uuidv4 } from "uuid";
import { getDb } from "./db.js";
import type { AuditorDivergenceRow, AuditorDivergenceSubtype, VerdictPair } from "../shared/types.js";

export interface WriteDivergenceArgs {
  traceId: string;
  sessionId?: string;
  messageId?: string;
  taskId?: string;
  wirePoint: "message_handler" | "chat_manager_envelope";
  oldVerdict: "passed" | "blocked";
  newVerdict: "passed" | "blocked";
  oldReplacementText?: string;
  newReplacementText?: string;
}

/**
 * Phase 6: always writes a divergence row, tagged with `verdict_pair`.
 * When verdicts agree the subtype is `agreed_pass` or `agreed_block` as a placeholder;
 * consumers should prefer `verdict_pair` for the full 4-way breakdown.
 */
export function writeDivergenceLog(args: WriteDivergenceArgs): string | null {
  const verdictPair: VerdictPair =
    (args.oldVerdict === "passed" && args.newVerdict === "passed") ? "agreed_pass" :
    (args.oldVerdict === "blocked" && args.newVerdict === "blocked") ? "agreed_block" :
    (args.oldVerdict === "blocked" && args.newVerdict === "passed") ? "old_blocks_new_passes" :
    "old_passes_new_blocks";

  // backward-compat divergence_subtype: use verdictPair for real divergences,
  // fall back to old_blocks_new_passes for agreed cases (harmless placeholder).
  const divergenceSubtype: AuditorDivergenceSubtype = verdictPair === "agreed_pass" || verdictPair === "agreed_block"
    ? "old_blocks_new_passes"
    : verdictPair;

  const id = uuidv4();
  try {
    // v65 added verdict_pair column; use PRAGMA table_info guard for production safety.
    const db = getDb();
    const columns = (db.prepare("PRAGMA table_info(auditor_divergence_log)").all() as Array<{ name: string }>);
    const hasVerdictPair = columns.some(c => c.name === "verdict_pair");

    if (hasVerdictPair) {
      db.prepare(`
        INSERT INTO auditor_divergence_log (
          id, trace_id, session_id, message_id, task_id,
          wire_point, old_verdict, new_verdict, divergence_subtype,
          verdict_pair, old_replacement_text, new_replacement_text, recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, args.traceId, args.sessionId ?? null, args.messageId ?? null, args.taskId ?? null,
        args.wirePoint, args.oldVerdict, args.newVerdict, divergenceSubtype,
        verdictPair, args.oldReplacementText ?? null, args.newReplacementText ?? null, Date.now(),
      );
    } else {
      db.prepare(`
        INSERT INTO auditor_divergence_log (
          id, trace_id, session_id, message_id, task_id,
          wire_point, old_verdict, new_verdict, divergence_subtype,
          old_replacement_text, new_replacement_text, recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, args.traceId, args.sessionId ?? null, args.messageId ?? null, args.taskId ?? null,
        args.wirePoint, args.oldVerdict, args.newVerdict, divergenceSubtype,
        args.oldReplacementText ?? null, args.newReplacementText ?? null, Date.now(),
      );
    }
  } catch {
    // Fail-open: persist errors must not block the message.
    return null;
  }
  return id;
}

/**
 * List divergence rows.
 * @note `divergence_subtype` is preserved for backward compat and covers only real-divergence cases.
 * For the full 4-way breakdown (including agreed_pass / agreed_block), use `verdictPair`.
 */
export function listDivergenceLog(filter?: { traceId?: string; subtype?: AuditorDivergenceSubtype }): AuditorDivergenceRow[] {
  let sql = "SELECT * FROM auditor_divergence_log WHERE 1=1";
  const params: unknown[] = [];
  if (filter?.traceId) { sql += " AND trace_id = ?"; params.push(filter.traceId); }
  if (filter?.subtype) { sql += " AND divergence_subtype = ?"; params.push(filter.subtype); }
  sql += " ORDER BY recorded_at ASC";
  const rows = getDb().prepare(sql).all(...params) as Array<Record<string, unknown>>;
  return rows.map(rowToDivergence);
}

function rowToDivergence(row: Record<string, unknown>): AuditorDivergenceRow {
  return {
    id: row.id as string,
    traceId: row.trace_id as string,
    sessionId: (row.session_id as string | null) ?? undefined,
    messageId: (row.message_id as string | null) ?? undefined,
    taskId: (row.task_id as string | null) ?? undefined,
    wirePoint: row.wire_point as "message_handler" | "chat_manager_envelope",
    oldVerdict: row.old_verdict as "passed" | "blocked",
    newVerdict: row.new_verdict as "passed" | "blocked",
    divergenceSubtype: row.divergence_subtype as AuditorDivergenceSubtype,
    // Phase 6: read verdict_pair directly (v65 added the column). Fall back to divergence_subtype
    // for pre-v65 rows where the column may be absent at the application layer.
    verdictPair: (row.verdict_pair as VerdictPair) ?? (row.divergence_subtype as VerdictPair),
    oldReplacementText: (row.old_replacement_text as string | null) ?? undefined,
    newReplacementText: (row.new_replacement_text as string | null) ?? undefined,
    recordedAt: row.recorded_at as number,
  };
}
