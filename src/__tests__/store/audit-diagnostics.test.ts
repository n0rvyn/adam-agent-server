import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

import { listAuditDiagnostics, recordAuditDiagnostic } from "../../store/audit-diagnostics.js";

afterAll(() => cleanup());
beforeEach(() => clearTestDb());

describe("store/audit-diagnostics", () => {
  it("records diagnostics and filters by source plus trace id", () => {
    recordAuditDiagnostic({
      source: "delivery_ledger",
      severity: "error",
      traceId: "trace-1",
      sourceId: "task-1",
      message: "ledger failed",
      createdAt: 1000,
    });
    recordAuditDiagnostic({
      source: "viewer_identity",
      severity: "warning",
      traceId: "trace-2",
      sourceId: "ch-1",
      message: "viewer missing",
      createdAt: 2000,
    });

    expect(listAuditDiagnostics({ source: "delivery_ledger" })).toEqual([
      expect.objectContaining({ source: "delivery_ledger", traceId: "trace-1", message: "ledger failed" }),
    ]);
    expect(listAuditDiagnostics({ traceId: "trace-2" })).toEqual([
      expect.objectContaining({ source: "viewer_identity", sourceId: "ch-1" }),
    ]);
  });
});
