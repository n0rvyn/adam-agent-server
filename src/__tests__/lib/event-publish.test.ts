import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

vi.mock("../../server/events/server-bus.js", () => ({
  serverBus: {
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
  },
}));

import { serverBus } from "../../server/events/server-bus.js";
import { publishEvent } from "../../lib/event-publish.js";
import { queryEvents } from "../../store/events.js";

afterAll(() => cleanup());
beforeEach(() => {
  clearTestDb();
  vi.clearAllMocks();
});

describe("publishEvent", () => {
  it("inserts a new row and emits event_fired", () => {
    const result = publishEvent({
      eventDefId: "def-1",
      type: "test.happy",
      source: "unit-test",
      dedupKey: "key-happy-1",
      payload: { k: "v" },
    });

    expect(result.inserted).toBe(true);
    expect(result.id).toBeDefined();
    expect(serverBus.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "event_fired",
        eventDefId: "def-1",
        eventId: result.id,
        payload: { k: "v" },
      }),
    );
    const events = queryEvents({ eventDefId: "def-1" });
    expect(events).toHaveLength(1);
  });

  it("suppresses emit on dedup (same source + dedup_key)", () => {
    const first = publishEvent({
      eventDefId: "def-2",
      type: "test.dup",
      source: "unit-test",
      dedupKey: "key-dup-1",
      payload: { n: 1 },
    });
    expect(first.inserted).toBe(true);
    vi.clearAllMocks();

    const second = publishEvent({
      eventDefId: "def-2",
      type: "test.dup",
      source: "unit-test",
      dedupKey: "key-dup-1",
      payload: { n: 2 }, // payload differs but dedup still hits
    });

    expect(second.inserted).toBe(false);
    expect(second.id).toBe(first.id);
    expect(serverBus.emit).not.toHaveBeenCalled();
  });

  it("uses emitPayload override when provided", () => {
    const result = publishEvent({
      eventDefId: "def-3",
      type: "test.emit-override",
      source: "unit-test",
      dedupKey: "key-emit-1",
      payload: { stored: true },
      emitPayload: { broadcasted: true },
    });

    expect(result.inserted).toBe(true);
    expect(serverBus.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "event_fired",
        payload: { broadcasted: true },
      }),
    );
    const events = queryEvents({ eventDefId: "def-3" });
    expect(events[0].payload).toEqual({ stored: true });
  });

  it("does NOT emit when eventDefId is absent (source-less event)", () => {
    const result = publishEvent({
      type: "test.no-def",
      source: "unit-test",
      dedupKey: "key-nodef-1",
      payload: {},
    });
    expect(result.inserted).toBe(true);
    expect(serverBus.emit).not.toHaveBeenCalled();
  });
});
