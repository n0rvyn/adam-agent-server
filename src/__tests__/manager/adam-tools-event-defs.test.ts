import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

vi.mock("../../events/sources/index.js", () => ({
  startEventDefSource: vi.fn(),
  stopEventDefSource: vi.fn(),
  fireManualEvent: vi.fn(() => ({ eventId: "evt-manual-fire" })),
  fireTestEvent: vi.fn(() => ({ eventId: "evt-test-fire" })),
}));

const {
  mockCreateEventDef,
  mockGetEventDef,
  mockListEventDefs,
  mockUpdateEventDef,
  mockDeleteEventDef,
  mockEventDefs,
  mockCreateEvent,
  mockQueryEvents,
  mockEvents,
} = vi.hoisted(() => {
  const mockEventDefs: Array<Record<string, unknown>> = [];
  const mockEvents: Array<Record<string, unknown>> = [];

  const VALID_UUID = "550e8400-e29b-41d4-a716-446655440099";

  const mockCreateEventDef = vi.fn((def: Record<string, unknown>) => {
    const row = { ...def, created_at: Date.now(), updated_at: Date.now() };
    mockEventDefs.push(row);
    return {
      id: def.id as string,
      name: def.name as string,
      sourceType: def.sourceType as string,
      sourceConfig: def.sourceConfig as Record<string, unknown>,
      enabled: def.enabled as boolean,
      description: def.description as string | undefined,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  });

  const mockGetEventDef = vi.fn((id: string) => {
    const row = mockEventDefs.find(d => d.id === id);
    if (!row) return undefined;
    return {
      id: row.id as string,
      name: row.name as string,
      sourceType: row.source_type ?? (row.sourceType ?? "manual") as string,
      sourceConfig: typeof row.source_config === "string" ? JSON.parse(row.source_config) : (row.sourceConfig ?? {}),
      enabled: row.enabled === 1 || row.enabled === true,
      description: row.description as string | undefined,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  });

  const mockListEventDefs = vi.fn(() => mockEventDefs.map(row => ({
    id: row.id as string,
    name: row.name as string,
    sourceType: row.source_type ?? (row.sourceType ?? "manual") as string,
    sourceConfig: typeof row.source_config === "string" ? JSON.parse(row.source_config) : (row.sourceConfig ?? {}),
    enabled: row.enabled === 1 || row.enabled === true,
    description: row.description as string | undefined,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  })));

  const mockUpdateEventDef = vi.fn((id: string, _updates?: Record<string, unknown>) => {
    const row = mockEventDefs.find(d => d.id === id);
    if (!row) return undefined;
    return {
      id: row.id as string,
      name: row.name as string,
      sourceType: row.source_type ?? (row.sourceType ?? "manual") as string,
      sourceConfig: typeof row.source_config === "string" ? JSON.parse(row.source_config) : (row.sourceConfig ?? {}),
      enabled: row.enabled === 1 || row.enabled === true,
      description: row.description as string | undefined,
      createdAt: row.created_at as number,
      updatedAt: Date.now(),
    };
  });

  const mockDeleteEventDef = vi.fn(() => true);

  const mockCreateEvent = vi.fn((evt: Record<string, unknown>) => {
    mockEvents.push(evt);
    return { inserted: true, id: evt.id as string };
  });

  const mockQueryEvents = vi.fn(({ eventDefId }: { eventDefId?: string }) =>
    mockEvents.filter(e => !eventDefId || (e as Record<string, unknown>).eventDefId === eventDefId).map(row => ({
      id: row.id as string,
      eventDefId: (row as Record<string, unknown>).eventDefId as string,
      type: (row as Record<string, unknown>).type as string,
      source: (row as Record<string, unknown>).source as string,
      dedupKey: (row as Record<string, unknown>).dedupKey as string,
      payload: (row as Record<string, unknown>).payload ?? {},
      occurredAt: (row as Record<string, unknown>).occurredAt as string,
      confidence: "medium",
    }))
  );

  return {
    mockCreateEventDef, mockGetEventDef, mockListEventDefs,
    mockUpdateEventDef, mockDeleteEventDef, mockEventDefs,
    mockCreateEvent, mockQueryEvents, mockEvents,
    VALID_UUID,
  };
});

vi.mock("../../store/event-defs.js", () => ({
  createEventDef: mockCreateEventDef,
  getEventDef: mockGetEventDef,
  listEventDefs: mockListEventDefs,
  updateEventDef: mockUpdateEventDef,
  deleteEventDef: mockDeleteEventDef,
}));

vi.mock("../../store/events.js", () => ({
  createEvent: mockCreateEvent,
  queryEvents: mockQueryEvents,
}));

// Test harness: capture SDK tool() registrations
const mockCreateSdkMcpServer = vi.fn();
const mockTool = vi.fn((name, description, schema, handler) => ({ name, description, schema, handler }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: mockCreateSdkMcpServer,
  tool: mockTool,
}));

afterAll(() => cleanup());

describe("adam-tools event-def tools (Tasks 5-7)", () => {
  let toolsArray: Array<{ name: string; handler: (args: Record<string, unknown>) => Promise<unknown> }>;

  beforeEach(async () => {
    clearTestDb();
    vi.clearAllMocks();
    mockEventDefs.length = 0;
    mockEvents.length = 0;
    mockGetEventDef.mockReturnValue(undefined);
    mockListEventDefs.mockReturnValue([]);
    mockCreateEventDef.mockClear();
    mockGetEventDef.mockClear();
    mockListEventDefs.mockClear();
    mockUpdateEventDef.mockClear();
    mockDeleteEventDef.mockClear();
    mockCreateEvent.mockClear();
    mockQueryEvents.mockClear();

    // Restore hoisted mocks after clearAllMocks
    vi.mocked(mockCreateEventDef).mockImplementation((def: Record<string, unknown>) => {
      const row = { ...def, created_at: Date.now(), updated_at: Date.now() };
      mockEventDefs.push(row);
      return {
        id: def.id as string,
        name: def.name as string,
        sourceType: def.sourceType as string,
        sourceConfig: def.sourceConfig as Record<string, unknown>,
        enabled: def.enabled as boolean,
        description: def.description as string | undefined,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
    });

    vi.mocked(mockGetEventDef).mockImplementation((id: string) => {
      const row = mockEventDefs.find(d => d.id === id);
      if (!row) return undefined;
      return {
        id: row.id as string,
        name: row.name as string,
        sourceType: row.source_type ?? (row.sourceType ?? "manual") as string,
        sourceConfig: typeof row.source_config === "string" ? JSON.parse(row.source_config) : (row.sourceConfig ?? {}),
        enabled: row.enabled === 1 || row.enabled === true,
        description: row.description as string | undefined,
        createdAt: row.created_at as number,
        updatedAt: row.updated_at as number,
      };
    });

    vi.mocked(mockListEventDefs).mockImplementation(() => mockEventDefs.map(row => ({
      id: row.id as string,
      name: row.name as string,
      sourceType: row.source_type ?? (row.sourceType ?? "manual") as string,
      sourceConfig: typeof row.source_config === "string" ? JSON.parse(row.source_config) : (row.sourceConfig ?? {}),
      enabled: row.enabled === 1 || row.enabled === true,
      description: row.description as string | undefined,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    })));

    vi.mocked(mockUpdateEventDef).mockImplementation((id: string) => {
      const row = mockEventDefs.find(d => d.id === id);
      if (!row) return undefined;
      return {
        id: row.id as string,
        name: row.name as string,
        sourceType: row.source_type ?? (row.sourceType ?? "manual") as string,
        sourceConfig: typeof row.source_config === "string" ? JSON.parse(row.source_config) : (row.sourceConfig ?? {}),
        enabled: row.enabled === 1 || row.enabled === true,
        description: row.description as string | undefined,
        createdAt: row.created_at as number,
        updatedAt: Date.now(),
      };
    });

    vi.mocked(mockDeleteEventDef).mockReturnValue(true);

    const { createAdamTools } = await import("../../manager/adam-tools.js");
    createAdamTools();
    toolsArray = mockCreateSdkMcpServer.mock.calls[0][0].tools;
  });

  // ===== Task 5: create_event_def =====

  describe("create_event_def", () => {
    it("creates event def with valid cron config", async () => {
      const tool = toolsArray.find(t => t.name === "create_event_def");
      expect(tool).toBeDefined();

      const result = await tool!.handler({
        name: "daily-check",
        sourceType: "cron",
        sourceConfig: { cron: "0 9 * * *" },
        enabled: true,
      }) as { content: Array<{ text: string }> };

      const payload = JSON.parse(result.content[0].text);
      expect(payload.id).toBeDefined();
      expect(payload.name).toBe("daily-check");
      expect(payload.sourceType).toBe("cron");
      expect(payload.enabled).toBe(true);
      expect(mockCreateEventDef).toHaveBeenCalledOnce();
      const { startEventDefSource } = await import("../../events/sources/index.js");
      expect(startEventDefSource).toHaveBeenCalledOnce();
    });

    it("returns error for unknown sourceType", async () => {
      const tool = toolsArray.find(t => t.name === "create_event_def");
      const result = await tool!.handler({
        name: "bad-type",
        sourceType: "nonexistent",
        sourceConfig: {},
      }) as { content: Array<{ text: string }> };

      const payload = JSON.parse(result.content[0].text);
      expect(payload.error).toContain("Unknown sourceType");
      expect(payload.error).toContain("nonexistent");
      expect(payload.error).toContain("webhook");
      expect(payload.error).toContain("cron");
      expect(mockCreateEventDef).not.toHaveBeenCalled();
    });

    it("returns error for invalid sourceConfig on cron type", async () => {
      const tool = toolsArray.find(t => t.name === "create_event_def");
      const result = await tool!.handler({
        name: "bad-cron",
        sourceType: "cron",
        sourceConfig: { foo: "bar" }, // missing required `cron` field
      }) as { content: Array<{ text: string }> };

      const payload = JSON.parse(result.content[0].text);
      expect(payload.error).toContain("Invalid sourceConfig");
      expect(mockCreateEventDef).not.toHaveBeenCalled();
    });

    it("rolls back DB row when startEventDefSource throws", async () => {
      const { startEventDefSource } = await import("../../events/sources/index.js");
      vi.mocked(startEventDefSource).mockImplementationOnce(() => {
        throw new Error("cron-parser failed");
      });

      const tool = toolsArray.find(t => t.name === "create_event_def");
      const result = await tool!.handler({
        name: "bad-start",
        sourceType: "cron",
        sourceConfig: { cron: "invalid" },
      }) as { content: Array<{ text: string }> };

      const payload = JSON.parse(result.content[0].text);
      expect(payload.error).toContain("Failed to start source");
      expect(payload.error).toContain("cron-parser failed");
      expect(mockDeleteEventDef).toHaveBeenCalledOnce();
    });
  });

  // ===== Task 5: list_event_defs =====

  describe("list_event_defs", () => {
    it("returns shaped def objects", async () => {
      const tool = toolsArray.find(t => t.name === "list_event_defs");
      expect(tool).toBeDefined();

      const result = await tool!.handler({}) as { content: Array<{ text: string }> };
      const payload = JSON.parse(result.content[0].text);
      expect(Array.isArray(payload)).toBe(true);
      expect(mockListEventDefs).toHaveBeenCalledOnce();
    });
  });

  // ===== Task 5: update_event_def =====

  describe("update_event_def", () => {
    it("stops source before updating when disabling an enabled def", async () => {
      const { startEventDefSource } = await import("../../events/sources/index.js");
      const { stopEventDefSource } = await import("../../events/sources/index.js");

      // Pre-seed an enabled cron def
      const id = "550e8400-e29b-41d4-a716-446655440101";
      mockGetEventDef.mockReturnValueOnce({
        id, name: "to-disable", sourceType: "cron",
        sourceConfig: { cron: "0 9 * * *" }, enabled: true,
        description: undefined, createdAt: Date.now(), updatedAt: Date.now(),
      });
      mockUpdateEventDef.mockReturnValueOnce({
        id, name: "to-disable", sourceType: "cron",
        sourceConfig: { cron: "0 9 * * *" }, enabled: false,
        description: undefined, createdAt: Date.now(), updatedAt: Date.now(),
      });

      const tool = toolsArray.find(t => t.name === "update_event_def");
      const result = await tool!.handler({ id, enabled: false }) as { content: Array<{ text: string }> };

      const payload = JSON.parse(result.content[0].text);
      expect(payload.id).toBe(id);
      expect(stopEventDefSource).toHaveBeenCalledWith(id, "cron");
      expect(startEventDefSource).not.toHaveBeenCalled();
    });

    it("starts source after updating when enabling a disabled def", async () => {
      const { startEventDefSource } = await import("../../events/sources/index.js");

      const id = "550e8400-e29b-41d4-a716-446655440102";
      mockGetEventDef.mockReturnValueOnce({
        id, name: "to-enable", sourceType: "manual",
        sourceConfig: {}, enabled: false,
        description: undefined, createdAt: Date.now(), updatedAt: Date.now(),
      });
      mockUpdateEventDef.mockReturnValueOnce({
        id, name: "to-enable", sourceType: "manual",
        sourceConfig: {}, enabled: true,
        description: undefined, createdAt: Date.now(), updatedAt: Date.now(),
      });

      const tool = toolsArray.find(t => t.name === "update_event_def");
      const result = await tool!.handler({ id, enabled: true }) as { content: Array<{ text: string }> };

      const payload = JSON.parse(result.content[0].text);
      expect(startEventDefSource).toHaveBeenCalledOnce();
      expect(mockUpdateEventDef).toHaveBeenCalledOnce();
    });

    it("stop-update-start sequence on config change of enabled def", async () => {
      const { startEventDefSource, stopEventDefSource } = await import("../../events/sources/index.js");

      const id = "550e8400-e29b-41d4-a716-446655440103";
      mockGetEventDef.mockReturnValueOnce({
        id, name: "config-change", sourceType: "cron",
        sourceConfig: { cron: "0 9 * * *" }, enabled: true,
        description: undefined, createdAt: Date.now(), updatedAt: Date.now(),
      });
      mockUpdateEventDef.mockReturnValueOnce({
        id, name: "config-change", sourceType: "cron",
        sourceConfig: { cron: "0 10 * * *" }, enabled: true,
        description: undefined, createdAt: Date.now(), updatedAt: Date.now(),
      });

      const tool = toolsArray.find(t => t.name === "update_event_def");
      await tool!.handler({ id, sourceConfig: { cron: "0 10 * * *" } }) as { content: Array<{ text: string }> };

      // Handler executes: stop first (was enabled + config changing), then update, then start
      expect(stopEventDefSource).toHaveBeenCalled();
      expect(mockUpdateEventDef).toHaveBeenCalled();
      expect(startEventDefSource).toHaveBeenCalled();
    });

    it("self-heals: marks disabled when start fails after config change", async () => {
      const { startEventDefSource } = await import("../../events/sources/index.js");
      vi.mocked(startEventDefSource).mockImplementationOnce(() => {
        throw new Error("bad cron");
      });

      const id = "550e8400-e29b-41d4-a716-446655440104";
      mockGetEventDef.mockReturnValueOnce({
        id, name: "bad-start-update", sourceType: "cron",
        sourceConfig: { cron: "0 9 * * *" }, enabled: true,
        description: undefined, createdAt: Date.now(), updatedAt: Date.now(),
      });
      mockUpdateEventDef.mockReturnValueOnce({
        id, name: "bad-start-update", sourceType: "cron",
        sourceConfig: { cron: "bad" }, enabled: false,
        description: undefined, createdAt: Date.now(), updatedAt: Date.now(),
      });

      const tool = toolsArray.find(t => t.name === "update_event_def");
      const result = await tool!.handler({ id, sourceConfig: { cron: "bad" } }) as { content: Array<{ text: string }> };

      const payload = JSON.parse(result.content[0].text);
      expect(payload.error).toContain("bad cron");
      expect(payload.error).toContain("marked disabled");
      // Called once for the update, once for the self-heal
      expect(mockUpdateEventDef).toHaveBeenCalledTimes(2);
      const secondCall = mockUpdateEventDef.mock.calls[1];
      expect(secondCall[1]).toMatchObject({ enabled: false });
    });
  });

  // ===== Task 5: delete_event_def =====

  describe("delete_event_def", () => {
    it("stops source before deleting def", async () => {
      const { stopEventDefSource } = await import("../../events/sources/index.js");

      const id = "550e8400-e29b-41d4-a716-446655440105";
      mockGetEventDef.mockReturnValueOnce({
        id, name: "to-delete", sourceType: "cron",
        sourceConfig: { cron: "0 9 * * *" }, enabled: true,
        description: undefined, createdAt: Date.now(), updatedAt: Date.now(),
      });

      const tool = toolsArray.find(t => t.name === "delete_event_def");
      const result = await tool!.handler({ id }) as { content: Array<{ text: string }> };

      const payload = JSON.parse(result.content[0].text);
      expect(payload.ok).toBe(true);
      expect(stopEventDefSource).toHaveBeenCalledWith(id, "cron");
      expect(mockDeleteEventDef).toHaveBeenCalledWith(id);
    });
  });

  // ===== Task 6: fire_event_def =====

  describe("fire_event_def", () => {
    it("fires manual def without test flag", async () => {
      const { fireManualEvent } = await import("../../events/sources/index.js");

      mockGetEventDef.mockReturnValueOnce({
        id: "manual-def-id", name: "manual", sourceType: "manual",
        sourceConfig: {}, enabled: true,
        description: undefined, createdAt: Date.now(), updatedAt: Date.now(),
      });

      const tool = toolsArray.find(t => t.name === "fire_event_def");
      expect(tool).toBeDefined();

      const result = await tool!.handler({ id: "manual-def-id" }) as { content: Array<{ text: string }> };
      const payload = JSON.parse(result.content[0].text);
      expect(payload.ok).toBe(true);
      expect(payload.test).toBe(false);
      expect(fireManualEvent).toHaveBeenCalledOnce();
    });

    it("rejects non-manual def without test=true", async () => {
      const id = "550e8400-e29b-41d4-a716-446655440106";
      mockGetEventDef.mockReturnValueOnce({
        id, name: "cron-def", sourceType: "cron",
        sourceConfig: { cron: "0 9 * * *" }, enabled: true,
        description: undefined, createdAt: Date.now(), updatedAt: Date.now(),
      });

      const tool = toolsArray.find(t => t.name === "fire_event_def");
      const result = await tool!.handler({ id }) as { content: Array<{ text: string }> };

      const payload = JSON.parse(result.content[0].text);
      expect(payload.error).toContain("test=true");
    });

    it("fires any def with test=true", async () => {
      const { fireTestEvent } = await import("../../events/sources/index.js");

      const id = "550e8400-e29b-41d4-a716-446655440107";
      mockGetEventDef.mockReturnValueOnce({
        id, name: "cron-def-test", sourceType: "cron",
        sourceConfig: { cron: "0 9 * * *" }, enabled: true,
        description: undefined, createdAt: Date.now(), updatedAt: Date.now(),
      });

      const tool = toolsArray.find(t => t.name === "fire_event_def");
      const result = await tool!.handler({ id, test: true }) as { content: Array<{ text: string }> };

      const payload = JSON.parse(result.content[0].text);
      expect(payload.ok).toBe(true);
      expect(payload.test).toBe(true);
      expect(fireTestEvent).toHaveBeenCalledOnce();
    });

    it("rejects payload over 64 KB", async () => {
      const id = "550e8400-e29b-41d4-a716-446655440108";
      mockGetEventDef.mockReturnValueOnce({
        id, name: "manual-payload", sourceType: "manual",
        sourceConfig: {}, enabled: true,
        description: undefined, createdAt: Date.now(), updatedAt: Date.now(),
      });

      const bigPayload = { data: "x".repeat(70000) };
      const tool = toolsArray.find(t => t.name === "fire_event_def");
      const result = await tool!.handler({ id, payload: bigPayload }) as { content: Array<{ text: string }> };

      const payload = JSON.parse(result.content[0].text);
      expect(payload.error).toContain("64 KB");
    });

    it("returns error for unknown id", async () => {
      mockGetEventDef.mockReturnValueOnce(undefined);

      const tool = toolsArray.find(t => t.name === "fire_event_def");
      const result = await tool!.handler({ id: "does-not-exist" }) as { content: Array<{ text: string }> };

      const payload = JSON.parse(result.content[0].text);
      expect(payload.error).toContain("not found");
    });
  });

  // ===== Task 7: list_event_firings =====

  describe("list_event_firings", () => {
    it("returns error for unknown eventDefId", async () => {
      mockGetEventDef.mockReturnValueOnce(undefined);

      const tool = toolsArray.find(t => t.name === "list_event_firings");
      const result = await tool!.handler({ eventDefId: "unknown-id" }) as { content: Array<{ text: string }> };

      const payload = JSON.parse(result.content[0].text);
      expect(payload.error).toContain("not found");
    });

    it("returns firings with truncated payload when large", async () => {
      const id = "550e8400-e29b-41d4-a716-446655440109";
      mockGetEventDef.mockReturnValueOnce({
        id, name: "my-event", sourceType: "manual",
        sourceConfig: {}, enabled: true,
        description: undefined, createdAt: Date.now(), updatedAt: Date.now(),
      });
      mockQueryEvents.mockReturnValueOnce([{
        id: "evt-1",
        eventDefId: id,
        type: "manual.fire",
        source: "manual",
        dedupKey: "manual-abc",
        payload: { data: "x".repeat(600) },
        occurredAt: new Date().toISOString(),
        confidence: "medium",
      }]);

      const tool = toolsArray.find(t => t.name === "list_event_firings");
      const result = await tool!.handler({ eventDefId: id }) as { content: Array<{ text: string }> };

      const payload = JSON.parse(result.content[0].text);
      expect(payload.count).toBe(1);
      expect(payload.firings[0].payloadTruncated).toBe(true);
      expect(payload.firings[0].payloadPreview).toMatch(/\.\.\.\[truncated\]$/);
    });

    it("returns small payload without truncation flag", async () => {
      const id = "550e8400-e29b-41d4-a716-446655440110";
      mockGetEventDef.mockReturnValueOnce({
        id, name: "small-event", sourceType: "manual",
        sourceConfig: {}, enabled: true,
        description: undefined, createdAt: Date.now(), updatedAt: Date.now(),
      });
      mockQueryEvents.mockReturnValueOnce([{
        id: "evt-2",
        eventDefId: id,
        type: "manual.fire",
        source: "manual",
        dedupKey: "manual-def",
        payload: { key: "value" },
        occurredAt: new Date().toISOString(),
        confidence: "medium",
      }]);

      const tool = toolsArray.find(t => t.name === "list_event_firings");
      const result = await tool!.handler({ eventDefId: id }) as { content: Array<{ text: string }> };

      const payload = JSON.parse(result.content[0].text);
      expect(payload.firings[0].payloadTruncated).toBe(false);
      expect(payload.firings[0].payloadPreview).not.toContain("[truncated]");
    });
  });
});
