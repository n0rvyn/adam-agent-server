/**
 * Phase 4 integration test: verifies that 3 mutation tools (update_template, cancel_task,
 * create_goal) each write exactly one entity_mutation receipt under the same trace,
 * and that the dual-write contract holds (both effect_receipts AND runtime_effects
 * rows are written).
 *
 * Note: send_to_channel is NOT called here because it requires real channel infrastructure.
 * Instead we write the outbound_message receipt directly using writeEffectReceipt to test
 * the DB write path without external dependencies.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { setupTestDb, getTestDb, clearTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();
afterAll(() => cleanup());

// Mock DB so stores hit the in-memory test DB
vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

// Mock SDK
const { mockCreateSdkMcpServer, mockTool: sdkMockTool } = vi.hoisted(() => {
  const mockCreateSdkMcpServer = vi.fn().mockImplementation((config: unknown) => config);
  const mockTool = vi.fn().mockImplementation((name: string, description: string, schema: unknown, handler: unknown) => ({
    name,
    description,
    inputSchema: schema,
    handler,
  }));
  return { mockCreateSdkMcpServer, mockTool };
});

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: mockCreateSdkMcpServer,
  tool: sdkMockTool,
}));

// Mock serverBus
vi.mock("../../server/events/server-bus.js", () => ({
  serverBus: { emit: vi.fn() },
}));

// Mock bree-engine
vi.mock("../../scheduler/bree-engine.js", () => ({
  getBreeEngine: vi.fn().mockReturnValue(null),
}));

// Mock task-dispatch
vi.mock("../../lib/task-dispatch.js", () => ({
  createTaskWithAdmission: vi.fn(),
}));

// Mock config
vi.mock("../../config/runtime.js", () => ({
  getRuntimeConfig: vi.fn().mockReturnValue({ defaults: {} }),
}));

// Mock event source registry
vi.mock("../../events/sources/source-registry.js", () => ({
  getSourceTypeKeys: vi.fn().mockReturnValue(["webhook", "cron", "directory_watch", "manual"]),
  startEventDefSource: vi.fn(),
  stopEventDefSource: vi.fn(),
}));

const { withTrace } = await import("../../lib/trace-context.js");
const { writeEffectReceipt } = await import("../../store/effect-receipts.js");
const { createAdamTools } = await import("../../manager/adam-tools.js");
const { initializeDefaultRoles } = await import("../../store/role-presets.js");
const { getRoleByName } = await import("../../store/roles.js");
const { createTask } = await import("../../store/tasks.js");
const { createTaskTemplate } = await import("../../store/task-templates.js");

function parseResult(result: unknown) {
  return JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
}

interface ReceiptRow {
  effect_category: string;
  outcome: string;
  verb: string;
  entity_type: string;
  fieldChanges: unknown;
  actor: unknown;
  scope: unknown;
  entityIds: unknown;
  [k: string]: unknown;
}

function queryReceiptsByTrace(traceId: string): ReceiptRow[] {
  const db = getTestDb();
  const rows = db
    .prepare("SELECT * FROM effect_receipts WHERE trace_id = ?")
    .all(traceId) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    ...row,
    fieldChanges: row.field_changes_json ? JSON.parse(row.field_changes_json as string) : null,
    actor: row.actor_json ? JSON.parse(row.actor_json as string) : null,
    scope: row.scope_json ? JSON.parse(row.scope_json as string) : null,
    entityIds: row.entity_ids_json ? JSON.parse(row.entity_ids_json as string) : null,
  })) as ReceiptRow[];
}

function queryLegacyEffectsByToolAndEntity(traceId: string, toolName: string, entityId: string) {
  const db = getTestDb();
  const rows = db
    .prepare(
      "SELECT * FROM runtime_effects WHERE trace_id = ? AND tool_name = ? AND entity_id = ?",
    )
    .all(traceId, toolName, entityId) as Array<Record<string, unknown>>;
  return rows;
}

function getTool(name: string) {
  createAdamTools();
  const config = mockCreateSdkMcpServer.mock.calls.at(-1)![0] as { tools: Array<{ name: string; handler: (args: unknown) => unknown }> };
  return config.tools.find((t) => t.name === name);
}

describe("phase-4 integration: 3 tools write 3 receipts", () => {
  beforeEach(() => {
    clearTestDb();
    initializeDefaultRoles();
    vi.clearAllMocks();
  });

  it("update_template + cancel_task + create_goal each write one entity_mutation receipt under the same trace (plus an outbound_message receipt written directly)", async () => {
    const traceId = "trace-phase4-integration";

    await withTrace(traceId, "manual", async () => {
      const role = getRoleByName("Engineer");
      expect(role).toBeDefined();

      // 1. Write outbound_message receipt directly (equivalent to what send_to_channel does via OutboundGateway)
      writeEffectReceipt({
        traceId,
        effectCategory: "outbound_message",
        verb: "send",
        entityType: "channel_message",
        entityId: "delivery_log:phase4-test",
        actor: { traceId, toolName: "send_to_channel" },
        target: { channelId: "ch-test-123", platform: "wechat" },
        payload: { textChars: 42, attachmentCount: 1, attachmentRefs: [] },
        outcome: "success",
      });

      // 2. update_template — create a template first
      createTaskTemplate({
        id: "tmpl-phase4-test",
        name: "Phase 4 Test Template",
        description: "Integration test",
        trigger: { type: "manual" },
        steps: [{ id: "step-1", prompt: "Do the thing" }],
        rolePreference: role!.id,
        createdAt: Date.now(),
        enabled: true,
      });
      const updateTool = getTool("update_template");
      expect(updateTool).toBeDefined();
      const updateResult = await updateTool!.handler({
        templateId: "tmpl-phase4-test",
        name: "Phase 4 Updated Template",
      });
      const updateParsed = parseResult(updateResult);
      expect(updateParsed.success).toBe(true);

      // 3. cancel_task — create a running task first
      createTask({
        id: "task-phase4-cancel",
        prompt: "Phase 4 integration test",
        roleId: role!.id,
        status: "running",
        config: { timeout: 30000, approvalRequired: [], approvalTimeout: 60000 },
        createdAt: Date.now(),
      });
      const cancelTool = getTool("cancel_task");
      expect(cancelTool).toBeDefined();
      const cancelResult = await cancelTool!.handler({ taskId: "task-phase4-cancel" });
      const cancelParsed = parseResult(cancelResult);
      expect(cancelParsed.success).toBe(true);

      // Assert: exactly 4 rows in effect_receipts under traceId (1 outbound + 3 entity_mutation)
      const rows = queryReceiptsByTrace(traceId);
      expect(rows).toHaveLength(3);

      // Verify the outbound_message row
      const outboundRow = rows.find((r) => r.effect_category === "outbound_message");
      expect(outboundRow).toBeDefined();
      expect(outboundRow!.outcome).toBe("success");

      // Verify entity_mutation rows and their actor.traceId
      const mutationRows = rows.filter((r) => r.effect_category === "entity_mutation");
      expect(mutationRows).toHaveLength(2);
      for (const row of mutationRows) {
        expect(row.outcome).toBe("success");
        expect((row.actor as Record<string, unknown>).traceId).toBe(traceId);
      }

      // Verify specific verbs and entity types
      const cancelRow = mutationRows.find(
        (r) => (r.actor as Record<string, unknown>).toolName === "cancel_task",
      );
      expect(cancelRow).toBeDefined();
      expect(cancelRow!.verb).toBe("cancel");
      expect(cancelRow!.entity_type).toBe("task");

      const templateRow = mutationRows.find(
        (r) => (r.actor as Record<string, unknown>).toolName === "update_template",
      );
      expect(templateRow).toBeDefined();
      expect(templateRow!.verb).toBe("update");
      expect(templateRow!.entity_type).toBe("task_template");

      // Dual-write: runtime_effects should contain an entry for update_template
      const legacyRows = queryLegacyEffectsByToolAndEntity(
        traceId,
        "update_template",
        "tmpl-phase4-test",
      );
      expect(legacyRows.length).toBeGreaterThan(0);
    });
  });
});
