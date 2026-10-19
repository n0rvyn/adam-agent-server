import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

import {
  createArtifact,
  getArtifact,
  getArtifactById,
  listArtifactsByExecution,
  listArtifactsByTask,
  listArtifactsByChatSession,
  listArtifactsByRole,
  removeArtifact,
  type Artifact,
} from "../../store/artifacts.js";
import { createTaskTemplate } from "../../store/task-templates.js";
import { createTemplateExecution } from "../../store/template-executions.js";

afterAll(() => cleanup());

function seedExecution(id: string) {
  createTaskTemplate({
    id: `tmpl-${id}`,
    name: id,
    trigger: { type: "manual" },
    steps: [{ id: "s1", prompt: "x" }],
    rolePreference: "role-test",
    enabled: true,
    createdAt: Date.now(),
  });
  createTemplateExecution(id, `tmpl-${id}`);
}

function seedTask(id: string) {
  getTestDb().prepare(
    `INSERT OR IGNORE INTO tasks (id, prompt, config, status, created_at) VALUES (?, ?, ?, 'pending', ?)`,
  ).run(id, "test", "{}", Date.now());
}

function seedChatSession(id: string) {
  const now = Date.now();
  getTestDb().prepare(
    `INSERT OR IGNORE INTO chat_sessions (id, source_type, status, created_at, last_active_at) VALUES (?, 'web', 'active', ?, ?)`,
  ).run(id, now, now);
}

describe("store/artifacts", () => {
  beforeEach(() => {
    clearTestDb();
  });

  it("createArtifact accepts source_kind='template_step' with execution_id + step_id", () => {
    seedExecution("exec-ts");
    expect(() =>
      createArtifact({
        id: "art-ts-1",
        sourceKind: "template_step",
        executionId: "exec-ts",
        stepId: "s1",
        key: "output",
        kind: "json",
        value: { ok: true },
        sizeBytes: 10,
        createdAt: 1,
        roleId: "role-test",
      }),
    ).not.toThrow();
    const result = getArtifact("exec-ts", "s1", "output");
    expect(result).toBeDefined();
    expect(result?.id).toBe("art-ts-1");
    expect(result?.sourceKind).toBe("template_step");
  });

  it("createArtifact accepts source_kind='task_published' with task_id", () => {
    seedTask("task-abc");
    expect(() =>
      createArtifact({
        id: "art-tp-1",
        sourceKind: "task_published",
        taskId: "task-abc",
        key: "report",
        kind: "json",
        value: { data: "x" },
        sizeBytes: 5,
        createdAt: 2,
        roleId: "role-test",
      }),
    ).not.toThrow();
    const result = getArtifactById("art-tp-1");
    expect(result).toBeDefined();
    expect(result?.sourceKind).toBe("task_published");
    expect(result?.taskId).toBe("task-abc");
  });

  it("createArtifact accepts source_kind='chat_sent' with chat_session_id", () => {
    seedChatSession("session-xyz");
    expect(() =>
      createArtifact({
        id: "art-cs-1",
        sourceKind: "chat_sent",
        chatSessionId: "session-xyz",
        key: "attachment",
        kind: "file",
        blobPath: "/tmp/file.bin",
        mime: "application/pdf",
        sizeBytes: 100,
        createdAt: 3,
        roleId: "role-test",
      }),
    ).not.toThrow();
    const result = getArtifactById("art-cs-1");
    expect(result).toBeDefined();
    expect(result?.sourceKind).toBe("chat_sent");
    expect(result?.chatSessionId).toBe("session-xyz");
  });

  it("createArtifact requires roleId (application enforcement, not SQL CHECK)", () => {
    seedExecution("exec-roleid");
    expect(() =>
      createArtifact({
        id: "art-norole",
        sourceKind: "template_step",
        executionId: "exec-roleid",
        stepId: "s1",
        key: "out",
        kind: "json",
        value: 1,
        sizeBytes: 1,
        createdAt: 1,
        roleId: "",
      } as unknown as Artifact),
    ).toThrow();
  });

  it("createArtifact rejects template_step row missing execution_id (DB CHECK)", () => {
    // Bypass app validation via raw INSERT to test DB CHECK constraint
    expect(() =>
      getTestDb()
        .prepare(
          `INSERT INTO artifacts (id, source_kind, execution_id, step_id, key, kind, size_bytes, created_at, role_id)
           VALUES (?, 'template_step', NULL, 's1', 'k', 'json', 1, 1, 'r')`,
        )
        .run("art-check-1"),
    ).toThrow();
  });

  it("createArtifact rejects task_published row with execution_id (DB CHECK)", () => {
    expect(() =>
      getTestDb()
        .prepare(
          `INSERT INTO artifacts (id, source_kind, execution_id, task_id, key, kind, size_bytes, created_at, role_id)
           VALUES (?, 'task_published', 'exec-id', 'task-id', 'k', 'json', 1, 1, 'r')`,
        )
        .run("art-check-2"),
    ).toThrow();
  });

  it("createArtifact rejects chat_sent row with task_id (DB CHECK)", () => {
    expect(() =>
      getTestDb()
        .prepare(
          `INSERT INTO artifacts (id, source_kind, chat_session_id, task_id, key, kind, size_bytes, created_at, role_id)
           VALUES (?, 'chat_sent', 'session-id', 'task-id', 'k', 'json', 1, 1, 'r')`,
        )
        .run("art-check-3"),
    ).toThrow();
  });

  it("createArtifact preserves all optional v50 columns (locator, content_hash, retention_hint, etc.)", () => {
    seedExecution("exec-opts");
    createArtifact({
      id: "art-opts",
      sourceKind: "template_step",
      executionId: "exec-opts",
      stepId: "s1",
      key: "full",
      kind: "file",
      blobPath: "/tmp/a.bin",
      mime: "audio/mpeg",
      originalFilename: "audio.mp3",
      sizeBytes: 512,
      createdAt: 100,
      locator: "s3://bucket/key",
      contentHash: "sha256:abc123",
      retentionHint: "persistent",
      encryptionClass: "at_rest",
      purpose: "media",
      replaces: "art-old",
      producedByRole: "role-producer",
      access: "private",
      roleId: "role-test",
    });
    const result = getArtifact("exec-opts", "s1", "full");
    expect(result).toMatchObject({
      id: "art-opts",
      blobPath: "/tmp/a.bin",
      mime: "audio/mpeg",
      originalFilename: "audio.mp3",
      locator: "s3://bucket/key",
      contentHash: "sha256:abc123",
      retentionHint: "persistent",
      encryptionClass: "at_rest",
      purpose: "media",
      replaces: "art-old",
      producedByRole: "role-producer",
      access: "private",
    });
  });

  it("getArtifact(executionId, stepId, key) returns template_step artifact", () => {
    seedExecution("exec-get");
    createArtifact({
      id: "art-get",
      sourceKind: "template_step",
      executionId: "exec-get",
      stepId: "s1",
      key: "mykey",
      kind: "json",
      value: { found: true },
      sizeBytes: 5,
      createdAt: 10,
      roleId: "role-test",
    });
    const result = getArtifact("exec-get", "s1", "mykey");
    expect(result?.id).toBe("art-get");
    expect(result?.executionId).toBe("exec-get");
  });

  it("getArtifactById(id) returns artifact regardless of source_kind", () => {
    seedExecution("exec-byid");
    seedTask("task-byid");
    seedChatSession("sess-byid");
    createArtifact({
      id: "byid-ts",
      sourceKind: "template_step",
      executionId: "exec-byid",
      stepId: "s1",
      key: "a",
      kind: "json",
      value: 1,
      sizeBytes: 1,
      createdAt: 1,
      roleId: "role-test",
    });
    createArtifact({
      id: "byid-tp",
      sourceKind: "task_published",
      taskId: "task-byid",
      key: "b",
      kind: "json",
      value: 2,
      sizeBytes: 1,
      createdAt: 2,
      roleId: "role-test",
    });
    createArtifact({
      id: "byid-cs",
      sourceKind: "chat_sent",
      chatSessionId: "sess-byid",
      key: "c",
      kind: "json",
      value: 3,
      sizeBytes: 1,
      createdAt: 3,
      roleId: "role-test",
    });
    expect(getArtifactById("byid-ts")?.sourceKind).toBe("template_step");
    expect(getArtifactById("byid-tp")?.sourceKind).toBe("task_published");
    expect(getArtifactById("byid-cs")?.sourceKind).toBe("chat_sent");
    expect(getArtifactById("nonexistent")).toBeUndefined();
  });

  it("listArtifactsByExecution returns only template_step rows for that execution", () => {
    seedExecution("exec-list-e");
    seedTask("task-other");
    createArtifact({ id: "e1", sourceKind: "template_step", executionId: "exec-list-e", stepId: "s1", key: "a", kind: "json", value: 1, sizeBytes: 1, createdAt: 1, roleId: "role-test" });
    createArtifact({ id: "e2", sourceKind: "template_step", executionId: "exec-list-e", stepId: "s2", key: "b", kind: "json", value: 2, sizeBytes: 1, createdAt: 2, roleId: "role-test" });
    createArtifact({ id: "tp1", sourceKind: "task_published", taskId: "task-other", key: "c", kind: "json", value: 3, sizeBytes: 1, createdAt: 3, roleId: "role-test" });
    const results = listArtifactsByExecution("exec-list-e");
    expect(results.map((r) => r.id)).toEqual(["e1", "e2"]);
    expect(results.every((r) => r.sourceKind === "template_step")).toBe(true);
  });

  it("listArtifactsByTask returns only task_published rows for that task", () => {
    seedTask("task-list");
    seedTask("task-other2");
    createArtifact({ id: "t1", sourceKind: "task_published", taskId: "task-list", key: "a", kind: "json", value: 1, sizeBytes: 1, createdAt: 1, roleId: "role-test" });
    createArtifact({ id: "t2", sourceKind: "task_published", taskId: "task-list", key: "b", kind: "json", value: 2, sizeBytes: 1, createdAt: 2, roleId: "role-test" });
    createArtifact({ id: "t3", sourceKind: "task_published", taskId: "task-other2", key: "c", kind: "json", value: 3, sizeBytes: 1, createdAt: 3, roleId: "role-test" });
    const results = listArtifactsByTask("task-list");
    expect(results.map((r) => r.id)).toEqual(["t1", "t2"]);
    expect(results.every((r) => r.taskId === "task-list")).toBe(true);
  });

  it("listArtifactsByChatSession returns only chat_sent rows for that session", () => {
    seedChatSession("sess-list");
    seedChatSession("sess-other");
    createArtifact({ id: "cs1", sourceKind: "chat_sent", chatSessionId: "sess-list", key: "a", kind: "json", value: 1, sizeBytes: 1, createdAt: 1, roleId: "role-test" });
    createArtifact({ id: "cs2", sourceKind: "chat_sent", chatSessionId: "sess-list", key: "b", kind: "json", value: 2, sizeBytes: 1, createdAt: 2, roleId: "role-test" });
    createArtifact({ id: "cs3", sourceKind: "chat_sent", chatSessionId: "sess-other", key: "c", kind: "json", value: 3, sizeBytes: 1, createdAt: 3, roleId: "role-test" });
    const results = listArtifactsByChatSession("sess-list");
    expect(results.map((r) => r.id)).toEqual(["cs1", "cs2"]);
    expect(results.every((r) => r.chatSessionId === "sess-list")).toBe(true);
  });

  it("listArtifactsByRole returns rows from all 3 source_kinds for that role", () => {
    seedExecution("exec-role");
    seedTask("task-role");
    seedTask("task-other-role");
    seedChatSession("sess-role");
    createArtifact({ id: "r1", sourceKind: "template_step", executionId: "exec-role", stepId: "s1", key: "a", kind: "json", value: 1, sizeBytes: 1, createdAt: 1, roleId: "role-shared" });
    createArtifact({ id: "r2", sourceKind: "task_published", taskId: "task-role", key: "b", kind: "json", value: 2, sizeBytes: 1, createdAt: 2, roleId: "role-shared" });
    createArtifact({ id: "r3", sourceKind: "chat_sent", chatSessionId: "sess-role", key: "c", kind: "json", value: 3, sizeBytes: 1, createdAt: 3, roleId: "role-shared" });
    createArtifact({ id: "r4", sourceKind: "task_published", taskId: "task-other-role", key: "d", kind: "json", value: 4, sizeBytes: 1, createdAt: 4, roleId: "role-other" });
    const results = listArtifactsByRole("role-shared");
    expect(results.map((r) => r.id).sort()).toEqual(["r1", "r2", "r3"]);
  });

  it("removeArtifact deletes row + returns true; returns false if id not found", () => {
    seedExecution("exec-remove");
    createArtifact({
      id: "art-remove",
      sourceKind: "template_step",
      executionId: "exec-remove",
      stepId: "s1",
      key: "out",
      kind: "json",
      value: 1,
      sizeBytes: 1,
      createdAt: 1,
      roleId: "role-test",
    });
    expect(removeArtifact("art-remove")).toBe(true);
    expect(getArtifactById("art-remove")).toBeUndefined();
    expect(removeArtifact("nonexistent-id")).toBe(false);
  });

  it("template_step UNIQUE(execution_id, step_id, key) enforced", () => {
    seedExecution("exec-uniq");
    createArtifact({ id: "u1", sourceKind: "template_step", executionId: "exec-uniq", stepId: "s1", key: "dup", kind: "json", value: 1, sizeBytes: 1, createdAt: 1, roleId: "role-test" });
    expect(() =>
      createArtifact({ id: "u2", sourceKind: "template_step", executionId: "exec-uniq", stepId: "s1", key: "dup", kind: "json", value: 2, sizeBytes: 1, createdAt: 2, roleId: "role-test" }),
    ).toThrow();
  });

  it("task_published with same key is allowed (no UNIQUE)", () => {
    seedTask("task-dup");
    expect(() => {
      createArtifact({ id: "tp-dup1", sourceKind: "task_published", taskId: "task-dup", key: "report", kind: "json", value: 1, sizeBytes: 1, createdAt: 1, roleId: "role-test" });
      createArtifact({ id: "tp-dup2", sourceKind: "task_published", taskId: "task-dup", key: "report", kind: "json", value: 2, sizeBytes: 1, createdAt: 2, roleId: "role-test" });
    }).not.toThrow();
    const results = listArtifactsByTask("task-dup");
    expect(results).toHaveLength(2);
  });

  it("chat_sent with same filename is allowed (no UNIQUE)", () => {
    seedChatSession("sess-dup");
    expect(() => {
      createArtifact({ id: "cs-dup1", sourceKind: "chat_sent", chatSessionId: "sess-dup", key: "f1", kind: "file", originalFilename: "photo.jpg", sizeBytes: 50, createdAt: 1, roleId: "role-test" });
      createArtifact({ id: "cs-dup2", sourceKind: "chat_sent", chatSessionId: "sess-dup", key: "f2", kind: "file", originalFilename: "photo.jpg", sizeBytes: 50, createdAt: 2, roleId: "role-test" });
    }).not.toThrow();
    const results = listArtifactsByChatSession("sess-dup");
    expect(results).toHaveLength(2);
  });
});
