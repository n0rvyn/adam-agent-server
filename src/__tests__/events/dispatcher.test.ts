import { describe, it, expect, beforeEach, vi, afterAll } from "vitest";
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
import { listTaskTemplates } from "../../store/task-templates.js";
import { dispatchTemplate } from "../../scheduler/template-dispatch.js";

afterAll(() => cleanup());

beforeEach(() => {
  clearTestDb();
  vi.clearAllMocks();
  vi.mocked(listTaskTemplates).mockReturnValue([]);

  // Reset the dispatcher's module-level `started` flag so each test
  // gets a fresh registration call (avoid idempotent-guard skip).
  vi.resetModules();
});

describe("EventDispatcher", () => {
  it("startEventDispatcher registers exactly one handler on the serverBus", async () => {
    const { startEventDispatcher } = await import("../../events/dispatcher.js");

    startEventDispatcher();
    expect(serverBus.on).toHaveBeenCalledWith("event_fired", expect.any(Function));
    // Calling again should be idempotent (guard inside the module)
    startEventDispatcher();
    expect(serverBus.on).toHaveBeenCalledTimes(1);
  });

  it("dispatches once per matching template", async () => {
    const { startEventDispatcher } = await import("../../events/dispatcher.js");

    const template1 = {
      id: "tmpl-1",
      name: "tmpl1",
      trigger: { type: "event" as const, eventDefId: "def-x" },
      steps: [],
      enabled: true,
      createdAt: Date.now(),
    };
    const template2 = {
      id: "tmpl-2",
      name: "tmpl2",
      trigger: { type: "event" as const, eventDefId: "def-x" },
      steps: [],
      enabled: true,
      createdAt: Date.now(),
    };
    vi.mocked(listTaskTemplates).mockReturnValue([template1, template2]);

    startEventDispatcher();
    const handler = vi.mocked(serverBus.on).mock.calls[0][1] as (data: unknown) => Promise<void>;

    await handler({ eventDefId: "def-x", eventId: "evt-1", payload: { foo: "bar" } });

    expect(dispatchTemplate).toHaveBeenCalledTimes(2);
    expect(dispatchTemplate).toHaveBeenCalledWith(template1, {
      triggerContext: { eventId: "evt-1", payload: { foo: "bar" } },
    });
    expect(dispatchTemplate).toHaveBeenCalledWith(template2, {
      triggerContext: { eventId: "evt-1", payload: { foo: "bar" } },
    });
  });

  it("ignores eventDefId with no matching templates", async () => {
    const { startEventDispatcher } = await import("../../events/dispatcher.js");
    vi.mocked(listTaskTemplates).mockReturnValue([]);

    startEventDispatcher();
    const handler = vi.mocked(serverBus.on).mock.calls[0][1] as (data: unknown) => Promise<void>;

    await handler({ eventDefId: "def-no-match", eventId: "evt-99", payload: {} });

    expect(dispatchTemplate).not.toHaveBeenCalled();
  });

  it("only matches templates with trigger.type === 'event' and matching eventDefId", async () => {
    const { startEventDispatcher } = await import("../../events/dispatcher.js");

    const eventTemplate = {
      id: "tmpl-event",
      name: "event-tmpl",
      trigger: { type: "event" as const, eventDefId: "def-match" },
      steps: [],
      enabled: true,
      createdAt: Date.now(),
    };
    const cronTemplate = {
      id: "tmpl-cron",
      name: "cron-tmpl",
      trigger: { type: "cron" as const, cron: "*/5 * * * *" },
      steps: [],
      enabled: true,
      createdAt: Date.now(),
    };
    const otherEventTemplate = {
      id: "tmpl-other",
      name: "other-event",
      trigger: { type: "event" as const, eventDefId: "def-other" },
      steps: [],
      enabled: true,
      createdAt: Date.now(),
    };
    vi.mocked(listTaskTemplates).mockReturnValue([eventTemplate, cronTemplate, otherEventTemplate]);

    startEventDispatcher();
    const handler = vi.mocked(serverBus.on).mock.calls[0][1] as (data: unknown) => Promise<void>;

    await handler({ eventDefId: "def-match", eventId: "evt-match", payload: {} });

    expect(dispatchTemplate).toHaveBeenCalledTimes(1);
    expect(dispatchTemplate).toHaveBeenCalledWith(eventTemplate, {
      triggerContext: { eventId: "evt-match", payload: {} },
    });
  });

  it("one dispatch failure does not block siblings", async () => {
    const { startEventDispatcher } = await import("../../events/dispatcher.js");

    vi.mocked(dispatchTemplate)
      .mockRejectedValueOnce(new Error("template-1 failed"))
      .mockResolvedValueOnce(undefined);

    const template1 = {
      id: "tmpl-fail",
      name: "failing",
      trigger: { type: "event" as const, eventDefId: "def-isolated" },
      steps: [],
      enabled: true,
      createdAt: Date.now(),
    };
    const template2 = {
      id: "tmpl-ok",
      name: "ok",
      trigger: { type: "event" as const, eventDefId: "def-isolated" },
      steps: [],
      enabled: true,
      createdAt: Date.now(),
    };
    vi.mocked(listTaskTemplates).mockReturnValue([template1, template2]);

    startEventDispatcher();
    const handler = vi.mocked(serverBus.on).mock.calls[0][1] as (data: unknown) => Promise<void>;

    // Should not throw — errors are caught inside the handler
    await handler({ eventDefId: "def-isolated", eventId: "evt-iso", payload: {} });

    expect(dispatchTemplate).toHaveBeenCalledTimes(2);
  });

  it("passes eventId and payload in triggerContext", async () => {
    const { startEventDispatcher } = await import("../../events/dispatcher.js");

    const tmpl = {
      id: "tmpl-payload",
      name: "payload-tmpl",
      trigger: { type: "event" as const, eventDefId: "def-payload" },
      steps: [],
      enabled: true,
      createdAt: Date.now(),
    };
    vi.mocked(listTaskTemplates).mockReturnValue([tmpl]);

    startEventDispatcher();
    const handler = vi.mocked(serverBus.on).mock.calls[0][1] as (data: unknown) => Promise<void>;

    const payload = { custom: "data", nested: { value: 42 } };
    await handler({ eventDefId: "def-payload", eventId: "evt-payload", payload });

    expect(dispatchTemplate).toHaveBeenCalledWith(
      tmpl,
      expect.objectContaining({
        triggerContext: expect.objectContaining({ eventId: "evt-payload", payload }),
      }),
    );
  });

  it("LRU dedup: same eventId within TTL dispatches only once", async () => {
    const mod = await import("../../events/dispatcher.js");
    const { startEventDispatcher, _resetDispatcherLru } = mod;
    _resetDispatcherLru();

    const tmpl = {
      id: "tmpl-lru",
      name: "lru",
      trigger: { type: "event" as const, eventDefId: "def-lru" },
      steps: [],
      enabled: true,
      createdAt: Date.now(),
    };
    vi.mocked(listTaskTemplates).mockReturnValue([tmpl]);

    startEventDispatcher();
    const handler = vi.mocked(serverBus.on).mock.calls[0][1] as (data: unknown) => Promise<void>;

    const sameEvent = { eventDefId: "def-lru", eventId: "evt-same", payload: {} };
    await handler(sameEvent);
    await handler(sameEvent);
    await handler(sameEvent);

    expect(dispatchTemplate).toHaveBeenCalledTimes(1);
  });

  it("LRU dedup: different eventIds are NOT suppressed", async () => {
    const mod = await import("../../events/dispatcher.js");
    const { startEventDispatcher, _resetDispatcherLru } = mod;
    _resetDispatcherLru();

    const tmpl = {
      id: "tmpl-lru2",
      name: "lru2",
      trigger: { type: "event" as const, eventDefId: "def-lru2" },
      steps: [],
      enabled: true,
      createdAt: Date.now(),
    };
    vi.mocked(listTaskTemplates).mockReturnValue([tmpl]);

    startEventDispatcher();
    const handler = vi.mocked(serverBus.on).mock.calls[0][1] as (data: unknown) => Promise<void>;

    await handler({ eventDefId: "def-lru2", eventId: "evt-a", payload: {} });
    await handler({ eventDefId: "def-lru2", eventId: "evt-b", payload: {} });
    await handler({ eventDefId: "def-lru2", eventId: "evt-c", payload: {} });

    expect(dispatchTemplate).toHaveBeenCalledTimes(3);
  });
});
