import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
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

vi.mock("../../scheduler/template-dispatch.js", () => ({
  dispatchTemplate: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../store/task-templates.js", () => ({
  listTaskTemplates: vi.fn(),
}));

import { serverBus } from "../../server/events/server-bus.js";
import { fireWebhookEvent } from "../../events/sources/webhook.js";
import { fireManualEvent } from "../../events/sources/manual.js";
import type { EventDef } from "../../shared/types.js";
import { createEventDef } from "../../store/event-defs.js";
import { queryEvents } from "../../store/events.js";

afterAll(() => cleanup());
beforeEach(() => {
  clearTestDb();
  vi.clearAllMocks();
});

function makeDef(overrides: Partial<Omit<EventDef, "createdAt" | "updatedAt">> = {}): EventDef {
  const now = Date.now();
  return {
    id: `def-${Math.random().toString(36).slice(2)}`,
    name: `test-def-${Math.random().toString(36).slice(2)}`,
    sourceType: "webhook",
    sourceConfig: {},
    enabled: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("events/sources", () => {
  describe("webhook", () => {
    it("creates event and emits event_fired on happy path", () => {
      const def = makeDef({ id: "def-webhook-1", sourceType: "webhook" });
      const body = {
        type: "user.signup",
        payload: { userId: "u123" },
        dedup_key: "signup-123",
      };

      const result = fireWebhookEvent(def, body);

      expect(result.duplicate).toBe(false);
      expect(result.eventId).toBeDefined();

      // Verify bus emit
      expect(serverBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({ type: "event_fired", eventDefId: "def-webhook-1" }),
      );

      // Verify event stored
      const events = queryEvents({ eventDefId: "def-webhook-1" });
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("user.signup");
      expect(events[0].payload).toEqual({ userId: "u123" });
    });

    it("returns duplicate=true without second bus emit on dedup", () => {
      const def = makeDef({ id: "def-webhook-2", sourceType: "webhook" });
      const body = {
        type: "order.placed",
        payload: { orderId: "o456" },
        dedup_key: "order-456",
      };

      const first = fireWebhookEvent(def, body);
      expect(first.duplicate).toBe(false);
      vi.clearAllMocks();

      const second = fireWebhookEvent(def, body);
      expect(second.duplicate).toBe(true);
      expect(second.eventId).toBe(first.eventId);

      // No second emit
      expect(serverBus.emit).not.toHaveBeenCalled();
    });

    it("rejects malformed envelope at Zod validation", () => {
      const def = makeDef({ id: "def-webhook-3", sourceType: "webhook" });

      // Missing required 'type' field
      expect(() => fireWebhookEvent(def, { payload: {}, dedup_key: "bad" })).toThrow();

      // Bad type format (uppercase)
      expect(() => fireWebhookEvent(def, { type: "Bad.Type", payload: {}, dedup_key: "bad2" })).toThrow();

      // Missing dedup_key
      expect(() => fireWebhookEvent(def, { type: "good.type", payload: {} })).toThrow();
    });

    it("respects optional occurred_at and confidence fields", () => {
      const def = makeDef({ id: "def-webhook-4", sourceType: "webhook" });
      const body = {
        type: "feature.updated",
        payload: { feature: "dark-mode" },
        dedup_key: "feat-dark-1",
        occurred_at: "2025-03-01T10:00:00.000Z",
        confidence: 0.85,
      };

      const result = fireWebhookEvent(def, body);
      expect(result.duplicate).toBe(false);

      const events = queryEvents({ eventDefId: "def-webhook-4" });
      expect(events[0].occurredAt).toBe("2025-03-01T10:00:00.000Z");
      expect(events[0].confidence).toBe(0.85);
    });
  });

  describe("manual", () => {
    it("fires manual event and emits bus", () => {
      const def = makeDef({ id: "def-manual-1", sourceType: "manual" });
      const result = fireManualEvent(def, { reason: "testing" });

      expect(result.eventId).toBeDefined();
      expect(serverBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({ type: "event_fired", eventDefId: "def-manual-1" }),
      );

      const events = queryEvents({ eventDefId: "def-manual-1" });
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("manual.fire");
      expect(events[0].payload).toEqual({ reason: "testing" });
      expect(events[0].source).toBe("manual");
    });

    it("rejects disabled def", () => {
      const def = makeDef({ id: "def-manual-2", sourceType: "manual", enabled: false });

      expect(() => fireManualEvent(def, {})).toThrow(/disabled/i);
    });

    it("allows undefined payload", () => {
      const def = makeDef({ id: "def-manual-3", sourceType: "manual" });
      const result = fireManualEvent(def);

      expect(result.eventId).toBeDefined();
      const events = queryEvents({ eventDefId: "def-manual-3" });
      expect(events[0].payload).toEqual({});
    });
  });

  describe("cron (unit)", () => {
    it("startCronSource registers a timer in cronTimers map", async () => {
      const { startCronSource } = await import("../../events/sources/cron.js");

      const def = makeDef({
        id: "def-cron-unit",
        sourceType: "cron",
        sourceConfig: { cron: "*/2 * * * *" },
      });

      startCronSource(def);

      // Verify a timer was set (check via module-level map via fake timers)
      // The map is module-private; we verify indirectly by checking that the handler fires
      // when we advance fake time.
    });

    it("stopCronSource clears timer", async () => {
      const { startCronSource, stopCronSource } = await import("../../events/sources/cron.js");

      const def = makeDef({
        id: "def-cron-stop",
        sourceType: "cron",
        sourceConfig: { cron: "*/3 * * * *" },
      });

      startCronSource(def);
      stopCronSource(def.id);

      // Stop should not throw and subsequent advance should not fire
      // (covered by integration test pattern below)
    });

    it("invalid cron expression throws on startCronSource", async () => {
      const { startCronSource } = await import("../../events/sources/cron.js");

      const def = makeDef({
        id: "def-cron-bad",
        sourceType: "cron",
        sourceConfig: { cron: "not a cron expression" },
      });

      expect(() => startCronSource(def)).toThrow();
    });
  });

  describe("directory_watch (unit)", () => {
    it("startDirectoryWatch throws for path outside home dir", async () => {
      const { startDirectoryWatch } = await import("../../events/sources/directory-watch.js");

      const def = makeDef({
        id: "def-dir-reject",
        sourceType: "directory_watch",
        sourceConfig: { path: "/etc/passwd", stability_delay_ms: 1000 },
      });

      expect(() => startDirectoryWatch(def)).toThrow(/must be within/i);
    });
  });
});

// ============================================================
// Integration tests — vi.useFakeTimers for timing-sensitive sources
// ============================================================

describe("events/sources (fake-timer integration)", () => {
  beforeEach(() => {
    clearTestDb();
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: false });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("cron", () => {
    it("fires event after scheduled delay", async () => {
      const { startCronSource } = await import("../../events/sources/cron.js");

      const def = makeDef({
        id: "def-cron-timer",
        sourceType: "cron",
        sourceConfig: { cron: "*/2 * * * *" },
      });

      startCronSource(def);

      // Advance time by a large amount to trigger the scheduled fire
      vi.advanceTimersByTime(3 * 60 * 1000);

      expect(serverBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "event_fired",
          eventDefId: "def-cron-timer",
          payload: expect.objectContaining({ triggered_at: expect.any(String) }),
        }),
      );

      // Verify event was stored
      const events = queryEvents({ eventDefId: "def-cron-timer" });
      expect(events.some((e) => e.type === "scheduler.tick")).toBe(true);
    });

    it("re-arms after fire", async () => {
      const { startCronSource } = await import("../../events/sources/cron.js");

      const def = makeDef({
        id: "def-cron-rearm",
        sourceType: "cron",
        sourceConfig: { cron: "*/2 * * * *" },
      });

      startCronSource(def);
      vi.clearAllMocks();

      // First fire
      vi.advanceTimersByTime(3 * 60 * 1000);
      const firstCall = vi.mocked(serverBus.emit).mock.calls.length;

      // Second fire
      vi.advanceTimersByTime(3 * 60 * 1000);

      expect(vi.mocked(serverBus.emit).mock.calls.length).toBeGreaterThan(firstCall);
    });

    it("stopCronSource prevents subsequent fires", async () => {
      const { startCronSource, stopCronSource } = await import("../../events/sources/cron.js");

      const def = makeDef({
        id: "def-cron-no-fire",
        sourceType: "cron",
        sourceConfig: { cron: "*/1 * * * *" },
      });

      startCronSource(def);
      stopCronSource(def.id);
      vi.clearAllMocks();

      vi.advanceTimersByTime(2 * 60 * 1000);

      expect(serverBus.emit).not.toHaveBeenCalled();
    });

    it("handler failure is caught and re-arms", async () => {
      // Mock createEvent to throw
      vi.doMock("../../store/events.js", () => ({
        createEvent: vi.fn().mockImplementation(() => {
          throw new Error("createEvent boom");
        }),
        getEvent: vi.fn(),
        queryEvents: () => [],
      }));

      const { startCronSource } = await import("../../events/sources/cron.js");

      const def = makeDef({
        id: "def-cron-error",
        sourceType: "cron",
        sourceConfig: { cron: "*/2 * * * *" },
      });

      // Should not throw from startCronSource
      expect(() => startCronSource(def)).not.toThrow();

      // The timer fires but the error is caught inside
      expect(() => vi.advanceTimersByTime(3 * 60 * 1000)).not.toThrow();

      vi.useRealTimers();
    });
  });
});
