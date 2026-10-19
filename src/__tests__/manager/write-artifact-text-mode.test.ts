import { describe, it, expect } from "vitest";
import { isTextDeliverable, isTextCapturable } from "../../lib/resolve-contract-rules.js";
import type { TaskStep } from "../../shared/types.js";

// Task 2: write_artifact stores a STRING value as a raw text blob (not JSON.stringify-wrapped)
// ONLY when the step's contract declares format markdown|text. A bare string status with no
// text-format contract must stay JSON, or read_artifact (which expects a JSON value) breaks.
// Pure design: format is declared via the canonical contractRules vocabulary (the legacy
// outputContract.format field was removed).
// The full write→read round-trip is covered by the T9 e2e; this locks the branch decision.

function step(outputContract: TaskStep["outputContract"]): Pick<TaskStep, "outputContract"> {
  return { outputContract };
}

describe("isTextDeliverable", () => {
  it("string value + contractRules format:markdown → true (store as text blob)", () => {
    expect(isTextDeliverable(step({ contractRules: [{ kind: "format", value: "markdown" }] }), "# 标题\n正文")).toBe(true);
  });

  it("string value + contractRules format:text → true", () => {
    expect(isTextDeliverable(step({ contractRules: [{ kind: "format", value: "text" }] }), "plain body")).toBe(true);
  });

  it("string value + contractRules format:json → false (keep JSON storage)", () => {
    expect(isTextDeliverable(step({ contractRules: [{ kind: "format", value: "json" }] }), '{"a":1}')).toBe(false);
  });

  it("string value + NO contract → false (bare string stays JSON; read_artifact contract)", () => {
    expect(isTextDeliverable(step(undefined), "polished")).toBe(false);
    expect(isTextDeliverable(step({}), "polished")).toBe(false);
  });

  it("object value + contractRules format:markdown → false (only strings become text blobs)", () => {
    expect(isTextDeliverable(step({ contractRules: [{ kind: "format", value: "markdown" }] }), { content: "x" })).toBe(false);
  });

  it("string value + lengthTarget only (no format) → false (length alone doesn't imply text storage)", () => {
    expect(isTextDeliverable(step({ contractRules: [{ kind: "lengthTarget", min: 1, max: 9, unit: "characters" }] }), "hi")).toBe(false);
  });
});

// Capture-primary discriminant: whether a text step's response can be captured verbatim as a
// markdown artifact (no publish tool call). Differs from isTextDeliverable on the NO-CONTRACT
// case — there the response IS the deliverable, so it's capturable (true), whereas
// write_artifact's storeAsText needs an explicit format rule (false).
describe("isTextCapturable", () => {
  it("no contract → true (response is the deliverable; the common podcast text step)", () => {
    expect(isTextCapturable(step(undefined))).toBe(true);
    expect(isTextCapturable(step({}))).toBe(true);
  });

  it("format:markdown / format:text → true", () => {
    expect(isTextCapturable(step({ contractRules: [{ kind: "format", value: "markdown" }] }))).toBe(true);
    expect(isTextCapturable(step({ contractRules: [{ kind: "format", value: "text" }] }))).toBe(true);
  });

  it("lengthTarget only (no format) → true (still free text)", () => {
    expect(isTextCapturable(step({ contractRules: [{ kind: "lengthTarget", min: 1, max: 9, unit: "characters" }] }))).toBe(true);
  });

  it("format:json → false (structured value, must publish a typed artifact, not markdown blob)", () => {
    expect(isTextCapturable(step({ contractRules: [{ kind: "format", value: "json" }] }))).toBe(false);
  });

  it("mime:application/json → false (structured JSON deliverable)", () => {
    expect(isTextCapturable(step({ contractRules: [{ kind: "mime", declared: "application/json" }] }))).toBe(false);
  });

  it("binary (fileSizeBytes / audioDurationMs / non-json mime) → false (must publish a real file)", () => {
    expect(isTextCapturable(step({ contractRules: [{ kind: "fileSizeBytes", min: 1 }] }))).toBe(false);
    expect(isTextCapturable(step({ contractRules: [{ kind: "audioDurationMs", min: 500 }] }))).toBe(false);
    expect(isTextCapturable(step({ contractRules: [{ kind: "mime", declared: "audio/mpeg" }] }))).toBe(false);
  });
});
