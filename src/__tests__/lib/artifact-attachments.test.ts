/**
 * Unit tests for src/lib/artifact-attachments.ts.
 * Covers: getDeliverableFileArtifacts, mediaTypeForArtifact, filenameForArtifact,
 * buildAttachmentsFromArtifacts.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

const artifactRows: Array<Record<string, unknown>> = [];
vi.mock("../../store/artifacts.js", () => ({
  listArtifactsByExecution: vi.fn((executionId: string) =>
    artifactRows.filter((r) => r.executionId === executionId),
  ),
}));

import {
  getDeliverableFileArtifacts,
  extractH1Title,
  mediaTypeForArtifact,
  filenameForArtifact,
  buildAttachmentsFromArtifacts,
} from "../../lib/artifact-attachments.js";
import type { Artifact } from "../../store/artifacts.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

afterAll(() => cleanup());
beforeEach(() => {
  clearTestDb();
  artifactRows.length = 0;
});

// ---------------------------------------------------------------------------
// mediaTypeForArtifact
// ---------------------------------------------------------------------------
describe("mediaTypeForArtifact", () => {
  function makeArtifact(mime: string | undefined): Artifact {
    return { id: "art-1", executionId: "exec-1", stepId: "s1", key: "f", kind: "file", mime, sizeBytes: 100, createdAt: Date.now() } as unknown as Artifact;
  }

  it("image/jpeg → image", () => expect(mediaTypeForArtifact(makeArtifact("image/jpeg"))).toBe("image"));
  it("image/png → image", () => expect(mediaTypeForArtifact(makeArtifact("image/png"))).toBe("image"));
  it("image/webp → image", () => expect(mediaTypeForArtifact(makeArtifact("image/webp"))).toBe("image"));
  it("audio/mpeg → audio", () => expect(mediaTypeForArtifact(makeArtifact("audio/mpeg"))).toBe("audio"));
  it("audio/ogg → audio", () => expect(mediaTypeForArtifact(makeArtifact("audio/ogg"))).toBe("audio"));
  it("video/mp4 → video", () => expect(mediaTypeForArtifact(makeArtifact("video/mp4"))).toBe("video"));
  it("video/webm → video", () => expect(mediaTypeForArtifact(makeArtifact("video/webm"))).toBe("video"));
  it("application/pdf → file", () => expect(mediaTypeForArtifact(makeArtifact("application/pdf"))).toBe("file"));
  it("text/plain → file", () => expect(mediaTypeForArtifact(makeArtifact("text/plain"))).toBe("file"));
  it("undefined mime → file", () => expect(mediaTypeForArtifact(makeArtifact(undefined))).toBe("file"));
  it("empty string mime → file", () => expect(mediaTypeForArtifact(makeArtifact(""))).toBe("file"));
});

// ---------------------------------------------------------------------------
// filenameForArtifact — 6-tier priority
// ---------------------------------------------------------------------------
describe("filenameForArtifact", () => {
  function makeArtifact(partial: Partial<Artifact>): Artifact {
    return {
      id: "art-f",
      executionId: "exec-1",
      stepId: "s1",
      key: "step-output",
      kind: "file",
      mime: "application/octet-stream",
      sizeBytes: 100,
      createdAt: Date.now(),
      ...partial,
    } as unknown as Artifact;
  }

  it("(a) originalFilename with extension → wins", () => {
    const a = makeArtifact({ originalFilename: "my-report.pdf" });
    expect(filenameForArtifact(a)).toBe("my-report.pdf");
  });

  it("(b) key already has extension → uses key", () => {
    const a = makeArtifact({ key: "report.md" });
    expect(filenameForArtifact(a)).toBe("report.md");
  });

  it("(c) derive from MIME (non-bin)", () => {
    const a = makeArtifact({ key: "report", mime: "text/markdown" });
    expect(filenameForArtifact(a)).toBe("report.md");
  });

  it("(c) skips bin default", () => {
    const a = makeArtifact({ key: "report", mime: "application/octet-stream" });
    expect(filenameForArtifact(a)).not.toContain(".bin");
  });

  it("(d) originalFilename without extension", () => {
    const a = makeArtifact({ originalFilename: "report-no-ext" });
    expect(filenameForArtifact(a)).toBe("report-no-ext");
  });

  it("(e) plain key (no extension, no originalFilename)", () => {
    const a = makeArtifact({ key: "artifact-key" });
    expect(filenameForArtifact(a)).toBe("artifact-key");
  });

  it("(f) fallback to blobPath basename", () => {
    const a = makeArtifact({ key: "", blobPath: "/tmp/abc123.bin" });
    expect(filenameForArtifact(a)).toBe("abc123.bin");
  });

  it("originalFilename path separators are replaced with dashes", () => {
    const a = makeArtifact({ originalFilename: "C:\\Users\\me\\file.pdf" });
    // replace(/[\\/]/g, "-") converts both slash styles to dashes, keeping the full path
    expect(filenameForArtifact(a)).toBe("C:-Users-me-file.pdf");
  });

  it("key path separators are normalized", () => {
    const a = makeArtifact({ key: "dir/subdir/file.pdf" });
    expect(filenameForArtifact(a)).toBe("file.pdf");
  });
});

// ---------------------------------------------------------------------------
// getDeliverableFileArtifacts
// ---------------------------------------------------------------------------
describe("getDeliverableFileArtifacts", () => {
  function push(id: string, kind: string, blobPath: string | undefined) {
    artifactRows.push({ id, executionId: "exec-1", stepId: "s1", key: id, kind, blobPath, sizeBytes: 100, createdAt: Date.now() });
  }

  it("filters to kind=file with blobPath", () => {
    push("json-art", "json", undefined);
    push("file-no-blob", "file", undefined);
    push("file-good", "file", "/tmp/good.txt");
    const result = getDeliverableFileArtifacts("exec-1");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("file-good");
  });

  it("returns empty array when no file artifacts", () => {
    push("json-art", "json", "/tmp/data.json");
    const result = getDeliverableFileArtifacts("exec-1");
    expect(result).toHaveLength(0);
  });

  it("returns empty array for unknown executionId", () => {
    const result = getDeliverableFileArtifacts("nonexistent");
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// extractH1Title
// ---------------------------------------------------------------------------
describe("extractH1Title", () => {
  const dir = mkdtempSync(join(tmpdir(), "h1title-"));
  function fileArtifact(content: string): Artifact {
    const p = join(dir, `f-${Math.random().toString(36).slice(2)}.md`);
    writeFileSync(p, content, "utf-8");
    return { id: "a", kind: "file", blobPath: p, mime: "text/markdown", sizeBytes: content.length, createdAt: 0 } as unknown as Artifact;
  }

  it("returns the first H1 heading text", () => {
    expect(extractH1Title(fileArtifact("# AI时代的大象\n\n正文…"))).toBe("AI时代的大象");
  });

  it("trims trailing whitespace in heading", () => {
    expect(extractH1Title(fileArtifact("#   带空格的标题   \n"))).toBe("带空格的标题");
  });

  it("returns undefined when no H1", () => {
    expect(extractH1Title(fileArtifact("没有标题的正文\n## 二级标题"))).toBeUndefined();
  });

  it("returns undefined for json artifact (no blob)", () => {
    expect(extractH1Title({ id: "j", kind: "json", value: {}, sizeBytes: 0, createdAt: 0 } as unknown as Artifact)).toBeUndefined();
  });

  it("returns undefined when blob unreadable", () => {
    expect(extractH1Title({ id: "x", kind: "file", blobPath: "/no/such/file.md", sizeBytes: 0, createdAt: 0 } as unknown as Artifact)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buildAttachmentsFromArtifacts
// ---------------------------------------------------------------------------
describe("buildAttachmentsFromArtifacts", () => {
  function makeArtifact(partial: Partial<Artifact>): Artifact {
    return {
      id: "art-build",
      executionId: "exec-1",
      stepId: "s1",
      key: "output",
      kind: "file",
      mime: "image/png",
      blobPath: "/tmp/out.png",
      sizeBytes: 2048,
      createdAt: Date.now(),
      ...partial,
    } as unknown as Artifact;
  }

  it("maps artifact to OutboundAttachment shape", () => {
    const artifacts = [makeArtifact({ id: "art-1", key: "image", mime: "image/png" })];
    const result = buildAttachmentsFromArtifacts(artifacts);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      path: "/tmp/out.png",
      mediaType: "image",
      filename: "image.png",
      contentType: "image/png",
      mimeType: "image/png",
      artifactId: "art-1",
    });
  });

  it("maps 3 artifacts correctly", () => {
    const artifacts = [
      makeArtifact({ id: "a1", key: "img", mime: "image/jpeg", blobPath: "/tmp/img.jpg" }),
      makeArtifact({ id: "a2", key: "audio", mime: "audio/mp3", blobPath: "/tmp/audio.mp3" }),
      makeArtifact({ id: "a3", key: "video", mime: "video/mp4", blobPath: "/tmp/video.mp4" }),
    ];
    const result = buildAttachmentsFromArtifacts(artifacts);
    expect(result).toHaveLength(3);
    expect(result.map((a) => a.mediaType)).toEqual(["image", "audio", "video"]);
  });

  it("empty array returns empty array", () => {
    expect(buildAttachmentsFromArtifacts([])).toHaveLength(0);
  });

  it("populates all optional fields when present", () => {
    const artifacts = [makeArtifact({
      id: "a-full",
      key: "doc",
      mime: "application/pdf",
      blobPath: "/tmp/doc.pdf",
      locator: "s3://bucket/doc.pdf",
      purpose: "media",
      contentHash: "sha256:abc",
    })];
    const result = buildAttachmentsFromArtifacts(artifacts);
    expect(result[0]).toMatchObject({
      locator: "s3://bucket/doc.pdf",
      purpose: "media",
      contentHash: "sha256:abc",
    });
  });

});

// ---------------------------------------------------------------------------
// filenameForArtifact — task_published source
// ---------------------------------------------------------------------------
describe("filenameForArtifact — task_published source", () => {
  it("returns originalFilename when present (priority a)", () => {
    const artifact: Artifact = {
      id: "a1",
      sourceKind: "task_published",
      taskId: "task-1",
      kind: "file",
      blobPath: "/abs/path/to/abc123.bin",
      originalFilename: "report.pdf",
      sizeBytes: 1024,
      createdAt: 0,
    } as unknown as Artifact;
    expect(filenameForArtifact(artifact)).toBe("report.pdf");
  });

  it("falls back to blobPath basename when no originalFilename and no key (priority f)", () => {
    const artifact: Artifact = {
      id: "a2",
      sourceKind: "task_published",
      taskId: "task-1",
      kind: "file",
      blobPath: "/abs/path/to/def456.bin",
      sizeBytes: 100,
      createdAt: 0,
    } as unknown as Artifact;
    expect(filenameForArtifact(artifact)).toBe("def456.bin");
  });
});

// ---------------------------------------------------------------------------
// filenameForArtifact — chat_sent source
// ---------------------------------------------------------------------------
describe("filenameForArtifact — chat_sent source", () => {
  it("returns originalFilename when present", () => {
    const artifact: Artifact = {
      id: "c1",
      sourceKind: "chat_sent",
      chatSessionId: "sess-1",
      kind: "file",
      blobPath: "/abs/path/to/xyz789.bin",
      originalFilename: "vacation-photo.jpg",
      sizeBytes: 50000,
      createdAt: 0,
    } as unknown as Artifact;
    expect(filenameForArtifact(artifact)).toBe("vacation-photo.jpg");
  });

  it("derives extension from mime when key empty (priority c skipped — falls to f because safeKey is empty)", () => {
    const artifact: Artifact = {
      id: "c2",
      sourceKind: "chat_sent",
      chatSessionId: "sess-1",
      kind: "file",
      blobPath: "/abs/path/to/qrs012.bin",
      mime: "audio/mpeg",
      sizeBytes: 1000,
      createdAt: 0,
    } as unknown as Artifact;
    // key is null → safeKey is empty → priority (c) requires `&& safeKey`, skipped → falls through to (f)
    expect(filenameForArtifact(artifact)).toBe("qrs012.bin");
  });

  it("returns id when blobPath also absent (final fallback)", () => {
    const artifact: Artifact = {
      id: "c3",
      sourceKind: "chat_sent",
      chatSessionId: "sess-1",
      kind: "file",
      sizeBytes: 0,
      createdAt: 0,
    } as unknown as Artifact;
    expect(filenameForArtifact(artifact)).toBe("c3");
  });
});
