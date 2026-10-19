import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

import { listRuntimeEffectsByTrace, recordRuntimeEffect } from "../../store/runtime-effects.js";

afterAll(() => cleanup());
beforeEach(() => clearTestDb());

describe("store/runtime-effects", () => {
  it("records and lists effects by trace", () => {
    const effect = recordRuntimeEffect({
      traceId: "trace-1",
      effectType: "update",
      effectCategory: "template_update",
      entityType: "task_template",
      entityId: "tmpl-1",
      fieldPath: "steps.intro.prompt",
      before: { prompt: "old" },
      after: { prompt: "new" },
      toolName: "update_template",
      createdAt: 1000,
    });
    recordRuntimeEffect({
      traceId: "trace-2",
      effectType: "update",
      effectCategory: "goal_update",
      entityType: "goal",
      entityId: "goal-1",
      createdAt: 2000,
    });

    expect(listRuntimeEffectsByTrace("trace-1")).toEqual([
      expect.objectContaining({
        id: effect.id,
        traceId: "trace-1",
        effectCategory: "template_update",
        entityType: "task_template",
        fieldPath: "steps.intro.prompt",
        before: { prompt: "old" },
        after: { prompt: "new" },
      }),
    ]);
  });
});
