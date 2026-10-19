import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../../helpers/test-db.js";
import { vi } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { v4 as uuidv4 } from "uuid";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
import type { Artifact } from "../../../store/artifacts.js";

afterAll(() => cleanup());

let tmpDir: string;

function seedTaskRow(taskId: string): void {
  getTestDb().prepare(`
    INSERT OR IGNORE INTO tasks (id, status, prompt, config, created_at)
    VALUES (?, 'completed', 'test', '{}', ?)
  `).run(taskId, Date.now());
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
    roleId: overrides.roleId ?? "role-blob-test",
    key: overrides.key,
    kind: overrides.kind ?? "file",
    blobPath: overrides.blobPath,
    mime: overrides.mime ?? "application/octet-stream",
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

describe("server/routes/artifacts — blob download", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "adam-blob-test-"));
    app = await buildTestApp();
  });

  beforeEach(() => {
    clearTestDb();
  });

  afterAll(async () => {
    await app.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // Test case A — happy path text file
  it("A: downloads file with correct headers", async () => {
    const blobDir = join(tmpDir, "artifacts", "task");
    mkdirSync(blobDir, { recursive: true });
    const blobPath = join(blobDir, "abc.bin");
    writeFileSync(blobPath, "hello world");

    const tid = uuidv4();
    seedTaskRow(tid);
    const artifact = makeArtifact({
      sourceKind: "task_published",
      taskId: tid,
      mime: "text/plain",
      originalFilename: "hello.txt",
      blobPath,
      sizeBytes: 11,
    });
    createArtifact(artifact);

    const resp = await app.inject({ method: "GET", url: `/artifacts/${artifact.id}/blob` });
    expect(resp.statusCode).toBe(200);
    expect(resp.body).toBe("hello world");
    expect(resp.headers["content-type"]).toContain("text/plain");
    expect(resp.headers["content-disposition"]).toBe('attachment; filename="hello.txt"');
    expect(resp.headers["content-length"]).toBe("11");
  });

  // Test case B — audio MIME
  it("B: audio artifact returns correct content-disposition filename", async () => {
    const blobDir = join(tmpDir, "artifacts", "audio");
    mkdirSync(blobDir, { recursive: true });
    const blobPath = join(blobDir, "podcast.mp3");
    writeFileSync(blobPath, "mp3content");

    const tid = uuidv4();
    seedTaskRow(tid);
    const artifact = makeArtifact({
      sourceKind: "task_published",
      taskId: tid,
      mime: "audio/mpeg",
      originalFilename: "podcast.mp3",
      blobPath,
      sizeBytes: 10,
    });
    createArtifact(artifact);

    const resp = await app.inject({ method: "GET", url: `/artifacts/${artifact.id}/blob` });
    expect(resp.statusCode).toBe(200);
    expect(resp.headers["content-disposition"]).toBe('attachment; filename="podcast.mp3"');
  });

  // Test case C — no originalFilename, no key — fallback to blobPath basename
  it("C: no originalFilename falls back to blobPath basename", async () => {
    const blobDir = join(tmpDir, "artifacts", "fallback");
    mkdirSync(blobDir, { recursive: true });
    const blobPath = join(blobDir, "def456.bin");
    writeFileSync(blobPath, "data");

    const tid = uuidv4();
    seedTaskRow(tid);
    const artifact = makeArtifact({
      sourceKind: "task_published",
      taskId: tid,
      mime: "application/octet-stream",
      originalFilename: undefined,
      key: undefined,
      blobPath,
      sizeBytes: 4,
    });
    createArtifact(artifact);

    const resp = await app.inject({ method: "GET", url: `/artifacts/${artifact.id}/blob` });
    expect(resp.statusCode).toBe(200);
    expect(resp.headers["content-disposition"]).toBe('attachment; filename="def456.bin"');
  });

  // Test case D — artifact not found
  it("D: artifact not found returns 404", async () => {
    const resp = await app.inject({ method: "GET", url: "/artifacts/nonexistent-id/blob" });
    expect(resp.statusCode).toBe(404);
    const body = resp.json();
    expect(body.code).toBe("NOT_FOUND");
  });

  // Test case E — blob file missing on disk
  it("E: blob file missing on disk returns 500", async () => {
    const tid = uuidv4();
    seedTaskRow(tid);
    const artifact = makeArtifact({
      sourceKind: "task_published",
      taskId: tid,
      mime: "text/plain",
      originalFilename: "missing.txt",
      blobPath: join(tmpDir, "does-not-exist.bin"),
      sizeBytes: 10,
    });
    createArtifact(artifact);

    const resp = await app.inject({ method: "GET", url: `/artifacts/${artifact.id}/blob` });
    expect(resp.statusCode).toBe(500);
    const body = resp.json();
    expect(body.code).toBe("INTERNAL_ERROR");
    expect(body.message).toContain("blob missing");
  });

  // Test case F — chat_sent source downloads successfully
  it("F: chat_sent artifact downloads successfully", async () => {
    const blobDir = join(tmpDir, "artifacts", "chat");
    mkdirSync(blobDir, { recursive: true });
    const blobPath = join(blobDir, "chatfile.txt");
    writeFileSync(blobPath, "chat file");

    const sessionId = uuidv4();
    seedChatSessionRow(sessionId);
    const artifact = makeArtifact({
      sourceKind: "chat_sent",
      chatSessionId: sessionId,
      mime: "text/plain",
      originalFilename: "chatfile.txt",
      blobPath,
      sizeBytes: 9,
    });
    createArtifact(artifact);

    const resp = await app.inject({ method: "GET", url: `/artifacts/${artifact.id}/blob` });
    expect(resp.statusCode).toBe(200);
    expect(resp.body).toBe("chat file");
  });
});
