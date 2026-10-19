/**
 * Unit tests for src/scheduler/prompt-assembler.ts
 *
 * Tests all 10 branches (a-j) per dev-guide acceptance:
 * (a)  explicit consumesFrom + artifact present   → fenced content in prompt
 * (b)  explicit consumesFrom + artifact missing    → throws MissingRequiredArtifactError
 * (c)  consumesFromOptional + missing              → no throw; placeholder injected; missingOptional populated
 * (d)  persona block inserted in correct position
 * (e)  output contract block inserted in correct position
 * (f)  synthesized from dependsOn + artifact missing → no throw; missingOptional populated
 * (g)  synthesized from dependsOn + artifact exists → fenced content injected
 * (h)  artifact > 32 KB                            → head/tail truncation + TRUNCATED marker
 * (i)  binary file artifact                        → self-closing stub injected
 * (j)  untrusted-input safety note                 → present when artifacts present, absent when not
 */

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { assemblePrompt, MissingRequiredArtifactError } from "../../scheduler/prompt-assembler.js";
import type { TaskStep } from "../../shared/types.js";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();
vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

// ---------------------------------------------------------------------------
// Artifact store mock — backed by an in-memory Map so tests can seed artifacts
// ---------------------------------------------------------------------------
type ArtifactSeed = {
  stepId: string;
  key: string;
  kind: "json" | "file";
  value?: unknown;
  mime?: string;
  blobPath?: string;
  sizeBytes: number;
};

const artifactStore = new Map<string, ArtifactSeed[]>();

vi.mock("../../store/artifacts.js", () => ({
  listArtifactsByExecution: vi.fn((executionId: string) => {
    const seeds = artifactStore.get(executionId) ?? [];
    return seeds.map((s) => ({
      id: `art-${executionId}-${s.stepId}-${s.key}`,
      sourceKind: "template_step" as const,
      roleId: "role-test",
      executionId,
      stepId: s.stepId,
      key: s.key,
      kind: s.kind,
      value: s.value,
      blobPath: s.blobPath,
      mime: s.mime,
      sizeBytes: s.sizeBytes,
      createdAt: Date.now(),
    }));
  }),
}));

import { listArtifactsByExecution } from "../../store/artifacts.js";

function seedArtifact(
  executionId: string,
  seed: ArtifactSeed,
) {
  if (!artifactStore.has(executionId)) {
    artifactStore.set(executionId, []);
  }
  artifactStore.get(executionId)!.push(seed);
}

function clearArtifacts() {
  artifactStore.clear();
}

beforeEach(() => {
  clearTestDb();
  clearArtifacts();
  vi.clearAllMocks();
  // Re-wire mock to return fresh data each call
  vi.mocked(listArtifactsByExecution).mockImplementation((executionId: string) => {
    const seeds = artifactStore.get(executionId) ?? [];
    return seeds.map((s) => ({
      id: `art-${executionId}-${s.stepId}-${s.key}`,
      sourceKind: "template_step" as const,
      roleId: "role-test",
      executionId,
      stepId: s.stepId,
      key: s.key,
      kind: s.kind,
      value: s.value,
      blobPath: s.blobPath,
      mime: s.mime,
      sizeBytes: s.sizeBytes,
      createdAt: Date.now(),
    }));
  });
});

afterAll(() => cleanup());

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------
const EXECUTION_ID = "exec-test-001";
const USER_PROMPT = "Write the podcast script.";

function makeStep(overrides: Partial<TaskStep> = {}): TaskStep {
  return {
    id: "step-1",
    prompt: USER_PROMPT,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Branch (a): explicit consumesFrom + artifact exists → fenced content injected
// ---------------------------------------------------------------------------
describe("(a) explicit consumesFrom + artifact present", () => {
  it("injects literal artifact content within UNTRUSTED_INPUT fences", () => {
    seedArtifact(EXECUTION_ID, {
      stepId: "gather",
      key: "material",
      kind: "json",
      value: { text: "Today we discuss AI safety." },
      sizeBytes: 42,
    });

    const step = makeStep({
      id: "write",
      consumesFrom: ["gather"],
    });

    const result = assemblePrompt({ step, executionId: EXECUTION_ID, userPromptResolved: USER_PROMPT });

    expect(result.missingRequired).toEqual([]);
    expect(result.missingOptional).toEqual([]);
    expect(result.prompt).toContain('<UNTRUSTED_INPUT source="upstream-artifact" step="gather" key="material" mime="text/plain">');
    expect(result.prompt).toContain('"text": "Today we discuss AI safety."');
    expect(result.prompt).toContain("</UNTRUSTED_INPUT>");
    expect(result.prompt).toContain(USER_PROMPT);
  });

  it("multiple artifacts from same producer step are all injected", () => {
    seedArtifact(EXECUTION_ID, { stepId: "gather", key: "text", kind: "json", value: { t: "A" }, sizeBytes: 10 });
    seedArtifact(EXECUTION_ID, { stepId: "gather", key: "extra", kind: "json", value: { x: 1 }, sizeBytes: 10 });

    const step = makeStep({ consumesFrom: ["gather"] });
    const result = assemblePrompt({ step, executionId: EXECUTION_ID, userPromptResolved: USER_PROMPT });

    expect(result.prompt).toContain('key="text"');
    expect(result.prompt).toContain('key="extra"');
  });
});

// ---------------------------------------------------------------------------
// Branch (b): explicit consumesFrom + artifact missing → throws
// ---------------------------------------------------------------------------
describe("(b) explicit consumesFrom + artifact missing", () => {
  it("throws MissingRequiredArtifactError listing the missing producer step IDs", () => {
    // No artifact seeded for "gather"

    const step = makeStep({
      consumesFrom: ["gather"],
    });

    expect(() =>
      assemblePrompt({ step, executionId: EXECUTION_ID, userPromptResolved: USER_PROMPT }),
    ).toThrow(MissingRequiredArtifactError);

    try {
      assemblePrompt({ step, executionId: EXECUTION_ID, userPromptResolved: USER_PROMPT });
    } catch (err) {
      expect(err).toBeInstanceOf(MissingRequiredArtifactError);
      expect((err as MissingRequiredArtifactError).missingProducerStepIds).toEqual(["gather"]);
      expect((err as MissingRequiredArtifactError).executionId).toBe(EXECUTION_ID);
    }
  });

  it("collects multiple missing required artifacts and throws once with all IDs", () => {
    const step = makeStep({
      consumesFrom: ["step-a", "step-b"],
    });
    // No artifacts seeded

    expect(() =>
      assemblePrompt({ step, executionId: EXECUTION_ID, userPromptResolved: USER_PROMPT }),
    ).toThrow(MissingRequiredArtifactError);

    try {
      assemblePrompt({ step, executionId: EXECUTION_ID, userPromptResolved: USER_PROMPT });
    } catch (err) {
      const ids = (err as MissingRequiredArtifactError).missingProducerStepIds;
      expect(ids).toContain("step-a");
      expect(ids).toContain("step-b");
    }
  });

  it("missingRequired is empty in returned AssembledPrompt when no artifacts missing", () => {
    seedArtifact(EXECUTION_ID, { stepId: "upstream", key: "out", kind: "json", value: { ok: true }, sizeBytes: 20 });
    const step = makeStep({ consumesFrom: ["upstream"] });
    const result = assemblePrompt({ step, executionId: EXECUTION_ID, userPromptResolved: USER_PROMPT });
    expect(result.missingRequired).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Branch (c): consumesFromOptional + missing → no throw; placeholder injected
// ---------------------------------------------------------------------------
describe("(c) consumesFromOptional + missing artifact", () => {
  it("does not throw; missingOptional is populated", () => {
    const step = makeStep({
      consumesFromOptional: ["opt-step"],
    });

    const result = assemblePrompt({ step, executionId: EXECUTION_ID, userPromptResolved: USER_PROMPT });

    expect(result.missingRequired).toEqual([]);
    expect(result.missingOptional).toEqual(["opt-step"]);
  });

  it("injects no_artifact placeholder for missing optional artifact", () => {
    const step = makeStep({
      consumesFromOptional: ["opt-step"],
    });

    const result = assemblePrompt({ step, executionId: EXECUTION_ID, userPromptResolved: USER_PROMPT });

    expect(result.prompt).toContain('<UNTRUSTED_INPUT source="upstream-artifact" step="opt-step" status="no_artifact"/>');
  });

  it("when optional artifact IS present, it is injected normally", () => {
    seedArtifact(EXECUTION_ID, { stepId: "opt-step", key: "content", kind: "json", value: { ready: true }, sizeBytes: 25 });
    const step = makeStep({ consumesFromOptional: ["opt-step"] });

    const result = assemblePrompt({ step, executionId: EXECUTION_ID, userPromptResolved: USER_PROMPT });

    expect(result.missingOptional).toEqual([]);
    expect(result.prompt).toContain("ready");
    expect(result.prompt).not.toContain("no_artifact");
  });
});

// ---------------------------------------------------------------------------
// Branch (d): Persona block inserted in correct position
// ---------------------------------------------------------------------------
describe("(d) persona block", () => {
  it("is absent when persona is not set", () => {
    const step = makeStep();
    const result = assemblePrompt({ step, executionId: EXECUTION_ID, userPromptResolved: USER_PROMPT });
    expect(result.prompt).not.toContain("## Persona");
  });

  it("is present and in correct position (after artifacts, before output contract)", () => {
    // Seed an artifact so "## Upstream Artifacts" section appears before persona
    seedArtifact(EXECUTION_ID, { stepId: "gather", key: "raw", kind: "json", value: { text: "raw" }, sizeBytes: 20 });

    const step = makeStep({
      consumesFrom: ["gather"],
      persona: { speakAs: "卞旸", voiceConstraints: "自然口语" },
    });

    const result = assemblePrompt({ step, executionId: EXECUTION_ID, userPromptResolved: USER_PROMPT });

    expect(result.prompt).toContain("## Persona");
    expect(result.prompt).toContain("You speak as: 卞旸");
    expect(result.prompt).toContain("Voice constraints: 自然口语");
    expect(result.prompt).toContain("Do NOT introduce yourself by your Role name");

    // Persona after Upstream Artifacts, before Task Instruction
    const upstreamIdx = result.prompt.indexOf("## Upstream Artifacts");
    const personaIdx = result.prompt.indexOf("## Persona");
    const taskIdx = result.prompt.indexOf("## Task Instruction");
    expect(upstreamIdx).toBeGreaterThanOrEqual(0);
    expect(personaIdx).toBeGreaterThan(upstreamIdx);
    expect(personaIdx).toBeLessThan(taskIdx);
  });

  it("persona block with only speakAs (no voiceConstraints)", () => {
    const step = makeStep({
      persona: { speakAs: "Alice" },
    });

    const result = assemblePrompt({ step, executionId: EXECUTION_ID, userPromptResolved: USER_PROMPT });

    expect(result.prompt).toContain("You speak as: Alice");
    expect(result.prompt).not.toContain("Voice constraints:");
  });
});

// ---------------------------------------------------------------------------
// Branch (e): Output contract block inserted in correct position
// ---------------------------------------------------------------------------
describe("(e) output contract block", () => {
  it("is absent when outputContract is not set", () => {
    const step = makeStep();
    const result = assemblePrompt({ step, executionId: EXECUTION_ID, userPromptResolved: USER_PROMPT });
    expect(result.prompt).not.toContain("## Output Contract");
  });

  it("is present with all sub-fields", () => {
    // Seed an artifact so upstream section appears before contract
    seedArtifact(EXECUTION_ID, { stepId: "gather", key: "raw", kind: "json", value: { text: "raw" }, sizeBytes: 20 });

    const step = makeStep({
      consumesFrom: ["gather"],
      outputContract: {
        contractRules: [
          { kind: "lengthTarget", min: 2200, max: 2800, unit: "characters" },
          { kind: "format", value: "markdown" },
        ],
        mustReferenceArtifacts: true,
      },
    });

    const result = assemblePrompt({ step, executionId: EXECUTION_ID, userPromptResolved: USER_PROMPT });

    expect(result.prompt).toContain("## Output Contract");
    expect(result.prompt).toContain("Length target: 2200-2800 characters.");
    expect(result.prompt).toContain("Format: markdown.");
    expect(result.prompt).toContain("Must reference at least one fact from the upstream artifacts above.");

    // Output Contract after Upstream Artifacts and Persona, before Task Instruction
    const upstreamIdx = result.prompt.indexOf("## Upstream Artifacts");
    const contractIdx = result.prompt.indexOf("## Output Contract");
    const taskIdx = result.prompt.indexOf("## Task Instruction");
    expect(upstreamIdx).toBeGreaterThanOrEqual(0);
    expect(contractIdx).toBeGreaterThan(upstreamIdx);
    expect(contractIdx).toBeLessThan(taskIdx);
  });

  it("output contract with only format (no length target)", () => {
    const step = makeStep({
      outputContract: { contractRules: [{ kind: "format", value: "json" }] },
    });

    const result = assemblePrompt({ step, executionId: EXECUTION_ID, userPromptResolved: USER_PROMPT });

    expect(result.prompt).toContain("Format: json.");
    expect(result.prompt).not.toContain("Length target:");
  });
});

// ---------------------------------------------------------------------------
// Branch (f): Synthesized consumesFrom from dependsOn + artifact missing
// ---------------------------------------------------------------------------
describe("(f) synthesized consumesFrom from dependsOn + artifact missing", () => {
  it("does NOT throw (soft fallback per DP-000)", () => {
    const step = makeStep({
      dependsOn: ["legacy-step"],
      // consumesFrom deliberately absent — synthesize from dependsOn
    });

    expect(() =>
      assemblePrompt({ step, executionId: EXECUTION_ID, userPromptResolved: USER_PROMPT }),
    ).not.toThrow();
  });

  it("missingOptional is populated for the synthesized dependency", () => {
    const step = makeStep({
      dependsOn: ["legacy-step"],
    });

    const result = assemblePrompt({ step, executionId: EXECUTION_ID, userPromptResolved: USER_PROMPT });

    expect(result.missingOptional).toContain("legacy-step");
  });

  it("no_artifact placeholder is injected for the synthesized dependency", () => {
    const step = makeStep({
      dependsOn: ["legacy-step"],
    });

    const result = assemblePrompt({ step, executionId: EXECUTION_ID, userPromptResolved: USER_PROMPT });

    expect(result.prompt).toContain('<UNTRUSTED_INPUT source="upstream-artifact" step="legacy-step" status="no_artifact"/>');
  });

  it("user prompt still appears last (legacy back-compat)", () => {
    const step = makeStep({
      dependsOn: ["legacy-step"],
    });

    const result = assemblePrompt({ step, executionId: EXECUTION_ID, userPromptResolved: USER_PROMPT });

    expect(result.prompt).toMatch(/## Task Instruction\nWrite the podcast script\.$/);
  });
});

// ---------------------------------------------------------------------------
// Branch (g): Synthesized consumesFrom from dependsOn + artifact exists
// ---------------------------------------------------------------------------
describe("(g) synthesized consumesFrom from dependsOn + artifact present", () => {
  it("injects artifact content (opportunistic upgrade)", () => {
    seedArtifact(EXECUTION_ID, { stepId: "prev-step", key: "output", kind: "json", value: { script: "Introduction..." }, sizeBytes: 30 });

    const step = makeStep({
      dependsOn: ["prev-step"],
      // No consumesFrom → synthesize from dependsOn
    });

    const result = assemblePrompt({ step, executionId: EXECUTION_ID, userPromptResolved: USER_PROMPT });

    expect(result.prompt).toContain("Introduction...");
    expect(result.prompt).toContain('<UNTRUSTED_INPUT source="upstream-artifact" step="prev-step"');
    expect(result.missingOptional).not.toContain("prev-step");
  });

  it("explicit consumesFrom takes priority over synthesized (consumesFrom set → hard)", () => {
    seedArtifact(EXECUTION_ID, { stepId: "prev-step", key: "out", kind: "json", value: { x: 1 }, sizeBytes: 10 });

    const step = makeStep({
      dependsOn: ["prev-step"],
      consumesFrom: ["prev-step"], // explicit → hard
    });

    const result = assemblePrompt({ step, executionId: EXECUTION_ID, userPromptResolved: USER_PROMPT });

    // Should succeed (artifact present) — no throw
    expect(result.missingRequired).toEqual([]);
    expect(result.prompt).toContain("x");
  });
});

// ---------------------------------------------------------------------------
// Branch (h): Artifact > 32 KB → head/tail truncation + TRUNCATED marker
// ---------------------------------------------------------------------------
describe("(h) artifact truncation > 32 KB", () => {
  it("truncates large artifact and injects TRUNCATED marker", () => {
    // Create content larger than MAX_ARTIFACT_INJECT_BYTES (32 KB)
    const largeContent = "X".repeat(40 * 1024);
    seedArtifact(EXECUTION_ID, {
      stepId: "large-step",
      key: "big-file",
      kind: "json",
      value: { body: largeContent },
      sizeBytes: 40 * 1024,
    });

    const step = makeStep({ consumesFrom: ["large-step"] });

    const result = assemblePrompt({ step, executionId: EXECUTION_ID, userPromptResolved: USER_PROMPT });

    expect(result.prompt).toContain("<TRUNCATED");
    expect(result.prompt).toContain("reason=");
    expect(result.truncatedArtifacts).toContainEqual({
      stepId: "large-step",
      key: "big-file",
      sizeBytes: 40 * 1024,
    });
  });

  it("small artifact is NOT truncated", () => {
    seedArtifact(EXECUTION_ID, { stepId: "small", key: "doc", kind: "json", value: { small: true }, sizeBytes: 100 });

    const step = makeStep({ consumesFrom: ["small"] });
    const result = assemblePrompt({ step, executionId: EXECUTION_ID, userPromptResolved: USER_PROMPT });

    expect(result.prompt).not.toContain("<TRUNCATED");
    expect(result.truncatedArtifacts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Branch (i): Binary file artifact → self-closing metadata stub
// ---------------------------------------------------------------------------
describe("(i) binary file artifact", () => {
  it("injects self-closing UNTRUSTED_INPUT stub without reading blob", () => {
    // Simulate a binary blob path (readFileSync should not be called)
    seedArtifact(EXECUTION_ID, {
      stepId: "audio-step",
      key: "podcast.mp3",
      kind: "file",
      mime: "audio/mpeg",
      blobPath: "/nonexistent/path/audio.mp3", // should not be read
      sizeBytes: 1_234_567,
    });

    const step = makeStep({ consumesFrom: ["audio-step"] });
    const result = assemblePrompt({ step, executionId: EXECUTION_ID, userPromptResolved: USER_PROMPT });

    expect(result.prompt).toContain('<UNTRUSTED_INPUT');
    expect(result.prompt).toContain('step="audio-step"');
    expect(result.prompt).toContain('key="podcast.mp3"');
    expect(result.prompt).toContain('mime="audio/mpeg"');
    expect(result.prompt).toContain('binary="true"');
    expect(result.prompt).toContain('size="1,234,567"');
    expect(result.prompt).not.toContain("/nonexistent/path");
  });
});

// ---------------------------------------------------------------------------
// Branch (j): Untrusted-input safety note
// ---------------------------------------------------------------------------
describe("(j) untrusted-input safety note", () => {
  it("appears once at top when any artifact is injected", () => {
    seedArtifact(EXECUTION_ID, { stepId: "s1", key: "a", kind: "json", value: { x: 1 }, sizeBytes: 10 });

    const step = makeStep({ consumesFrom: ["s1"] });
    const result = assemblePrompt({ step, executionId: EXECUTION_ID, userPromptResolved: USER_PROMPT });

    const noteCount = (result.prompt.match(/## Untrusted Input Safety Note/g) ?? []).length;
    expect(noteCount).toBe(1);
    expect(result.prompt.indexOf("## Untrusted Input Safety Note")).toBe(0);
  });

  it("is absent when no artifacts are injected", () => {
    const step = makeStep();
    const result = assemblePrompt({ step, executionId: EXECUTION_ID, userPromptResolved: USER_PROMPT });

    expect(result.prompt).not.toContain("Untrusted Input Safety Note");
    expect(result.prompt).not.toContain("UNTRUSTED_INPUT");
  });

  it("is absent when consumesFromOptional step has no artifact (placeholder only)", () => {
    // Only a no_artifact placeholder → safety note not shown
    const step = makeStep({ consumesFromOptional: ["opt"] });
    const result = assemblePrompt({ step, executionId: EXECUTION_ID, userPromptResolved: USER_PROMPT });

    // The placeholder is self-closing (no content inlined), so safety note should not appear
    expect(result.prompt).not.toContain("## Untrusted Input Safety Note");
    expect(result.prompt).toContain("no_artifact");
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------
describe("edge cases", () => {
  it("step with no dependsOn and no consumesFrom fields → no artifact sections", () => {
    const step = makeStep({ dependsOn: undefined, consumesFrom: undefined, consumesFromOptional: undefined });
    const result = assemblePrompt({ step, executionId: EXECUTION_ID, userPromptResolved: USER_PROMPT });

    expect(result.missingRequired).toEqual([]);
    expect(result.missingOptional).toEqual([]);
    expect(result.truncatedArtifacts).toEqual([]);
    expect(result.prompt).not.toContain("UNTRUSTED_INPUT");
  });

  it("consumesFrom with empty array → no artifact injection", () => {
    const step = makeStep({ consumesFrom: [] });
    const result = assemblePrompt({ step, executionId: EXECUTION_ID, userPromptResolved: USER_PROMPT });

    expect(result.missingRequired).toEqual([]);
    expect(result.prompt).not.toContain("UNTRUSTED_INPUT");
  });

  it("combines persona + outputContract + artifact in correct order", () => {
    seedArtifact(EXECUTION_ID, { stepId: "src", key: "raw", kind: "json", value: { raw: true }, sizeBytes: 20 });

    const step = makeStep({
      consumesFrom: ["src"],
      persona: { speakAs: "Alice", voiceConstraints: "brief" },
      outputContract: { contractRules: [{ kind: "format", value: "text" }] },
    });

    const result = assemblePrompt({ step, executionId: EXECUTION_ID, userPromptResolved: USER_PROMPT });

    const p = result.prompt;
    const upIdx = p.indexOf("## Upstream Artifacts");
    const perIdx = p.indexOf("## Persona");
    const ocIdx = p.indexOf("## Output Contract");
    const tiIdx = p.indexOf("## Task Instruction");

    expect(upIdx).toBeGreaterThan(0);
    expect(perIdx).toBeGreaterThan(upIdx);
    expect(ocIdx).toBeGreaterThan(perIdx);
    expect(tiIdx).toBeGreaterThan(ocIdx);
  });
});

describe("required step output block", () => {
  it("adds a mandatory publication block when outputAs is set", () => {
    const step = makeStep({
      id: "polish",
      outputAs: "最终逐字稿",
    });

    const result = assemblePrompt({ step, executionId: EXECUTION_ID, userPromptResolved: USER_PROMPT });

    expect(result.prompt).toContain("## Required Step Output");
    expect(result.prompt).toContain("Step id: `polish`");
    expect(result.prompt).toContain("Required artifact key: `最终逐字稿`");
    expect(result.prompt).toContain("publish_artifact_file");
    expect(result.prompt).toContain("write_artifact");
    expect(result.prompt).toContain("incomplete until this artifact exists");
    expect(result.prompt).toContain("final assistant response is only a summary");
    // New assertions for strengthened prompt
    expect(result.prompt).toContain("What does NOT count");
    expect(result.prompt).toContain("Workspace writes alone do not register");
    expect(result.prompt).toContain('publish_artifact_file(key="最终逐字稿", sourcePath=');
    expect(result.prompt).toContain("Workspace path constraint");
    expect(result.prompt).toContain("~/.adam/roles/");
  });

  it("does not add the mandatory publication block when outputAs is absent", () => {
    const step = makeStep();
    const result = assemblePrompt({ step, executionId: EXECUTION_ID, userPromptResolved: USER_PROMPT });

    expect(result.prompt).not.toContain("## Required Step Output");
    expect(result.prompt).not.toContain("Required artifact key");
  });
});

// ---------------------------------------------------------------------------
// Branch (e+): customAssertions rendering in Output Contract block
// ---------------------------------------------------------------------------
describe("(e+) customAssertions rendering in Output Contract block", () => {
  it("renders customAssertions as numbered bullets in Output Contract block", () => {
    const step = makeStep({
      outputContract: {
        contractRules: [{ kind: "lengthTarget", min: 100, max: 200, unit: "characters" }],
        customAssertions: ["thesis must be falsifiable", "must cite source"],
      },
    });
    const result = assemblePrompt({ step, executionId: EXECUTION_ID, userPromptResolved: USER_PROMPT });
    expect(result.prompt).toContain("## Output Contract");
    expect(result.prompt).toContain("- Length target: 100-200 characters.");
    expect(result.prompt).toContain("- Assertion 1: thesis must be falsifiable");
    expect(result.prompt).toContain("- Assertion 2: must cite source");
  });

  it("does not render assertion lines when customAssertions absent", () => {
    const step = makeStep({
      outputContract: { contractRules: [{ kind: "format", value: "markdown" }] },
    });
    const result = assemblePrompt({ step, executionId: EXECUTION_ID, userPromptResolved: USER_PROMPT });
    expect(result.prompt).toContain("## Output Contract");
    expect(result.prompt).not.toContain("- Assertion");
  });
});
