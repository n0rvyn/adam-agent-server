/**
 * Task 1-tests (Phase 2): open-questions injection primitive.
 *
 * Symmetric to the existing settlement-optin test (settlement-optin.test.ts):
 *   - step.openLedgerOwner triggers an open-questions block at the top of the
 *     assembled prompt, populated from `findRecentOpenPredictions(owner)`.
 *   - step.openLedgerOwner absent → no open-questions block (zero regression).
 *   - When a step has BOTH settlementLedgerOwner AND openLedgerOwner, the two
 *     blocks must be DISJOINT (no prediction appears in both).
 *
 * The implementation contract: the platform (prompt-assembler) is the only
 * caller of `findRecentOpenPredictions` for the prompt path. These tests
 * exercise the production path through `assemblePrompt`.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";
import { recordPrediction } from "../../agent/belief-ledger.js";
import { assemblePrompt } from "../../scheduler/prompt-assembler.js";
import type { TaskStep } from "../../shared/types.js";

const { cleanup } = setupTestDb();
vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

afterAll(() => cleanup());
beforeEach(() => clearTestDb());

const OWNER = "podcast-show";
const EXEC_ID = "exec-open-questions-1";

function makeStepWithOpenLedger(opts: { openLedgerOwner?: string; settlementLedgerOwner?: string }): TaskStep {
  return {
    id: "step-open-q",
    prompt: "Write today's opening segment.",
    roleId: "writer",
    outputAs: "opening",
    ...(opts.settlementLedgerOwner !== undefined ? { settlementLedgerOwner: opts.settlementLedgerOwner } : {}),
    ...(opts.openLedgerOwner !== undefined ? { openLedgerOwner: opts.openLedgerOwner } : {}),
  };
}

function seedPrediction(claim: string, dateOffsetDays: number): string {
  const pastDate = new Date(Date.now() - dateOffsetDays * 86_400_000)
    .toISOString().slice(0, 10);
  return recordPrediction(OWNER, {
    claim,
    confidence: 0.6,
    falsifyCondition: "f",
    date: pastDate,
  });
}

describe("TaskStep.openLedgerOwner — prompt injection", () => {
  it("injects an open-questions block referencing a recent (today) unsettled prediction", () => {
    const claimText = "iPhone 18 will regain spatial-computing momentum via on-device LLM";
    seedPrediction(claimText, 0); // today

    const step = makeStepWithOpenLedger({ openLedgerOwner: OWNER });
    const result = assemblePrompt({
      step,
      executionId: EXEC_ID,
      userPromptResolved: step.prompt,
    });

    // Header / framing text from buildOpenQuestionsSection
    expect(result.prompt).toMatch(/开放问题/);
    // The claim text must appear verbatim
    expect(result.prompt).toContain(claimText);
  });

  it("does NOT inject an open-questions block when openLedgerOwner is absent (zero regression)", () => {
    seedPrediction("any claim", 0);

    const step: TaskStep = {
      id: "step-no-owner",
      prompt: "Write today's opening segment.",
      roleId: "writer",
      outputAs: "opening",
      // NO openLedgerOwner
    };
    const result = assemblePrompt({
      step,
      executionId: EXEC_ID,
      userPromptResolved: step.prompt,
    });

    expect(result.prompt).not.toContain("开放问题");
  });

  it("does NOT inject when no recent unsettled predictions exist for the owner", () => {
    // Only a 10-day-old prediction (age=10, well past dueDays=3) — must NOT appear in
    // the open-questions block (it belongs to findDuePredictions if we ever set
    // settlementLedgerOwner, but the open block is disjoint by age).
    seedPrediction("old-claim", 10);

    const step = makeStepWithOpenLedger({ openLedgerOwner: OWNER });
    const result = assemblePrompt({
      step,
      executionId: EXEC_ID,
      userPromptResolved: step.prompt,
    });

    expect(result.prompt).not.toContain("开放问题");
    // The old claim must not leak into the open block
    expect(result.prompt).not.toContain("old-claim");
  });
});

describe("TaskStep.openLedgerOwner — disjoint partition from settlementLedgerOwner", () => {
  it("a single step with BOTH owners gets two blocks, and the same prediction does NOT appear in both", () => {
    // A recent (today) prediction → open-questions block
    const recentClaim = "recent-open-claim-disjoint";
    const recentId = seedPrediction(recentClaim, 0);

    // A 5-day-old prediction → settlement block
    const dueClaim = "due-settlement-claim-disjoint";
    const dueId = seedPrediction(dueClaim, 5);

    const step = makeStepWithOpenLedger({
      openLedgerOwner: OWNER,
      settlementLedgerOwner: OWNER,
    });
    const result = assemblePrompt({
      step,
      executionId: EXEC_ID,
      userPromptResolved: step.prompt,
    });

    // Both blocks present
    expect(result.prompt).toContain("开放问题");
    expect(result.prompt).toContain("自我证伪结算");

    // The recent claim appears in the open-questions block, not the settlement block
    expect(result.prompt).toContain(recentClaim);
    expect(result.prompt).toContain(dueClaim);

    // The recent prediction's id must not appear inside the settlement block
    // (i.e. between the settlement header and the open-questions header).
    const settlementIdx = result.prompt.indexOf("自我证伪结算");
    const openIdx = result.prompt.indexOf("开放问题");
    expect(settlementIdx).toBeGreaterThanOrEqual(0);
    expect(openIdx).toBeGreaterThan(settlementIdx);

    // The settlement block (between its header and the open-questions block) must
    // not mention the recent prediction id or claim — disjoint by age.
    const settlementBlock = result.prompt.slice(settlementIdx, openIdx);
    expect(settlementBlock).not.toContain(recentId);
    expect(settlementBlock).not.toContain(recentClaim);

    // The open-questions block (after the open-questions header) must not mention
    // the due prediction id or claim — disjoint by age.
    const openBlock = result.prompt.slice(openIdx);
    expect(openBlock).not.toContain(dueId);
    expect(openBlock).not.toContain(dueClaim);
  });
});
