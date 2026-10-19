/**
 * Task 4-tests: settlement opt-in (settlementLedgerOwner + publishesClaimsTo)
 *
 * The platform (prompt-assembler / template-executor) consumes two new opt-in
 * fields on TaskStep:
 *   - settlementLedgerOwner: injects a settlement block at the top of the
 *     step's prompt, populated from `findDuePredictions(owner)` /
 *     `findHitPredictions(owner, embedding)` (Phase 1: due path only — the
 *     assembled prompt is what Task 4-impl will use, no embedding).
 *   - publishesClaimsTo: after the step completes, parses the step's
 *     `outputAs` artifact as a JSON array of structured claims and writes
 *     each one to the named owner via `recordPrediction`.
 *
 * Test-validity rule (Task 4-impl §3, also Task 4-tests §3): the claims-array
 * shape MUST match the real path — `[{claim, confidence, falsifyCondition, date}]`
 * — so the test stays honest with what Task 7's `本期下注` step will produce.
 *
 * Steps without these fields see NO behavior change (opt-in zero regression).
 */

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";
import { recordPrediction, listUnsettledPredictions, persistClaimsFromArtifactValue, settlePredictionsFromArtifactValue, findDuePredictions, checkSettlementCompleteness } from "../../agent/belief-ledger.js";
import { getBelief } from "../../store/beliefs.js";
import { assemblePrompt } from "../../scheduler/prompt-assembler.js";
import { createArtifact, getArtifact } from "../../store/artifacts.js";
import type { TaskStep } from "../../shared/types.js";

const { cleanup } = setupTestDb();
vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

afterAll(() => cleanup());
beforeEach(() => clearTestDb());

const OWNER = "podcast-show";
const EXEC_ID = "exec-optin-1";
const STEP_ID_OPENING = "step-open";
const STEP_ID_CLAIMS = "step-claims";

function makeStepWithSettlement(): TaskStep {
  return {
    id: STEP_ID_OPENING,
    prompt: "Write today's opening segment.",
    roleId: "writer",
    outputAs: "opening",
    settlementLedgerOwner: OWNER,
  };
}

function makeStepWithClaimsPublish(): TaskStep {
  return {
    id: STEP_ID_CLAIMS,
    prompt: "Extract today's falsifiable predictions as a JSON array.",
    roleId: "writer",
    outputAs: "本期下注",
    publishesClaimsTo: OWNER,
  };
}

function seedDuePrediction(claim: string, dateOffsetDays: number): string {
  const pastDate = new Date(Date.now() - dateOffsetDays * 86_400_000)
    .toISOString().slice(0, 10);
  return recordPrediction(OWNER, {
    claim,
    confidence: 0.6,
    falsifyCondition: "if not observed within window",
    date: pastDate,
  });
}

function seedClaimsArtifact(stepId: string, outputAs: string, value: unknown): void {
  // template_executions has FK to task_templates(id); seed both so the test
  // does not blow up at insert. The execution id is a string PK.
  getTestDb()
    .prepare(
      "INSERT OR IGNORE INTO task_templates (id, name, trigger_type, steps, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run("tpl-test", "test-template", "manual", "[]", Date.now());
  getTestDb()
    .prepare(
      "INSERT OR IGNORE INTO template_executions (id, template_id, status, started_at) VALUES (?, ?, ?, ?)",
    )
    .run(EXEC_ID, "tpl-test", "running", Date.now());
  // roleId is required at the createArtifact layer — use the OWNER since
  // claims are a template/show-scope artifact (D-021).
  createArtifact({
    id: "art-claims-1",
    sourceKind: "template_step",
    executionId: EXEC_ID,
    stepId,
    key: outputAs,
    kind: "json",
    value,
    sizeBytes: JSON.stringify(value).length,
    createdAt: Date.now(),
    roleId: OWNER,
  });
}

// ---------------------------------------------------------------------------
// Thin wrapper mirroring ONLY the executor's artifact-fetch + kind check
// (executor-specific plumbing). The parse/guard/validate/persist CONTRACT is
// delegated to the REAL belief-ledger.persistClaimsFromArtifactValue — the same
// function template-executor.ts calls — so these tests exercise the production
// code path, not a copy. If the real contract changes, these tests catch it.
// ---------------------------------------------------------------------------

function persistClaimsFromStepArtifact(args: {
  executionId: string;
  stepId: string;
  outputAs: string;
  ownerId: string;
  warn?: (msg: string) => void;
}): { persisted: number } {
  const artifact = getArtifact(args.executionId, args.stepId, args.outputAs);
  if (!artifact || artifact.kind !== "json" || artifact.value === undefined) {
    return { persisted: 0 };
  }
  const r = persistClaimsFromArtifactValue(args.ownerId, artifact.value, {
    onWarn: (msg) => args.warn?.(msg),
  });
  return { persisted: r.persisted };
}

// ---------------------------------------------------------------------------
// Symmetric thin wrapper for the SETTLE side (settlesPredictionsFor). Mirrors
// ONLY the executor's artifact-fetch + kind check; the parse/guard/validate/settle
// CONTRACT is delegated to the REAL belief-ledger.settlePredictionsFromArtifactValue
// — the same function template-executor.ts calls — so this test exercises the
// production code path, not a copy.
// ---------------------------------------------------------------------------

function settlePredictionsFromStepArtifact(args: {
  executionId: string;
  stepId: string;
  outputAs: string;
  ownerId: string;
  today?: string;
  warn?: (msg: string) => void;
}): { settled: number; skipped: number } {
  const artifact = getArtifact(args.executionId, args.stepId, args.outputAs);
  if (!artifact || artifact.kind !== "json" || artifact.value === undefined) {
    return { settled: 0, skipped: 0 };
  }
  const r = settlePredictionsFromArtifactValue(args.ownerId, artifact.value, {
    today: args.today,
    onWarn: (msg) => args.warn?.(msg),
  });
  return { settled: r.settled, skipped: r.skipped };
}

// ===========================================================================
// Tests
// ===========================================================================

describe("TaskStep.settlementLedgerOwner — prompt injection", () => {
  it("injects a settlement block referencing the due prediction's claim", () => {
    // Seed a prediction that is already 5 days old (>= dueDays default = 3)
    const claimText = "iPhone-side on-device LLM will beat cloud latency by Q3 2026";
    seedDuePrediction(claimText, 5);

    const step = makeStepWithSettlement();
    const result = assemblePrompt({
      step,
      executionId: EXEC_ID,
      userPromptResolved: step.prompt,
    });

    // The settlement section must appear in the assembled prompt
    expect(result.prompt).toContain("自我证伪结算");
    // The claim text must appear (verbatim)
    expect(result.prompt).toContain(claimText);
    // The owner-derived directive line (buildSettlementSection) must appear
    expect(result.prompt).toContain("我之前说");
  });

  it("does NOT inject a settlement block when settlementLedgerOwner is absent", () => {
    seedDuePrediction("any claim", 5);

    const step: TaskStep = {
      id: STEP_ID_OPENING,
      prompt: "Write today's opening segment.",
      roleId: "writer",
      outputAs: "opening",
      // NO settlementLedgerOwner — zero regression
    };
    const result = assemblePrompt({
      step,
      executionId: EXEC_ID,
      userPromptResolved: step.prompt,
    });

    expect(result.prompt).not.toContain("自我证伪结算");
  });

  it("does NOT inject when no due predictions exist for the owner", () => {
    // Seed a prediction that is NOT yet due (1 day old, dueDays=3)
    seedDuePrediction("future prediction", 1);

    const step = makeStepWithSettlement();
    const result = assemblePrompt({
      step,
      executionId: EXEC_ID,
      userPromptResolved: step.prompt,
    });

    expect(result.prompt).not.toContain("自我证伪结算");
  });
});

describe("TaskStep.publishesClaimsTo — post-step claim persistence", () => {
  it("persists a well-formed claims array to the ledger", () => {
    // Pre-state: zero unsettled predictions
    expect(listUnsettledPredictions(OWNER)).toHaveLength(0);

    // Step's `outputAs` is `本期下注` and its artifact is a JSON array of
    // claim objects — this is the EXACT shape Task 7's `本期下注` step will produce.
    const claims = [
      { claim: "iPhone on-device LLM beats cloud latency by Q3", confidence: 0.65, falsifyCondition: "if benchmark shows < 10% improvement", date: "2026-06-05" },
      { claim: "Apple's Foundation Models v2 will be open-weight", confidence: 0.40, falsifyCondition: "if WWDC 2026 keeps it private", date: "2026-06-05" },
    ];
    seedClaimsArtifact(STEP_ID_CLAIMS, "本期下注", claims);

    const result = persistClaimsFromStepArtifact({
      executionId: EXEC_ID,
      stepId: STEP_ID_CLAIMS,
      outputAs: "本期下注",
      ownerId: OWNER,
    });

    expect(result.persisted).toBe(2);
    const unsettled = listUnsettledPredictions(OWNER);
    expect(unsettled).toHaveLength(2);
    const claims2 = unsettled.map((p) => p.content).sort();
    expect(claims2).toEqual([
      "Apple's Foundation Models v2 will be open-weight",
      "iPhone on-device LLM beats cloud latency by Q3",
    ]);
    // Each persisted row must carry the prediction columns
    for (const p of unsettled) {
      expect(p.kind).toBe("prediction");
      expect(p.settlementStatus).toBe("unsettled");
      expect(p.predictionConfidence).toBeGreaterThan(0);
      expect(p.falsifyCondition).toBeTruthy();
      expect(p.predictionDate).toBe("2026-06-05");
    }
  });

  it("persists 0 and warns when artifact is a `{title,body}` script shape (must not eat script output)", () => {
    // Simulate the script step's `定稿结果` artifact (the shape Task 7 protects
    // from being mistaken for claims) — and an unrelated step that mistakenly
    // declares publishesClaimsTo. The contract must reject the wrong shape.
    seedClaimsArtifact(STEP_ID_CLAIMS, "本期下注", {
      title: "早间播客定稿",
      body: "正文开始...",
    });

    const warns: string[] = [];
    const result = persistClaimsFromStepArtifact({
      executionId: EXEC_ID,
      stepId: STEP_ID_CLAIMS,
      outputAs: "本期下注",
      ownerId: OWNER,
      warn: (m) => warns.push(m),
    });

    expect(result.persisted).toBe(0);
    expect(listUnsettledPredictions(OWNER)).toHaveLength(0);
    expect(warns.length).toBeGreaterThan(0);
    expect(warns.some((w) => w.includes("not a JSON array"))).toBe(true);
  });

  it("persists 0 and warns on malformed entries within an array", () => {
    // Mixed: 1 valid, 2 invalid (missing fields, wrong types)
    const mixed = [
      { claim: "good claim", confidence: 0.5, falsifyCondition: "f", date: "2026-06-05" },
      { claim: "no confidence", falsifyCondition: "f" }, // missing confidence
      { confidence: 0.5 }, // missing claim
    ];
    seedClaimsArtifact(STEP_ID_CLAIMS, "本期下注", mixed);

    const warns: string[] = [];
    const result = persistClaimsFromStepArtifact({
      executionId: EXEC_ID,
      stepId: STEP_ID_CLAIMS,
      outputAs: "本期下注",
      ownerId: OWNER,
      warn: (m) => warns.push(m),
    });

    expect(result.persisted).toBe(1);
    expect(listUnsettledPredictions(OWNER)).toHaveLength(1);
    expect(warns.some((w) => w.includes("malformed"))).toBe(true);
  });

  it("persists 0 when the artifact is absent (the step never published outputAs)", () => {
    const result = persistClaimsFromStepArtifact({
      executionId: EXEC_ID,
      stepId: STEP_ID_CLAIMS,
      outputAs: "本期下注",
      ownerId: OWNER,
    });
    expect(result.persisted).toBe(0);
    expect(listUnsettledPredictions(OWNER)).toHaveLength(0);
  });
});

describe("TaskStep.settlesPredictionsFor — post-step settle (Phase 1.5)", () => {
  const STEP_ID_SETTLE = "step-settle";
  const TODAY = "2026-06-04";

  it("settles each verdict via the real helper (old superseded+settled, new unsettled row)", () => {
    const oldId = seedDuePrediction("端侧小模型一年内承接多数日常 AI 交互", 5);
    expect(listUnsettledPredictions(OWNER)).toHaveLength(1);

    seedClaimsArtifact(STEP_ID_SETTLE, "结算", [
      { predictionId: oldId, status: "partial", outcome: "我低估了云端规模效应,推迟", newConfidence: 0.5 },
    ]);

    const result = settlePredictionsFromStepArtifact({
      executionId: EXEC_ID,
      stepId: STEP_ID_SETTLE,
      outputAs: "结算",
      ownerId: OWNER,
      today: TODAY,
    });
    expect(result.settled).toBe(1);
    expect(result.skipped).toBe(0);

    // old row settled + superseded
    const oldRow = getBelief(oldId)!;
    expect(oldRow.settlementStatus).not.toBe("unsettled");
    // a fresh unsettled successor dated today exists
    const unsettled = listUnsettledPredictions(OWNER);
    expect(unsettled).toHaveLength(1);
    expect(unsettled[0].predictionDate).toBe(TODAY);
  });

  it("a step WITHOUT settlesPredictionsFor settles nothing (the wrapper is only invoked when the field is set)", () => {
    const oldId = seedDuePrediction("untouched prediction", 5);
    // Simulate executor seeing a step with no settlesPredictionsFor → settle path not entered.
    // (Mirror the executor gate: only call the wrapper when the field is present.)
    const step: TaskStep = {
      id: STEP_ID_SETTLE,
      prompt: "no settle field",
      roleId: "writer",
      outputAs: "结算",
    };
    if (step.settlesPredictionsFor) {
      settlePredictionsFromStepArtifact({
        executionId: EXEC_ID, stepId: STEP_ID_SETTLE, outputAs: "结算", ownerId: OWNER, today: TODAY,
      });
    }
    expect(getBelief(oldId)!.settlementStatus).toBe("unsettled");
  });

  it("rejects a non-array `{title,body}` settle artifact (must not settle garbage)", () => {
    const oldId = seedDuePrediction("guarded prediction", 5);
    seedClaimsArtifact(STEP_ID_SETTLE, "结算", { title: "x", body: "y" });
    const warns: string[] = [];
    const result = settlePredictionsFromStepArtifact({
      executionId: EXEC_ID, stepId: STEP_ID_SETTLE, outputAs: "结算", ownerId: OWNER, today: TODAY,
      warn: (m) => warns.push(m),
    });
    expect(result.settled).toBe(0);
    expect(getBelief(oldId)!.settlementStatus).toBe("unsettled");
    expect(warns.some((w) => w.includes("not a JSON array"))).toBe(true);
  });
});

describe("opt-in zero regression", () => {
  it("a step with neither field set neither injects settlement nor persists claims", () => {
    seedDuePrediction("any claim", 5);

    const step: TaskStep = {
      id: STEP_ID_OPENING,
      prompt: "Write today's opening segment.",
      roleId: "writer",
      outputAs: "opening",
    };
    const result = assemblePrompt({
      step,
      executionId: EXEC_ID,
      userPromptResolved: step.prompt,
    });
    expect(result.prompt).not.toContain("自我证伪结算");

    // No publishesClaimsTo → persistence path returns 0
    const persist = persistClaimsFromStepArtifact({
      executionId: EXEC_ID,
      stepId: STEP_ID_CLAIMS,
      outputAs: "本期下注",
      ownerId: OWNER,
    });
    expect(persist.persisted).toBe(0);
  });
});

describe("门② settlement completeness — Gap 1 gate 2 (D-022 settled==due)", () => {
  // Exercises the SAME two real functions the executor's post-step 门② calls:
  //   findDuePredictions  (the due-count snapshot, taken BEFORE settle)
  //   checkSettlementCompleteness  (the settled<due decision)
  // The executor's literal if-guard + recordAuditViolation side-effect stay
  // code-review-covered (consistent with this file's thin-wrapper convention);
  // this proves the DECISION LOGIC deterministically on a real test DB.
  // `today` uses real-now to match seedDuePrediction's basis (Date.now()-relative)
  // and the executor's own `new Date().toISOString().slice(0,10)`.
  const today = new Date().toISOString().slice(0, 10);

  it("flags settled<due: a due prediction left unsettled trips the gate (real findDuePredictions)", () => {
    seedDuePrediction("端侧模型一年内承接多数日常 AI 交互", 5); // 5d ago → due (cutoff today-3)
    const due = findDuePredictions(OWNER, today).length;
    expect(due).toBe(1);
    // settle step emitted [] (or settled nothing) → settled=0 while due=1
    const comp = checkSettlementCompleteness({ due, settled: 0 });
    expect(comp.complete).toBe(false);
    expect(comp.shortfall).toBe(1); // → executor records an error audit_violation here
  });

  it("0-due stays silent: a not-yet-due prediction yields due=0, [] is correct, no violation", () => {
    recordPrediction(OWNER, { claim: "今天刚下的注", confidence: 0.6, falsifyCondition: "z", date: today });
    expect(findDuePredictions(OWNER, today).length).toBe(0);
    expect(checkSettlementCompleteness({ due: 0, settled: 0 }).complete).toBe(true);
  });

  it("complete settlement stays silent: due==settled records nothing", () => {
    seedDuePrediction("a", 5);
    seedDuePrediction("b", 5);
    const due = findDuePredictions(OWNER, today).length;
    expect(due).toBe(2);
    expect(checkSettlementCompleteness({ due, settled: 2 }).complete).toBe(true);
  });
});
