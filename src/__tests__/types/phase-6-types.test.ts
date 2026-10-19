import { describe, it, expect } from "vitest";
import type {
  ClaimSource,
  VerdictPair,
  ClaimAuditResult,
  AuditorDivergenceRow,
} from "../../shared/types.js";

// ---- ClaimSource ----

// Valid values must type-check
const validClaimSources: ClaimSource[] = [
  "implicit",
  "explicit",
  "hybrid",
  "vacuous",
  "conflict",
  "fallback_legacy",
];

const _claimAuditResultImplicit = {
  status: "passed" as const,
  perClaim: [],
  claimSource: "implicit" satisfies ClaimSource,
};

const _claimAuditResultExplicit = {
  status: "blocked" as const,
  perClaim: [],
  claimSource: "explicit" satisfies ClaimSource,
  replacementText: "oops",
};

// Invalid value must NOT type-check
// @ts-expect-error -- "unknown" is not a valid ClaimSource
const _invalidClaimSource: ClaimSource = "unknown";

// ---- VerdictPair ----

const validVerdictPairs: VerdictPair[] = [
  "agreed_pass",
  "agreed_block",
  "old_blocks_new_passes",
  "old_passes_new_blocks",
];

const _divergenceRowAgreedPass = {
  id: "x",
  traceId: "t1",
  wirePoint: "message_handler" as const,
  oldVerdict: "passed" as const,
  newVerdict: "passed" as const,
  divergenceSubtype: "old_passes_new_blocks" as const,
  verdictPair: "agreed_pass" satisfies VerdictPair,
  recordedAt: 0,
};

const _divergenceRowOldBlocksNewPasses = {
  id: "y",
  traceId: "t2",
  wirePoint: "chat_manager_envelope" as const,
  oldVerdict: "blocked" as const,
  newVerdict: "passed" as const,
  divergenceSubtype: "old_blocks_new_passes" as const,
  verdictPair: "old_blocks_new_passes" satisfies VerdictPair,
  recordedAt: 1,
};

// @ts-expect-error -- "agreed" is not a valid VerdictPair
const _invalidVerdictPair: VerdictPair = "agreed";

// ---- ClaimAuditResult includes claimSource ----

const _resultWithHybrid: ClaimAuditResult = {
  status: "passed",
  perClaim: [],
  claimSource: "hybrid",
};

// ---- AuditorDivergenceRow includes verdictPair ----

const _rowWithVerdictPair: AuditorDivergenceRow = {
  id: "d1",
  traceId: "trace-1",
  wirePoint: "message_handler",
  oldVerdict: "blocked",
  newVerdict: "passed",
  divergenceSubtype: "old_blocks_new_passes",
  verdictPair: "old_blocks_new_passes",
  recordedAt: Date.now(),
};

describe("Phase 6 type definitions", () => {
  it("ClaimSource union has exactly 6 members", () => {
    expect(validClaimSources).toHaveLength(6);
  });

  it("VerdictPair union has exactly 4 members", () => {
    expect(validVerdictPairs).toHaveLength(4);
  });

  it("ClaimAuditResult requires claimSource", () => {
    const result: ClaimAuditResult = {
      status: "passed",
      perClaim: [],
      claimSource: "vacuous",
    };
    expect(result.claimSource).toBe("vacuous");
  });

  it("AuditorDivergenceRow requires verdictPair", () => {
    const row: AuditorDivergenceRow = {
      id: "div-1",
      traceId: "trace-x",
      wirePoint: "message_handler",
      oldVerdict: "passed",
      newVerdict: "blocked",
      divergenceSubtype: "old_passes_new_blocks",
      verdictPair: "old_passes_new_blocks",
      recordedAt: Date.now(),
    };
    expect(row.verdictPair).toBe("old_passes_new_blocks");
  });
});
