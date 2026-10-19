/**
 * Regression guard for the per-turn trace fix covering SPREAD tool factories.
 *
 * The buildTools `withTrace` wrapper only covers the inline `tool()` calls. The shared
 * memory tools (search/save/delete) are built by `createSharedMemoryTools` with the raw
 * SDK `tool` and spread into buildTools — so they bypassed the wrapper and their
 * `writeMutationReceipt` landed under the frozen construction-time trace, reproducing the
 * commitment-audit "无执行证据" false-positive for memory-only turns.
 *
 * Fix: `createSharedMemoryTools(undefined, tool)` passes the traced wrapper.
 * This test asserts delete_memory's receipt attributes to the in-flight turn trace
 * (holder.id), NOT the surrounding "ctor-trace" ALS context.
 *
 * Red without the fix: remove `, tool` at adam-tools.ts (createSharedMemoryTools call) →
 * delete_memory uses the unwrapped SDK tool → receipt lands under "ctor-trace" → assertion fails.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();
afterAll(() => cleanup());

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

const { mockTool, mockCreateSdkMcpServer } = vi.hoisted(() => {
  const mockTool = vi.fn().mockImplementation(
    (name: string, _desc: string, _schema: unknown, handler: unknown) => ({ name, handler }),
  );
  const mockCreateSdkMcpServer = vi.fn().mockImplementation((cfg: { tools: unknown }) => ({ tools: cfg.tools }));
  return { mockTool, mockCreateSdkMcpServer };
});

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: mockCreateSdkMcpServer,
  tool: mockTool,
}));

vi.mock("../../config/runtime.js", () => ({
  getRuntimeConfig: vi.fn().mockReturnValue({ defaults: {} }),
  updateMutableConfig: vi.fn(),
}));
vi.mock("../../server/events/server-bus.js", () => ({
  serverBus: { emit: vi.fn() },
}));
vi.mock("../../lib/task-dispatch.js", () => ({ createTaskWithAdmission: vi.fn() }));
vi.mock("../../manager/skill-registry.js", () => ({
  SkillRegistry: { query: vi.fn().mockReturnValue([]), match: vi.fn().mockReturnValue([]) },
}));
vi.mock("../../store/role-workspace.js", async () => {
  const actual = await vi.importActual<typeof import("../../store/role-workspace.js")>("../../store/role-workspace.js");
  return { ...actual, getRoleWorkspacePath: vi.fn(() => "/tmp/test-role-ws") };
});
vi.mock("../../lib/artifact-storage.js", () => ({
  publishBlob: vi.fn().mockReturnValue({ blobPath: "/tmp/blob", sizeBytes: 1 }),
  unlinkSourceFileStrict: vi.fn(),
  unlinkBlob: vi.fn(),
  fetchBlob: vi.fn(),
  validatePathInWorkspace: vi.fn(),
}));
vi.mock("../../store/audit-diagnostics.js", () => ({
  recordAuditDiagnostic: vi.fn().mockResolvedValue(undefined),
}));

const { createAdamTools } = await import("../../manager/adam-tools.js");
const { listReceiptsByTrace } = await import("../../store/effect-receipts.js");
const { withTrace } = await import("../../lib/trace-context.js");
const { v4: uuidv4 } = await import("uuid");

describe("memory tools per-turn trace attribution (spread-factory wrapper coverage)", () => {
  beforeEach(() => {
    clearTestDb();
    mockTool.mockClear();
  });

  it("delete_memory receipt attributes to the in-flight turn trace, not the frozen ctor trace", async () => {
    const turnTraceHolder = { id: undefined as string | undefined };

    // Build the ChatManager adam-tools with the per-turn trace getter, inside a frozen "ctor-trace"
    // ALS context (mirrors LiveSession construction freezing the reader-loop trace).
    withTrace("ctor-trace", "chat", () => {
      createAdamTools({ getTurnTraceId: () => turnTraceHolder.id } as Parameters<typeof createAdamTools>[0]);
    });

    const handlers = new Map<string, (args: unknown) => Promise<unknown>>();
    for (const call of mockTool.mock.calls) {
      const [name, , , handler] = call as [string, string, unknown, (args: unknown) => Promise<unknown>];
      handlers.set(name, handler);
    }
    const deleteHandler = handlers.get("delete_memory");
    expect(deleteHandler).toBeDefined();

    // Simulate an in-flight turn: holder set to the turn trace, but the call itself runs under
    // the frozen "ctor-trace" ALS (as the reader loop does in prod).
    turnTraceHolder.id = "trace-mem-turn";
    const memId = uuidv4();
    await withTrace("ctor-trace", "chat", () => deleteHandler!({ id: memId }));

    // The receipt must land under the turn trace, NOT the frozen ctor-trace.
    const turnReceipts = listReceiptsByTrace("trace-mem-turn");
    const delReceipt = turnReceipts.find((r) => r.verb === "delete" && r.entityType === "memory");
    expect(delReceipt).toBeDefined();

    const ctorReceipts = listReceiptsByTrace("ctor-trace");
    expect(ctorReceipts.find((r) => r.entityType === "memory")).toBeUndefined();
  });
});
