import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();
vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

afterAll(() => cleanup());
beforeEach(() => clearTestDb());

import { recordAuditViolation, getViolationsByRole, getViolationsByTask, getViolationsByExecution } from "../../store/audit-violations.js";
import { v4 as uuidv4 } from "uuid";

describe("store/audit-violations", () => {
  beforeEach(() => {
    // seed server_state so migrations don't re-run
    getTestDb().prepare(
      "INSERT OR IGNORE INTO server_state (id, schema_version, created_at) VALUES (1, 52, ?)",
    ).run(Date.now());
  });

  it("inserts a row and retrieves it by task", () => {
    const id = uuidv4();
    recordAuditViolation({
      id,
      stepTaskId: "task-001",
      executionId: "exec-001",
      roleId: "role-abc",
      contractField: "lengthTarget",
      layer: "A",
      severity: "error",
      message: "actual 30 characters / target 100-200 characters",
      createdAt: Date.now(),
    });

    const rows = getViolationsByTask("task-001");
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(id);
    expect(rows[0].contractField).toBe("lengthTarget");
    expect(rows[0].layer).toBe("A");
  });

  it("inserts a row and retrieves it by role", () => {
    const id = uuidv4();
    recordAuditViolation({
      id,
      stepTaskId: "task-002",
      roleId: "role-xyz",
      contractField: "persona.speakAs",
      layer: "B",
      severity: "warning",
      message: "self-identifies as 达芬奇",
      metadata: { confidence: 0.9, issues: ["self-identifies as 达芬奇"], verifierTaskId: "verifier-1" },
      createdAt: Date.now(),
    });

    const rows = getViolationsByRole("role-xyz", 10);
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata?.confidence).toBe(0.9);
    expect(rows[0].metadata?.verifierTaskId).toBe("verifier-1");
  });

  it("inserts a row and retrieves it by execution", () => {
    const id = uuidv4();
    recordAuditViolation({
      id,
      stepTaskId: "task-003",
      executionId: "exec-003",
      roleId: "role-abc",
      contractField: "format",
      layer: "A",
      severity: "error",
      message: "format=markdown declared but no heading detected",
      createdAt: Date.now(),
    });

    const rows = getViolationsByExecution("exec-003");
    expect(rows).toHaveLength(1);
    expect(rows[0].executionId).toBe("exec-003");
  });

  it("CHECK constraint rejects invalid layer value", () => {
    // NOTE: "C" was added as a valid layer in Phase 1 customAssertions (schema v75).
    // Use "Z" as the deliberately-invalid sentinel — it stays outside the allowed set (A | B | C).
    const db = getTestDb();
    expect(() => {
      db.prepare(`
        INSERT INTO audit_violations
          (id, step_task_id, role_id, contract_field, layer, severity, message, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(uuidv4(), "task-err", "role-abc", "lengthTarget", "Z", "error", "bad layer", Date.now());
    }).toThrow();
  });

  it("CHECK constraint accepts layer 'C' (Phase 1 customAssertions)", () => {
    // Regression test: layer 'C' must insert successfully after schema v75 migration
    // adds 'C' to the allowed set. If this throws, the production migration was missed.
    const db = getTestDb();
    expect(() => {
      db.prepare(`
        INSERT INTO audit_violations
          (id, step_task_id, role_id, contract_field, layer, severity, message, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(uuidv4(), "task-c", "role-abc", "customAssertions", "C", "warning", "layer C accepted", Date.now());
    }).not.toThrow();
  });

  it("CHECK constraint rejects invalid severity value", () => {
    const db = getTestDb();
    expect(() => {
      db.prepare(`
        INSERT INTO audit_violations
          (id, step_task_id, role_id, contract_field, layer, severity, message, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(uuidv4(), "task-err2", "role-abc", "lengthTarget", "A", "critical", "bad severity", Date.now());
    }).toThrow();
  });

  it("getViolationsByRole respects limit", () => {
    for (let i = 0; i < 5; i++) {
      recordAuditViolation({
        id: uuidv4(),
        stepTaskId: `task-limit-${i}`,
        roleId: "role-limit",
        contractField: "lengthTarget",
        layer: "A",
        severity: "error",
        message: `msg ${i}`,
        createdAt: Date.now() - i,
      });
    }
    const rows = getViolationsByRole("role-limit", 3);
    expect(rows).toHaveLength(3);
  });

  it("returns empty array for non-existent role", () => {
    const rows = getViolationsByRole("role-nonexistent");
    expect(rows).toHaveLength(0);
  });
});
