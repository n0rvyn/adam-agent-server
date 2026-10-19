import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../../helpers/test-db.js";
import { vi } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { v4 as uuidv4 } from "uuid";

const { cleanup } = setupTestDb();

vi.mock("../../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

vi.mock("../../../config/index.js", () => ({
  getDefaults: () => ({
    timeout: 600,
    approvalRequired: [],
    approvalTimeout: 300,
    allowedTools: [],
    disallowedTools: [],
    maxTurns: 100,
    maxBudgetUsd: 5.0,
    model: "claude-sonnet-4-6",
    effort: "high",
    settingSources: ["project"],
    env: {},
  }),
}));

import { artifactRoutes } from "../../../server/routes/artifacts.js";
import { createArtifact } from "../../../store/artifacts.js";
import { createDeliveryLog } from "../../../store/delivery-log.js";
import type { Artifact } from "../../../store/artifacts.js";

afterAll(() => cleanup());

/**
 * Seed helper utilities.
 * Each source_kind requires a corresponding parent row due to FK constraints:
 * - template_step → template_executions row
 * - task_published → tasks row
 * - chat_sent → chat_sessions row
 */
function seedTaskRow(taskId: string): void {
  getTestDb().prepare(`
    INSERT OR IGNORE INTO tasks (id, status, prompt, config, created_at)
    VALUES (?, 'completed', 'test', '{}', ?)
  `).run(taskId, Date.now());
}

function seedTemplateRow(executionId: string): void {
  // template_executions requires template_id → seed a task_template first
  const templateId = `tmpl-${executionId}`;
  getTestDb().prepare(`
    INSERT OR IGNORE INTO task_templates (id, name, trigger_type, steps, created_at, updated_at)
    VALUES (?, 'test-tmpl', 'manual', '[]', ?, ?)
  `).run(templateId, Date.now(), Date.now());
  getTestDb().prepare(`
    INSERT OR IGNORE INTO template_executions (id, template_id, status, step_statuses, started_at)
    VALUES (?, ?, 'completed', '{}', ?)
  `).run(executionId, templateId, Date.now());
}

function seedChatSessionRow(chatSessionId: string): void {
  getTestDb().prepare(`
    INSERT OR IGNORE INTO chat_sessions (id, status, source_type, created_at, last_active_at)
    VALUES (?, 'active', 'web', ?, ?)
  `).run(chatSessionId, Date.now(), Date.now());
}

function makeArtifact(overrides: Partial<Artifact> & { id?: string }): Artifact {
  return {
    id: overrides.id ?? uuidv4(),
    sourceKind: overrides.sourceKind ?? "task_published",
    taskId: overrides.taskId,
    executionId: overrides.executionId,
    chatSessionId: overrides.chatSessionId,
    stepId: overrides.stepId,
    roleId: overrides.roleId ?? "role-test",
    key: overrides.key,
    kind: overrides.kind ?? "file",
    blobPath: overrides.blobPath,
    mime: overrides.mime ?? "text/plain",
    originalFilename: overrides.originalFilename,
    sizeBytes: overrides.sizeBytes ?? 0,
    createdAt: overrides.createdAt ?? Date.now(),
  };
}

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(artifactRoutes);
  return app;
}

describe("server/routes/artifacts — list / detail / alias", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(() => {
    clearTestDb();
  });

  afterAll(async () => {
    await app.close();
  });

  // Test case A: GET /artifacts returns empty list for empty DB
  it("A: GET /artifacts returns empty list", async () => {
    const resp = await app.inject({ method: "GET", url: "/artifacts" });
    expect(resp.statusCode).toBe(200);
    const body = resp.json();
    expect(body.artifacts).toEqual([]);
    expect(body.total).toBe(0);
  });

  // Test case B: GET /artifacts returns all 3 source_kind rows, sorted by created_at DESC
  it("B: GET /artifacts returns 3 rows sorted by created_at DESC", async () => {
    const taskId = uuidv4();
    seedTaskRow(taskId);
    const execId = uuidv4();
    seedTemplateRow(execId);
    const sessionId = uuidv4();
    seedChatSessionRow(sessionId);

    const now = Date.now();
    createArtifact(makeArtifact({ sourceKind: "task_published", taskId, roleId: "role-b", createdAt: now - 2000 }));
    createArtifact(makeArtifact({ sourceKind: "template_step", executionId: execId, stepId: "step-1", key: "out-b", roleId: "role-b", createdAt: now - 1000 }));
    createArtifact(makeArtifact({ sourceKind: "chat_sent", chatSessionId: sessionId, roleId: "role-b", createdAt: now }));

    const resp = await app.inject({ method: "GET", url: "/artifacts" });
    expect(resp.statusCode).toBe(200);
    const body = resp.json();
    expect(body.artifacts).toHaveLength(3);
    expect(body.total).toBe(3);
    // First item should have the highest createdAt
    expect(body.artifacts[0].createdAt).toBeGreaterThanOrEqual(body.artifacts[1].createdAt);
    expect(body.artifacts[1].createdAt).toBeGreaterThanOrEqual(body.artifacts[2].createdAt);
  });

  // Test case C: filter ?source_kind=template_step
  it("C: ?source_kind=template_step returns only template_step rows", async () => {
    const taskId = uuidv4();
    seedTaskRow(taskId);
    const execId = uuidv4();
    seedTemplateRow(execId);
    const sessionId = uuidv4();
    seedChatSessionRow(sessionId);

    createArtifact(makeArtifact({ sourceKind: "task_published", taskId, roleId: "role-c" }));
    createArtifact(makeArtifact({ sourceKind: "template_step", executionId: execId, stepId: "step-1", key: "out-c", roleId: "role-c" }));
    createArtifact(makeArtifact({ sourceKind: "chat_sent", chatSessionId: sessionId, roleId: "role-c" }));

    const resp = await app.inject({ method: "GET", url: "/artifacts?source_kind=template_step" });
    expect(resp.statusCode).toBe(200);
    const body = resp.json();
    expect(body.artifacts).toHaveLength(1);
    expect(body.artifacts[0].sourceKind).toBe("template_step");
  });

  // Test case D: filter ?mime_prefix=audio/
  it("D: ?mime_prefix=audio/ returns only audio rows", async () => {
    const t1 = uuidv4(); seedTaskRow(t1);
    const t2 = uuidv4(); seedTaskRow(t2);
    const t3 = uuidv4(); seedTaskRow(t3);

    createArtifact(makeArtifact({ sourceKind: "task_published", taskId: t1, mime: "audio/mpeg", roleId: "role-d" }));
    createArtifact(makeArtifact({ sourceKind: "task_published", taskId: t2, mime: "image/png", roleId: "role-d" }));
    createArtifact(makeArtifact({ sourceKind: "task_published", taskId: t3, mime: "text/plain", roleId: "role-d" }));

    const resp = await app.inject({ method: "GET", url: "/artifacts?mime_prefix=audio%2F" });
    expect(resp.statusCode).toBe(200);
    const body = resp.json();
    expect(body.artifacts).toHaveLength(1);
    expect(body.artifacts[0].mime).toBe("audio/mpeg");
  });

  // Test case E: filter ?from=<ts>&to=<ts>
  it("E: ?from + ?to filters by date range", async () => {
    const base = 1_700_000_000_000;
    const t1 = uuidv4(); seedTaskRow(t1);
    const t2 = uuidv4(); seedTaskRow(t2);
    const t3 = uuidv4(); seedTaskRow(t3);

    createArtifact(makeArtifact({ sourceKind: "task_published", taskId: t1, roleId: "role-e", createdAt: base }));
    createArtifact(makeArtifact({ sourceKind: "task_published", taskId: t2, roleId: "role-e", createdAt: base + 1000 }));
    createArtifact(makeArtifact({ sourceKind: "task_published", taskId: t3, roleId: "role-e", createdAt: base + 2000 }));

    const from = base + 500;
    const to = base + 1500;
    const resp = await app.inject({ method: "GET", url: `/artifacts?from=${from}&to=${to}` });
    expect(resp.statusCode).toBe(200);
    const body = resp.json();
    expect(body.artifacts).toHaveLength(1);
    expect(body.total).toBe(1);
  });

  // Test case F: filter ?role_id=role-x returns only those rows
  it("F: ?role_id filter returns matching rows", async () => {
    const t1 = uuidv4(); seedTaskRow(t1);
    const t2 = uuidv4(); seedTaskRow(t2);
    const t3 = uuidv4(); seedTaskRow(t3);

    createArtifact(makeArtifact({ sourceKind: "task_published", taskId: t1, roleId: "role-x" }));
    createArtifact(makeArtifact({ sourceKind: "task_published", taskId: t2, roleId: "role-x" }));
    createArtifact(makeArtifact({ sourceKind: "task_published", taskId: t3, roleId: "role-other" }));

    const resp = await app.inject({ method: "GET", url: "/artifacts?role_id=role-x" });
    expect(resp.statusCode).toBe(200);
    const body = resp.json();
    expect(body.artifacts).toHaveLength(2);
    expect(body.total).toBe(2);
  });

  // Test case G: pagination ?limit=2&offset=1
  it("G: pagination limit + offset", async () => {
    for (let i = 0; i < 5; i++) {
      const tid = uuidv4(); seedTaskRow(tid);
      createArtifact(makeArtifact({ sourceKind: "task_published", taskId: tid, roleId: "role-g" }));
    }

    const resp = await app.inject({ method: "GET", url: "/artifacts?limit=2&offset=1" });
    expect(resp.statusCode).toBe(200);
    const body = resp.json();
    expect(body.artifacts).toHaveLength(2);
    expect(body.total).toBe(5);
  });

  // Test case H: GET /artifacts/:id exists — returns artifact + empty deliveryLog
  it("H: GET /artifacts/:id returns artifact with empty deliveryLog", async () => {
    const tid = uuidv4(); seedTaskRow(tid);
    const artifact = makeArtifact({ sourceKind: "task_published", taskId: tid, roleId: "role-h" });
    createArtifact(artifact);

    const resp = await app.inject({ method: "GET", url: `/artifacts/${artifact.id}` });
    expect(resp.statusCode).toBe(200);
    const body = resp.json();
    expect(body.artifact).toBeDefined();
    expect(body.artifact.id).toBe(artifact.id);
    expect(body.deliveryLog).toEqual([]);
  });

  // Test case I: GET /artifacts/:id not found → 404
  it("I: GET /artifacts/:id not found returns 404", async () => {
    const resp = await app.inject({ method: "GET", url: "/artifacts/nonexistent-id" });
    expect(resp.statusCode).toBe(404);
    const body = resp.json();
    expect(body.code).toBe("NOT_FOUND");
  });

  // Test case J: GET /artifacts/:id includes delivery_log rows matching task_id
  it("J: GET /artifacts/:id returns delivery_log entries", async () => {
    const tid = uuidv4(); seedTaskRow(tid);
    const artifact = makeArtifact({ sourceKind: "task_published", taskId: tid, roleId: "role-j" });
    createArtifact(artifact);

    // seed 2 delivery_log rows with same task_id
    const logBase = { status: "delivered" as const, target: { type: "channel" as const, channelId: "ch-1" }, content: "msg", attempts: 1, createdAt: Date.now(), expiresAt: Date.now() + 86400000 };
    createDeliveryLog({ id: uuidv4(), taskId: tid, ...logBase });
    createDeliveryLog({ id: uuidv4(), taskId: tid, ...logBase });

    const resp = await app.inject({ method: "GET", url: `/artifacts/${artifact.id}` });
    expect(resp.statusCode).toBe(200);
    const body = resp.json();
    expect(body.deliveryLog).toHaveLength(2);
  });

  // Test case K: chat_sent source → deliveryLog === []
  it("K: GET /artifacts/:id chat_sent source returns empty deliveryLog", async () => {
    const sessionId = uuidv4(); seedChatSessionRow(sessionId);
    const artifact = makeArtifact({ sourceKind: "chat_sent", chatSessionId: sessionId, roleId: "role-k" });
    createArtifact(artifact);

    const resp = await app.inject({ method: "GET", url: `/artifacts/${artifact.id}` });
    expect(resp.statusCode).toBe(200);
    const body = resp.json();
    expect(body.deliveryLog).toEqual([]);
  });

  // Test case L: GET /tasks/:taskId/artifacts alias
  it("L: GET /tasks/:taskId/artifacts alias returns only task-matching rows", async () => {
    const tid = uuidv4(); seedTaskRow(tid);
    const sessionId = uuidv4(); seedChatSessionRow(sessionId);

    createArtifact(makeArtifact({ sourceKind: "task_published", taskId: tid, roleId: "role-l" }));
    createArtifact(makeArtifact({ sourceKind: "chat_sent", chatSessionId: sessionId, roleId: "role-l" }));

    const resp = await app.inject({ method: "GET", url: `/tasks/${tid}/artifacts` });
    expect(resp.statusCode).toBe(200);
    const body = resp.json();
    expect(body.artifacts).toHaveLength(1);
    expect(body.artifacts[0].taskId).toBe(tid);
  });

  // Test case M: validation errors
  it("M: ?limit=999 returns 400 validation error", async () => {
    const resp = await app.inject({ method: "GET", url: "/artifacts?limit=999" });
    expect(resp.statusCode).toBe(400);
    const body = resp.json();
    expect(body.code).toBe("VALIDATION_ERROR");
  });

  it("M2: ?source_kind=invalid returns 400 validation error", async () => {
    const resp = await app.inject({ method: "GET", url: "/artifacts?source_kind=invalid" });
    expect(resp.statusCode).toBe(400);
    const body = resp.json();
    expect(body.code).toBe("VALIDATION_ERROR");
  });
});
