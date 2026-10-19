import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

import { writeDivergenceLog, listDivergenceLog } from "../../store/auditor-divergence.js";

afterAll(() => cleanup());
beforeEach(() => clearTestDb());

describe("auditor-divergence", () => {
  it("same verdict → returns id, row written with agreed_pass verdict_pair (Phase 6 always-write)", () => {
    const traceId = "trace-same-pass";
    const result = writeDivergenceLog({
      traceId,
      wirePoint: "message_handler",
      oldVerdict: "passed",
      newVerdict: "passed",
    });
    expect(result).not.toBeNull();
    const rows = listDivergenceLog({ traceId });
    expect(rows).toHaveLength(1);
    expect(rows[0].verdictPair).toBe("agreed_pass");
  });

  it("old=blocked, new=passed → subtype old_blocks_new_passes, row written", () => {
    const traceId = "trace-old-blocks";
    const id = writeDivergenceLog({
      traceId,
      wirePoint: "message_handler",
      oldVerdict: "blocked",
      newVerdict: "passed",
      oldReplacementText: "blocked replacement",
    });
    expect(id).not.toBeNull();
    const rows = listDivergenceLog({ traceId });
    expect(rows).toHaveLength(1);
    expect(rows[0].divergenceSubtype).toBe("old_blocks_new_passes");
    expect(rows[0].oldVerdict).toBe("blocked");
    expect(rows[0].newVerdict).toBe("passed");
    expect(rows[0].wirePoint).toBe("message_handler");
    expect(rows[0].oldReplacementText).toBe("blocked replacement");
  });

  it("old=passed, new=blocked → subtype old_passes_new_blocks, row written", () => {
    const traceId = "trace-new-blocks";
    const id = writeDivergenceLog({
      traceId,
      wirePoint: "chat_manager_envelope",
      oldVerdict: "passed",
      newVerdict: "blocked",
      newReplacementText: "new blocked replacement",
    });
    expect(id).not.toBeNull();
    const rows = listDivergenceLog({ traceId });
    expect(rows).toHaveLength(1);
    expect(rows[0].divergenceSubtype).toBe("old_passes_new_blocks");
    expect(rows[0].wirePoint).toBe("chat_manager_envelope");
    expect(rows[0].newReplacementText).toBe("new blocked replacement");
  });

  it("listDivergenceLog({ traceId }) filters correctly", () => {
    const trace1 = "trace-filter-1";
    const trace2 = "trace-filter-2";
    writeDivergenceLog({ traceId: trace1, wirePoint: "message_handler", oldVerdict: "blocked", newVerdict: "passed" });
    writeDivergenceLog({ traceId: trace2, wirePoint: "message_handler", oldVerdict: "passed", newVerdict: "blocked" });

    const filtered = listDivergenceLog({ traceId: trace1 });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].traceId).toBe(trace1);
  });

  it("listDivergenceLog({ subtype }) filters correctly", () => {
    const trace1 = "trace-subtype-1";
    const trace2 = "trace-subtype-2";
    writeDivergenceLog({ traceId: trace1, wirePoint: "message_handler", oldVerdict: "blocked", newVerdict: "passed" });
    writeDivergenceLog({ traceId: trace2, wirePoint: "message_handler", oldVerdict: "passed", newVerdict: "blocked" });

    const filtered = listDivergenceLog({ subtype: "old_blocks_new_passes" });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].divergenceSubtype).toBe("old_blocks_new_passes");
  });

  it("indexes exist (PRAGMA index_list)", () => {
    const db = getTestDb();
    const indexes = db.prepare("PRAGMA index_list(auditor_divergence_log)").all() as Array<{ name: string }>;
    expect(indexes.length).toBeGreaterThanOrEqual(3);
    const indexNames = indexes.map((r) => r.name);
    expect(indexNames.some((n) => n.includes("trace"))).toBe(true);
    expect(indexNames.some((n) => n.includes("subtype"))).toBe(true);
    expect(indexNames.some((n) => n.includes("session"))).toBe(true);
  });
});
