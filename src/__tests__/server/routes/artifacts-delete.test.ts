import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../../helpers/test-db.js";
import { vi } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { v4 as uuidv4 } from "uuid";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
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
import { createArtifact, getArtifactById } from "../../../store/artifacts.js";
import type { Artifact } from "../../../store/artifacts.js";

afterAll(() => cleanup());

let tmpDir: string;

function seedTaskRow(taskId: string): void {
  getTestDb().prepare(`
    INSERT OR IGNORE INTO tasks (id, status, prompt, config, created_at)
    VALUES (?, 'completed', 'test', '{}', ?)
  `).run(taskId, Date.now());
}

function makeArtifact(overrides: Partial<Artifact> & { id?: string }): Artifact {
  return {
    id: overrides.id ?? uuidv4(),
    sourceKind: overrides.sourceKind ?? "task_published",
    taskId: overrides.taskId,
    executionId: overrides.executionId,
    chatSessionId: overrides.chatSessionId,
    stepId: overrides.stepId,
    roleId: overrides.roleId ?? "role-delete-test",
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

describe("server/routes/artifacts — DELETE danger-class", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "adam-delete-test-"));
    app = await buildTestApp();
  });

  beforeEach(() => {
    clearTestDb();
  });

  afterAll(async () => {
    await app.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // Test case A — audio/mpeg without confirm → 412
  it("A: audio/mpeg without confirm returns 412", async () => {
    const blobDir = join(tmpDir, "audio");
    mkdirSync(blobDir, { recursive: true });
    const blobPath = join(blobDir, `${uuidv4()}.mp3`);
    writeFileSync(blobPath, "audio data");

    const tid = uuidv4();
    seedTaskRow(tid);
    const artifact = makeArtifact({ sourceKind: "task_published", taskId: tid, mime: "audio/mpeg", blobPath });
    createArtifact(artifact);

    const resp = await app.inject({ method: "DELETE", url: `/artifacts/${artifact.id}` });
    expect(resp.statusCode).toBe(412);
    const body = resp.json();
    expect(body.error).toBe("danger-class-requires-confirm");
    expect(body.mime).toBe("audio/mpeg");
    expect(body.danger_class).toBe("audio");
    // blob and row should still exist
    expect(existsSync(blobPath)).toBe(true);
    expect(getArtifactById(artifact.id)).toBeDefined();
  });

  // Test case B — video/mp4 without confirm → 412
  it("B: video/mp4 without confirm returns 412", async () => {
    const blobDir = join(tmpDir, "video");
    mkdirSync(blobDir, { recursive: true });
    const blobPath = join(blobDir, `${uuidv4()}.mp4`);
    writeFileSync(blobPath, "video data");

    const tid = uuidv4();
    seedTaskRow(tid);
    const artifact = makeArtifact({ sourceKind: "task_published", taskId: tid, mime: "video/mp4", blobPath });
    createArtifact(artifact);

    const resp = await app.inject({ method: "DELETE", url: `/artifacts/${artifact.id}` });
    expect(resp.statusCode).toBe(412);
    const body = resp.json();
    expect(body.error).toBe("danger-class-requires-confirm");
    expect(body.mime).toBe("video/mp4");
    expect(body.danger_class).toBe("video");
    expect(existsSync(blobPath)).toBe(true);
    expect(getArtifactById(artifact.id)).toBeDefined();
  });

  // Test case C — application/pdf without confirm → 412
  it("C: application/pdf without confirm returns 412", async () => {
    const blobDir = join(tmpDir, "pdf");
    mkdirSync(blobDir, { recursive: true });
    const blobPath = join(blobDir, `${uuidv4()}.pdf`);
    writeFileSync(blobPath, "pdf data");

    const tid = uuidv4();
    seedTaskRow(tid);
    const artifact = makeArtifact({ sourceKind: "task_published", taskId: tid, mime: "application/pdf", blobPath });
    createArtifact(artifact);

    const resp = await app.inject({ method: "DELETE", url: `/artifacts/${artifact.id}` });
    expect(resp.statusCode).toBe(412);
    const body = resp.json();
    expect(body.error).toBe("danger-class-requires-confirm");
    expect(body.danger_class).toBe("pdf");
    expect(existsSync(blobPath)).toBe(true);
    expect(getArtifactById(artifact.id)).toBeDefined();
  });

  // Test case D — audio/mpeg with ?confirm=true → 204 + deleted
  it("D: audio/mpeg with ?confirm=true deletes blob and row", async () => {
    const blobDir = join(tmpDir, "audio-confirm");
    mkdirSync(blobDir, { recursive: true });
    const blobPath = join(blobDir, `${uuidv4()}.mp3`);
    writeFileSync(blobPath, "audio data");

    const tid = uuidv4();
    seedTaskRow(tid);
    const artifact = makeArtifact({ sourceKind: "task_published", taskId: tid, mime: "audio/mpeg", blobPath });
    createArtifact(artifact);

    const resp = await app.inject({ method: "DELETE", url: `/artifacts/${artifact.id}?confirm=true` });
    expect(resp.statusCode).toBe(204);
    expect(existsSync(blobPath)).toBe(false);
    expect(getArtifactById(artifact.id)).toBeUndefined();
  });

  // Test case E — text/plain (non-danger) → 204 directly
  it("E: text/plain deletes without confirm", async () => {
    const blobDir = join(tmpDir, "text");
    mkdirSync(blobDir, { recursive: true });
    const blobPath = join(blobDir, `${uuidv4()}.txt`);
    writeFileSync(blobPath, "text data");

    const tid = uuidv4();
    seedTaskRow(tid);
    const artifact = makeArtifact({ sourceKind: "task_published", taskId: tid, mime: "text/plain", blobPath });
    createArtifact(artifact);

    const resp = await app.inject({ method: "DELETE", url: `/artifacts/${artifact.id}` });
    expect(resp.statusCode).toBe(204);
    expect(existsSync(blobPath)).toBe(false);
    expect(getArtifactById(artifact.id)).toBeUndefined();
  });

  // Test case F — image/png (non-danger) → 204 directly
  it("F: image/png deletes without confirm", async () => {
    const blobDir = join(tmpDir, "image");
    mkdirSync(blobDir, { recursive: true });
    const blobPath = join(blobDir, `${uuidv4()}.png`);
    writeFileSync(blobPath, "image data");

    const tid = uuidv4();
    seedTaskRow(tid);
    const artifact = makeArtifact({ sourceKind: "task_published", taskId: tid, mime: "image/png", blobPath });
    createArtifact(artifact);

    const resp = await app.inject({ method: "DELETE", url: `/artifacts/${artifact.id}` });
    expect(resp.statusCode).toBe(204);
    expect(existsSync(blobPath)).toBe(false);
    expect(getArtifactById(artifact.id)).toBeUndefined();
  });

  // Test case G — artifact not found → 404
  it("G: artifact not found returns 404", async () => {
    const resp = await app.inject({ method: "DELETE", url: "/artifacts/nonexistent-id" });
    expect(resp.statusCode).toBe(404);
    const body = resp.json();
    expect(body.code).toBe("NOT_FOUND");
  });

  // Test case H — blob missing but artifact row exists → 204 (best-effort ENOENT)
  it("H: blob already gone but row exists → 204 idempotent delete", async () => {
    const tid = uuidv4();
    seedTaskRow(tid);
    const artifact = makeArtifact({
      sourceKind: "task_published",
      taskId: tid,
      mime: "text/plain",
      blobPath: join(tmpDir, "already-gone.txt"),
    });
    createArtifact(artifact);

    const resp = await app.inject({ method: "DELETE", url: `/artifacts/${artifact.id}` });
    expect(resp.statusCode).toBe(204);
    expect(getArtifactById(artifact.id)).toBeUndefined();
  });

  // Test case I — ?confirm=1 equivalent to ?confirm=true
  it("I: ?confirm=1 is equivalent to ?confirm=true for danger class", async () => {
    const blobDir = join(tmpDir, "audio-confirm1");
    mkdirSync(blobDir, { recursive: true });
    const blobPath = join(blobDir, `${uuidv4()}.mp3`);
    writeFileSync(blobPath, "audio data");

    const tid = uuidv4();
    seedTaskRow(tid);
    const artifact = makeArtifact({ sourceKind: "task_published", taskId: tid, mime: "audio/mpeg", blobPath });
    createArtifact(artifact);

    const resp = await app.inject({ method: "DELETE", url: `/artifacts/${artifact.id}?confirm=1` });
    expect(resp.statusCode).toBe(204);
    expect(existsSync(blobPath)).toBe(false);
    expect(getArtifactById(artifact.id)).toBeUndefined();
  });

  // Test case J — ?confirm=false does NOT count as confirmation
  it("J: ?confirm=false still returns 412 for danger class", async () => {
    const blobDir = join(tmpDir, "audio-false");
    mkdirSync(blobDir, { recursive: true });
    const blobPath = join(blobDir, `${uuidv4()}.mp3`);
    writeFileSync(blobPath, "audio data");

    const tid = uuidv4();
    seedTaskRow(tid);
    const artifact = makeArtifact({ sourceKind: "task_published", taskId: tid, mime: "audio/mpeg", blobPath });
    createArtifact(artifact);

    const resp = await app.inject({ method: "DELETE", url: `/artifacts/${artifact.id}?confirm=false` });
    expect(resp.statusCode).toBe(412);
    expect(existsSync(blobPath)).toBe(true);
    expect(getArtifactById(artifact.id)).toBeDefined();
  });
});
