/**
 * Tests for publishBlobByKind and isPathInAdamRuntime (Task 1, Phase 2).
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdirSync, writeFileSync, existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

import { publishBlobByKind, isPathInAdamRuntime } from "../../lib/artifact-storage.js";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "adam-artifact-kind-test-"));
  process.env.ADAM_TEST_DIR = tmpRoot;
});

afterAll(() => {
  delete process.env.ADAM_TEST_DIR;
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
});

// ---------------------------------------------------------------------------
// publishBlobByKind
// ---------------------------------------------------------------------------

describe("publishBlobByKind — kind='task'", () => {
  it("writes blob to ~/.adam/artifacts/task/<aid>.bin (case A)", () => {
    const srcPath = join(tmpRoot, "source-a.bin");
    writeFileSync(srcPath, "hello task");

    const result = publishBlobByKind({ kind: "task", artifactId: "a1", sourcePath: srcPath });

    const expected = join(tmpRoot, "artifacts", "task", "a1.bin");
    expect(result.blobPath).toBe(expected);
    expect(existsSync(expected)).toBe(true);
    expect(result.sizeBytes).toBe(statSync(expected).size);
    expect(result.sizeBytes).toBe(10); // "hello task"
  });
});

describe("publishBlobByKind — kind='chat'", () => {
  it("writes blob to ~/.adam/artifacts/chat/<aid>.bin (case B)", () => {
    const srcPath = join(tmpRoot, "source-b.bin");
    writeFileSync(srcPath, "hello chat!");

    const result = publishBlobByKind({ kind: "chat", artifactId: "a2", sourcePath: srcPath });

    const expected = join(tmpRoot, "artifacts", "chat", "a2.bin");
    expect(result.blobPath).toBe(expected);
    expect(existsSync(expected)).toBe(true);
    expect(result.sizeBytes).toBe(statSync(expected).size);
  });
});

describe("publishBlobByKind — kind='template' with executionId", () => {
  it("writes blob to ~/.adam/template-executions/<id>/artifacts/<aid>.bin (case C)", () => {
    const srcPath = join(tmpRoot, "source-c.bin");
    writeFileSync(srcPath, "template blob content");

    const result = publishBlobByKind({
      kind: "template",
      executionId: "exec-1",
      artifactId: "a3",
      sourcePath: srcPath,
    });

    const expected = join(tmpRoot, "template-executions", "exec-1", "artifacts", "a3.bin");
    expect(result.blobPath).toBe(expected);
    expect(existsSync(expected)).toBe(true);
    expect(result.sizeBytes).toBe(statSync(expected).size);
  });
});

describe("publishBlobByKind — kind='template' missing executionId", () => {
  it("throws 'template kind requires executionId' (case D)", () => {
    const srcPath = join(tmpRoot, "source-d.bin");
    writeFileSync(srcPath, "x");

    expect(() =>
      publishBlobByKind({ kind: "template", artifactId: "a4", sourcePath: srcPath }),
    ).toThrow("template kind requires executionId");
  });
});

// ---------------------------------------------------------------------------
// isPathInAdamRuntime
// ---------------------------------------------------------------------------

describe("isPathInAdamRuntime", () => {
  it("returns true for a path inside the runtime root (case E)", () => {
    // Must create the file so realpathSync succeeds
    const dir = join(tmpRoot, "artifacts", "task");
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, "x.bin");
    writeFileSync(filePath, "data");

    expect(isPathInAdamRuntime(filePath)).toBe(true);
  });

  it("returns false for /etc/passwd (case F)", () => {
    expect(isPathInAdamRuntime("/etc/passwd")).toBe(false);
  });

  it("returns false for relative path (case G)", () => {
    expect(isPathInAdamRuntime("relative/path.bin")).toBe(false);
  });

  it("returns false for nonexistent absolute path (case H)", () => {
    expect(isPathInAdamRuntime("/some/nonexistent/definitely-not-here/file.bin")).toBe(false);
  });
});
