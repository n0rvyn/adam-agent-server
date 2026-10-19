import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

import { resolveDeliverableArtifacts } from "../../chat/deliverable-resolver.js";
import {
  createDeliveryCommitment,
  getDeliveryCommitment,
} from "../../store/assistant-delivery-commitments.js";
import type { Task } from "../../shared/types.js";

afterAll(() => cleanup());
beforeEach(() => clearTestDb());

function makeTask(result: string): Task {
  return {
    id: "task-1",
    status: "completed",
    prompt: "generate images",
    result,
    roleId: "role-1",
    config: { timeout: 60, approvalRequired: [], approvalTimeout: 60 },
    createdAt: Date.now(),
  };
}

function makeCommitment(kind: "image" | "file" = "image") {
  return createDeliveryCommitment({
    traceId: "trace-1",
    sessionId: "session-1",
    taskId: "task-1",
    target: { type: "session", sessionId: "session-1" },
    artifactExpectation: { kind },
  });
}

describe("chat/deliverable-resolver", () => {
  it("resolves three PNG paths in task result into outbound image attachments", () => {
    const root = mkdtempSync(join(tmpdir(), "adam-deliverable-root-"));
    try {
      const files = [1, 2, 3].map((index) => {
        const file = join(root, `${index}.png`);
        writeFileSync(file, `png-${index}`);
        return file;
      });
      const commitment = makeCommitment("image");
      const result = resolveDeliverableArtifacts({
        task: makeTask(`生成完成：\n${files.join("\n")}`),
        commitment,
        allowedRoots: [root],
      });

      expect(result.attachments.map((item) => item.filename)).toEqual(["1.png", "2.png", "3.png"]);
      expect(result.attachments.every((item) => item.mimeType === "image/png")).toBe(true);
      expect(result.diagnostics).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ignores paths when there is no pending commitment", () => {
    const root = mkdtempSync(join(tmpdir(), "adam-deliverable-root-"));
    try {
      const file = join(root, "1.png");
      writeFileSync(file, "png");
      const result = resolveDeliverableArtifacts({
        task: makeTask(file),
        allowedRoots: [root],
      });

      expect(result.attachments).toEqual([]);
      expect(result.diagnostics).toEqual([{ reason: "no_pending_commitment" }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ignores remote URLs", () => {
    const commitment = makeCommitment("image");
    const result = resolveDeliverableArtifacts({
      task: makeTask("https://example.com/image.png"),
      commitment,
      allowedRoots: [tmpdir()],
      markFailedOnEmpty: false,
    });

    expect(result.attachments).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });

  it("ignores paths outside the role workspace or managed roots", () => {
    const allowedRoot = mkdtempSync(join(tmpdir(), "adam-deliverable-allowed-"));
    const outsideRoot = mkdtempSync(join(tmpdir(), "adam-deliverable-outside-"));
    try {
      const file = join(outsideRoot, "1.png");
      writeFileSync(file, "png");
      const commitment = makeCommitment("image");
      const result = resolveDeliverableArtifacts({
        task: makeTask(file),
        commitment,
        allowedRoots: [allowedRoot],
        markFailedOnEmpty: false,
      });

      expect(result.attachments).toEqual([]);
      expect(result.diagnostics).toEqual([{ path: file, reason: "outside_allowed_roots" }]);
    } finally {
      rmSync(allowedRoot, { recursive: true, force: true });
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  it("marks commitment failed when no deliverable artifact remains", () => {
    const root = mkdtempSync(join(tmpdir(), "adam-deliverable-root-"));
    try {
      const missing = join(root, "missing.png");
      const commitment = makeCommitment("image");
      const result = resolveDeliverableArtifacts({
        task: makeTask(missing),
        commitment,
        allowedRoots: [root],
      });

      expect(result.attachments).toEqual([]);
      expect(result.diagnostics).toEqual([{ path: missing, reason: "missing_file" }]);
      expect(getDeliveryCommitment(commitment.id)).toEqual(expect.objectContaining({
        status: "failed",
        failureReason: "no_deliverable_artifacts",
      }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
