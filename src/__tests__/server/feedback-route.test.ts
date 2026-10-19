import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { v4 as uuidv4 } from "uuid";

const { cleanup } = setupTestDb();

// Hoist mocks so they are available at module evaluation time
const { mockApplyFitnessUpdate, mockGetBelief } = vi.hoisted(() => ({
  mockApplyFitnessUpdate: vi.fn(),
  mockGetBelief: vi.fn(),
}));

// Mock db so tests use in-memory testDb
vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

// Mock belief-mechanism to capture applyFitnessUpdate calls
vi.mock("../../agent/belief-mechanism.js", () => ({
  applyFitnessUpdate: mockApplyFitnessUpdate,
  materializeOnTouch: vi.fn(),
  computeEffectiveEma: vi.fn().mockReturnValue(null),
  checkArchiveThreshold: vi.fn().mockReturnValue(false),
  archiveBelief: vi.fn(),
}));

// Mock store/beliefs.js (used by user-feedback.ts via getBelief)
vi.mock("../../store/beliefs.js", () => ({
  getBelief: mockGetBelief,
}));

vi.mock("../../config/runtime.js", () => ({
  getRuntimeConfig: () => ({
    memory: {
      scope: {
        humanFeedbackWeight: 3.0,
        emaAlpha: 0.3,
      },
    },
  }),
}));

import { feedbackRoutes } from "../../server/routes/feedback.js";

afterAll(() => cleanup());

let app: FastifyInstance;

beforeEach(async () => {
  clearTestDb();
  mockApplyFitnessUpdate.mockClear();
  mockGetBelief.mockReset();

  app = Fastify();
  await app.register(feedbackRoutes);
  await app.ready();
});

// Helper: seed a template execution with step statuses
function seedExecution(executionId: string, stepStatuses: Record<string, { taskId: string }> = {}) {
  const templateId = `tmpl-${executionId}`;
  getTestDb().prepare(
    "INSERT OR IGNORE INTO task_templates (id, name, trigger_type, steps, created_at, updated_at) VALUES (?, 'tmpl', 'manual', '[]', ?, ?)"
  ).run(templateId, Date.now(), Date.now());
  getTestDb().prepare(
    "INSERT OR IGNORE INTO template_executions (id, template_id, status, step_statuses, started_at) VALUES (?, ?, 'completed', ?, ?)"
  ).run(executionId, templateId, JSON.stringify(stepStatuses), Date.now());
}

// Helper: seed a task row
function seedTask(taskId: string, roleId: string, contextMeta?: Record<string, unknown>) {
  getTestDb().prepare(
    "INSERT OR IGNORE INTO tasks (id, status, prompt, config, role_id, context_meta, created_at) VALUES (?, 'completed', 'test', '{}', ?, ?, ?)"
  ).run(taskId, roleId, contextMeta ? JSON.stringify(contextMeta) : null, Date.now());
}

describe("POST /executions/:executionId/feedback", () => {
  it("persists a good rating and returns ok=true", async () => {
    const executionId = uuidv4();
    seedExecution(executionId);

    const res = await app.inject({
      method: "POST",
      url: `/executions/${executionId}/feedback`,
      payload: { rating: "good" },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });

    const row = getTestDb()
      .prepare("SELECT * FROM user_feedback WHERE execution_id = ?")
      .get(executionId) as { rating: string; step_id: string | null } | undefined;
    expect(row).toBeDefined();
    expect(row!.rating).toBe("good");
    expect(row!.step_id).toBeNull();
  });

  it("persists a bad rating and returns ok=true", async () => {
    const executionId = uuidv4();
    seedExecution(executionId);

    const res = await app.inject({
      method: "POST",
      url: `/executions/${executionId}/feedback`,
      payload: { rating: "bad" },
    });

    expect(res.statusCode).toBe(200);
    const row = getTestDb()
      .prepare("SELECT * FROM user_feedback WHERE execution_id = ?")
      .get(executionId) as { rating: string } | undefined;
    expect(row!.rating).toBe("bad");
  });

  it("persists with stepId when provided", async () => {
    const executionId = uuidv4();
    const stepId = "step-abc";
    seedExecution(executionId, { [stepId]: { taskId: uuidv4() } });

    const res = await app.inject({
      method: "POST",
      url: `/executions/${executionId}/feedback`,
      payload: { rating: "good", stepId },
    });

    expect(res.statusCode).toBe(200);
    const row = getTestDb()
      .prepare("SELECT step_id FROM user_feedback WHERE execution_id = ?")
      .get(executionId) as { step_id: string } | undefined;
    expect(row!.step_id).toBe(stepId);
  });

  it("returns 400 for an invalid rating", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/executions/${uuidv4()}/feedback`,
      payload: { rating: "excellent" },
    });

    expect(res.statusCode).toBe(400);
  });

  it("returns 400 when rating is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/executions/${uuidv4()}/feedback`,
      payload: {},
    });

    expect(res.statusCode).toBe(400);
  });

  it("persists feedback and skips attribution when task has no usedMemoryIds", async () => {
    const executionId = uuidv4();
    const taskId = uuidv4();
    seedTask(taskId, "role-abc", {}); // no usedMemoryIds in context_meta
    seedExecution(executionId, { "step-1": { taskId } });

    const res = await app.inject({
      method: "POST",
      url: `/executions/${executionId}/feedback`,
      payload: { rating: "bad" },
    });

    expect(res.statusCode).toBe(200);
    // Attribution skipped — applyFitnessUpdate not called
    expect(mockApplyFitnessUpdate).not.toHaveBeenCalled();
    // But row still persisted
    const row = getTestDb()
      .prepare("SELECT * FROM user_feedback WHERE execution_id = ?")
      .get(executionId);
    expect(row).toBeDefined();
  });

  it("calls applyFitnessUpdate for active beliefs in usedMemoryIds on good rating", async () => {
    const executionId = uuidv4();
    const taskId = uuidv4();
    const beliefId = uuidv4();

    mockGetBelief.mockReturnValue({
      id: beliefId,
      roleId: "role-abc",
      content: "test belief",
      isAnti: false,
      evidenceObsIds: [],
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      lastValidatedAt: Date.now(),
      status: "active",
      injectCount: 0,
    });

    seedTask(taskId, "role-abc", { usedMemoryIds: [beliefId] });
    seedExecution(executionId, { "step-1": { taskId } });

    const res = await app.inject({
      method: "POST",
      url: `/executions/${executionId}/feedback`,
      payload: { rating: "good" },
    });

    expect(res.statusCode).toBe(200);
    // applyFitnessUpdate called humanFeedbackWeight (3) times with taskScore=1.0
    expect(mockApplyFitnessUpdate).toHaveBeenCalledTimes(3);
    expect(mockApplyFitnessUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ id: beliefId }),
      1.0,
      expect.any(Number),
    );
  });
});
