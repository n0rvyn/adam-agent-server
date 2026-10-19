import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  chmodSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";

let root = "";

describe("lib/artifact-storage", () => {
  beforeEach(() => {
    root = mkdtempSync(tmpdir() + sep + "adam-test-");
    process.env.ADAM_TEST_DIR = root;
  });

  afterEach(() => {
    delete process.env.ADAM_TEST_DIR;
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("manages artifact directories and path validation", async () => {
    const mod = await import("../../lib/artifact-storage.js");
    expect(mod.getArtifactsDir("exec-1")).toBe(join(root, "template-executions", "exec-1", "artifacts"));
    const dir = mod.ensureArtifactsDir("exec-1");
    expect(dir).toBe(mod.ensureArtifactsDir("exec-1"));
    expect(existsSync(dir)).toBe(true);

    const workspace = join(root, "roles", "role-a");
    mkdirSync(workspace, { recursive: true });
    const file = join(workspace, "inside.txt");
    writeFileSync(file, "ok");
    mod.validatePathInWorkspace(file, workspace, true);
    mod.validatePathInWorkspace(join(workspace, "out.txt"), workspace, false);

    expect(() => mod.validatePathInWorkspace("/tmp/evil", workspace, false)).toThrow(
      /destination escapes workspace/,
    );
    expect(() => mod.validatePathInWorkspace("relative.txt", workspace, false)).toThrow(
      /path must be absolute/,
    );
    expect(() => mod.validatePathInWorkspace(join(workspace, "missing.txt"), workspace, true)).toThrow();

    // An existing REGULAR file is now allowed (fetch overwrites stale same-named leftovers in the
    // shared role workspace); only symlinks and out-of-workspace escapes are still refused.
    const existingDest = join(workspace, "existing.txt");
    writeFileSync(existingDest, "exists");
    expect(() => mod.validatePathInWorkspace(existingDest, workspace, false)).not.toThrow();

    const outside = join(root, "outside.txt");
    writeFileSync(outside, "evil");
    const link = join(workspace, "link.txt");
    symlinkSync(outside, link);
    expect(() => mod.validatePathInWorkspace(link, workspace, true)).toThrow(/path escapes workspace/);
    expect(() => mod.validatePathInWorkspace(link, workspace, false)).toThrow(/symlink/);
  });

  it("publishes, fetches, unlinks, removes, and gc's blobs", async () => {
    const mod = await import("../../lib/artifact-storage.js");
    const workspace = join(root, "roles", "role-a");
    mkdirSync(workspace, { recursive: true });
    const source = join(workspace, "audio.txt");
    writeFileSync(source, "hello");

    const published = mod.publishBlob({
      executionId: "exec-blob",
      artifactId: "artifact-1",
      sourcePath: source,
    });
    expect(existsSync(source)).toBe(true);
    expect(readFileSync(published.blobPath, "utf8")).toBe("hello");

    const fetchedPath = join(workspace, "copy.txt");
    const fetched = mod.fetchBlob({ blobPath: published.blobPath, destPath: fetchedPath });
    expect(fetched.sizeBytes).toBe(5);
    expect(readFileSync(fetchedPath, "utf8")).toBe("hello");

    // Re-fetch to the same dest now OVERWRITES (was a COPYFILE_EXCL throw) — fetch always delivers
    // this run's artifact, never a stale leftover at the same path.
    const refetched = mod.fetchBlob({ blobPath: published.blobPath, destPath: fetchedPath });
    expect(refetched.sizeBytes).toBe(5);
    expect(readFileSync(fetchedPath, "utf8")).toBe("hello");

    expect(() => mod.fetchBlob({ blobPath: join(root, "missing.bin"), destPath: fetchedPath })).toThrow(
      /blob file missing on disk/,
    );

    const orphanOld = join(mod.getArtifactsDir("exec-blob"), "orphan-old.bin");
    const orphanNew = join(mod.getArtifactsDir("exec-blob"), "orphan-new.bin");
    writeFileSync(orphanOld, "old");
    writeFileSync(orphanNew, "new");
    const oldTs = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
    utimesSync(orphanOld, oldTs, oldTs);
    const removed = mod.gcOrphanBlobs("exec-blob", new Set(["artifact-1"]), 60 * 60 * 1000);
    expect(removed).toBe(1);
    expect(existsSync(orphanOld)).toBe(false);
    expect(existsSync(orphanNew)).toBe(true);

    mod.unlinkSourceFile(source);
    expect(existsSync(source)).toBe(false);
    mod.unlinkSourceFile(source);

    const strictSource = join(workspace, "strict.txt");
    writeFileSync(strictSource, "strict");
    chmodSync(workspace, 0o555);
    expect(() => mod.unlinkSourceFileStrict(strictSource)).toThrow();
    chmodSync(workspace, 0o755);

    mod.removeTemplateExecutionArtifactsDir("exec-blob");
    expect(existsSync(join(root, "template-executions", "exec-blob"))).toBe(false);
  });
});
