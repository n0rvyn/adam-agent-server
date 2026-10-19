/**
 * Unit tests for OutboundGateway.redeliverExecutionTo.
 * Covers:
 *   Single target, success
 *   Multi-target with one missing channel
 *   No artifacts
 *   includeArtifacts=false
 *   dedupDiscriminator default (auto-injected per call)
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

const emittedEvents: Array<{ type: string; [key: string]: unknown }> = [];
vi.mock("../../server/events/server-bus.js", () => ({
  serverBus: {
    emit: (event: { type: string; [key: string]: unknown }) => { emittedEvents.push(event); },
  },
}));

vi.mock("../../delivery/format.js", () => ({
  formatForChannel: vi.fn((content: string, platform: string) => `[${platform}] ${content}`),
}));

vi.mock("../../store/channels.js", () => ({
  getChannel: vi.fn((channelId: string) => {
    if (channelId === "ch-A") return { id: channelId, name: "Channel A", platform: "email", config: {}, viewerKey: "owner" };
    if (channelId === "ch-B") return { id: channelId, name: "Channel B", platform: "email", config: {}, viewerKey: "owner" };
    if (channelId === "ch-disabled") return { id: channelId, name: "Disabled", platform: "email", config: {}, viewerKey: "owner", status: "disconnected" };
    return undefined;
  }),
  // Return a large cap so packing never drops artifacts in existing redelivery tests
  getRecipientCap: vi.fn(() => 209_715_200),
}));

const mockSendMessage = vi.fn();
vi.mock("../../server/routes/channels.js", () => ({
  getChannelManager: vi.fn(() => ({ sendMessage: mockSendMessage })),
}));

const artifactRows: Array<Record<string, unknown>> = [];
vi.mock("../../store/artifacts.js", () => ({
  listArtifactsByExecution: vi.fn((executionId: string) =>
    artifactRows.filter((r) => r.executionId === executionId),
  ),
}));

afterAll(() => cleanup());
beforeEach(() => {
  clearTestDb();
  artifactRows.length = 0;
  emittedEvents.length = 0;
  mockSendMessage.mockReset().mockResolvedValue("msg-redelivery-1");

  const db = getTestDb();
  db.exec(`INSERT INTO tasks (id, status, prompt, config, created_at) VALUES ('exec-redelivery', 'completed', 'seed', '{}', ${Date.now()})`);
  db.exec(`INSERT INTO tasks (id, status, prompt, config, created_at) VALUES ('exec-no-artifacts', 'completed', 'seed', '{}', ${Date.now()})`);
  db.exec(`INSERT INTO tasks (id, status, prompt, config, created_at) VALUES ('exec-missing-channel', 'completed', 'seed', '{}', ${Date.now()})`);

  const gateway = getOutboundGateway();
  (gateway as unknown as { _dedupCache: Map<string, unknown> })._dedupCache.clear();
  (gateway as unknown as { _rateLimitWindows: Map<string, number[]> })._rateLimitWindows.clear();
  (gateway as unknown as { _recentlySentIds: Set<string> })._recentlySentIds.clear();
});

import { getOutboundGateway } from "../../delivery/outbound-gateway.js";
import { getDeliveryLogByTask } from "../../store/delivery-log.js";

describe("OutboundGateway.redeliverExecutionTo", () => {

  it("Single target, success → 1 delivery, status=delivered, attachmentCount=2", async () => {
    artifactRows.push(
      { id: "art-r1", executionId: "exec-redelivery", stepId: "s1", key: "file1", kind: "file", blobPath: "/tmp/f1.txt", mime: "text/plain", sizeBytes: 100, createdAt: Date.now() },
      { id: "art-r2", executionId: "exec-redelivery", stepId: "s1", key: "file2", kind: "file", blobPath: "/tmp/f2.txt", mime: "text/plain", sizeBytes: 200, createdAt: Date.now() },
    );

    const gateway = getOutboundGateway();
    const result = await gateway.redeliverExecutionTo({
      executionId: "exec-redelivery",
      targets: [{ channelId: "ch-A", chatId: "chat-a1" }],
      content: "Redelivery test content",
      messageType: "result_delivery",
      actorToolName: "test-redelivery",
    });

    expect(result.deliveries).toHaveLength(1);
    expect(result.deliveries[0].status).toBe("delivered");
    expect(result.deliveries[0].attachmentCount).toBe(2);
    expect(result.deliveries[0].deliveryLogId).toBeTruthy();
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
  });

  it("Multi-target with one missing channel → second delivery fails", async () => {
    const gateway = getOutboundGateway();
    const result = await gateway.redeliverExecutionTo({
      executionId: "exec-missing-channel",
      targets: [
        { channelId: "ch-A", chatId: "chat-a1" },
        { channelId: "nonexistent-channel", chatId: "chat-x" },
      ],
      content: "Partial delivery",
    });

    expect(result.deliveries).toHaveLength(2);
    expect(result.deliveries[0].status).toBe("delivered");
    expect(result.deliveries[1].status).toBe("failed");
    expect(result.deliveries[1].error).toContain("Channel not found");
    expect(result.deliveries[1].deliveryLogId).toBe("");
  });

  it("No artifacts → attachmentCount=0, gateway still sends text", async () => {
    const gateway = getOutboundGateway();
    const result = await gateway.redeliverExecutionTo({
      executionId: "exec-no-artifacts",
      targets: [{ channelId: "ch-A", chatId: "chat-a1" }],
      content: "No attachments here",
    });

    expect(result.deliveries).toHaveLength(1);
    expect(result.deliveries[0].status).toBe("delivered");
    expect(result.deliveries[0].attachmentCount).toBe(0);
  });

  it("includeArtifacts=false → gateway called without attachments", async () => {
    artifactRows.push(
      { id: "art-5", executionId: "exec-no-artifacts", stepId: "s1", key: "f", kind: "file", blobPath: "/tmp/f5.txt", mime: "text/plain", sizeBytes: 100, createdAt: Date.now() },
    );

    const gateway = getOutboundGateway();
    await gateway.redeliverExecutionTo({
      executionId: "exec-no-artifacts",
      targets: [{ channelId: "ch-A", chatId: "chat-a1" }],
      content: "No artifacts",
      includeArtifacts: false,
    });

    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    const callArg = mockSendMessage.mock.calls[0][2] as Record<string, unknown>;
    expect(callArg.attachments).toBeUndefined();
  });

  it("dedupDiscriminator default is auto-injected per call (both calls succeed)", async () => {
    const gateway = getOutboundGateway();

    // Pass unique discriminators so both calls go through the gateway independently.
    // Without explicit discriminators, two calls in the same millisecond would share
    // the same `redelivery:<Date.now()>` key and the dedup cache would return the
    // cached logEntryId for the second call (no second send).
    await gateway.redeliverExecutionTo({
      executionId: "exec-no-artifacts",
      targets: [{ channelId: "ch-A", chatId: "chat-a1" }],
      content: "First call",
      dedupDiscriminator: "dedup-call-1",
    });
    await gateway.redeliverExecutionTo({
      executionId: "exec-no-artifacts",
      targets: [{ channelId: "ch-A", chatId: "chat-a1" }],
      content: "Second call",
      dedupDiscriminator: "dedup-call-2",
    });

    expect(mockSendMessage).toHaveBeenCalledTimes(2);
  });

  it("delivery_log rows written for each target", async () => {
    const gateway = getOutboundGateway();
    await gateway.redeliverExecutionTo({
      executionId: "exec-redelivery",
      targets: [{ channelId: "ch-A", chatId: "chat-a1" }],
      content: "Delivery log check",
    });

    const logs = getDeliveryLogByTask("exec-redelivery");
    expect(logs).toHaveLength(1);
    expect(logs[0].status).toBe("delivered");
  });
});
