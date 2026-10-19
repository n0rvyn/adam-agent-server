import { describe, test, expect, vi, beforeEach, afterAll } from "vitest";
import { setupTestDb, getTestDb, clearTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();
vi.mock("../../store/db.js", () => ({ getDb: () => getTestDb(), closeDb: () => {} }));

// Mock store/channels.js — sendApprovalToChannel calls supportsInteractiveApproval → getChannel,
// which would otherwise hit getDb().prepare(). Return a wechat platform so supportsInteractiveApproval
// resolves to false (text-mode approval); test exercises the fetch headers regardless of mode.
vi.mock("../../store/channels.js", () => ({
  getChannel: (id: string) => ({ id, platform: "wechat" }),
}));

// Hoisted vi.mock for OutboundGateway — must be top-level so the consumer module
// (approval-handler) sees the stub at import resolution time, not after.
// vi.doMock placed AFTER `await import("approval-handler")` is too late: the consumer
// module already resolved the real gateway into its module record.
const gatewaySendMock = vi.fn().mockResolvedValue({ success: true, logEntryId: "x" });
vi.mock("../../delivery/outbound-gateway.js", () => ({
  getOutboundGateway: () => ({ send: gatewaySendMock , redeliverExecutionTo: vi.fn().mockResolvedValue(undefined) }),
}));

// Set the auth key BEFORE importing approval-handler so its module-level state is correct
import { setAuthKey } from "../../server/auth-key.js";
setAuthKey("test-api-key-deadbeef");

const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
vi.stubGlobal("fetch", fetchMock);

afterAll(() => cleanup());

describe("approval-handler fetch injects x-api-key header (DP-001 Task 15)", () => {
  beforeEach(() => {
    clearTestDb();
    fetchMock.mockClear();
    gatewaySendMock.mockClear();
  });

  test("handleInboundForApproval forwards approval with x-api-key header", async () => {
    const { sendApprovalToChannel, handleInboundForApproval, getPendingApprovalRequestIds } =
      await import("../../channels/approval-handler.js");

    // Set up a pending approval (gateway is hoisted-mocked, so no real channel needed)
    await sendApprovalToChannel("ch-test", "chat-1", "plan-uuid-12345678", "task-1", "Approve plan?");
    const ids = getPendingApprovalRequestIds();
    expect(ids).toHaveLength(1);
    const shortId = ids[0];

    // Trigger inbound approval reply (fetch will fire to /tasks/.../approve-plan)
    fetchMock.mockClear();
    const consumed = await handleInboundForApproval("ch-test", "chat-1", `yes ${shortId}`);
    expect(consumed).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();

    const fetchArgs = fetchMock.mock.calls[0];
    const url = fetchArgs[0] as string;
    const opts = fetchArgs[1] as RequestInit;
    expect(url).toContain("/tasks/task-1/approve-plan");
    const headers = opts.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("test-api-key-deadbeef");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  test("auto-deny on timeout includes x-api-key header", async () => {
    vi.useFakeTimers();
    try {
      const { sendApprovalToChannel } = await import("../../channels/approval-handler.js");
      await sendApprovalToChannel("ch-test", "chat-2", "plan-uuid-87654321", "task-2", "Approve?", 1_000);
      fetchMock.mockClear();
      // Advance time past timeout (1000ms approval timeout + 1000ms internal buffer)
      vi.advanceTimersByTime(2_500);
      // Allow microtasks to flush
      await Promise.resolve();
      await Promise.resolve();
      // Auto-deny fetch should have fired
      expect(fetchMock).toHaveBeenCalled();
      const lastCall = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
      const headers = (lastCall[1] as RequestInit).headers as Record<string, string>;
      expect(headers["x-api-key"]).toBe("test-api-key-deadbeef");
    } finally {
      vi.useRealTimers();
    }
  });
});
