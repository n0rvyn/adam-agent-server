import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

import {
  appendArtifactToCollection,
  createArtifact,
  convertPrimaryFileToCollectionInTransaction,
  deleteArtifactById,
  deleteArtifactsByExecution,
  getArtifact,
  isArtifactCollectionManifest,
  listArtifactsByExecution,
  listExpiredExecutions,
} from "../../store/artifacts.js";
import { createTaskTemplate } from "../../store/task-templates.js";
import { createTemplateExecution } from "../../store/template-executions.js";

afterAll(() => cleanup());

function seedExecution(id: string, completedAt?: number, status = "completed") {
  createTaskTemplate({
    id: `tmpl-${id}`,
    name: id,
    trigger: { type: "manual" },
    steps: [{ id: "s1", prompt: "x" }],
    rolePreference: "role-test-seed",
      enabled: true,
    createdAt: Date.now(),
  });
  createTemplateExecution(id, `tmpl-${id}`);
  if (completedAt !== undefined) {
    getTestDb().prepare(
      "UPDATE template_executions SET status = ?, completed_at = ? WHERE id = ?",
    ).run(status, completedAt, id);
  } else if (status !== "running") {
    getTestDb().prepare(
      "UPDATE template_executions SET status = ? WHERE id = ?",
    ).run(status, id);
  }
}

describe("store/template execution-artifacts", () => {
  beforeEach(() => {
    clearTestDb();
  });

  it("creates and reads json artifacts", () => {
    seedExecution("exec-json");
    createArtifact({
      id: "art-json",
      sourceKind: "template_step",
      executionId: "exec-json",
      stepId: "step-1",
      key: "summary",
      kind: "json",
      value: { ok: true },
      sizeBytes: 12,
      createdAt: 1,
      roleId: "test-role",
    });

    expect(getArtifact("exec-json", "step-1", "summary")).toMatchObject({
      id: "art-json",
      kind: "json",
      value: { ok: true },
    });
  });

  it("creates and reads file artifacts", () => {
    seedExecution("exec-file");
    createArtifact({
      id: "art-file",
      sourceKind: "template_step",
      executionId: "exec-file",
      stepId: "step-1",
      key: "audio",
      kind: "file",
      blobPath: "/tmp/audio.bin",
      mime: "audio/mpeg",
      sizeBytes: 42,
      createdAt: 2,
      roleId: "test-role",
    });

    expect(getArtifact("exec-file", "step-1", "audio")).toMatchObject({
      blobPath: "/tmp/audio.bin",
      mime: "audio/mpeg",
      sizeBytes: 42,
    });
  });

  it("lists artifacts ordered by created_at and filtered by stepId", () => {
    seedExecution("exec-list");
    createArtifact({
      id: "a1",
      sourceKind: "template_step",
      executionId: "exec-list",
      stepId: "s1",
      key: "one",
      kind: "json",
      value: 1,
      sizeBytes: 1,
      createdAt: 10,
      roleId: "test-role",
    });
    createArtifact({
      id: "a2",
      sourceKind: "template_step",
      executionId: "exec-list",
      stepId: "s2",
      key: "two",
      kind: "json",
      value: 2,
      sizeBytes: 1,
      createdAt: 20,
      roleId: "test-role",
    });

    expect(listArtifactsByExecution("exec-list").map((a) => a.id)).toEqual(["a1", "a2"]);
    expect(listArtifactsByExecution("exec-list", "s2").map((a) => a.id)).toEqual(["a2"]);
  });

  it("deletes artifacts by execution and returns deleted rows", () => {
    seedExecution("exec-delete");
    createArtifact({
      id: "a1",
      sourceKind: "template_step",
      executionId: "exec-delete",
      stepId: "s1",
      key: "one",
      kind: "json",
      value: 1,
      sizeBytes: 1,
      createdAt: 10,
      roleId: "test-role",
    });

    const deleted = deleteArtifactsByExecution("exec-delete");
    expect(deleted).toHaveLength(1);
    expect(listArtifactsByExecution("exec-delete")).toEqual([]);
  });

  it("deletes a single artifact by id", () => {
    seedExecution("exec-delete-one");
    createArtifact({
      id: "a1",
      sourceKind: "template_step",
      executionId: "exec-delete-one",
      stepId: "s1",
      key: "one",
      kind: "json",
      value: 1,
      sizeBytes: 1,
      createdAt: 10,
      roleId: "test-role",
    });

    deleteArtifactById("a1");

    expect(getArtifact("exec-delete-one", "s1", "one")).toBeUndefined();
  });

  it("enforces unique execution/step/key", () => {
    seedExecution("exec-uniq");
    createArtifact({
      id: "a1",
      sourceKind: "template_step",
      executionId: "exec-uniq",
      stepId: "s1",
      key: "dup",
      kind: "json",
      value: 1,
      sizeBytes: 1,
      createdAt: 10,
      roleId: "test-role",
    });

    expect(() =>
      createArtifact({
        id: "a2",
        sourceKind: "template_step",
        executionId: "exec-uniq",
        stepId: "s1",
        key: "dup",
        kind: "json",
        value: 2,
        sizeBytes: 1,
        createdAt: 11,
        roleId: "test-role",
      }),
    ).toThrow();
  });

  it("converts an outputAs primary file into a collection manifest with child file keys", () => {
    seedExecution("exec-collection-convert");
    createArtifact({
      id: "art-first",
      sourceKind: "template_step",
      executionId: "exec-collection-convert",
      stepId: "s1",
      key: "artworks",
      kind: "file",
      blobPath: "/tmp/artwork-01.bin",
      mime: "image/png",
      originalFilename: "artwork_01_surrealism.png",
      sizeBytes: 10,
      createdAt: 10,
      roleId: "test-role",
    });

    const existingPrimary = getArtifact("exec-collection-convert", "s1", "artworks")!;
    const result = convertPrimaryFileToCollectionInTransaction(
      "exec-collection-convert",
      "s1",
      "artworks",
      existingPrimary,
      {
        id: "art-second",
        sourceKind: "template_step",
        executionId: "exec-collection-convert",
        stepId: "s1",
        key: "artwork_02_surrealism.png",
        kind: "file",
        blobPath: "/tmp/artwork-02.bin",
        mime: "image/png",
        originalFilename: "artwork_02_surrealism.png",
        sizeBytes: 20,
        createdAt: 20,
        roleId: "test-role",
      },
    );

    const primary = getArtifact("exec-collection-convert", "s1", "artworks");
    expect(primary?.kind).toBe("json");
    expect(isArtifactCollectionManifest(primary?.value)).toBe(true);
    expect(result.childArtifact.key).toBe("artwork_02_surrealism.png");
    expect(getArtifact("exec-collection-convert", "s1", "artwork_01_surrealism.png")).toMatchObject({
      id: "art-first",
      kind: "file",
    });
    expect(getArtifact("exec-collection-convert", "s1", "artwork_02_surrealism.png")).toMatchObject({
      id: "art-second",
      kind: "file",
    });
    expect(primary!.value).toMatchObject({
      type: "artifact_collection",
      outputAs: "artworks",
      items: [
        { artifactId: "art-first", key: "artwork_01_surrealism.png", filename: "artwork_01_surrealism.png" },
        { artifactId: "art-second", key: "artwork_02_surrealism.png", filename: "artwork_02_surrealism.png" },
      ],
    });
  });

  it("appends collection children under unique sanitized keys", () => {
    seedExecution("exec-collection-append");
    createArtifact({
      id: "art-first",
      sourceKind: "template_step",
      executionId: "exec-collection-append",
      stepId: "s1",
      key: "artworks",
      kind: "file",
      blobPath: "/tmp/artwork-01.bin",
      mime: "image/png",
      originalFilename: "artwork_01.png",
      sizeBytes: 10,
      createdAt: 10,
      roleId: "test-role",
    });
    const existingPrimary = getArtifact("exec-collection-append", "s1", "artworks")!;
    convertPrimaryFileToCollectionInTransaction(
      "exec-collection-append",
      "s1",
      "artworks",
      existingPrimary,
      {
        id: "art-second",
        sourceKind: "template_step",
        executionId: "exec-collection-append",
        stepId: "s1",
        key: "nested/artwork 02.png",
        kind: "file",
        blobPath: "/tmp/artwork-02.bin",
        mime: "image/png",
        originalFilename: "artwork 02.png",
        sizeBytes: 20,
        createdAt: 20,
        roleId: "test-role",
      },
    );

    const appendResult = appendArtifactToCollection(
      "exec-collection-append",
      "s1",
      "artworks",
      {
        id: "art-third",
        sourceKind: "template_step",
        executionId: "exec-collection-append",
        stepId: "s1",
        key: "nested/artwork 02.png",
        kind: "file",
        blobPath: "/tmp/artwork-03.bin",
        mime: "image/png",
        originalFilename: "artwork 02.png",
        sizeBytes: 30,
        createdAt: 30,
        roleId: "test-role",
      },
    );

    expect(appendResult.childArtifact.key).toBe("artwork-02.png-2");
    const primary = getArtifact("exec-collection-append", "s1", "artworks");
    expect(isArtifactCollectionManifest(primary?.value)).toBe(true);
    expect((primary!.value as { items: Array<{ artifactId: string; key: string }> }).items).toEqual([
      expect.objectContaining({ artifactId: "art-first", key: "artwork_01.png" }),
      expect.objectContaining({ artifactId: "art-second", key: "artwork-02.png" }),
      expect.objectContaining({ artifactId: "art-third", key: "artwork-02.png-2" }),
    ]);
  });

  it("leaves the primary file intact when collection conversion fails before DB mutation", () => {
    seedExecution("exec-collection-fail");
    createArtifact({
      id: "art-primary",
      sourceKind: "template_step",
      executionId: "exec-collection-fail",
      stepId: "s1",
      key: "artworks",
      kind: "file",
      blobPath: "/tmp/artwork-01.bin",
      mime: "image/png",
      originalFilename: "artwork_01.png",
      sizeBytes: 10,
      createdAt: 10,
      roleId: "test-role",
    });
    const stalePrimary = { ...getArtifact("exec-collection-fail", "s1", "artworks")!, id: "stale-id" };

    expect(() => convertPrimaryFileToCollectionInTransaction(
      "exec-collection-fail",
      "s1",
      "artworks",
      stalePrimary,
      {
        id: "art-new",
        sourceKind: "template_step",
        executionId: "exec-collection-fail",
        stepId: "s1",
        key: "artwork_02.png",
        kind: "file",
        blobPath: "/tmp/artwork-02.bin",
        mime: "image/png",
        sizeBytes: 20,
        createdAt: 20,
        roleId: "test-role",
      },
    )).toThrow("Primary artifact changed");

    expect(getArtifact("exec-collection-fail", "s1", "artworks")).toMatchObject({
      id: "art-primary",
      kind: "file",
      key: "artworks",
    });
    expect(listArtifactsByExecution("exec-collection-fail")).toHaveLength(1);
  });

  it("lists expired executions even when they have no artifacts", () => {
    const now = Date.now();
    seedExecution("exec-old-with-artifact", now - 8 * 24 * 60 * 60 * 1000);
    seedExecution("exec-old-empty", now - 8 * 24 * 60 * 60 * 1000);
    seedExecution("exec-new", now - 1 * 24 * 60 * 60 * 1000);
    seedExecution("exec-running", undefined, "running");
    createArtifact({
      id: "old-art",
      sourceKind: "template_step",
      executionId: "exec-old-with-artifact",
      stepId: "s1",
      key: "x",
      kind: "json",
      value: 1,
      sizeBytes: 1,
      createdAt: 1,
      roleId: "test-role",
    });

    const expired = listExpiredExecutions(now - 7 * 24 * 60 * 60 * 1000);
    expect(expired).toContain("exec-old-with-artifact");
    expect(expired).toContain("exec-old-empty");
    expect(expired).not.toContain("exec-new");
    expect(expired).not.toContain("exec-running");
  });
});
