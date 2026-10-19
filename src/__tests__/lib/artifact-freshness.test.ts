import { describe, it, expect } from "vitest";
import { isStalePublish, PUBLISH_FRESHNESS_SKEW_MS } from "../../lib/artifact-freshness.js";

describe("isStalePublish", () => {
  const startedAt = Date.parse("2026-06-03T06:00:00Z");

  it("passes a file created during the execution", () => {
    const mid = startedAt + 30 * 60 * 1000; // 30 min into the run
    const { stale } = isStalePublish({ birthtimeMs: mid, mtimeMs: mid }, startedAt);
    expect(stale).toBe(false);
  });

  it("flags a leftover whose mtime was bumped at publish but birthtime is days old (the 2026-06-03 bug)", () => {
    const birth = Date.parse("2026-05-28T22:15:00Z"); // 5/28 creation
    const bumped = startedAt + 53 * 60 * 1000; // copy/touch bumped mtime to during this run
    const { stale, fileTimeMs } = isStalePublish({ birthtimeMs: birth, mtimeMs: bumped }, startedAt);
    expect(stale).toBe(true); // birthtime (min) wins over the bumped mtime
    expect(fileTimeMs).toBe(birth);
  });

  it("falls back to mtime when birthtime is unrecorded (0)", () => {
    const old = Date.parse("2026-05-30T00:00:00Z");
    expect(isStalePublish({ birthtimeMs: 0, mtimeMs: old }, startedAt).stale).toBe(true);
    const fresh = startedAt + 1000;
    expect(isStalePublish({ birthtimeMs: 0, mtimeMs: fresh }, startedAt).stale).toBe(false);
  });

  it("tolerates clock skew just before execution start", () => {
    const justBefore = startedAt - (PUBLISH_FRESHNESS_SKEW_MS - 1000);
    expect(isStalePublish({ birthtimeMs: justBefore, mtimeMs: justBefore }, startedAt).stale).toBe(false);
    const beyondSkew = startedAt - (PUBLISH_FRESHNESS_SKEW_MS + 1000);
    expect(isStalePublish({ birthtimeMs: beyondSkew, mtimeMs: beyondSkew }, startedAt).stale).toBe(true);
  });
});
