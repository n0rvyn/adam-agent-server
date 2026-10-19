/**
 * Task 1-tests: Unit tests for `checkDeliveryCompleteness` chokepoint.
 *
 * These tests describe what "complete" means for podcast deliveries — every
 * step that declares `outputAs` must have a real kind=file artifact with a
 * non-null blobPath. Anything else is a typed gap.
 *
 * Pattern: mocks store/artifacts.js to return in-memory artifact arrays
 * (matching the pattern in artifact-attachments.test.ts).
 *
 * Expected state: FAIL — src/lib/delivery-completeness.ts does not exist yet.
 * After Task 1-impl: all 6 tests pass.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

// ---------------------------------------------------------------------------
// In-memory artifact store — mirrors the pattern used in artifact-attachments.test.ts
// ---------------------------------------------------------------------------

const artifactRows: Array<{
  id: string;
  executionId: string;
  stepId: string;
  key: string;
  kind: "json" | "file";
  value?: unknown;
  blobPath?: string | null;
  mime?: string;
  roleId?: string;
}> = [];

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

vi.mock("../../store/artifacts.js", () => ({
  listArtifactsByExecution: vi.fn((executionId: string) =>
    artifactRows
      .filter((r) => r.executionId === executionId)
      .map((r) => ({
        id: r.id,
        sourceKind: "template_step" as const,
        executionId: r.executionId,
        stepId: r.stepId,
        key: r.key,
        kind: r.kind,
        value: r.value,
        blobPath: r.blobPath,
        mime: r.mime,
        sizeBytes: r.kind === "file" ? 1024 : 0,
        createdAt: Date.now(),
        roleId: r.roleId ?? "role-test",
      })),
  ),
}));

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("checkDeliveryCompleteness", () => {
  beforeEach(() => {
    clearTestDb();
    artifactRows.length = 0;
  });

  it("returns complete=true when every outputAs has a kind=file artifact with blobPath", async () => {
    artifactRows.push(
      { id: "a1", executionId: "exec-complete-1", stepId: "step-dingao", key: "markdown", kind: "file", blobPath: "/tmp/dingao.md", roleId: "role-dingao" },
      { id: "a2", executionId: "exec-complete-1", stepId: "step-jay", key: "audio-files", kind: "file", blobPath: "/tmp/podcast.mp3", mime: "audio/mpeg", roleId: "role-jay" },
    );

    const { checkDeliveryCompleteness } = await import("../../lib/delivery-completeness.js");
    const template = {
      id: "tpl-complete-1",
      name: "Morning Podcast",
      trigger: { type: "manual" as const },
      steps: [
        { id: "step-dingao", prompt: "", outputAs: "markdown" },
        { id: "step-jay", prompt: "", outputAs: "audio-files" },
      ],
      enabled: true,
    };

    const result = checkDeliveryCompleteness("exec-complete-1", template as import("../../shared/types.js").TaskTemplate);

    expect(result.complete).toBe(true);
    expect(result.gaps).toHaveLength(0);
  });

  it("returns gap with kind='no_content' when a step's artifact is a {status:'no_content'} JSON marker", async () => {
    artifactRows.push(
      { id: "a1", executionId: "exec-nocontent-1", stepId: "step-dingao", key: "markdown", kind: "file", blobPath: "/tmp/dingao.md", roleId: "role-dingao" },
      {
        id: "a2",
        executionId: "exec-nocontent-1",
        stepId: "step-jay",
        key: "audio-files",
        kind: "json",
        value: { status: "no_content", reason: "Previous task wrote no files - crashed or hit quota before producing audio output" },
        blobPath: null,
        roleId: "role-jay",
      },
    );

    const { checkDeliveryCompleteness } = await import("../../lib/delivery-completeness.js");
    const template = {
      id: "tpl-nocontent-1",
      name: "Morning Podcast",
      trigger: { type: "manual" as const },
      steps: [
        { id: "step-dingao", prompt: "", outputAs: "markdown" },
        { id: "step-jay", prompt: "", outputAs: "audio-files" },
      ],
      enabled: true,
    };

    const result = checkDeliveryCompleteness("exec-nocontent-1", template as import("../../shared/types.js").TaskTemplate);

    expect(result.complete).toBe(false);
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0]).toMatchObject({
      stepId: "step-jay",
      key: "audio-files",
      kind: "no_content",
    });
    expect(result.gaps[0].reason).toMatch("crashed or hit quota");
  });

  it("returns gap with kind='missing' when a step declared outputAs but produced no artifact", async () => {
    // step-jay is NOT in artifactRows — it was declared but nothing was produced
    artifactRows.push(
      { id: "a1", executionId: "exec-missing-1", stepId: "step-dingao", key: "markdown", kind: "file", blobPath: "/tmp/dingao.md", roleId: "role-dingao" },
    );

    const { checkDeliveryCompleteness } = await import("../../lib/delivery-completeness.js");
    const template = {
      id: "tpl-missing-1",
      name: "Morning Podcast",
      trigger: { type: "manual" as const },
      steps: [
        { id: "step-dingao", prompt: "", outputAs: "markdown" },
        { id: "step-jay", prompt: "", outputAs: "audio-files" },
      ],
      enabled: true,
    };

    const result = checkDeliveryCompleteness("exec-missing-1", template as import("../../shared/types.js").TaskTemplate);

    expect(result.complete).toBe(false);
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0]).toMatchObject({
      stepId: "step-jay",
      key: "audio-files",
      kind: "missing",
    });
  });

  it("recurses into artifact_collection manifest — flags missing child artifact", async () => {
    // The collection manifest itself (kind=json) + only mp3-en child exists; mp3-zh is absent.
    artifactRows.push(
      {
        id: "a1",
        executionId: "exec-collection-missing-1",
        stepId: "step-picasso",
        key: "audio-files",
        kind: "json",
        value: { type: "artifact_collection", outputAs: "audio-files", items: [{ key: "mp3-en" }, { key: "mp3-zh" }] },
        roleId: "role-picasso",
      },
      {
        id: "a2",
        executionId: "exec-collection-missing-1",
        stepId: "step-picasso",
        key: "mp3-en",
        kind: "file",
        blobPath: "/tmp/en.mp3",
        mime: "audio/mpeg",
        roleId: "role-picasso",
      },
      // mp3-zh is absent
    );

    const { checkDeliveryCompleteness } = await import("../../lib/delivery-completeness.js");
    const template = {
      id: "tpl-collection-missing-1",
      name: "Podcast",
      trigger: { type: "manual" as const },
      steps: [{ id: "step-picasso", prompt: "", outputAs: "audio-files" }],
      enabled: true,
    };

    const result = checkDeliveryCompleteness("exec-collection-missing-1", template as import("../../shared/types.js").TaskTemplate);

    expect(result.complete).toBe(false);
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0]).toMatchObject({
      stepId: "step-picasso",
      key: "mp3-zh",
      kind: "missing",
    });
  });

  it("recurses into artifact_collection manifest — flags no_content child marker", async () => {
    // Collection manifest lists 2 items; mp3-en present, mp3-zh is a no_content marker.
    artifactRows.push(
      {
        id: "a1",
        executionId: "exec-collection-nocontent-1",
        stepId: "step-picasso",
        key: "audio-files",
        kind: "json",
        value: { type: "artifact_collection", outputAs: "audio-files", items: [{ key: "mp3-en" }, { key: "mp3-zh" }] },
        roleId: "role-picasso",
      },
      {
        id: "a2",
        executionId: "exec-collection-nocontent-1",
        stepId: "step-picasso",
        key: "mp3-en",
        kind: "file",
        blobPath: "/tmp/en.mp3",
        mime: "audio/mpeg",
        roleId: "role-picasso",
      },
      {
        id: "a3",
        executionId: "exec-collection-nocontent-1",
        stepId: "step-picasso",
        key: "mp3-zh",
        kind: "json",
        value: { status: "no_content", reason: "Synth quota exceeded" },
        blobPath: null,
        roleId: "role-picasso",
      },
    );

    const { checkDeliveryCompleteness } = await import("../../lib/delivery-completeness.js");
    const template = {
      id: "tpl-collection-nocontent-1",
      name: "Podcast",
      trigger: { type: "manual" as const },
      steps: [{ id: "step-picasso", prompt: "", outputAs: "audio-files" }],
      enabled: true,
    };

    const result = checkDeliveryCompleteness("exec-collection-nocontent-1", template as import("../../shared/types.js").TaskTemplate);

    expect(result.complete).toBe(false);
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0]).toMatchObject({
      stepId: "step-picasso",
      key: "mp3-zh",
      kind: "no_content",
      reason: "Synth quota exceeded",
    });
  });

  it("ignores steps with no outputAs (no declared output → can't be a gap)", async () => {
    // step-writea declares outputAs and has artifact; step-score has no outputAs and no artifact.
    artifactRows.push(
      { id: "a1", executionId: "exec-no-outputas-1", stepId: "step-writea", key: "draft-a", kind: "file", blobPath: "/tmp/draft-a.md", roleId: "role-writea" },
    );

    const { checkDeliveryCompleteness } = await import("../../lib/delivery-completeness.js");
    const template = {
      id: "tpl-no-outputas-1",
      name: "Review Flow",
      trigger: { type: "manual" as const },
      steps: [
        { id: "step-writea", prompt: "", outputAs: "draft-a" },
        { id: "step-score", prompt: "" },
      ],
      enabled: true,
    };

    const result = checkDeliveryCompleteness("exec-no-outputas-1", template as import("../../shared/types.js").TaskTemplate);

    expect(result.complete).toBe(true);
    expect(result.gaps).toHaveLength(0);
  });
});

afterAll(() => cleanup());
