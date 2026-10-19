/**
 * Integration test: artifact filename derivation through TemplateExecutor delivery pipeline.
 *
 * Covers the 6-branch fallback chain in filenameForArtifact (Task 6):
 * (a) originalFilename with extension wins
 * (b) key with extension honored
 * (c) MIME-derived extension (skips .bin)
 * (d) originalFilename bare (no extension)
 * (e) plain key (no extension better than wrong extension)
 * (f) blob basename fallback
 *
 * Approach: unit tests that call filenameForArtifact directly — no DB, no execute().
 * This avoids vitest vi.mock evaluation-order issues with shared state across mocks.
 */

import { describe, it, expect } from "vitest";
import { filenameForArtifact } from "../../lib/artifact-attachments.js";
import type { Artifact } from "../../store/artifacts.js";

describe("filenameForArtifact — all fallback branches", () => {
  function make(filename: string, mime?: string, originalFilename?: string, blobPath?: string) {
    return filenameForArtifact({
      id: "test-artifact",
      key: filename,
      mime: mime ?? "application/octet-stream",
      originalFilename,
      blobPath: blobPath ?? `/tmp/${filename}.bin`,
    } as unknown as Artifact);
  }

  // (a) originalFilename with extension wins
  it("branch (a): originalFilename with extension beats mime-derived", () => {
    expect(make("podcast-script", "text/markdown", "podcast.md")).toBe("podcast.md");
  });

  // (b) key with extension is honored
  it("branch (b): key already carrying extension is honored", () => {
    expect(make("report-final.pdf", "application/pdf", undefined)).toBe("report-final.pdf");
  });

  // (c) mime-derived .mp3
  it("branch (c): mime-derived .mp3 for audio/mp3", () => {
    expect(make("audio-output", "audio/mp3", undefined)).toBe("audio-output.mp3");
  });

  // (c) mime-derived .md
  it("branch (c): mime-derived .md for text/markdown", () => {
    expect(make("podcast-summary", "text/markdown", undefined)).toBe("podcast-summary.md");
  });

  // (e) no extension is better than .bin
  it("branch (e): bare key used for unknown mime (NOT key.bin)", () => {
    const result = make("weird-blob", "application/foo-bar", undefined);
    expect(result).toBe("weird-blob");
    expect(result).not.toBe("weird-blob.bin");
  });

  // (d) bare originalFilename (no extension) is better than guessing
  it("branch (d): bare originalFilename used when it has no extension", () => {
    expect(make("data-export", "application/octet-stream", "exported-data")).toBe("exported-data");
  });

  // (f) blob basename fallback
  it("branch (f): returns blob basename when key is empty", () => {
    expect(
      filenameForArtifact({ id: "fallback-id", key: "", blobPath: "/tmp/abc123.bin" } as unknown as Artifact),
    ).toBe("abc123.bin");
  });

  it("returns id when key is empty and no blobPath", () => {
    expect(
      filenameForArtifact({ id: "fallback-id", key: "", blobPath: undefined } as unknown as Artifact),
    ).toBe("fallback-id");
  });

  // Edge case: key with extension takes priority over mime
  it("key.ext beats mime-derived extension", () => {
    expect(make("notes.docx", "text/plain", undefined)).toBe("notes.docx");
  });

  // Edge case: application/octet-stream yields bare key (not .bin)
  it("mime application/octet-stream yields bare key (not .bin)", () => {
    const result = make("data-dump", "application/octet-stream", undefined);
    expect(result).toBe("data-dump");
    expect(result).not.toBe("data-dump.bin");
  });

  // Edge case: originalFilename path separators are sanitized
  it("sanitizes path separators in originalFilename", () => {
    expect(
      filenameForArtifact({
        id: "id",
        key: "key",
        originalFilename: "foo/bar.md",
        mime: "text/markdown",
        blobPath: "/tmp/x.bin",
      } as unknown as Artifact),
    ).toBe("bar.md");
  });

});
