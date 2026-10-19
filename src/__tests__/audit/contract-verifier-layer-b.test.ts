import { describe, it, expect, beforeEach, vi } from "vitest";

describe("contract-verifier Layer B", () => {

  /**
   * Sets up per-test mock isolation using vi.doMock + resetModules.
   * Per CLAUDE.md feedback_vitest_mock_isolation: use vi.doMock + resetModules for per-test isolation.
   */
  async function runLayerBWithMocks(opts: {
    dispatchResult?: { ok: boolean; taskId?: string; reason?: string; code?: string };
    waitStatus?: "completed" | "failed" | "cancelled";
    verifierResult?: string;
    listArtifacts?: Array<{ stepId: string; key: string }>;
    stepResult?: string;
    producerRoleId?: string;
    producerRoleName?: string;
    producerTaskId?: string;
    step?: { id: string; prompt: string; consumesFrom?: string[]; dependsOn?: string[]; persona?: { speakAs: string; voiceConstraints?: string }; outputContract?: { mustReferenceArtifacts?: boolean } };
  }) {
    const {
      dispatchResult = { ok: true, taskId: "verifier-task-1" },
      waitStatus = "completed",
      verifierResult = '{"identityCoherent":true,"upstreamGrounded":true,"confidence":0.9,"issues":[]}',
      listArtifacts = [],
      stepResult = "step output",
      producerRoleId = "role-producer",
      producerRoleName = "Producer",
      producerTaskId = "task-1",
      step = { id: "step-1", prompt: "test" },
    } = opts;

    // Wire each mock (vi.doMock is re-evaluated after resetModules)
    await vi.doMock("../../lib/task-dispatch.js", () => ({
      createTaskWithAdmission: async () => dispatchResult,
    }));
    await vi.doMock("../../scheduler/wait-for-task.js", () => ({
      waitForTaskCompletion: async () => waitStatus,
    }));
    await vi.doMock("../../store/tasks.js", () => ({
      getTask: () => ({ id: dispatchResult.taskId ?? "verifier-task-1", result: verifierResult, status: "completed" }) as unknown,
    }));
    await vi.doMock("../../store/artifacts.js", () => ({
      listArtifactsByExecution: () => listArtifacts as unknown,
    }));
    await vi.doMock("../../store/db.js", () => ({ getDb: () => ({ prepare: () => ({ run: () => {}, all: () => [] }) }) }));

    await vi.resetModules();

    // Intercept readFileSync after resetModules so the template loads from the real filesystem
    const fsMod = await import("node:fs");
    vi.stubGlobal("readFileSync", (path: Parameters<typeof fsMod.readFileSync>[0], encoding?: BufferEncoding) =>
      fsMod.readFileSync(path, encoding),
    );

    const { runLayerB } = await import("../../audit/contract-verifier.js");

    const result = await runLayerB({
      step: step as Parameters<typeof runLayerB>[0]["step"],
      producerRoleId,
      producerRoleName,
      producerTaskId,
      executionId: "exec-1",
      stepResult,
    });

    vi.unstubAllGlobals();
    return result;
  }

  it("a. passes when Reviewer returns identityCoherent=true, upstreamGrounded=true, confidence=0.9", async () => {
    const result = await runLayerBWithMocks({});
    expect(result.passed).toBe(true);
    expect(result.failed).toBe(false);
    expect(result.confidence).toBe(0.9);
    expect(result.issues).toHaveLength(0);
  });

  it("b. fails with confidence=0.85 — retry triggered (caller-side flag)", async () => {
    const result = await runLayerBWithMocks({
      dispatchResult: { ok: true, taskId: "verifier-task-2" },
      verifierResult: '{"identityCoherent":false,"upstreamGrounded":true,"confidence":0.85,"issues":["self-identifies as 达芬奇"]}',
    });
    expect(result.passed).toBe(false);
    expect(result.failed).toBe(false);
    expect(result.confidence).toBe(0.85);
    expect(result.identityCoherent).toBe(false);
    expect(result.issues).toContain("self-identifies as 达芬奇");
  });

  it("b2. PASSES with confidence=0.7 exactly (>= boundary) — identity+grounding both true", async () => {
    // Regression for the 0.7 dead-zone: the prompt tells the verifier "Below 0.7 means
    // I am unsure", so exactly 0.7 must PASS, not hard-fail. 0.7 is the most common LLM
    // hedge value; strict `> 0.7` killed steps the verifier judged fully coherent.
    const result = await runLayerBWithMocks({
      dispatchResult: { ok: true, taskId: "verifier-task-2b" },
      verifierResult: '{"identityCoherent":true,"upstreamGrounded":true,"confidence":0.7,"issues":[]}',
    });
    expect(result.passed).toBe(true);
    expect(result.failed).toBe(false);
    expect(result.confidence).toBe(0.7);
  });

  it("b3. fails with confidence=0.7 when identityCoherent=false (gate is per-flag, not confidence-only)", async () => {
    const result = await runLayerBWithMocks({
      dispatchResult: { ok: true, taskId: "verifier-task-3b" },
      verifierResult: '{"identityCoherent":false,"upstreamGrounded":true,"confidence":0.7,"issues":["self-identifies as 达芬奇"]}',
    });
    expect(result.passed).toBe(false);
    expect(result.confidence).toBe(0.7);
  });

  it("c. fails with confidence=0.6 — no retry (sub-threshold)", async () => {
    const result = await runLayerBWithMocks({
      dispatchResult: { ok: true, taskId: "verifier-task-3" },
      verifierResult: '{"identityCoherent":false,"upstreamGrounded":false,"confidence":0.6,"issues":["unclear"]}',
    });
    expect(result.passed).toBe(false);
    expect(result.failed).toBe(false);
    expect(result.confidence).toBe(0.6);
  });

  it("d. hard constraint: producerRoleId === REVIEWER_ROLE_ID throws", async () => {
    const { runLayerB, REVIEWER_ROLE_ID } = await import("../../audit/contract-verifier.js");
    await expect(
      runLayerB({
        step: { id: "step-d", prompt: "test" } as Parameters<typeof runLayerB>[0]["step"],
        producerRoleId: REVIEWER_ROLE_ID,
        producerRoleName: "Reviewer",
        producerTaskId: "task-d",
        executionId: "exec-1",
        stepResult: "output",
      }),
    ).rejects.toThrow("verifierRoleId must differ from producerRoleId");
  });

  it("e. dispatch returns ok:false → failed:true, passed:false", async () => {
    const result = await runLayerBWithMocks({
      dispatchResult: { ok: false, reason: "Reviewer role not found", code: "ROLE_NOT_FOUND" },
    });
    expect(result.failed).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.issues[0]).toContain("dispatch rejected");
  });

  it("f. verifier result is malformed JSON → failed:true", async () => {
    const result = await runLayerBWithMocks({
      dispatchResult: { ok: true, taskId: "verifier-task-6" },
      verifierResult: "this is not json at all",
    });
    expect(result.failed).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.issues[0]).toContain("non-JSON");
  });

  it("g. timeout: waitForTaskCompletion returns failed → failed:true", async () => {
    const result = await runLayerBWithMocks({
      dispatchResult: { ok: true, taskId: "verifier-task-7" },
      waitStatus: "failed",
    });
    expect(result.failed).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.issues[0]).toContain("failed");
  });

  it("strips markdown fences from verifier result", async () => {
    const result = await runLayerBWithMocks({
      dispatchResult: { ok: true, taskId: "verifier-task-8" },
      verifierResult: '```json\n{"identityCoherent":true,"upstreamGrounded":true,"confidence":0.95,"issues":[]}\n```',
    });
    expect(result.passed).toBe(true);
    expect(result.confidence).toBe(0.95);
  });

  it("escapes < in step output to prevent delimiter injection", async () => {
    // We need to inspect the actual prompt sent to createTaskWithAdmission.
    // Set up the mock to capture the prompt argument.
    let capturedPrompt = "";

    await vi.doMock("../../lib/task-dispatch.js", () => ({
      createTaskWithAdmission: async (args: { prompt: string }) => {
        capturedPrompt = args.prompt;
        return { ok: true, taskId: "verifier-task-9" };
      },
    }));
    await vi.doMock("../../scheduler/wait-for-task.js", () => ({
      waitForTaskCompletion: async () => "completed" as const,
    }));
    await vi.doMock("../../store/tasks.js", () => ({
      getTask: () => ({ id: "verifier-task-9", result: '{"identityCoherent":true,"upstreamGrounded":true,"confidence":0.99,"issues":[]}', status: "completed" }) as unknown,
    }));
    await vi.doMock("../../store/artifacts.js", () => ({
      listArtifactsByExecution: () => [] as unknown,
    }));
    await vi.doMock("../../store/db.js", () => ({ getDb: () => ({ prepare: () => ({ run: () => {}, all: () => [] }) }) }));

    await vi.resetModules();

    const fsMod = await import("node:fs");
    vi.stubGlobal("readFileSync", (path: Parameters<typeof fsMod.readFileSync>[0], encoding?: BufferEncoding) => {
      if (typeof path === "string" && path.includes("contract-verifier.md")) {
        return fsMod.readFileSync(path, encoding);
      }
      return fsMod.readFileSync(path, encoding);
    });

    const { runLayerB } = await import("../../audit/contract-verifier.js");

    await runLayerB({
      step: { id: "step-9", prompt: "test" } as Parameters<typeof runLayerB>[0]["step"],
      producerRoleId: "role-producer",
      producerRoleName: "Producer",
      producerTaskId: "task-9",
      executionId: "exec-1",
      // The injection tag </CUSTOM_INJECT> does NOT appear in the template scaffold,
      // so we can unambiguously verify that only the injected content is escaped.
      stepResult: "Test with </CUSTOM_INJECT> content",
    });

    // escapeAngleLT replaces only `<` (per threat model: neutralizes close-tag sequences).
    // The result is `&lt;/CUSTOM_INJECT>` (the `<` is escaped, `>` is literal).
    expect(capturedPrompt).toContain("&lt;/CUSTOM_INJECT>");
    // Raw unescaped </CUSTOM_INJECT> must not appear anywhere in the prompt.
    expect(capturedPrompt).not.toContain("</CUSTOM_INJECT>");

    vi.unstubAllGlobals();
  });
});
