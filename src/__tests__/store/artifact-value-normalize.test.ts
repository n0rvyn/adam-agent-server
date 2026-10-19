import { describe, it, expect, vi } from "vitest";

// artifacts.ts imports db.js (used only inside functions); mock it so module load is side-effect-free.
vi.mock("../../store/db.js", () => ({ getDb: vi.fn() }));

import { normalizeJsonArtifactValue } from "../../store/artifacts.js";

describe("normalizeJsonArtifactValue", () => {
  it("parses a double-encoded JSON-object string into the object (the 2026-06-03 empty-body bug)", () => {
    const stringified = JSON.stringify({ title: "能力边界", body: "# 标题\n正文" });
    const out = normalizeJsonArtifactValue("json", stringified);
    expect(out).toEqual({ title: "能力边界", body: "# 标题\n正文" });
    expect((out as { body: string }).body).toBe("# 标题\n正文"); // field access now works
  });

  it("parses a double-encoded JSON array string", () => {
    expect(normalizeJsonArtifactValue("json", "[1,2,3]")).toEqual([1, 2, 3]);
  });

  it("leaves a real object untouched", () => {
    const obj = { a: 1 };
    expect(normalizeJsonArtifactValue("json", obj)).toBe(obj);
  });

  it("leaves a plain (non-JSON) string as a string", () => {
    expect(normalizeJsonArtifactValue("json", "just a summary")).toBe("just a summary");
  });

  it("does NOT turn a stringified scalar into a non-string (keeps it a string)", () => {
    expect(normalizeJsonArtifactValue("json", "42")).toBe("42");
    expect(normalizeJsonArtifactValue("json", '"hello"')).toBe('"hello"');
  });

  it("ignores non-json kinds", () => {
    expect(normalizeJsonArtifactValue("file", '{"a":1}')).toBe('{"a":1}');
  });

  it("handles undefined", () => {
    expect(normalizeJsonArtifactValue("json", undefined)).toBeUndefined();
  });
});
