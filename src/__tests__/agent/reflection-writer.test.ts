import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";
import { parseCandidates, runReflectionForRole } from "../../agent/reflection.js";
import { listMemoriesByRole, createMemory } from "../../store/memories.js";
import { createRole, getRoleTaskSeq } from "../../store/roles.js";
import { listBeliefsByRole } from "../../store/beliefs.js";
import type { Role, MemoryNode } from "../../shared/types.js";
import type { ConflictVerdict } from "../../agent/conflict-resolver.js";

const { cleanup } = setupTestDb();
vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const haikuMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/llm-eval.js", () => ({
  callClaudeForEvaluation: haikuMock,
}));

const conflictResolverMock = vi.hoisted(() => vi.fn(async (): Promise<ConflictVerdict> => ({ action: "coexist" as const })));
vi.mock("../../agent/conflict-resolver.js", () => ({
  resolveBeliefConflict: conflictResolverMock,
}));

vi.mock("../../lib/embedding.js", () => ({
  generateEmbedding: vi.fn().mockResolvedValue(new Float32Array([0.1, 0.2, 0.3])),
  isModelAvailable: vi.fn().mockReturnValue(true),
}));

vi.mock("../../config/runtime.js", () => ({
  getRuntimeConfig: () => ({
    anthropic: { defaultHaikuModel: "claude-haiku-4-5" },
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

afterAll(() => cleanup());
beforeEach(() => {
  clearTestDb();
  haikuMock.mockReset();
  conflictResolverMock.mockReset();
  conflictResolverMock.mockImplementation(async () => ({ action: "coexist" as const }));
});

function seedRole(id = "r1"): void {
  const role: Role = {
    id,
    name: id,
    cagPrompt: "",
    learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
    memoryStreamId: "stream-" + id,
    status: "active",
    preferences: {},
    createdAt: Date.now(),
  };
  createRole(role);
}

function seedMemory(roleId: string, id: string, content: string, importance = 3): void {
  const mem: MemoryNode = {
    id,
    roleId,
    type: "event",
    content,
    keywords: [],
    importance,
    sourceType: "observation",
    createdAt: Date.now(),
    lastAccessed: Date.now(),
    retrievedCount: 0,
    tier: "episodic",
  };
  createMemory(mem);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("reflection-writer parseCandidates", () => {
  it("parses a valid JSON array", () => {
    const raw = '[{"content":"TTS must pass audibility check","evidence_indices":[1,3]}]';
    const candidates = parseCandidates(raw);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].content).toBe("TTS must pass audibility check");
    expect(candidates[0].evidence_indices).toEqual([1, 3]);
  });

  it("ignores legacy confidence field (v3 cleanup: not part of BeliefCandidate anymore)", () => {
    const raw = '[{"content":"legacy","confidence":1.5,"evidence_indices":[]}]';
    const candidates = parseCandidates(raw);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).not.toHaveProperty("confidence");
  });

  it("returns [] on malformed input", () => {
    expect(parseCandidates("not json")).toEqual([]);
    expect(parseCandidates("")).toEqual([]);
    expect(parseCandidates("[{}]")).toEqual([]); // empty content
    expect(parseCandidates('{"action":"coexist"}')).toEqual([]); // not an array
  });

  it("filters items with empty content", () => {
    const raw = '[{"content":"valid belief","confidence":0.5,"evidence_indices":[0]},{"content":"","confidence":0.5,"evidence_indices":[]}]';
    const candidates = parseCandidates(raw);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].content).toBe("valid belief");
  });
});

describe("reflection-writer runReflectionForRole", () => {
  it("with no observations returns { written: 0 } without calling Haiku", async () => {
    seedRole("r-empty");

    const result = await runReflectionForRole("r-empty");
    expect(result).toEqual({ written: 0 });
    expect(haikuMock).not.toHaveBeenCalled();

    const db = getTestDb();
    const beliefCount = db.prepare("SELECT COUNT(*) as cnt FROM beliefs").get() as { cnt: number };
    expect(beliefCount.cnt).toBe(0);
  });

  it("with Haiku rejection returns { written: 0 } and writes no beliefs", async () => {
    seedRole("r-reject");
    for (let i = 0; i < 5; i++) {
      seedMemory("r-reject", `m${i}`, `Observation ${i} with high importance`, 4);
    }

    haikuMock.mockRejectedValue(new Error("Haiku unavailable"));

    const result = await runReflectionForRole("r-reject");
    expect(result).toEqual({ written: 0 });

    const db = getTestDb();
    const beliefCount = db.prepare("SELECT COUNT(*) as cnt FROM beliefs").get() as { cnt: number };
    expect(beliefCount.cnt).toBe(0);
  });

  it("writes beliefs with evidenceObsIds and does not write legacy memories.type='reflection'", async () => {
    seedRole("r-writer");
    for (let i = 0; i < 5; i++) {
      seedMemory("r-writer", `m${i}`, `Observation ${i} about TTS audio processing`, 4);
    }

    haikuMock.mockResolvedValue(
      JSON.stringify([
        { content: "TTS audio must pass an audibility check before delivery", confidence: 0.8, evidence_indices: [0, 2] },
        { content: "Use base64 encoding for audio artifacts", confidence: 0.7, evidence_indices: [1, 3] },
      ]),
    );

    const result = await runReflectionForRole("r-writer");
    expect(result.written).toBeGreaterThanOrEqual(1);

    const db = getTestDb();
    const beliefs = db.prepare("SELECT * FROM beliefs WHERE role_id = 'r-writer'").all() as Array<{ id: string }>;
    expect(beliefs.length).toBeGreaterThanOrEqual(1);

    // Verify evidenceObsIds are non-empty
    for (const belief of beliefs) {
      const row = db.prepare("SELECT evidence_obs_ids FROM beliefs WHERE id = ?").get(belief.id) as { evidence_obs_ids: string };
      const obsIds = JSON.parse(row.evidence_obs_ids || "[]") as string[];
      expect(obsIds.length).toBeGreaterThan(0);
    }

    // Confirm no legacy memories.type='reflection' rows were written
    const reflectionMemories = db.prepare(
      "SELECT COUNT(*) as cnt FROM memories WHERE role_id = 'r-writer' AND type = 'reflection'"
    ).get() as { cnt: number };
    expect(reflectionMemories.cnt).toBe(0);

    // v81: new beliefs must have status='active'
    const savedBeliefs = db.prepare(
      "SELECT status FROM beliefs WHERE role_id = 'r-writer'"
    ).all() as Array<{ status: string }>;

    for (const b of savedBeliefs) {
      expect(b.status, "new beliefs should be 'active'").toBe("active");
    }

    // Bug #2 regression: lastUsedAt must be role.task_seq (small integer), NOT Date.now() (ms timestamp)
    const seq = getRoleTaskSeq("r-writer");
    const writtenBeliefs = listBeliefsByRole("r-writer");
    expect(writtenBeliefs.length).toBeGreaterThanOrEqual(1);
    for (const written of writtenBeliefs) {
      expect(written.lastUsedAt).toBe(seq);           // must equal role task_seq (small int)
      expect(written.lastUsedAt).toBeLessThan(1000);  // sanity: not a ms timestamp (which is ~1.7e12)
      // DP-001 seed contract: new beliefs start with inject_count=0
      expect(written.injectCount).toBe(0);
      // D-009 seed contract: new beliefs start with status='active'
      expect(written.status).toBe("active");
    }
  });

  it("merge verdict writes a new merged belief and supersedes the target", async () => {
    seedRole("r-merge");
    for (let i = 0; i < 5; i++) {
      seedMemory("r-merge", `mm${i}`, `Observation ${i} about email pipeline`, 4);
    }

    // Pre-seed a target belief the candidate will merge into.
    const targetId = "b-merge-target";
    const { createBelief } = await import("../../store/beliefs.js");
    createBelief({
      id: targetId,
      roleId: "r-merge",
      content: "old: validate email before send",
      isAnti: false,
      evidenceObsIds: [],
      embedding: new Float32Array([0.1, 0.2, 0.3]),
      createdAt: Date.now(),
      lastUsedAt: 0,
      lastValidatedAt: Date.now(),
      status: "active",
      injectCount: 0,
      successEma: 0.5,
    });

    haikuMock.mockResolvedValue(
      JSON.stringify([{ content: "validate and retry email pipeline", evidence_indices: [0, 1] }]),
    );
    conflictResolverMock.mockImplementation(async () => ({
      action: "merge" as const,
      intoBeliefId: targetId,
      mergedContent: "validate, sign, and retry email pipeline",
    }));

    const result = await runReflectionForRole("r-merge");
    expect(result.written).toBeGreaterThanOrEqual(1);

    // Target was superseded
    const { getBelief } = await import("../../store/beliefs.js");
    const target = getBelief(targetId)!;
    expect(target.supersededBy).toBeTruthy();

    // Merged belief follows the v3 + v82 contract
    const merged = getBelief(target.supersededBy!)!;
    expect(merged.content).toBe("validate, sign, and retry email pipeline");
    expect(merged.scopeKey).toBeUndefined();           // post-v82: merged scope = undefined
    expect(merged.status).toBe("active");
    expect(merged.injectCount).toBe(0);
    expect(merged.lastUsedAt).toBe(getRoleTaskSeq("r-merge"));
    expect(merged.lastUsedAt).toBeLessThan(1000);
  });

  it("supersede verdict writes a new belief and supersedes the old (with content from candidate)", async () => {
    seedRole("r-sup");
    for (let i = 0; i < 5; i++) {
      seedMemory("r-sup", `ms${i}`, `Observation ${i} about old workflow`, 4);
    }

    const oldId = "b-old-belief";
    const { createBelief } = await import("../../store/beliefs.js");
    createBelief({
      id: oldId,
      roleId: "r-sup",
      content: "old: always retry 3x on 500",
      isAnti: false,
      evidenceObsIds: [],
      embedding: new Float32Array([0.1, 0.2, 0.3]),
      createdAt: Date.now(),
      lastUsedAt: 0,
      lastValidatedAt: Date.now(),
      status: "active",
      injectCount: 0,
      successEma: 0.5,
    });

    haikuMock.mockResolvedValue(
      JSON.stringify([{ content: "stop retrying on 500 — switch vendor instead", evidence_indices: [0, 1] }]),
    );
    conflictResolverMock.mockImplementation(async () => ({
      action: "supersede" as const,
      oldBeliefId: oldId,
    }));

    const result = await runReflectionForRole("r-sup");
    expect(result.written).toBeGreaterThanOrEqual(1);

    const { getBelief } = await import("../../store/beliefs.js");
    const old = getBelief(oldId)!;
    expect(old.supersededBy).toBeTruthy();

    const newer = getBelief(old.supersededBy!)!;
    expect(newer.content).toBe("stop retrying on 500 — switch vendor instead");
    expect(newer.scopeKey).toBeUndefined();
    expect(newer.status).toBe("active");
    expect(newer.injectCount).toBe(0);
    expect(newer.lastUsedAt).toBe(getRoleTaskSeq("r-sup"));
  });
});
