/**
 * Tests for POST /artifacts/:id/redeliver
 *
 * Per-test gateway mock isolation: vi.resetModules() + vi.doMock() + dynamic import
 * inside buildTestApp() so each test gets its own mock for gateway.send.
 * Stable mocks (db, config) are re-registered after each resetModules call.
 * (See project memory: feedback_vitest_mock_isolation)
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../../helpers/test-db.js";
import Fastify from "fastify";
import { v4 as uuidv4 } from "uuid";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { cleanup } = setupTestDb();

afterAll(() => cleanup());

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "adam-redeliver-test-"));
  clearTestDb();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  vi.resetModules();
  vi.unstubAllGlobals();
});

function seedTaskRow(taskId: string): void {
  getTestDb()
    .prepare(
      `INSERT OR IGNORE INTO tasks (id, status, prompt, config, created_at)
       VALUES (?, 'completed', 'test', '{}', ?)`,
    )
    .run(taskId, Date.now());
}

function seedChannel(id: string): void {
  getTestDb()
    .prepare(
      `INSERT OR IGNORE INTO channels (id, name, platform, enabled, status, config, message_count, created_at)
       VALUES (?, 'Test Channel', 'telegram', 1, 'connected', '{}', 0, ?)`,
    )
    .run(id, Date.now());
}

async function buildTestApp(gatewaySendFn: ReturnType<typeof vi.fn>) {
  // Reset modules so the dynamic import below picks up fresh mocks
  vi.resetModules();

  // Re-register stable mocks after reset
  vi.doMock("../../../store/db.js", () => ({
    getDb: () => getTestDb(),
    closeDb: () => {},
  }));
  vi.doMock("../../../config/index.js", () => ({
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

  // Per-test gateway mock
  vi.doMock("../../../delivery/outbound-gateway.js", () => ({
    getOutboundGateway: () => ({
      send: gatewaySendFn,
    }),
  }));

  const { artifactRoutes } = await import("../../../server/routes/artifacts.js");
  const app = Fastify();
  await app.register(artifactRoutes);
  return app;
}

// ─── Test cases ───────────────────────────────────────────────────────────────

// Test case A — happy path: artifact + channel + gateway success → 200 pending
it("A: happy path returns 200 with status:pending and deliveryLogId", async () => {
  const sendFn = vi.fn(async () => ({ success: true, logEntryId: "log-mock-1" }));
  const app = await buildTestApp(sendFn);

  const tid = uuidv4();
  seedTaskRow(tid);
  const chId = uuidv4();
  seedChannel(chId);

  const blobDir = join(tmpDir, "task");
  mkdirSync(blobDir, { recursive: true });
  const blobPath = join(blobDir, `${uuidv4()}.mp3`);
  writeFileSync(blobPath, "audio data");

  const { createArtifact } = await import("../../../store/artifacts.js");
  const artId = uuidv4();
  createArtifact({
    id: artId,
    sourceKind: "task_published",
    taskId: tid,
    roleId: "role-redeliver-test",
    kind: "file",
    blobPath,
    mime: "audio/mpeg",
    originalFilename: "podcast.mp3",
    sizeBytes: 10,
    createdAt: Date.now(),
  });

  const resp = await app.inject({
    method: "POST",
    url: `/artifacts/${artId}/redeliver`,
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ channelId: chId }),
  });

  expect(resp.statusCode).toBe(200);
  const body = resp.json();
  expect(body.status).toBe("pending");
  expect(body.deliveryLogId).toBe("log-mock-1");
  expect(sendFn).toHaveBeenCalledOnce();
  await app.close();
});

// Test case B — artifact not found → 404
it("B: artifact not found returns 404", async () => {
  const sendFn = vi.fn(async () => ({ success: true, logEntryId: "log-mock-b" }));
  const app = await buildTestApp(sendFn);

  const chId = uuidv4();
  seedChannel(chId);

  const resp = await app.inject({
    method: "POST",
    url: `/artifacts/nonexistent-id/redeliver`,
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ channelId: chId }),
  });

  expect(resp.statusCode).toBe(404);
  const body = resp.json();
  expect(body.code).toBe("NOT_FOUND");
  expect(body.message).toMatch(/artifact/i);
  await app.close();
});

// Test case C — channel not found → 404
it("C: channel not found returns 404 with message containing channel id", async () => {
  const sendFn = vi.fn(async () => ({ success: true, logEntryId: "log-mock-c" }));
  const app = await buildTestApp(sendFn);

  const tid = uuidv4();
  seedTaskRow(tid);
  const { createArtifact } = await import("../../../store/artifacts.js");
  const artId = uuidv4();
  createArtifact({
    id: artId,
    sourceKind: "task_published",
    taskId: tid,
    roleId: "role-redeliver-test",
    kind: "file",
    mime: "text/plain",
    sizeBytes: 0,
    createdAt: Date.now(),
  });

  const resp = await app.inject({
    method: "POST",
    url: `/artifacts/${artId}/redeliver`,
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ channelId: "ch-missing" }),
  });

  expect(resp.statusCode).toBe(404);
  const body = resp.json();
  expect(body.code).toBe("NOT_FOUND");
  expect(body.message).toContain("ch-missing");
  await app.close();
});

// Test case D — gateway sync reject → 200 with status:rejected
it("D: gateway sync reject returns 200 with status:rejected", async () => {
  const sendFn = vi.fn(async () => ({
    success: false,
    logEntryId: "log-mock-d",
    error: "rate-limited",
  }));
  const app = await buildTestApp(sendFn);

  const tid = uuidv4();
  seedTaskRow(tid);
  const chId = uuidv4();
  seedChannel(chId);

  const { createArtifact } = await import("../../../store/artifacts.js");
  const artId = uuidv4();
  createArtifact({
    id: artId,
    sourceKind: "task_published",
    taskId: tid,
    roleId: "role-redeliver-test",
    kind: "file",
    mime: "audio/mpeg",
    sizeBytes: 0,
    createdAt: Date.now(),
  });

  const resp = await app.inject({
    method: "POST",
    url: `/artifacts/${artId}/redeliver`,
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ channelId: chId }),
  });

  expect(resp.statusCode).toBe(200);
  const body = resp.json();
  expect(body.status).toBe("rejected");
  expect(body.reason).toBe("rate-limited");
  expect(body.deliveryLogId).toBe("log-mock-d");
  await app.close();
});

// Test case E — body missing channelId → 400 VALIDATION_ERROR
it("E: body missing channelId returns 400", async () => {
  const sendFn = vi.fn(async () => ({ success: true, logEntryId: "log-mock-e" }));
  const app = await buildTestApp(sendFn);

  const tid = uuidv4();
  seedTaskRow(tid);
  const { createArtifact } = await import("../../../store/artifacts.js");
  const artId = uuidv4();
  createArtifact({
    id: artId,
    sourceKind: "task_published",
    taskId: tid,
    roleId: "role-redeliver-test",
    kind: "file",
    mime: "text/plain",
    sizeBytes: 0,
    createdAt: Date.now(),
  });

  const resp = await app.inject({
    method: "POST",
    url: `/artifacts/${artId}/redeliver`,
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({}),
  });

  expect(resp.statusCode).toBe(400);
  expect(resp.json().code).toBe("VALIDATION_ERROR");
  await app.close();
});

// Test case F — channelId > 64 chars → 400 VALIDATION_ERROR
it("F: channelId over 64 chars returns 400", async () => {
  const sendFn = vi.fn(async () => ({ success: true, logEntryId: "log-mock-f" }));
  const app = await buildTestApp(sendFn);

  const tid = uuidv4();
  seedTaskRow(tid);
  const { createArtifact } = await import("../../../store/artifacts.js");
  const artId = uuidv4();
  createArtifact({
    id: artId,
    sourceKind: "task_published",
    taskId: tid,
    roleId: "role-redeliver-test",
    kind: "file",
    mime: "text/plain",
    sizeBytes: 0,
    createdAt: Date.now(),
  });

  const resp = await app.inject({
    method: "POST",
    url: `/artifacts/${artId}/redeliver`,
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ channelId: "x".repeat(65) }),
  });

  expect(resp.statusCode).toBe(400);
  await app.close();
});

// Test case G — chatId optional, provided → forwarded to gateway.send
it("G: provided chatId is forwarded to gateway.send", async () => {
  const sendFn = vi.fn(async () => ({ success: true, logEntryId: "log-mock-g" }));
  const app = await buildTestApp(sendFn);

  const tid = uuidv4();
  seedTaskRow(tid);
  const chId = uuidv4();
  seedChannel(chId);

  const { createArtifact } = await import("../../../store/artifacts.js");
  const artId = uuidv4();
  createArtifact({
    id: artId,
    sourceKind: "task_published",
    taskId: tid,
    roleId: "role-redeliver-test",
    kind: "file",
    mime: "text/plain",
    sizeBytes: 0,
    createdAt: Date.now(),
  });

  await app.inject({
    method: "POST",
    url: `/artifacts/${artId}/redeliver`,
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ channelId: chId, chatId: "custom-chat-123" }),
  });

  expect(sendFn).toHaveBeenCalledOnce();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const callArgs = (sendFn.mock.calls[0] as any)[0];
  expect(callArgs.chatId).toBe("custom-chat-123");
  await app.close();
});

// Test case H — chat_sent source artifact can be redelivered
it("H: chat_sent source artifact can be redelivered", async () => {
  const sendFn = vi.fn(async () => ({ success: true, logEntryId: "log-mock-h" }));
  const app = await buildTestApp(sendFn);

  const chId = uuidv4();
  seedChannel(chId);

  // chat_sent requires chat_session_id NOT NULL (DB CHECK constraint)
  const sessionId = uuidv4();
  getTestDb()
    .prepare(
      `INSERT OR IGNORE INTO chat_sessions (id, status, source_type, created_at, last_active_at)
       VALUES (?, 'active', 'web', ?, ?)`,
    )
    .run(sessionId, Date.now(), Date.now());

  const { createArtifact } = await import("../../../store/artifacts.js");
  const artId = uuidv4();
  createArtifact({
    id: artId,
    sourceKind: "chat_sent",
    chatSessionId: sessionId,
    roleId: "role-redeliver-test",
    kind: "file",
    mime: "image/png",
    sizeBytes: 0,
    createdAt: Date.now(),
  });

  const resp = await app.inject({
    method: "POST",
    url: `/artifacts/${artId}/redeliver`,
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ channelId: chId }),
  });

  expect(resp.statusCode).toBe(200);
  expect(resp.json().status).toBe("pending");
  await app.close();
});

// Test case I — gateway.send receives correct parameters
it("I: gateway.send receives channelId, mediaUrl, mediaType, messageType:deliver", async () => {
  const sendFn = vi.fn(async () => ({ success: true, logEntryId: "log-mock-i" }));
  const app = await buildTestApp(sendFn);

  const tid = uuidv4();
  seedTaskRow(tid);
  const chId = uuidv4();
  seedChannel(chId);

  const blobDir = join(tmpDir, "task-i");
  mkdirSync(blobDir, { recursive: true });
  const blobPath = join(blobDir, `${uuidv4()}.mp3`);
  writeFileSync(blobPath, "audio bytes");

  const { createArtifact } = await import("../../../store/artifacts.js");
  const artId = uuidv4();
  createArtifact({
    id: artId,
    sourceKind: "task_published",
    taskId: tid,
    roleId: "role-redeliver-test",
    kind: "file",
    blobPath,
    mime: "audio/mpeg",
    originalFilename: "episode.mp3",
    sizeBytes: 11,
    createdAt: Date.now(),
  });

  await app.inject({
    method: "POST",
    url: `/artifacts/${artId}/redeliver`,
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ channelId: chId }),
  });

  expect(sendFn).toHaveBeenCalledOnce();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const callArgs = (sendFn.mock.calls[0] as any)[0];
  expect(callArgs.channelId).toBe(chId);
  expect(callArgs.mediaUrl).toBe(blobPath);
  expect(callArgs.mediaType).toBe("audio");
  expect(callArgs.messageType).toBe("deliver");
  expect(typeof callArgs.content).toBe("string");
  await app.close();
});
