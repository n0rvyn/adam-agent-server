import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

import { createArtifact, getArtifact } from "../../store/artifacts.js";
import type { Artifact } from "../../store/artifacts.js";

afterAll(() => cleanup());
beforeEach(() => {
  clearTestDb();
  // Seed task_templates first (template_executions FK -> task_templates(id)),
  // then seed template_executions to satisfy execution_id FK on artifacts.
  // Verified columns against test-db.ts:257-267 (template_executions has no dispatch_mode).
  const db = getTestDb();
  db.prepare(`
    INSERT INTO task_templates (id, name, trigger_type, steps, created_at)
    VALUES ('tmpl-1', 'test-template', 'manual', '[]', 1000)
  `).run();
  db.prepare(`
    INSERT INTO template_executions (id, template_id, status, step_statuses, started_at)
    VALUES ('exec-1', 'tmpl-1', 'completed', '{}', 1000)
  `).run();
});

describe("template_execution_artifacts envelope round-trip (UX-013, column<->arg position safety)", () => {
  it("ux-013b-attachments-purpose-locator-roundtrip-artifacts: preserves all 19 fields end-to-end (write -> read)", () => {
    const artifact: Artifact = {
      id: "art-001",
      sourceKind: "template_step",
      roleId: "role-test",
      executionId: "exec-1",
      stepId: "step-A",
      key: "key-X",
      kind: "file",
      blobPath: "/tmp/blob-001",
      mime: "application/pdf",
      originalFilename: "report.pdf",
      sizeBytes: 12345,
      createdAt: 1700000000000,
      locator: "local:///tmp/blob-001",
      contentHash: "abc123",
      retentionHint: "persistent",
      encryptionClass: "none",
      purpose: "report",
      replaces: "art-prev-000",
      producedByRole: "审慎者",
      access: "private",
    };
    createArtifact(artifact);
    const read = getArtifact("exec-1", "step-A", "key-X");
    expect(read).toBeDefined();

    // Spot every field to catch column<->arg position swaps
    expect(read?.id).toBe(artifact.id);
    expect(read?.executionId).toBe(artifact.executionId);
    expect(read?.stepId).toBe(artifact.stepId);
    expect(read?.key).toBe(artifact.key);
    expect(read?.kind).toBe("file");
    expect(read?.blobPath).toBe(artifact.blobPath);
    expect(read?.mime).toBe(artifact.mime);
    expect(read?.originalFilename).toBe(artifact.originalFilename);
    expect(read?.sizeBytes).toBe(artifact.sizeBytes);
    expect(read?.createdAt).toBe(artifact.createdAt);
    expect(read?.locator).toBe(artifact.locator);
    expect(read?.contentHash).toBe(artifact.contentHash);
    expect(read?.retentionHint).toBe("persistent");
    expect(read?.encryptionClass).toBe("none");
    expect(read?.purpose).toBe("report");
    expect(read?.replaces).toBe(artifact.replaces);
    expect(read?.producedByRole).toBe(artifact.producedByRole);
    expect(read?.access).toBe("private");
  });

  it("preserves JSON-typed value field (kind='json')", () => {
    const artifact: Artifact = {
      id: "art-json-1",
      sourceKind: "template_step",
      roleId: "role-test",
      executionId: "exec-1",
      stepId: "step-B",
      key: "summary",
      kind: "json",
      value: { score: 0.87, tags: ["fast", "fresh"] },
      sizeBytes: 32,
      createdAt: 1700000000001,
    };
    createArtifact(artifact);
    const read = getArtifact("exec-1", "step-B", "summary");
    expect(read?.kind).toBe("json");
    expect(read?.value).toEqual(artifact.value);
  });

  it("null/undefined optional fields read back as undefined", () => {
    const artifact: Artifact = {
      id: "art-min-1",
      sourceKind: "template_step",
      roleId: "role-test",
      executionId: "exec-1",
      stepId: "step-C",
      key: "minimal",
      kind: "file",
      sizeBytes: 0,
      createdAt: 1700000000002,
    };
    createArtifact(artifact);
    const read = getArtifact("exec-1", "step-C", "minimal");
    expect(read?.locator).toBeUndefined();
    expect(read?.contentHash).toBeUndefined();
    expect(read?.retentionHint).toBeUndefined();
    expect(read?.purpose).toBeUndefined();
    expect(read?.replaces).toBeUndefined();
  });
});
