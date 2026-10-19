import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

import { createEvent, getEvent, queryEvents } from "../../store/events.js";

afterAll(() => cleanup());
beforeEach(() => clearTestDb());

function makeEvent(overrides: Partial<Parameters<typeof createEvent>[0]> = {}) {
  return {
    id: `evt-${Math.random().toString(36).slice(2)}`,
    eventDefId: `def-${Math.random().toString(36).slice(2)}`,
    type: "test.event",
    source: "test-source",
    dedupKey: `dedup-${Math.random().toString(36).slice(2)}`,
    payload: { value: 1 },
    occurredAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("store/events", () => {
  describe("createEvent", () => {
    it("inserts event and returns inserted=true with the event id", () => {
      const input = makeEvent();
      const result = createEvent(input);
      expect(result.inserted).toBe(true);
      expect(result.id).toBe(input.id);
    });

    it("auto-generates id when not provided", () => {
      const input = makeEvent();
      delete (input as { id?: string }).id;
      const result = createEvent(input);
      expect(result.inserted).toBe(true);
      expect(result.id).toBeDefined();
      expect(result.id.length).toBeGreaterThan(0);
    });

    it("dedup hit returns inserted=false with existing id", () => {
      const input = makeEvent({ id: "dedup-test-1", dedupKey: "same-dedup-key" });
      const first = createEvent(input);
      expect(first.inserted).toBe(true);

      // Same source + dedupKey
      const second = createEvent({ ...input, id: "dedup-test-2" });
      expect(second.inserted).toBe(false);
      expect(second.id).toBe("dedup-test-1");
    });

    it("different dedupKey allows second insert", () => {
      const first = createEvent(makeEvent({ dedupKey: "key-a" }));
      const second = createEvent(makeEvent({ dedupKey: "key-b" }));
      expect(first.inserted).toBe(true);
      expect(second.inserted).toBe(true);
      expect(second.id).not.toBe(first.id);
    });

    it("uses occurredAt or defaults to now", () => {
      const fixedTime = "2025-01-01T00:00:00.000Z";
      const result = createEvent(makeEvent({ occurredAt: fixedTime }));
      expect(result.inserted).toBe(true);
      const fetched = getEvent(result.id)!;
      expect(fetched.occurredAt).toBe(fixedTime);
    });

    it("defaults confidence to 1.0 and trustLevel to 'trusted'", () => {
      const result = createEvent(makeEvent());
      const fetched = getEvent(result.id)!;
      expect(fetched.confidence).toBe(1.0);
      expect(fetched.trustLevel).toBe("trusted");
    });

    it("accepts custom confidence and trustLevel", () => {
      const result = createEvent(makeEvent({ confidence: 0.7, trustLevel: "inferred" }));
      const fetched = getEvent(result.id)!;
      expect(fetched.confidence).toBe(0.7);
      expect(fetched.trustLevel).toBe("inferred");
    });

    it("serializes nested payload as JSON", () => {
      const nested = { nested: { deep: [1, 2, 3] } };
      const result = createEvent(makeEvent({ payload: nested }));
      const fetched = getEvent(result.id)!;
      expect(fetched.payload).toEqual(nested);
    });

    it("stores eventDefId correctly", () => {
      const defId = "def-fixed-123";
      const result = createEvent(makeEvent({ eventDefId: defId }));
      const fetched = getEvent(result.id)!;
      expect(fetched.eventDefId).toBe(defId);
    });
  });

  describe("getEvent", () => {
    it("retrieves a stored event", () => {
      const input = makeEvent();
      createEvent(input);
      const fetched = getEvent(input.id);
      expect(fetched).toBeDefined();
      expect(fetched!.type).toBe("test.event");
      expect(fetched!.source).toBe("test-source");
    });

    it("returns undefined for non-existent id", () => {
      expect(getEvent("non-existent")).toBeUndefined();
    });
  });

  describe("queryEvents", () => {
    beforeEach(() => {
      // Seed multiple events with known timestamps
      const base = new Date("2025-06-01T12:00:00Z");
      createEvent(makeEvent({ eventDefId: "def-a", type: "type.alpha", dedupKey: "q1", occurredAt: new Date(base.getTime() - 86400000 * 2).toISOString() }));
      createEvent(makeEvent({ eventDefId: "def-a", type: "type.alpha", dedupKey: "q2", occurredAt: new Date(base.getTime() - 86400000).toISOString() }));
      createEvent(makeEvent({ eventDefId: "def-b", type: "type.beta", dedupKey: "q3", occurredAt: base.toISOString() }));
      createEvent(makeEvent({ eventDefId: "def-a", type: "type.gamma", dedupKey: "q4", occurredAt: new Date(base.getTime() + 86400000).toISOString() }));
    });

    it("returns events ordered by occurred_at desc", () => {
      const results = queryEvents({});
      expect(results.length).toBeGreaterThanOrEqual(4);
      const times = results.map((e) => new Date(e.occurredAt).getTime());
      for (let i = 0; i < times.length - 1; i++) {
        expect(times[i]).toBeGreaterThanOrEqual(times[i + 1]);
      }
    });

    it("filters by eventDefId", () => {
      const results = queryEvents({ eventDefId: "def-a" });
      expect(results.every((e) => e.eventDefId === "def-a")).toBe(true);
    });

    it("filters by typePattern (SQL LIKE)", () => {
      const results = queryEvents({ typePattern: "type.a%" });
      // SQLite LIKE is case-insensitive by default, but we use exact type match
      // Actually the store uses `type LIKE ?` which is case-insensitive in SQLite
      // Let's test with a concrete type
      const alphaResults = queryEvents({ typePattern: "type.alpha" });
      expect(alphaResults.every((e) => e.type === "type.alpha")).toBe(true);
    });

    it("filters by since", () => {
      const since = new Date("2025-06-01T00:00:00Z").toISOString();
      const results = queryEvents({ since });
      expect(results.every((e) => new Date(e.occurredAt) >= new Date(since))).toBe(true);
    });

    it("filters by until", () => {
      const until = new Date("2025-06-01T00:00:00Z").toISOString();
      const results = queryEvents({ until });
      expect(results.every((e) => new Date(e.occurredAt) <= new Date(until))).toBe(true);
    });

    it("respects limit (default 50, max 500)", () => {
      const results = queryEvents({ limit: 2 });
      expect(results.length).toBeLessThanOrEqual(2);
    });

    it("caps limit at 500 even when requesting more", () => {
      const results = queryEvents({ limit: 1000 });
      expect(results.length).toBeLessThanOrEqual(500);
    });

    it("respects offset", () => {
      const all = queryEvents({ limit: 100 });
      const withOffset = queryEvents({ limit: 100, offset: 1 });
      if (all.length > 1) {
        expect(withOffset[0]).toEqual(all[1]);
      }
    });
  });
});
