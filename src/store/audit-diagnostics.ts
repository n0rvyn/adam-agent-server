import { v4 as uuidv4 } from "uuid";
import { getDb } from "./db.js";
import type { AuditDiagnostic, AuditDiagnosticSeverity, AuditDiagnosticSource } from "../shared/types.js";
import { getCurrentTraceId } from "../lib/trace-context.js";

interface AuditDiagnosticRow {
  id: string;
  source: string;
  severity: string;
  trace_id: string | null;
  source_id: string | null;
  message: string;
  created_at: number;
}

export interface RecordAuditDiagnosticInput {
  source: AuditDiagnosticSource;
  severity: AuditDiagnosticSeverity;
  traceId?: string;
  sourceId?: string;
  message: string;
  createdAt?: number;
}

export function recordAuditDiagnostic(input: RecordAuditDiagnosticInput): AuditDiagnostic {
  const diagnostic: AuditDiagnostic = {
    id: uuidv4(),
    source: input.source,
    severity: input.severity,
    traceId: input.traceId ?? getCurrentTraceId() ?? undefined,
    sourceId: input.sourceId,
    message: input.message,
    createdAt: input.createdAt ?? Date.now(),
  };

  getDb().prepare(`
    INSERT INTO audit_diagnostics (id, source, severity, trace_id, source_id, message, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    diagnostic.id,
    diagnostic.source,
    diagnostic.severity,
    diagnostic.traceId ?? null,
    diagnostic.sourceId ?? null,
    diagnostic.message,
    diagnostic.createdAt,
  );

  return diagnostic;
}

export function listAuditDiagnostics(args: {
  source?: AuditDiagnosticSource;
  traceId?: string;
  limit?: number;
} = {}): AuditDiagnostic[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (args.source) {
    clauses.push("source = ?");
    params.push(args.source);
  }
  if (args.traceId) {
    clauses.push("trace_id = ?");
    params.push(args.traceId);
  }
  let sql = "SELECT * FROM audit_diagnostics";
  if (clauses.length > 0) sql += ` WHERE ${clauses.join(" AND ")}`;
  sql += " ORDER BY created_at DESC";
  if (args.limit !== undefined) {
    sql += " LIMIT ?";
    params.push(args.limit);
  }
  const rows = getDb().prepare(sql).all(...params) as AuditDiagnosticRow[];
  return rows.map(rowToDiagnostic);
}

function rowToDiagnostic(row: AuditDiagnosticRow): AuditDiagnostic {
  return {
    id: row.id,
    source: row.source,
    severity: row.severity as AuditDiagnosticSeverity,
    traceId: row.trace_id ?? undefined,
    sourceId: row.source_id ?? undefined,
    message: row.message,
    createdAt: row.created_at,
  };
}
