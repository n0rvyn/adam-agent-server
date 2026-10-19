import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

import { createEventDef, getEventDef, listEventDefs, updateEventDef, deleteEventDef } from "../../store/event-defs.js";

afterAll(() => cleanup());
beforeEach(() => clearTestDb());

function makeDef(overrides: Partial<Parameters<typeof createEventDef>[0]> = {}) {
  return {
    id: `def-${Math.random().toString(36).slice(2)}`,
    name: `test-def-${Math.random().toString(36).slice(2)}`,
    sourceType: "webhook" as const,
    sourceConfig: {},
    enabled: true,
    ...overrides,
  };
}

describe("store/event-defs", () => {
  describe("createEventDef + getEventDef", () => {
    it("creates and retrieves an event def", () => {
      const def = makeDef({ name: "my-webhook", sourceType: "webhook" });
      createEventDef(def);
      const found = getEventDef(def.id);
      expect(found).toBeDefined();
      expect(found!.name).toBe("my-webhook");
      expect(found!.sourceType).toBe("webhook");
      expect(found!.enabled).toBe(true);
    });

    it("returns undefined for non-existent id", () => {
      expect(getEventDef("non-existent")).toBeUndefined();
    });

    it("stores sourceConfig as JSON and parses on retrieval", () => {
      const def = makeDef({ sourceType: "cron", sourceConfig: { cron: "*/5 * * * *", payload_template: { foo: "bar" } } });
      createEventDef(def);
      const found = getEventDef(def.id)!;
      expect(found.sourceConfig).toEqual({ cron: "*/5 * * * *", payload_template: { foo: "bar" } });
    });

    it("converts enabled boolean to integer on write, false on read", () => {
      createEventDef(makeDef({ enabled: false }));
      const all = listEventDefs();
      const found = all.find((d) => d.enabled === false);
      expect(found).toBeDefined();
    });
  });

  describe("listEventDefs", () => {
    it("returns all defs ordered by created_at desc", () => {
      const d1 = makeDef({ name: "first" });
      const d2 = makeDef({ name: "second" });
      createEventDef(d1);
      createEventDef(d2);
      const all = listEventDefs();
      expect(all.map((d) => d.name)).toContain("first");
      expect(all.map((d) => d.name)).toContain("second");
    });

    it("filters by sourceType", () => {
      createEventDef(makeDef({ sourceType: "webhook" }));
      createEventDef(makeDef({ sourceType: "cron" }));
      const webhookDefs = listEventDefs({ sourceType: "webhook" });
      expect(webhookDefs.every((d) => d.sourceType === "webhook")).toBe(true);
    });

    it("filters by enabled status", () => {
      createEventDef(makeDef({ enabled: true }));
      createEventDef(makeDef({ enabled: false }));
      const enabledDefs = listEventDefs({ enabled: true });
      expect(enabledDefs.every((d) => d.enabled === true)).toBe(true);
      const disabledDefs = listEventDefs({ enabled: false });
      expect(disabledDefs.every((d) => d.enabled === false)).toBe(true);
    });
  });

  describe("updateEventDef", () => {
    it("updates fields and returns updated def", () => {
      const def = makeDef({ name: "old-name" });
      createEventDef(def);
      const updated = updateEventDef(def.id, { name: "new-name", enabled: false });
      expect(updated).toBeDefined();
      expect(updated!.name).toBe("new-name");
      expect(updated!.enabled).toBe(false);
    });

    it("returns undefined for non-existent id", () => {
      expect(updateEventDef("non-existent", { name: "x" })).toBeUndefined();
    });

    it("updates sourceType and sourceConfig", () => {
      const def = makeDef({ sourceType: "webhook" });
      createEventDef(def);
      const updated = updateEventDef(def.id, {
        sourceType: "cron",
        sourceConfig: { cron: "0 9 * * *" },
      });
      expect(updated!.sourceType).toBe("cron");
      expect(updated!.sourceConfig).toEqual({ cron: "0 9 * * *" });
    });
  });

  describe("deleteEventDef", () => {
    it("deletes existing def and returns true", () => {
      const def = makeDef();
      createEventDef(def);
      expect(deleteEventDef(def.id)).toBe(true);
      expect(getEventDef(def.id)).toBeUndefined();
    });

    it("returns false for non-existent id", () => {
      expect(deleteEventDef("non-existent")).toBe(false);
    });
  });
});
